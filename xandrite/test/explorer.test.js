'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDb, addRoot, listLocations, getFolderTree } = require('../src/db');

// Builds a small library straight in the database: root/a.stl, root/sub/b.stl, root/sub/deep/c.3mf, root/sub2/d.stl (missing)
function build() {
  const db = openDb(':memory:');
  const root = path.join(path.sep, 'lib');
  addRoot(db, root);
  const files = [
    ['a.stl', 0], [path.join('sub', 'b.stl'), 0], [path.join('sub', 'deep', 'c.3mf'), 0], [path.join('sub2', 'd.stl'), 1], [path.join('sub', '100%_x.stl'), 0],
  ];
  files.forEach(([rel, missing], i) => {
    const sha = String(i).repeat(64).slice(0, 64);
    db.prepare('INSERT INTO models(sha256,size,format,first_seen_at) VALUES (?,?,?,?)').run(sha, 10, rel.endsWith('3mf') ? '3mf' : 'stl', 0);
    db.prepare('INSERT INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,missing) VALUES (?,?,?,?,?,?,?,?)')
      .run(path.join(root, rel), root, sha, 10, 0, 1, 1, missing);
  });
  return { db, root };
}
const names = (r) => r.rows.map((x) => path.relative(r.rows[0].root, x.path)).sort();

test('folder filter: direct files only, or including subfolders', () => {
  const { db, root } = build();
  const direct = listLocations(db, { dir: path.join(root, 'sub'), recursive: false, includeMissing: true });
  assert.deepEqual(names(direct), [path.join('sub', '100%_x.stl'), path.join('sub', 'b.stl')]);
  const all = listLocations(db, { dir: path.join(root, 'sub'), recursive: true, includeMissing: true });
  assert.equal(all.total, 3);
  assert.equal(listLocations(db, { dir: root, recursive: false }).total, 1);
});

test('folder filter does not match a sibling that shares a name prefix', () => {
  const { db, root } = build();
  const r = listLocations(db, { dir: path.join(root, 'sub'), recursive: true, includeMissing: true });
  assert.ok(r.rows.every((x) => !x.path.includes('sub2')));
});

test('missing files are left out when asked', () => {
  const { db, root } = build();
  assert.equal(listLocations(db, { dir: path.join(root, 'sub2'), includeMissing: false }).total, 0);
  assert.equal(listLocations(db, { dir: path.join(root, 'sub2'), includeMissing: true }).total, 1);
});

test('folder tree counts present files and nests folders', () => {
  const { db, root } = build();
  const [tree] = getFolderTree(db);
  assert.equal(tree.path, root);
  assert.equal(tree.count, 4);
  assert.equal(tree.direct, 1);
  assert.deepEqual(tree.children.map((c) => c.name), ['sub']);   // sub2 holds only a missing file
  const sub = tree.children[0];
  assert.equal(sub.count, 3);
  assert.equal(sub.direct, 2);
  assert.equal(sub.children[0].name, 'deep');
  assert.equal(sub.children[0].path, path.join(root, 'sub', 'deep'));
});

test('a hand-made view is stored per model, replaced on update, validated, and reported by the list', () => {
  const { db, root } = build();
  const { setView, getView, deleteView } = require('../src/db');
  const sha = '0'.repeat(64);
  assert.equal(getView(db, sha), null);
  setView(db, sha, { position: [1, 2, 3], target: [0, 0, 0], fovDeg: 35, zUp: true });
  assert.deepEqual(getView(db, sha), { position: [1, 2, 3], target: [0, 0, 0], fovDeg: 35, zUp: true });
  setView(db, sha, { position: [4, 5, 6], target: [0, 1, 0], fovDeg: 20, zUp: false });
  assert.deepEqual(getView(db, sha), { position: [4, 5, 6], target: [0, 1, 0], fovDeg: 20, zUp: false });
  const custom = listLocations(db, { dir: root, includeMissing: true }).rows.filter((r) => r.customView);
  assert.equal(custom.length, 1);
  assert.throws(() => setView(db, sha, { position: [1, 2, NaN], target: [0, 0, 0], fovDeg: 35, zUp: true }));
  assert.throws(() => setView(db, sha, { position: [1, 2, 3], target: [0, 0], fovDeg: 35, zUp: true }));
  assert.throws(() => setView(db, sha, { position: [1, 2, 3], target: [0, 0, 0], fovDeg: 500, zUp: true }));
  assert.equal(deleteView(db, sha), true);
  assert.equal(getView(db, sha), null);
});

test('removing a folder drops its records, keeps thumbnails by default, and can purge them', () => {
  const { removeRoot } = require('../src/db');
  const { db, root } = build();
  const other = path.join(path.sep, 'other');
  addRoot(db, other);
  // a file that exists in both folders (same content as lib/a.stl, sha "0000...")
  db.prepare('INSERT INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,missing) VALUES (?,?,?,?,?,?,?,?)')
    .run(path.join(other, 'copy.stl'), other, '0'.repeat(64), 10, 0, 1, 1, 0);
  db.prepare("INSERT INTO thumbnails(sha256,status,render_version,created_at) VALUES (?,?,?,?)").run('1'.repeat(64), 'ok', 1, 0);
  db.prepare("INSERT INTO thumbnails(sha256,status,render_version,created_at) VALUES (?,?,?,?)").run('0'.repeat(64), 'ok', 1, 0);

  const kept = removeRoot(db, root);   // default: keep thumbnails and models
  assert.equal(kept.removedLocations, 5);
  assert.deepEqual(kept.purgedShas, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM roots').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM models').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM thumbnails').get().n, 2);

  // add the folder back and remove again with purge: the model that also lives in "other" must survive
  addRoot(db, root);
  db.prepare('INSERT OR IGNORE INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,missing) VALUES (?,?,?,?,?,?,?,?)')
    .run(path.join(root, 'a.stl'), root, '0'.repeat(64), 10, 0, 1, 1, 0);
  db.prepare('INSERT OR IGNORE INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,missing) VALUES (?,?,?,?,?,?,?,?)')
    .run(path.join(root, 'b.stl'), root, '1'.repeat(64), 10, 0, 1, 1, 0);
  const purged = removeRoot(db, root, { purge: true });
  assert.ok(purged.purgedShas.includes('1'.repeat(64)));
  assert.ok(!purged.purgedShas.includes('0'.repeat(64)));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM thumbnails WHERE sha256 = ?").get('1'.repeat(64)).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM thumbnails WHERE sha256 = ?").get('0'.repeat(64)).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM locations WHERE root = ?").get(other).n, 1);
});

test('files can be ordered by name, date modified, date added and size, in either direction, with a stable tie-break', () => {
  const db = openDb(':memory:');
  const root = path.join(path.sep, 'lib');
  addRoot(db, root);
  // name, size, mtime, first seen
  const files = [['b.stl', 300, 1000, 5], ['A.stl', 100, 3000, 7], ['c.stl', 200, 2000, 6], ['d.stl', 200, 2000, 8]];
  files.forEach(([name, size, mtime, seen], i) => {
    const sha = String(i + 1).repeat(64).slice(0, 64);
    db.prepare('INSERT INTO models(sha256,size,format,first_seen_at) VALUES (?,?,?,?)').run(sha, size, 'stl', seen);
    db.prepare('INSERT INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,missing) VALUES (?,?,?,?,?,?,?,?)')
      .run(path.join(root, name), root, sha, size, mtime, 1, 1, 0);
  });
  const order = (opts) => listLocations(db, opts).rows.map((r) => r.name).join(' ');
  assert.equal(order({}), 'A.stl b.stl c.stl d.stl');                                  // name, case-insensitive
  assert.equal(order({ sort: 'name', direction: 'desc' }), 'd.stl c.stl b.stl A.stl');
  assert.equal(order({ sort: 'modified' }), 'A.stl c.stl d.stl b.stl');                 // newest first; c before d on a tie
  assert.equal(order({ sort: 'modified', direction: 'asc' }), 'b.stl c.stl d.stl A.stl');
  assert.equal(order({ sort: 'added' }), 'd.stl A.stl c.stl b.stl');
  assert.equal(order({ sort: 'size' }), 'b.stl c.stl d.stl A.stl');                     // largest first
  assert.equal(order({ sort: 'size', direction: 'asc' }), 'A.stl c.stl d.stl b.stl');
  assert.equal(order({ sort: 'nonsense; DROP TABLE locations' }), 'A.stl b.stl c.stl d.stl');   // unknown values fall back to name
  // paging with ties never repeats or skips a file
  const paged = [0, 1, 2, 3].map((o) => listLocations(db, { sort: 'size', limit: 1, offset: o }).rows[0].name);
  assert.deepEqual(paged, ['b.stl', 'c.stl', 'd.stl', 'A.stl']);
  const row = listLocations(db, { sort: 'modified' }).rows[0];
  assert.equal(row.modifiedMs, 3000);
  assert.equal(row.addedAt, 7);
});

test('"Name" orders by the file name across folders; "path" orders folder by folder', () => {
  const { db, root } = build();   // lib/a.stl, lib/sub/b.stl, lib/sub/deep/c.3mf, lib/sub/100%_x.stl (d.stl is missing)
  const names = (opts) => listLocations(db, opts).rows.map((r) => r.name).join(' ');
  assert.equal(names({ sort: 'name', includeMissing: false }), '100%_x.stl a.stl b.stl c.3mf');
  assert.equal(names({ sort: 'path', includeMissing: false }), 'a.stl 100%_x.stl b.stl c.3mf');
});

function buildForFilters() {
  const db = openDb(':memory:');
  const root = path.join(path.sep, 'lib');
  addRoot(db, root);
  const DAY = 86400000;
  const now = Date.now();
  // name, size, modified (days ago), added (days ago)
  const files = [['tiny.stl', 50 * 1024, 0.5, 40], ['small.stl', 500 * 1024, 5, 3], ['mid.stl', 5 * 1024 * 1024, 60, 2], ['big.stl', 80 * 1024 * 1024, 400, 1]];
  files.forEach(([name, size, modDays, addDays], i) => {
    const sha = String(i + 1).repeat(64).slice(0, 64);
    db.prepare('INSERT INTO models(sha256,size,format,first_seen_at) VALUES (?,?,?,?)').run(sha, size, 'stl', now - addDays * DAY);
    db.prepare('INSERT INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,missing) VALUES (?,?,?,?,?,?,?,?)')
      .run(path.join(root, name), root, sha, size, now - modDays * DAY, 1, 1, 0);
  });
  return { db, now, DAY, sha: (i) => String(i).repeat(64).slice(0, 64) };
}

test('ratings: 0 stars is different from unrated, can be cleared, and are validated', () => {
  const { setRating, getRating } = require('../src/db');
  const { db, sha } = buildForFilters();
  assert.equal(getRating(db, sha(1)), null);
  setRating(db, sha(1), 0);
  assert.equal(getRating(db, sha(1)), 0);
  setRating(db, sha(1), 4);
  assert.equal(getRating(db, sha(1)), 4);
  setRating(db, sha(1), null);
  assert.equal(getRating(db, sha(1)), null);
  for (const bad of [6, -1, 2.5, '3', NaN, undefined]) assert.throws(() => setRating(db, sha(1), bad), /0 to 5/);
  setRating(db, sha(2), 0);
  const rows = listLocations(db, {}).rows;
  assert.equal(rows.find((r) => r.name === 'small.stl').rating, 0);
  assert.equal(rows.find((r) => r.name === 'tiny.stl').rating, null);
});

test('order by rating puts unrated files below 0 stars, and reversing flips that', () => {
  const { setRating } = require('../src/db');
  const { db, sha } = buildForFilters();
  setRating(db, sha(1), 3); setRating(db, sha(2), 5); setRating(db, sha(3), 0);   // big.stl stays unrated
  const order = (o) => listLocations(db, o).rows.map((r) => r.name).join(' ');
  assert.equal(order({ sort: 'rating' }), 'small.stl tiny.stl mid.stl big.stl');
  assert.equal(order({ sort: 'rating', direction: 'asc' }), 'big.stl mid.stl tiny.stl small.stl');
});

test('filter by size uses [min, max) in bytes', () => {
  const { db } = buildForFilters();
  const names = (o) => listLocations(db, o).rows.map((r) => r.name).sort().join(' ');
  assert.equal(names({ sizeMax: 100 * 1024 }), 'tiny.stl');
  assert.equal(names({ sizeMin: 100 * 1024, sizeMax: 1024 * 1024 }), 'small.stl');
  assert.equal(names({ sizeMin: 50 * 1024 * 1024 }), 'big.stl');
  assert.equal(listLocations(db, { sizeMin: 50 * 1024 * 1024 }).total, 1);
  assert.equal(names({ sizeMin: 'oops', sizeMax: NaN }), 'big.stl mid.stl small.stl tiny.stl');   // not numbers: ignored
});

test('filter by age works on the date modified or the date added', () => {
  const { db, now, DAY } = buildForFilters();
  const names = (o) => listLocations(db, o).rows.map((r) => r.name).sort().join(' ');
  assert.equal(names({ since: now - 1 * DAY }), 'tiny.stl');                                   // modified in the last 24 hours
  assert.equal(names({ since: now - 30 * DAY }), 'small.stl tiny.stl');
  assert.equal(names({ before: now - 365 * DAY }), 'big.stl');                                  // older than a year
  assert.equal(names({ since: now - 7 * DAY, ageBasis: 'added' }), 'big.stl mid.stl small.stl'); // added in the last week
  assert.equal(names({ before: now - 7 * DAY, ageBasis: 'added' }), 'tiny.stl');
});

test('filter by rating, and filters combine', () => {
  const { setRating } = require('../src/db');
  const { db, sha, now, DAY } = buildForFilters();
  setRating(db, sha(1), 5); setRating(db, sha(2), 3); setRating(db, sha(3), 0);
  const names = (o) => listLocations(db, o).rows.map((r) => r.name).sort().join(' ');
  assert.equal(names({ rating: 'unrated' }), 'big.stl');
  assert.equal(names({ rating: 'rated' }), 'mid.stl small.stl tiny.stl');
  assert.equal(names({ rating: '0' }), 'mid.stl');
  assert.equal(names({ rating: '3+' }), 'small.stl tiny.stl');
  assert.equal(names({ rating: '5' }), 'tiny.stl');
  assert.equal(names({ rating: 'nonsense; DROP TABLE ratings' }), 'big.stl mid.stl small.stl tiny.stl');   // unknown: no filter
  assert.equal(names({ rating: '3+', since: now - 30 * DAY, sizeMax: 100 * 1024 }), 'tiny.stl');          // all three together
  assert.equal(listLocations(db, { rating: '3+', limit: 1 }).total, 2);                                    // total counts the filtered set
});

test('purging a removed folder also deletes the ratings of models found nowhere else', () => {
  const { setRating, removeRoot } = require('../src/db');
  const { db, sha } = buildForFilters();
  setRating(db, sha(1), 4);
  removeRoot(db, path.join(path.sep, 'lib'), { purge: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ratings').get().n, 0);
});
