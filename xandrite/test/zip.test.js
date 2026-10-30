'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');

const { openDb, addRoot, listLocations, getLocationSource, getStats } = require('../src/db');
const { scanRoot } = require('../src/indexer');
const { readZipEntry, virtualPath } = require('../src/zip-reader');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-zip-test-'));
  const root = path.join(dir, 'models');
  fs.mkdirSync(root);
  const db = openDb(':memory:');
  addRoot(db, root);
  const write = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };
  const writeZip = (rel, files) => {
    const data = {};
    for (const [name, content] of Object.entries(files)) data[name] = typeof content === 'string' ? strToU8(content) : content;
    return write(rel, Buffer.from(zipSync(data)));
  };
  return { dir, root, db, write, writeZip, scan: (o) => scanRoot(db, root, o), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const present = (lib) => listLocations(lib.db, { includeMissing: false }).rows;

test('models inside a zip are found, hashed from their content, and shown under the zip', async () => {
  const lib = makeLibrary();
  lib.write('loose.stl', 'solid loose');
  const zip = lib.writeZip('packs/robots.zip', {
    'arm/arm.stl': 'solid arm', 'body.3mf': 'body bytes', 'readme.txt': 'not a model',
    '__MACOSX/._arm.stl': 'junk', '.hidden/secret.stl': 'hidden', 'nested.zip': 'inner zip bytes', 'arm/': new Uint8Array(0),
  });
  const summary = await lib.scan();
  assert.equal(summary.found, 3);                      // loose + arm.stl + body.3mf
  assert.equal(summary.archives, 1);
  assert.equal(summary.nestedArchives, 1);
  const rows = present(lib);
  assert.deepEqual(rows.map((r) => r.relPath).sort(), ['loose.stl', path.join('packs', 'robots.zip', 'arm', 'arm.stl'), path.join('packs', 'robots.zip', 'body.3mf')].sort());
  const arm = rows.find((r) => r.name === 'arm.stl');
  assert.equal(arm.sha256, sha('solid arm'));          // same hash as the loose file with that content would have
  assert.equal(arm.container, zip);
  assert.equal(arm.archiveName, 'robots.zip');
  assert.equal(rows.find((r) => r.name === 'loose.stl').container, null);
  assert.deepEqual(getLocationSource(lib.db, virtualPath(zip, 'arm/arm.stl')), { container: zip, entry: 'arm/arm.stl' });
  assert.equal(getLocationSource(lib.db, path.join(lib.root, 'loose.stl')), null);
  assert.equal(getLocationSource(lib.db, '/nowhere.stl'), undefined);
  lib.cleanup();
});

test('the same model loose and inside a zip is one model with two locations', async () => {
  const lib = makeLibrary();
  lib.write('a.stl', 'solid same');
  lib.writeZip('z.zip', { 'copy.stl': 'solid same', 'other.stl': 'solid other' });
  const summary = await lib.scan();
  assert.equal(summary.duplicateGroups, 1);
  assert.equal(getStats(lib.db).uniqueModels, 2);
  lib.cleanup();
});

test('an unchanged zip is not opened again', async () => {
  const lib = makeLibrary();
  lib.writeZip('z.zip', { 'one.stl': 'solid one', 'two.stl': 'solid two' });
  await lib.scan();
  const yauzl = require('yauzl');
  const realOpen = yauzl.open;
  let opened = 0;
  yauzl.open = (...args) => { opened++; return realOpen.apply(yauzl, args); };
  try {
    const again = await lib.scan();
    assert.equal(opened, 0);              // the zip's size and modified time are unchanged, so it was not even opened
    assert.equal(again.errors, 0);
    assert.equal(again.hashed, 0);
    assert.equal(again.reused, 2);
    assert.equal(again.missing, 0);
    assert.equal(present(lib).length, 2);
  } finally {
    yauzl.open = realOpen;
  }
  lib.cleanup();
});

test('a changed zip only reads what changed; removed entries become missing', async () => {
  const lib = makeLibrary();
  const zip = lib.writeZip('z.zip', { 'keep.stl': 'solid keep', 'edit.stl': 'solid before', 'drop.stl': 'solid drop' });
  await lib.scan();
  lib.writeZip('z.zip', { 'keep.stl': 'solid keep', 'edit.stl': 'solid after!', 'add.stl': 'solid new' });
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(zip, future, future);
  const again = await lib.scan();
  assert.equal(again.hashed, 2);        // edit.stl and add.stl
  assert.equal(again.reused, 1);        // keep.stl, recognised by name, size, date and checksum
  assert.equal(again.missing, 1);       // drop.stl
  assert.deepEqual(present(lib).map((r) => r.name).sort(), ['add.stl', 'edit.stl', 'keep.stl']);
  assert.equal(present(lib).find((r) => r.name === 'edit.stl').sha256, sha('solid after!'));
  lib.cleanup();
});

test('a deleted zip makes its models missing, and a zip that cannot be read keeps its old records', async () => {
  const lib = makeLibrary();
  const zip = lib.writeZip('z.zip', { 'one.stl': 'solid one' });
  lib.write('other.stl', 'solid other');
  await lib.scan();

  fs.writeFileSync(zip, 'this is not a zip file at all');   // corrupt, and a different size
  const broken = await lib.scan();
  assert.equal(broken.errors, 1);
  assert.match(broken.problems[0].message, /could not read this archive/);
  assert.equal(broken.missing, 0);                         // the old entry is kept, not marked missing
  assert.equal(present(lib).length, 2);

  fs.rmSync(zip);
  const gone = await lib.scan();
  assert.equal(gone.missing, 1);
  assert.deepEqual(present(lib).map((r) => r.name), ['other.stl']);
  assert.equal(lib.db.prepare('SELECT COUNT(*) n FROM containers').get().n, 0);
  lib.cleanup();
});

test('turning zip scanning off leaves zips alone and their models go missing at the next scan', async () => {
  const lib = makeLibrary();
  lib.writeZip('z.zip', { 'one.stl': 'solid one' });
  lib.write('loose.stl', 'solid loose');
  const off = await lib.scan({ includeArchives: false });
  assert.equal(off.found, 1);
  const on = await lib.scan({ includeArchives: true });
  assert.equal(on.found, 2);
  const off2 = await lib.scan({ includeArchives: false });
  assert.equal(off2.missing, 1);
  lib.cleanup();
});

test('limits: oversized entries are reported and skipped, and a zip with too many entries is refused', async () => {
  const lib = makeLibrary();
  lib.writeZip('z.zip', { 'small.stl': 'solid s', 'big.stl': 'x'.repeat(5000) });
  const s = await lib.scan({ archiveLimits: { maxEntries: 100, maxEntryBytes: 1000, maxRatio: 1000, ratioMinBytes: 1 << 30 } });
  assert.equal(s.errors, 1);
  assert.match(s.problems[0].message, /too large/);
  assert.deepEqual(present(lib).map((r) => r.name), ['small.stl']);

  const lib2 = makeLibrary();
  lib2.writeZip('z.zip', { 'a.stl': 'solid a', 'b.stl': 'solid b', 'c.stl': 'solid c' });
  const s2 = await lib2.scan({ archiveLimits: { maxEntries: 2, maxEntryBytes: 1 << 30, maxRatio: 1000, ratioMinBytes: 1 << 30 } });
  assert.match(s2.problems[0].message, /too many entries/);
  lib.cleanup(); lib2.cleanup();
});

test('a zip with an unsafe file name is reported, not crashed on', async () => {
  const lib = makeLibrary();
  lib.writeZip('z.zip', { '../evil.stl': 'solid evil', 'fine.stl': 'solid fine' });
  lib.write('after.stl', 'solid after');
  const s = await lib.scan();
  assert.equal(s.errors >= 1, true);
  assert.ok(present(lib).some((r) => r.name === 'after.stl'));   // the rest of the scan carried on
  lib.cleanup();
});

test('readZipEntry returns the exact bytes, and reports a missing zip or entry with a code', async () => {
  const lib = makeLibrary();
  const zip = lib.writeZip('z.zip', { 'sub/model.stl': 'solid exact bytes' });
  assert.equal((await readZipEntry(zip, 'sub/model.stl')).toString(), 'solid exact bytes');
  await assert.rejects(readZipEntry(zip, 'sub/nope.stl'), { code: 'ENTRY_NOT_FOUND' });
  await assert.rejects(readZipEntry(zip, 'sub/model.stl', { maxBytes: 3 }), { code: 'TOO_LARGE' });
  await assert.rejects(readZipEntry(path.join(lib.dir, 'missing.zip'), 'x'), { code: 'ENOENT' });
  lib.cleanup();
});

test('thumbnails are made from models inside zips, and a model that left the zip is skipped as stale', async () => {
  const { ThumbnailQueue } = require('../src/thumbnail-queue');
  const lib = makeLibrary();
  const zip = lib.writeZip('z.zip', { 'inside/part.stl': 'solid part bytes', 'gone.stl': 'solid gone' });
  lib.write('loose.stl', 'solid loose bytes');
  await lib.scan();
  // after the scan, the zip loses one entry
  lib.writeZip('z.zip', { 'inside/part.stl': 'solid part bytes' });

  const seen = {};
  const thumbs = path.join(lib.dir, '_thumbs');
  const queue = new ThumbnailQueue({
    db: lib.db, dir: thumbs, renderVersion: 1,
    render: async (job) => { seen[job.name] = job.bytes.toString(); return Buffer.from('PNG-' + job.sha256); },
  });
  await queue.start();
  assert.equal(seen['part.stl'], 'solid part bytes');          // read out of the zip
  assert.equal(seen['loose.stl'], 'solid loose bytes');
  assert.equal(seen['gone.stl'], undefined);                   // the entry is no longer in the zip: skipped, not failed
  assert.equal(queue.getStatus().stale, 1);
  assert.ok(fs.existsSync(path.join(thumbs, sha('solid part bytes') + '.png')));
  assert.ok(!fs.existsSync(path.join(thumbs, sha('solid gone') + '.png')));
  assert.equal(listLocations(lib.db).rows.find((r) => r.name === 'gone.stl').thumbStatus, 'pending');
  lib.cleanup();
});

test('settings are stored, and a database from before zip support is upgraded in place', () => {
  const { getSetting, setSetting } = require('../src/db');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'model-old-db-')), 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE roots (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL, last_scanned_at INTEGER);
    CREATE TABLE models (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, format TEXT NOT NULL, first_seen_at INTEGER NOT NULL);
    CREATE TABLE locations (path TEXT PRIMARY KEY, root TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES models(sha256), size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL, last_seen_scan INTEGER NOT NULL, added_scan INTEGER NOT NULL, missing INTEGER NOT NULL DEFAULT 0);
    INSERT INTO roots VALUES ('/r', 1, 1);
    INSERT INTO models VALUES ('${'a'.repeat(64)}', 5, 'stl', 1);
    INSERT INTO locations VALUES ('/r/a.stl', '/r', '${'a'.repeat(64)}', 5, 1, 1, 1, 0);`);
  old.close();
  const db = openDb(file);                                        // opening runs the migration
  const row = listLocations(db).rows[0];
  assert.equal(row.name, 'a.stl');
  assert.equal(row.container, null);
  setSetting(db, 'scanZips', '0');
  assert.equal(getSetting(db, 'scanZips', '1'), '0');
  assert.equal(getSetting(db, 'missing-key', 'fallback'), 'fallback');
  db.close();
  openDb(file).close();                                           // opening twice is harmless
});
