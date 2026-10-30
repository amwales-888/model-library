'use strict';
const path = require('node:path');
// SQLite is built into Node 22.13+ and into Electron, so there is nothing native to install or compile.
const { DatabaseSync } = require('node:sqlite');

/*
 * Two tables carry the idea behind the whole app:
 *
 *   models     one row per distinct file content, identified by its SHA-256
 *   locations  every path where some content has been seen
 *
 * Two copies of a model share one `models` row and have two `locations` rows. When a file is moved,
 * its content is found again by hash at the new path, so the thumbnail that belongs to the SHA is kept.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS roots (
    path            TEXT PRIMARY KEY,
    added_at        INTEGER NOT NULL,
    last_scanned_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS models (
    sha256        TEXT PRIMARY KEY,
    size          INTEGER NOT NULL,
    format        TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS locations (
    path           TEXT PRIMARY KEY,
    root           TEXT NOT NULL,
    sha256         TEXT NOT NULL REFERENCES models(sha256),
    size           INTEGER NOT NULL,
    mtime_ms       REAL NOT NULL,
    last_seen_scan INTEGER NOT NULL,
    added_scan     INTEGER NOT NULL,
    missing        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_locations_sha  ON locations(sha256);
  CREATE INDEX IF NOT EXISTS idx_locations_root ON locations(root);

  -- .zip files that have been read. A zip whose size and modified time are unchanged is not opened again.
  CREATE TABLE IF NOT EXISTS containers (
    path           TEXT PRIMARY KEY,
    root           TEXT NOT NULL,
    size           INTEGER NOT NULL,
    mtime_ms       REAL NOT NULL,
    last_seen_scan INTEGER NOT NULL
  );

  -- Small app settings (for example whether to look inside zip files).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- One row per model that has been through the thumbnail renderer. The image itself is the file <sha256>.png.
  -- status is 'ok' or 'failed'. A model with no row here is still waiting for its thumbnail.
  CREATE TABLE IF NOT EXISTS thumbnails (
    sha256         TEXT PRIMARY KEY REFERENCES models(sha256),
    status         TEXT NOT NULL,
    render_version INTEGER NOT NULL,
    size_px        INTEGER,
    error          TEXT,
    created_at     INTEGER NOT NULL
  );

  -- A star rating from 0 to 5 given in the viewer. A model with no row here is unrated, which is different from 0 stars.
  CREATE TABLE IF NOT EXISTS ratings (
    sha256     TEXT PRIMARY KEY REFERENCES models(sha256),
    stars      INTEGER NOT NULL CHECK (stars BETWEEN 0 AND 5),
    updated_at INTEGER NOT NULL
  );

  -- A view the person set up by hand in the viewer. When a thumbnail is made again (new render version, deleted
  -- image) it is drawn with this view instead of the automatic one. Keyed by SHA-256, so it follows the file around.
  CREATE TABLE IF NOT EXISTS views (
    sha256     TEXT PRIMARY KEY REFERENCES models(sha256),
    position   TEXT NOT NULL,   -- JSON [x, y, z]
    target     TEXT NOT NULL,   -- JSON [x, y, z]
    fov_deg    REAL NOT NULL,
    z_up       INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// Columns added after the first release. Older databases get them here, and nothing already stored changes.
//   container / entry  set for a model that lives inside a .zip: the zip's path and the entry's name in it
//   crc32              the entry's checksum from the zip's directory, used to tell that an entry is unchanged
function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(locations)').all().map((c) => c.name));
  for (const [name, type] of [['container', 'TEXT'], ['entry', 'TEXT'], ['crc32', 'INTEGER']]) {
    if (!have.has(name)) db.exec(`ALTER TABLE locations ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_locations_container ON locations(container)');
}

function getSetting(db, key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function openDb(file) {
  const db = new DatabaseSync(file);
  // WAL with synchronous=NORMAL keeps the many small writes of a scan fast and still safe across crashes.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function addRoot(db, root) {
  db.prepare('INSERT OR IGNORE INTO roots(path, added_at) VALUES (?, ?)').run(root, Date.now());
}

function getRoots(db) {
  return db.prepare(`
    SELECT r.path,
           r.last_scanned_at AS lastScannedAt,
           (SELECT COUNT(*) FROM locations l WHERE l.root = r.path AND l.missing = 0) AS files
    FROM roots r
    ORDER BY r.path COLLATE NOCASE
  `).all().map((r) => ({ path: r.path, lastScannedAt: r.lastScannedAt, files: r.files }));
}

function hasRoot(db, root) {
  return !!db.prepare('SELECT 1 FROM roots WHERE path = ?').get(root);
}

// What the file list can be ordered by. Only these exact expressions ever reach the SQL.
const SORTS = {
  // The file's own name: the path with everything up to the last separator removed.
  name: { sql: `replace(l.path, rtrim(l.path, replace(l.path, '${path.sep}', '')), '') COLLATE NOCASE`, defaultDirection: 'asc' },
  path: { sql: 'l.path COLLATE NOCASE', defaultDirection: 'asc' },   // folder by folder
  modified: { sql: 'l.mtime_ms', defaultDirection: 'desc' },   // when the file was last changed on disk
  added: { sql: 'm.first_seen_at', defaultDirection: 'desc' }, // when the library first saw this content
  size: { sql: 'l.size', defaultDirection: 'desc' },
  rating: { sql: 'COALESCE(r.stars, -1)', defaultDirection: 'desc' },   // unrated files count as lower than 0 stars
};

// Rating filters: the only SQL that can come from the `rating` option.
const RATING_FILTERS = {
  unrated: 'r.stars IS NULL',
  rated: 'r.stars IS NOT NULL',
  '0': 'r.stars = 0',
  '1+': 'r.stars >= 1', '2+': 'r.stars >= 2', '3+': 'r.stars >= 3', '4+': 'r.stars >= 4',
  '5': 'r.stars = 5',
};

function orderBy(sort, direction) {
  const spec = SORTS[sort] || SORTS.name;
  const dir = (direction === 'asc' || direction === 'desc' ? direction : spec.defaultDirection).toUpperCase();
  // The path is the tie-breaker, so equal values keep a stable order and paging never repeats or skips a file.
  return `${spec.sql} ${dir}, l.path COLLATE NOCASE ASC`;
}

/** One page of known file locations, optionally filtered by a text match on the path or the hash. */
function listLocations(db, { search = '', limit = 200, offset = 0, includeMissing = true, dir = null, recursive = true, sort = 'name', direction = null,
  sizeMin = null, sizeMax = null, since = null, before = null, ageBasis = 'modified', rating = 'any' } = {}) {
  const term = String(search).trim();
  const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const where = [];
  const params = [];
  if (dir) {
    // Files inside `dir`. Non-recursive keeps only those with no further separator after the folder's own prefix.
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    where.push('substr(l.path, 1, ?) = ?');
    params.push(prefix.length, prefix);
    if (!recursive) {
      where.push('instr(substr(l.path, ?), ?) = 0');
      params.push(prefix.length + 1, path.sep);
    }
  }
  if (term) {
    where.push("(l.path LIKE ? ESCAPE '\\' OR l.sha256 LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (!includeMissing) where.push('l.missing = 0');

  // Filters. Sizes are in bytes (min inclusive, max exclusive). `since`/`before` are millisecond timestamps
  // (since inclusive, before exclusive) applied to the date modified or the date added.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (num(sizeMin) !== null) { where.push('l.size >= ?'); params.push(sizeMin); }
  if (num(sizeMax) !== null) { where.push('l.size < ?'); params.push(sizeMax); }
  const dateColumn = ageBasis === 'added' ? 'm.first_seen_at' : 'l.mtime_ms';
  if (num(since) !== null) { where.push(`${dateColumn} >= ?`); params.push(since); }
  if (num(before) !== null) { where.push(`${dateColumn} < ?`); params.push(before); }
  const ratingClause = RATING_FILTERS[rating];
  if (ratingClause) where.push(ratingClause);
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM locations l
    JOIN models m ON m.sha256 = l.sha256 LEFT JOIN ratings r ON r.sha256 = l.sha256 ${clause}`).get(...params).n;
  const rows = db.prepare(`
    SELECT l.path, l.root, l.sha256, l.size, l.missing, l.mtime_ms, l.container, l.entry, m.format, m.first_seen_at,
           t.status AS thumb_status, t.error AS thumb_error, t.created_at AS thumb_created_at,
           (v.sha256 IS NOT NULL) AS has_view, r.stars AS rating
    FROM locations l
    JOIN models m ON m.sha256 = l.sha256
    LEFT JOIN thumbnails t ON t.sha256 = l.sha256
    LEFT JOIN views v ON v.sha256 = l.sha256
    LEFT JOIN ratings r ON r.sha256 = l.sha256
    ${clause}
    ORDER BY ${orderBy(sort, direction)}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    total,
    rows: rows.map((r) => {
      const rel = path.relative(r.root, r.path);
      return {
        path: r.path,
        root: r.root,
        relPath: rel,
        name: path.basename(r.path),
        folder: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        sha256: r.sha256,
        size: r.size,
        format: r.format,
        missing: !!r.missing,
        thumbStatus: r.thumb_status || 'pending',   // 'ok', 'failed' or 'pending'
        thumbError: r.thumb_error || null,
        thumbCreatedAt: r.thumb_created_at || null,
        customView: !!r.has_view,
        rating: r.rating === null ? null : r.rating,   // null = unrated
        modifiedMs: r.mtime_ms,
        container: r.container || null,                        // the archive this model is inside, or null for a loose file
        entry: r.entry || null,                                // its name inside that archive
        archiveName: r.container ? path.basename(r.container) : null,
        addedAt: r.first_seen_at,
      };
    }),
  };
}

/**
 * The folder tree for the explorer: one node per root, with a nested node for every folder that holds at least
 * one present file. `count` includes subfolders; `direct` is the files in the folder itself.
 */
function getFolderTree(db) {
  const roots = getRoots(db).map((r) => r.path);
  const rows = db.prepare('SELECT root, path FROM locations WHERE missing = 0').all();
  const byRoot = new Map(roots.map((r) => [r, { name: r, path: r, direct: 0, count: 0, children: new Map() }]));
  for (const { root, path: file } of rows) {
    let node = byRoot.get(root);
    if (!node) continue;
    node.count++;
    const parts = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if (!node.children.has(part)) node.children.set(part, { name: part, path: current, direct: 0, count: 0, children: new Map() });
      node = node.children.get(part);
      node.count++;
    }
    node.direct++;
  }
  const finish = (n) => ({
    name: n.name, path: n.path, direct: n.direct, count: n.count,
    children: [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })).map(finish),
  });
  return roots.map((r) => finish(byRoot.get(r)));
}

/**
 * Takes a folder out of the library. Its file records go; the files on disk are never touched.
 * By default the thumbnails and saved views of those models are kept, so adding the folder again (or finding the
 * same files elsewhere) brings them straight back. With `purge`, models that are no longer found anywhere are
 * deleted along with their thumbnail rows and saved views. Returns the hashes whose images can be deleted.
 */
function removeRoot(db, root, { purge = false } = {}) {
  const shas = db.prepare('SELECT DISTINCT sha256 FROM locations WHERE root = ?').all(root).map((r) => r.sha256);
  let removedLocations = 0;
  const purged = [];
  db.exec('BEGIN');
  try {
    removedLocations = Number(db.prepare('DELETE FROM locations WHERE root = ?').run(root).changes);
    db.prepare('DELETE FROM containers WHERE root = ?').run(root);
    db.prepare('DELETE FROM roots WHERE path = ?').run(root);
    if (purge) {
      const stillThere = db.prepare('SELECT 1 FROM locations WHERE sha256 = ? LIMIT 1');
      for (const sha of shas) {
        if (stillThere.get(sha)) continue;
        db.prepare('DELETE FROM views WHERE sha256 = ?').run(sha);
        db.prepare('DELETE FROM ratings WHERE sha256 = ?').run(sha);
        db.prepare('DELETE FROM thumbnails WHERE sha256 = ?').run(sha);
        db.prepare('DELETE FROM models WHERE sha256 = ?').run(sha);
        purged.push(sha);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { removedLocations, purgedShas: purged };
}

/** Where to read a known location from: { container, entry } for a model inside a zip, or null for a loose file. */
function getLocationSource(db, filePath) {
  const r = db.prepare('SELECT container, entry FROM locations WHERE path = ?').get(filePath);
  if (!r) return undefined;                       // not in the library
  return r.container ? { container: r.container, entry: r.entry } : null;
}

/* ---------- ratings ---------- */

/** Sets the rating (0 to 5) for a model, or clears it with null so the model is unrated again. */
function setRating(db, sha256, stars) {
  if (stars === null) { db.prepare('DELETE FROM ratings WHERE sha256 = ?').run(sha256); return; }
  if (!Number.isInteger(stars) || stars < 0 || stars > 5) throw new Error('A rating is a whole number from 0 to 5.');
  db.prepare(`
    INSERT INTO ratings(sha256, stars, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at
  `).run(sha256, stars, Date.now());
}

function getRating(db, sha256) {
  const r = db.prepare('SELECT stars FROM ratings WHERE sha256 = ?').get(sha256);
  return r ? r.stars : null;
}

/* ---------- hand-made views ---------- */

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Remembers the view for a model. Throws if the view is not made of finite numbers. */
function setView(db, sha256, { position, target, fovDeg, zUp }) {
  if (!isVec3(position) || !isVec3(target) || !Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 170) throw new Error('That is not a valid view.');
  db.prepare(`
    INSERT INTO views(sha256, position, target, fov_deg, z_up, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET position = excluded.position, target = excluded.target,
      fov_deg = excluded.fov_deg, z_up = excluded.z_up, updated_at = excluded.updated_at
  `).run(sha256, JSON.stringify(position), JSON.stringify(target), fovDeg, zUp ? 1 : 0, Date.now());
}

function getView(db, sha256) {
  const r = db.prepare('SELECT position, target, fov_deg, z_up FROM views WHERE sha256 = ?').get(sha256);
  return r ? { position: JSON.parse(r.position), target: JSON.parse(r.target), fovDeg: r.fov_deg, zUp: !!r.z_up } : null;
}

function deleteView(db, sha256) {
  return Number(db.prepare('DELETE FROM views WHERE sha256 = ?').run(sha256).changes) > 0;
}

/* ---------- thumbnails ---------- */

// A model needs a thumbnail when it has at least one location that is not missing, and either has no
// thumbnail row yet or was rendered with an older render version.
const NEEDS_THUMBNAIL = `
  EXISTS (SELECT 1 FROM locations l WHERE l.sha256 = m.sha256 AND l.missing = 0)
  AND (t.sha256 IS NULL OR (t.status = 'ok' AND t.render_version < ?))
`;

/** Models waiting for a thumbnail, each with one present path to read it from. Ordered by path, so folders finish together. */
function pendingThumbnailJobs(db, renderVersion) {
  return db.prepare(`
    SELECT m.sha256, m.format, m.size,
           (SELECT l.path FROM locations l WHERE l.sha256 = m.sha256 AND l.missing = 0 ORDER BY l.path LIMIT 1) AS path,
           (SELECT l.container FROM locations l WHERE l.sha256 = m.sha256 AND l.missing = 0 ORDER BY l.path LIMIT 1) AS container,
           (SELECT l.entry FROM locations l WHERE l.sha256 = m.sha256 AND l.missing = 0 ORDER BY l.path LIMIT 1) AS entry
    FROM models m
    LEFT JOIN thumbnails t ON t.sha256 = m.sha256
    WHERE ${NEEDS_THUMBNAIL}
    ORDER BY path COLLATE NOCASE
  `).all(renderVersion).map((r) => ({ sha256: r.sha256, format: r.format, size: r.size, path: r.path, container: r.container || null, entry: r.entry || null }));
}

function recordThumbnail(db, sha256, { status, renderVersion, sizePx = null, error = null }) {
  db.prepare(`
    INSERT INTO thumbnails(sha256, status, render_version, size_px, error, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET status = excluded.status, render_version = excluded.render_version,
      size_px = excluded.size_px, error = excluded.error, created_at = excluded.created_at
  `).run(sha256, status, renderVersion, sizePx, error, Date.now());
}

function okThumbnailShas(db) {
  return db.prepare("SELECT sha256 FROM thumbnails WHERE status = 'ok'").all().map((r) => r.sha256);
}

function deleteThumbnailRow(db, sha256) {
  db.prepare('DELETE FROM thumbnails WHERE sha256 = ?').run(sha256);
}

/** Forget failed thumbnails so they are tried again. Returns how many were reset. */
function resetFailedThumbnails(db) {
  return Number(db.prepare("DELETE FROM thumbnails WHERE status = 'failed'").run().changes);
}

function getThumbnailCounts(db, renderVersion) {
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  return {
    ok: n(`SELECT COUNT(*) AS n FROM thumbnails t JOIN models m ON m.sha256 = t.sha256
           WHERE t.status = 'ok' AND t.render_version >= ?
             AND EXISTS (SELECT 1 FROM locations l WHERE l.sha256 = m.sha256 AND l.missing = 0)`, renderVersion),
    failed: n(`SELECT COUNT(*) AS n FROM thumbnails t JOIN models m ON m.sha256 = t.sha256
               WHERE t.status = 'failed'
                 AND EXISTS (SELECT 1 FROM locations l WHERE l.sha256 = m.sha256 AND l.missing = 0)`),
    pending: n(`SELECT COUNT(*) AS n FROM models m LEFT JOIN thumbnails t ON t.sha256 = m.sha256 WHERE ${NEEDS_THUMBNAIL}`, renderVersion),
  };
}

function getStats(db) {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    files: n('SELECT COUNT(*) AS n FROM locations WHERE missing = 0'),
    uniqueModels: n('SELECT COUNT(DISTINCT sha256) AS n FROM locations WHERE missing = 0'),
    missing: n('SELECT COUNT(*) AS n FROM locations WHERE missing = 1'),
    duplicateGroups: n('SELECT COUNT(*) AS n FROM (SELECT 1 FROM locations WHERE missing = 0 GROUP BY sha256 HAVING COUNT(*) > 1)'),
  };
}

module.exports = {
  openDb, getSetting, setSetting, getLocationSource, addRoot, removeRoot, getRoots, hasRoot, listLocations, SORTS, getFolderTree, getStats, setView, getView, deleteView, setRating, getRating,
  pendingThumbnailJobs, recordThumbnail, okThumbnailShas, deleteThumbnailRow, resetFailedThumbnails, getThumbnailCounts,
};
