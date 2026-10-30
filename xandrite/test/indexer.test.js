'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, addRoot, getRoots, listLocations, getStats } = require('../src/db');
const { scanRoot } = require('../src/indexer');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrite-test-'));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };
  const db = openDb(':memory:');
  addRoot(db, dir);
  return { dir, write, db, scan: (opts) => scanRoot(db, dir, opts), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('first scan finds model files, hashes them, and ignores everything else', async () => {
  const lib = makeLibrary();
  lib.write('cube.stl', 'solid cube');
  lib.write('parts/bracket.3mf', 'zip-bytes');
  lib.write('parts/Upper.STL', 'upper-case extension');
  lib.write('notes.txt', 'not a model');
  lib.write('.hidden/secret.stl', 'hidden folder');
  lib.write('._junk.stl', 'macOS resource fork');

  const summary = await lib.scan();
  assert.equal(summary.found, 3);
  assert.equal(summary.hashed, 3);
  assert.equal(summary.reused, 0);
  assert.equal(summary.errors, 0);

  const { rows, total } = listLocations(lib.db);
  assert.equal(total, 3);
  const cube = rows.find((r) => r.name === 'cube.stl');
  assert.equal(cube.sha256, sha('solid cube'));
  assert.equal(cube.format, 'stl');
  assert.equal(cube.folder, '');
  assert.equal(rows.find((r) => r.name === 'bracket.3mf').folder, 'parts');
  lib.cleanup();
});

test('a rescan with nothing changed reads no file contents', async () => {
  const lib = makeLibrary();
  lib.write('a.stl', 'aaa');
  lib.write('b.stl', 'bbb');
  await lib.scan();
  const again = await lib.scan();
  assert.equal(again.found, 2);
  assert.equal(again.reused, 2);
  assert.equal(again.hashed, 0);
  assert.equal(again.added, 0);
  assert.equal(again.missing, 0);
  lib.cleanup();
});

test('a moved file keeps its hash and is reported as moved, not as new content', async () => {
  const lib = makeLibrary();
  const original = lib.write('inbox/widget.stl', 'widget bytes');
  lib.write('other.stl', 'other');
  await lib.scan();

  fs.mkdirSync(path.join(lib.dir, 'sorted'), { recursive: true });
  fs.renameSync(original, path.join(lib.dir, 'sorted', 'widget-v2.stl'));

  const summary = await lib.scan();
  assert.equal(summary.moved, 1);
  assert.equal(summary.missing, 1);
  assert.equal(summary.added, 1);

  const stats = getStats(lib.db);
  assert.equal(stats.files, 2);            // other.stl and the moved file at its new path
  assert.equal(stats.uniqueModels, 2);     // no new content appeared
  assert.equal(stats.missing, 1);          // the old path

  const rows = listLocations(lib.db).rows.filter((r) => r.sha256 === sha('widget bytes'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.missing).sort(), [false, true]);
  lib.cleanup();
});

test('a deleted file is marked missing, and comes back if it reappears', async () => {
  const lib = makeLibrary();
  const file = lib.write('gone.stl', 'now you see me');
  await lib.scan();
  fs.rmSync(file);
  assert.equal((await lib.scan()).missing, 1);
  assert.equal(getStats(lib.db).missing, 1);

  fs.writeFileSync(file, 'now you see me');
  const back = await lib.scan();
  assert.equal(back.missing, 0);
  assert.equal(getStats(lib.db).missing, 0);
  lib.cleanup();
});

test('identical files in different places count as one model with duplicate locations', async () => {
  const lib = makeLibrary();
  lib.write('one/gear.stl', 'same content');
  lib.write('two/gear copy.stl', 'same content');
  lib.write('three/different.stl', 'different');
  const summary = await lib.scan();
  assert.equal(summary.duplicateGroups, 1);
  const stats = getStats(lib.db);
  assert.equal(stats.files, 3);
  assert.equal(stats.uniqueModels, 2);
  assert.equal(stats.duplicateGroups, 1);
  lib.cleanup();
});

test('a file edited in place is hashed again and gets its new hash', async () => {
  const lib = makeLibrary();
  const file = lib.write('part.stl', 'version one');
  await lib.scan();

  fs.writeFileSync(file, 'version two, longer');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  const summary = await lib.scan();
  assert.equal(summary.hashed, 1);
  const row = listLocations(lib.db).rows[0];
  assert.equal(row.sha256, sha('version two, longer'));
  lib.cleanup();
});

test('a cancelled scan does not mark anything missing', async () => {
  const lib = makeLibrary();
  for (let i = 0; i < 20; i++) lib.write(`f${i}.stl`, 'content ' + i);
  await lib.scan();

  const controller = new AbortController();
  controller.abort();
  const summary = await lib.scan({ signal: controller.signal });
  assert.equal(summary.cancelled, true);
  assert.equal(getStats(lib.db).missing, 0);
  lib.cleanup();
});

test('search matches part of a path or of a hash, and roots report their file counts', async () => {
  const lib = makeLibrary();
  lib.write('robots/arm.stl', 'arm');
  lib.write('robots/leg.stl', 'leg');
  lib.write('vases/tall.stl', 'tall');
  await lib.scan();

  assert.equal(listLocations(lib.db, { search: 'robots' }).total, 2);
  assert.equal(listLocations(lib.db, { search: 'TALL' }).total, 1);
  assert.equal(listLocations(lib.db, { search: sha('leg').slice(0, 10) }).total, 1);
  assert.equal(listLocations(lib.db, { search: '100%_' }).total, 0);   // wildcard characters are matched literally
  assert.equal(getRoots(lib.db)[0].files, 3);
  assert.ok(getRoots(lib.db)[0].lastScannedAt > 0);
  lib.cleanup();
});

test('scanning something that is not a folder fails with a clear error', async () => {
  const lib = makeLibrary();
  const file = lib.write('file.stl', 'x');
  await assert.rejects(() => scanRoot(lib.db, file), /Not a folder/);
  lib.cleanup();
});
