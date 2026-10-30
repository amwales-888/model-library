'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { walk } = require('./scanner');
const { hashFile } = require('./hasher');
const { eachModelEntry, hashStream, virtualPath } = require('./archive-reader');
const { nullLogger } = require('./logger');

/**
 * Scans one root folder and brings the database up to date.
 *
 *  - A file whose path, size and modified time match what is already stored is NOT read again.
 *    That is what makes a rescan of thousands of files take seconds.
 *  - Any other file is hashed (streaming) and stored under its SHA-256.
 *  - Files that were stored before but are no longer found are marked missing, not deleted.
 *    If their content turns up elsewhere, that shows as a "moved" file and the SHA, and so the
 *    thumbnail, stays attached.
 *
 * onProgress receives { found, hashed, reused, errors, current } after every file.
 * Resolves to a summary object. If the signal is aborted the scan stops early, nothing is marked missing,
 * and the summary has cancelled: true.
 */
async function scanRoot(db, root, { onProgress = () => {}, signal, concurrency = 4, includeArchives = true, archiveLimits, log = nullLogger } = {}) {
  const st = await fs.stat(root);
  if (!st.isDirectory()) throw new Error('Not a folder: ' + root);

  const startedAt = Date.now();
  const scanId = startedAt;
  log.info('scan.start', { root, archives: includeArchives, concurrency });
  const counts = { found: 0, hashed: 0, reused: 0, errors: 0, archives: 0, nestedArchives: 0 };
  const problems = [];
  let directoryErrors = 0;

  const getLocation = db.prepare('SELECT size, mtime_ms, crc32 FROM locations WHERE path = ?');
  const markSeen = db.prepare('UPDATE locations SET last_seen_scan = ?, missing = 0 WHERE path = ?');
  const insertModel = db.prepare('INSERT OR IGNORE INTO models(sha256, size, format, first_seen_at) VALUES (?, ?, ?, ?)');
  const upsertLocation = db.prepare(`
    INSERT INTO locations(path, root, sha256, size, mtime_ms, last_seen_scan, added_scan, missing, container, entry, crc32)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      sha256 = excluded.sha256, size = excluded.size, mtime_ms = excluded.mtime_ms,
      last_seen_scan = excluded.last_seen_scan, missing = 0,
      container = excluded.container, entry = excluded.entry, crc32 = excluded.crc32
  `);
  // Models inside zips. A zip that has not changed is not opened: its present entries are simply marked as seen.
  const getContainer = db.prepare('SELECT size, mtime_ms FROM containers WHERE path = ?');
  const markContainerSeen = db.prepare('UPDATE locations SET last_seen_scan = ? WHERE container = ? AND missing = 0');
  const saveContainer = db.prepare(`
    INSERT INTO containers(path, root, size, mtime_ms, last_seen_scan) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET root = excluded.root, size = excluded.size, mtime_ms = excluded.mtime_ms, last_seen_scan = excluded.last_seen_scan
  `);
  const touchContainer = db.prepare('UPDATE containers SET last_seen_scan = ? WHERE path = ?');

  const report = (current) => onProgress({ ...counts, current });
  const noteProblem = (item, error) => {
    counts.errors++;
    if (item.isDirectory) directoryErrors++;
    if (problems.length < 50) problems.push({ path: item.path, message: error.message });
    log.warn('problem', { path: item.path, message: error.message });
  };

  const inflight = new Set();
  const hashAndStore = async (item) => {
    try {
      const t0 = Date.now();
      const sha = await hashFile(item.path, { signal });
      const format = path.extname(item.path).slice(1).toLowerCase();
      insertModel.run(sha, item.size, format, Date.now());
      upsertLocation.run(item.path, root, sha, item.size, item.mtimeMs, scanId, scanId, null, null, null);
      counts.hashed++;
      log.info('hash', { path: item.path, sha256: sha, size: item.size, ms: Date.now() - t0 });
    } catch (error) {
      if (error.name === 'AbortError') return;
      // A file that could not be read (locked, permission denied) keeps its old record instead of being marked missing.
      markSeen.run(scanId, item.path);
      noteProblem(item, error);
    }
    report(item.path);
  };

  // Reads one zip: every model entry is hashed from its decompressed bytes, so a model has the same SHA-256 whether it
  // sits in a zip or loose. Entries whose name, size, date and checksum are unchanged are not read again.
  const scanZip = async (item) => {
    let clean = true;
    const archiveStart = Date.now();
    const foundBefore = counts.found;
    try {
      const { nested } = await eachModelEntry(item.path, {
        signal,
        limits: archiveLimits,
        onProblem: ({ entryName, message }) => { noteProblem({ path: virtualPath(item.path, entryName) }, new Error(message)); },
        onEntry: async (entry) => {
          counts.found++;
          const vpath = virtualPath(item.path, entry.entryName);
          const known = getLocation.get(vpath);
          if (known && known.size === entry.size && known.mtime_ms === entry.mtimeMs && known.crc32 === entry.crc32) {
            markSeen.run(scanId, vpath);
            counts.reused++;
            report(vpath);
            return;
          }
          try {
            const t0 = Date.now();
            const sha = await hashStream(await entry.open(), { signal });
            insertModel.run(sha, entry.size, entry.format, Date.now());
            upsertLocation.run(vpath, root, sha, entry.size, entry.mtimeMs, scanId, scanId, item.path, entry.entryName, entry.crc32);
            counts.hashed++;
            log.info('hash', { path: vpath, sha256: sha, size: entry.size, ms: Date.now() - t0, archive: item.path });
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            clean = false;
            markSeen.run(scanId, vpath);   // keep any old record instead of marking it missing
            noteProblem({ path: vpath }, error);
          }
          report(vpath);
        },
      });
      counts.nestedArchives += nested;
      counts.archives++;
      log.info('archive', { path: item.path, models: counts.found - foundBefore, nested, parts: item.parts, ms: Date.now() - archiveStart });
    } catch (error) {
      if (error.name === 'AbortError') return;
      clean = false;
      markContainerSeen.run(scanId, item.path);   // a zip that cannot be read keeps its old records instead of going missing
      noteProblem(item, new Error('could not read this archive: ' + error.message));
    }
    if (clean) saveContainer.run(item.path, root, item.size, item.mtimeMs, scanId);   // otherwise it is looked at again next scan
    else touchContainer.run(scanId, item.path);
    report(item.path);
  };

  for await (const item of walk(root, { signal, includeArchives })) {
    if (item.error) {
      noteProblem(item, item.error);
      report(item.path);
      continue;
    }
    if (item.isArchive && item.incomplete) {
      markContainerSeen.run(scanId, item.path);     // keep what is known about a set that has a part missing
      noteProblem(item, new Error('could not read this archive: ' + item.incomplete));
      report(item.path);
      continue;
    }
    if (item.isArchive) {
      const container = getContainer.get(item.path);
      if (container && container.size === item.size && container.mtime_ms === item.mtimeMs) {
        const n = Number(markContainerSeen.run(scanId, item.path).changes);
        touchContainer.run(scanId, item.path);
        counts.found += n;
        counts.reused += n;
        counts.archives++;
        report(item.path);
        continue;
      }
      const job = scanZip(item).finally(() => inflight.delete(job));
      inflight.add(job);
      if (inflight.size >= concurrency) await Promise.race(inflight);
      continue;
    }
    counts.found++;

    const known = getLocation.get(item.path);
    if (known && known.size === item.size && known.mtime_ms === item.mtimeMs) {
      markSeen.run(scanId, item.path);
      counts.reused++;
      report(item.path);
      continue;
    }

    const job = hashAndStore(item).finally(() => inflight.delete(job));
    inflight.add(job);
    if (inflight.size >= concurrency) await Promise.race(inflight);
  }
  await Promise.all(inflight);

  const cancelled = !!(signal && signal.aborted);
  let missing = 0;
  // Only mark files missing after a complete, clean scan. A partial scan or an unreadable folder would
  // otherwise make files look deleted when they are not.
  if (!cancelled && directoryErrors === 0) {
    const result = db.prepare('UPDATE locations SET missing = 1 WHERE root = ? AND last_seen_scan <> ? AND missing = 0').run(root, scanId);
    missing = Number(result.changes);
    db.prepare('DELETE FROM containers WHERE root = ? AND last_seen_scan <> ?').run(root, scanId);   // zips that are gone
  }
  if (!cancelled) db.prepare('UPDATE roots SET last_scanned_at = ? WHERE path = ?').run(Date.now(), root);

  const one = (sql, ...params) => db.prepare(sql).get(...params).n;
  const added = one('SELECT COUNT(*) AS n FROM locations WHERE root = ? AND added_scan = ?', root, scanId);
  // A "moved" file is new at this scan, and the same content has a location that is now missing.
  const moved = one(`
    SELECT COUNT(DISTINCT n.sha256) AS n
    FROM locations n JOIN locations o ON o.sha256 = n.sha256 AND o.path <> n.path
    WHERE n.root = ? AND n.added_scan = ? AND o.missing = 1
  `, root, scanId);
  const duplicateGroups = one(
    'SELECT COUNT(*) AS n FROM (SELECT 1 FROM locations WHERE root = ? AND missing = 0 GROUP BY sha256 HAVING COUNT(*) > 1)',
    root);

  const durationMs = Date.now() - startedAt;
  const level = cancelled || counts.errors ? 'warn' : 'info';
  log[level]('scan.end', {
    root, cancelled, duration_ms: durationMs, found: counts.found, hashed: counts.hashed, unchanged: counts.reused,
    new: added, moved, missing, duplicate_groups: duplicateGroups, archives: counts.archives, nested_archives: counts.nestedArchives, errors: counts.errors,
  });

  return {
    root,
    cancelled,
    found: counts.found,
    hashed: counts.hashed,
    reused: counts.reused,
    added,
    moved,
    missing,
    missingSkipped: !cancelled && directoryErrors > 0,
    duplicateGroups,
    archives: counts.archives,
    nestedArchives: counts.nestedArchives,
    errors: counts.errors,
    problems,
    durationMs,
  };
}

module.exports = { scanRoot };
