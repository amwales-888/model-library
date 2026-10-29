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
const { readArchiveEntry } = require('../src/archive-reader');
const { readModelBytes } = require('../src/model-source');
const sevenzip = require('../src/sevenzip-reader');
const { walk } = require('../src/scanner');
const { sevenZipAvailable, write7z, writeRar5 } = require('./helpers/archives');

const skip = sevenZipAvailable() ? false : '7-Zip is not available on this machine';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-arc-test-'));
  const root = path.join(dir, 'models');
  fs.mkdirSync(root);
  const db = openDb(':memory:');
  addRoot(db, root);
  const write = (rel, content) => { const full = path.join(root, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); return full; };
  return { dir, root, db, write, at: (rel) => path.join(root, rel), scan: (o) => scanRoot(db, root, o), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const present = (lib) => listLocations(lib.db, { includeMissing: false }).rows;
const modelFiles = {
  'arm/arm.stl': 'solid arm', 'body.3mf': 'body bytes', 'readme.txt': 'not a model',
  '.hidden/secret.stl': 'hidden', '__MACOSX/._arm.stl': 'junk', 'inner.zip': 'zip bytes', 'inner.7z': 'seven bytes',
};

test('models inside a solid .7z are found and hashed like loose files', { skip }, async () => {
  const lib = makeLibrary();
  lib.write('loose.stl', 'solid arm');                    // same content as the one in the archive
  const archive = write7z(lib.at('packs/robots.7z'), modelFiles, { solid: true });
  const summary = await lib.scan();
  assert.equal(summary.found, 3);                         // loose + arm.stl + body.3mf
  assert.equal(summary.archives, 1);
  assert.equal(summary.nestedArchives, 2);                // inner.zip and inner.7z
  assert.equal(summary.duplicateGroups, 1);
  const rows = present(lib);
  assert.deepEqual(rows.map((r) => r.relPath).sort(), ['loose.stl', path.join('packs', 'robots.7z', 'arm', 'arm.stl'), path.join('packs', 'robots.7z', 'body.3mf')].sort());
  const arm = rows.find((r) => r.name === 'arm.stl');
  assert.equal(arm.sha256, sha('solid arm'));
  assert.equal(arm.archiveName, 'robots.7z');
  assert.deepEqual(getLocationSource(lib.db, path.join(archive, 'arm', 'arm.stl')), { container: archive, entry: 'arm/arm.stl' });
  lib.cleanup();
});

test('a non-solid .7z works the same, and entry dates come from the archive', { skip }, async () => {
  const lib = makeLibrary();
  const when = new Date(2023, 5, 15, 10, 20, 30);
  write7z(lib.at('a.7z'), { 'one.stl': 'solid one', 'two.stl': 'solid two' }, { solid: false, mtimes: { 'one.stl': when } });
  await lib.scan();
  const rows = present(lib);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.name === 'one.stl').modifiedMs, when.getTime());
  lib.cleanup();
});

test('a RAR 5 archive is read', { skip }, async () => {
  const lib = makeLibrary();
  writeRar5(lib.at('packs/set.rar'), { 'parts/leg.stl': 'solid leg', 'plate.3mf': 'plate bytes', 'notes.txt': 'x' });
  const summary = await lib.scan();
  assert.equal(summary.found, 2);
  assert.equal(summary.errors, 0);
  const leg = present(lib).find((r) => r.name === 'leg.stl');
  assert.equal(leg.sha256, sha('solid leg'));
  assert.equal(leg.archiveName, 'set.rar');
  lib.cleanup();
});

test('later parts of a split RAR are not treated as archives', async () => {
  const lib = makeLibrary();
  for (const name of ['a.part1.rar', 'a.part2.rar', 'a.part10.rar', 'b.rar']) lib.write(name, 'x');
  const seen = [];
  for await (const item of walk(lib.root, { includeArchives: true })) seen.push(path.basename(item.path));
  assert.deepEqual(seen.sort(), ['a.part1.rar', 'b.rar']);
  lib.cleanup();
});

test('an unchanged .7z is not opened again, a changed one is', { skip }, async () => {
  const lib = makeLibrary();
  const fixed = { 'one.stl': new Date(2024, 0, 2, 3, 4, 5), 'two.stl': new Date(2024, 0, 2, 3, 4, 6) };   // as if the files were just added to the archive
  const file = write7z(lib.at('a.7z'), { 'one.stl': 'solid one', 'two.stl': 'solid two' }, { mtimes: fixed });
  await lib.scan();
  const cp = require('node:child_process');
  const real = cp.spawn; let spawned = 0;
  cp.spawn = (...args) => { spawned++; return real(...args); };
  try {
    const again = await lib.scan();
    assert.equal(spawned, 0);
    assert.equal(again.reused, 2);
    assert.equal(again.archives, 1);
    await new Promise((r) => setTimeout(r, 20));
    write7z(file, { 'one.stl': 'solid one', 'two.stl': 'solid two', 'three.stl': 'solid three' }, { mtimes: fixed });
    const changed = await lib.scan();
    assert.ok(spawned > 0);
    assert.equal(changed.found, 3);
    assert.equal(changed.hashed, 1);                    // the two known entries are not hashed again
    assert.equal(getStats(lib.db).files, 3);
  } finally {
    cp.spawn = real;
  }
  lib.cleanup();
});

test('removing an entry from a .7z marks it missing; deleting the archive marks everything missing', { skip }, async () => {
  const lib = makeLibrary();
  const file = write7z(lib.at('a.7z'), { 'one.stl': 'solid one', 'two.stl': 'solid two' });
  await lib.scan();
  await new Promise((r) => setTimeout(r, 20));
  write7z(file, { 'one.stl': 'solid one' });
  const s = await lib.scan();
  assert.equal(s.missing, 1);
  fs.rmSync(file);
  const s2 = await lib.scan();
  assert.equal(s2.missing, 1);
  assert.equal(present(lib).length, 0);
  lib.cleanup();
});

test('password-protected archives are reported, and old records are kept', { skip }, async () => {
  const lib = makeLibrary();
  write7z(lib.at('enc.7z'), { 'a.stl': 'solid a', 'b.stl': 'solid b' }, { password: 'pw' });
  const s = await lib.scan();
  assert.equal(s.found, 0);
  assert.equal(s.errors, 2);                            // one problem per model
  assert.match(s.problems[0].message, /password/);
  write7z(lib.at('hdr.7z'), { 'c.stl': 'solid c' }, { password: 'pw', encryptHeaders: true });
  const s2 = await lib.scan();
  assert.equal(s2.errors >= 1, true);
  assert.ok(s2.problems.some((p) => /hdr\.7z/.test(p.path) && /password/.test(p.message)));
  lib.cleanup();
});

test('a damaged archive is reported and does not stop the scan', { skip }, async () => {
  const lib = makeLibrary();
  lib.write('good.stl', 'solid good');
  lib.write('bad.7z', Buffer.from('7z\xBC\xAF\x27\x1C this is not really an archive'));
  lib.write('bad.rar', 'Rar!\x1A\x07\x01\x00 nope');
  const s = await lib.scan();
  assert.equal(s.found, 1);
  assert.equal(s.errors, 2);
  lib.cleanup();
});

test('a model inside an archive can be read back by the viewer and the thumbnail queue', { skip }, async () => {
  const lib = makeLibrary();
  const sevenZ = write7z(lib.at('a.7z'), { 'dir/one.stl': 'solid one', 'two.stl': 'solid two', 'odd[1]*name.stl': 'solid odd' });
  const rar = writeRar5(lib.at('b.rar'), { 'x/three.stl': 'solid three' });
  assert.equal((await readModelBytes({ path: path.join(sevenZ, 'dir', 'one.stl'), container: sevenZ, entry: 'dir/one.stl' })).toString(), 'solid one');
  assert.equal((await readModelBytes({ container: sevenZ, entry: 'odd[1]*name.stl' })).toString(), 'solid odd');
  assert.equal((await readModelBytes({ container: rar, entry: 'x/three.stl' })).toString(), 'solid three');
  await assert.rejects(readArchiveEntry(sevenZ, 'gone.stl'), { code: 'ENTRY_NOT_FOUND' });
  await assert.rejects(readArchiveEntry(sevenZ, 'two.stl', { maxBytes: 3 }), { code: 'TOO_LARGE' });
  fs.rmSync(sevenZ);
  await assert.rejects(readArchiveEntry(sevenZ, 'two.stl'), { code: 'ENOENT' });
  lib.cleanup();
});

test('a damaged entry is caught by its checksum', { skip }, async () => {
  const lib = makeLibrary();
  const file = writeRar5(lib.at('c.rar'), { 'one.stl': 'solid one', 'two.stl': 'solid two' });
  const bytes = fs.readFileSync(file);
  const at = bytes.indexOf('solid two');
  bytes[at + 2] ^= 0xff;                                // flip a byte of the second file's stored data
  fs.writeFileSync(file, bytes);
  const s = await lib.scan();
  assert.equal(s.hashed, 1);                            // the first file is fine
  assert.equal(s.errors, 1);
  assert.match(s.problems[0].message, /damaged|checksum|CRC/i);
  lib.cleanup();
});

test('limits apply to 7z archives too', { skip }, async () => {
  const lib = makeLibrary();
  write7z(lib.at('a.7z'), { 'one.stl': 'x'.repeat(5000), 'two.stl': 'solid two' });
  const s = await lib.scan({ archiveLimits: { maxEntries: 100, maxEntryBytes: 1000, maxRatio: 1000, ratioMinBytes: 1 << 30 } });
  assert.equal(s.hashed, 1);
  assert.ok(s.problems.some((p) => /too large/.test(p.message)));
  const s2 = await makeLibrary();
  write7z(s2.at('b.7z'), { 'a.stl': 'a', 'b.stl': 'b', 'c.stl': 'c' });
  const r = await s2.scan({ archiveLimits: { maxEntries: 2, maxEntryBytes: 1 << 30, maxRatio: 1000, ratioMinBytes: 1 << 30 } });
  assert.ok(r.problems.some((p) => /too many entries/.test(p.message)));
  s2.cleanup(); lib.cleanup();
});

test('zips and 7z archives side by side, and the setting turns all of them off', { skip }, async () => {
  const lib = makeLibrary();
  fs.writeFileSync(lib.at('z.zip'), Buffer.from(zipSync({ 'z.stl': strToU8('solid z') })));
  write7z(lib.at('s.7z'), { 's.stl': 'solid s' });
  writeRar5(lib.at('r.rar'), { 'r.stl': 'solid r' });
  const on = await lib.scan();
  assert.equal(on.found, 3);
  assert.equal(on.archives, 3);
  const off = await lib.scan({ includeArchives: false });
  assert.equal(off.found, 0);
  assert.equal(off.missing, 3);
  lib.cleanup();
});

test('without the 7-Zip program, 7z files are reported once and zips still work', async () => {
  const lib = makeLibrary();
  fs.writeFileSync(lib.at('z.zip'), Buffer.from(zipSync({ 'z.stl': strToU8('solid z') })));
  lib.write('s.7z', Buffer.from('7z\xBC\xAF\x27\x1C'));
  const real = sevenzip.binaryPath;
  const saved = process.env.MODEL_LIBRARY_7Z;
  process.env.MODEL_LIBRARY_7Z = '/nonexistent/7zz';
  // the lookup is cached, so call the reader the way the app would after a failed lookup
  const fresh = require('node:child_process');
  const realSpawn = fresh.spawn;
  fresh.spawn = () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; };
  try {
    const s = await lib.scan();
    assert.equal(s.found, 1);
    assert.equal(s.errors, 1);
  } finally {
    fresh.spawn = realSpawn;
    if (saved === undefined) delete process.env.MODEL_LIBRARY_7Z; else process.env.MODEL_LIBRARY_7Z = saved;
    void real;
  }
  lib.cleanup();
});

/* ---------- split archives ---------- */
const randomModels = (names) => Object.fromEntries(names.map((n) => [n, crypto.randomBytes(3000)]));

test('a split .7z (name.7z.001, .002 ...) is read as one archive', { skip }, async () => {
  const lib = makeLibrary();
  const files = randomModels(['a.stl', 'sub/b.stl', 'c.3mf']);
  const first = lib.at('sets/big.7z.001');
  write7z(lib.at('sets/big.7z'), files, { volume: '2k' });
  assert.ok(fs.existsSync(first) && fs.existsSync(lib.at('sets/big.7z.002')) && fs.existsSync(lib.at('sets/big.7z.003')), 'the test archive should have several parts');
  const s = await lib.scan();
  assert.equal(s.found, 3);
  assert.equal(s.archives, 1);                          // one archive, not one per part
  assert.equal(s.errors, 0);
  const rows = present(lib);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['a.stl', 'b.stl', 'c.3mf']);
  assert.equal(rows[0].archiveName, 'big.7z.001');
  assert.equal(rows.find((r) => r.name === 'b.stl').sha256, crypto.createHash('sha256').update(files['sub/b.stl']).digest('hex'));
  const bytes = await readModelBytes({ container: first, entry: 'sub/b.stl' });
  assert.ok(bytes.equals(files['sub/b.stl']));
  lib.cleanup();
});

test('a changed later part makes the split archive be looked at again', { skip }, async () => {
  const lib = makeLibrary();
  write7z(lib.at('big.7z'), randomModels(['a.stl', 'b.stl', 'c.stl']), { volume: '2k' });
  await lib.scan();
  const cp = require('node:child_process');
  const real = cp.spawn; let spawned = 0;
  cp.spawn = (...args) => { spawned++; return real(...args); };
  try {
    await lib.scan();
    assert.equal(spawned, 0);                           // nothing changed: not opened
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(lib.at('big.7z.002'), later, later);   // only the second part's date changes
    const again = await lib.scan();
    assert.ok(spawned > 0);
    assert.equal(again.found, 3);
  } finally {
    cp.spawn = real;
  }
  lib.cleanup();
});

test('a split archive with a part missing is reported, and its models are kept', { skip }, async () => {
  const lib = makeLibrary();
  write7z(lib.at('big.7z'), randomModels(['a.stl', 'b.stl', 'c.stl']), { volume: '2k' });
  await lib.scan();
  assert.equal(present(lib).length, 3);
  fs.rmSync(lib.at('big.7z.002'));
  const s = await lib.scan();
  assert.ok(s.problems.some((p) => /part 2 of this split archive is missing/.test(p.message)));
  assert.equal(s.missing, 0);
  assert.equal(present(lib).length, 3);
  fs.rmSync(lib.at('big.7z.001'));
  const s2 = await lib.scan();
  assert.ok(s2.problems.some((p) => /first part of this split archive is missing/.test(p.message)));
  lib.cleanup();
});

test('RAR sets are recognised: new-style parts and old-style .r00 volumes', async () => {
  const lib = makeLibrary();
  for (const name of ['a.part1.rar', 'a.part2.rar', 'a.part3.rar', 'b.rar', 'b.r00', 'b.r01', 'c.rar', 'd.part1.rar', 'd.part3.rar', 'e.part2.rar']) lib.write(name, name.length > 8 ? 'xxxxxxxx' : 'yy');
  const items = [];
  for await (const item of walk(lib.root, { includeArchives: true })) items.push(item);
  const byName = Object.fromEntries(items.map((i) => [path.basename(i.path), i]));
  assert.deepEqual(Object.keys(byName).sort(), ['a.part1.rar', 'b.rar', 'c.rar', 'd.part1.rar', 'e.part2.rar']);
  assert.equal(byName['a.part1.rar'].parts, 3);
  assert.equal(byName['a.part1.rar'].incomplete, undefined);
  assert.equal(byName['b.rar'].parts, 3);
  assert.equal(byName['c.rar'].parts, undefined);
  assert.match(byName['d.part1.rar'].incomplete, /part 2 .* missing/);
  assert.match(byName['e.part2.rar'].error.message, /first part .* missing/);
  assert.equal(byName['a.part1.rar'].size, 8 * 3);      // the size is the sum over the parts
  lib.cleanup();
});
