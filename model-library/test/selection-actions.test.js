'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');

const { openDb, addRoot, listLocations, setView } = require('../src/db');
const { scanRoot } = require('../src/indexer');
const { describeSelection, selectedRows, containingFolder, revealTarget, uniqueName, downloadRows, cleanBlocks } = require('../src/selection-actions');
const { sevenZipAvailable, write7z, writeRar5 } = require('./helpers/archives');

const skip = sevenZipAvailable() ? false : '7-Zip is not available on this machine';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-sel-test-'));
  const root = path.join(dir, 'models');
  fs.mkdirSync(root);
  const db = openDb(':memory:');
  addRoot(db, root);
  const at = (rel) => path.join(root, rel);
  const write = (rel, content) => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), content); return at(rel); };
  return { dir, root, db, at, write, scan: (o) => scanRoot(db, root, o), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const everything = (lib) => ({ query: { sort: 'path' }, blocks: [{ start: 0, end: listLocations(lib.db, { sort: 'path', includeMissing: false, limit: 1 }).total - 1 }] });
const rowsNamed = (lib, ...names) => listLocations(lib.db, { sort: 'path', limit: 1000 }).rows.filter((r) => names.includes(r.name));

test('Show in folder is only possible when everything selected is in one folder, and archives count as their own folder', async () => {
  const lib = await makeLibrary();
  lib.write('a/one.stl', 'solid one'); lib.write('a/two.stl', 'solid two'); lib.write('b/three.stl', 'solid three');
  fs.mkdirSync(lib.at('a'), { recursive: true });
  fs.writeFileSync(lib.at('a/pack.zip'), Buffer.from(zipSync({ 'inner/in1.stl': strToU8('solid in1'), 'in2.stl': strToU8('solid in2') })));
  await lib.scan();
  const all = listLocations(lib.db, { sort: 'path', limit: 1000 }).rows;
  const indexOf = (name) => all.findIndex((r) => r.name === name);
  const pick = (...names) => ({ query: { sort: 'path' }, blocks: names.map((n) => ({ start: indexOf(n), end: indexOf(n) })) });

  assert.equal(describeSelection(lib.db, pick('one.stl', 'two.stl')).sameFolder, true);
  assert.equal(describeSelection(lib.db, pick('one.stl', 'three.stl')).sameFolder, false);
  // a model inside pack.zip belongs to the folder that holds pack.zip, which is also where one.stl lives
  const zipped = describeSelection(lib.db, pick('in1.stl', 'in2.stl'));
  assert.equal(zipped.sameFolder, true);
  assert.equal(zipped.folder, lib.at('a'));
  assert.equal(describeSelection(lib.db, pick('in1.stl', 'one.stl')).sameFolder, true);
  assert.equal(describeSelection(lib.db, pick('in1.stl', 'three.stl')).sameFolder, false);
  assert.equal(describeSelection(lib.db, pick('one.stl')).count, 1);

  const inZip = all.find((r) => r.name === 'in1.stl');
  assert.equal(containingFolder(inZip), lib.at('a'));            // not the root, and not a "folder" inside the zip
  assert.equal(revealTarget(inZip), lib.at('a/pack.zip'));       // the archive is what gets shown
  assert.equal(revealTarget(all.find((r) => r.name === 'one.stl')), lib.at('a/one.stl'));
  lib.cleanup();
});

test('describeSelection reports hand-made views, and rejects nonsense selections', async () => {
  const lib = await makeLibrary();
  lib.write('x.stl', 'solid x'); lib.write('y.stl', 'solid y');
  await lib.scan();
  const rows = listLocations(lib.db, { sort: 'name', limit: 10 }).rows;
  assert.equal(describeSelection(lib.db, everything(lib)).anyCustomView, false);
  setView(lib.db, rows[1].sha256, { position: [1, 2, 3], target: [0, 0, 0], fovDeg: 35, zUp: true });
  assert.equal(describeSelection(lib.db, everything(lib)).anyCustomView, true);
  assert.equal(describeSelection(lib.db, { query: {}, blocks: 'all' }).count, 0);
  assert.equal(cleanBlocks([{ start: 5, end: 2 }]), null);
  assert.equal(cleanBlocks([{ start: 0, end: 10_000_000 }]), null);
  assert.deepEqual([...selectedRows(lib.db, { query: { sort: 'name' }, blocks: [{ start: 1, end: 1 }] })].map((r) => r.name), ['y.stl']);
  lib.cleanup();
});

test('uniqueName numbers clashing names before the extension and ignores case', () => {
  const taken = new Set(['a.stl']);
  assert.equal(uniqueName('A.stl', taken), 'A (2).stl');
  assert.equal(uniqueName('a.stl', taken), 'a (3).stl');
  assert.equal(uniqueName('b.stl', taken), 'b.stl');
});

test('download copies loose files and extracts files from zip, 7z and rar archives, never overwriting', { skip }, async () => {
  const lib = await makeLibrary();
  lib.write('loose/part.stl', 'solid loose part');
  lib.write('other/part.stl', 'solid other part');                         // same file name, different content
  fs.mkdirSync(lib.at('packs'), { recursive: true });
  fs.writeFileSync(lib.at('packs/z.zip'), Buffer.from(zipSync({ 'deep/dir/zipped.stl': strToU8('solid zipped'), 'part.stl': strToU8('solid zip part') })));
  write7z(lib.at('packs/s.7z'), { 'sub/sevened.stl': 'solid sevened', 'other.3mf': 'seven 3mf' });
  writeRar5(lib.at('packs/r.rar'), { 'rared.stl': 'solid rared' });
  await lib.scan();
  const dest = path.join(lib.dir, 'dest');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'rared.stl'), 'already here, must survive');

  const rows = listLocations(lib.db, { sort: 'path', limit: 1000 }).rows;
  assert.equal(rows.length, 7);
  const progress = [];
  const result = await downloadRows(rows, dest, { onProgress: (p) => progress.push(p) });
  assert.equal(result.copied, 7);
  assert.deepEqual(result.failed, []);
  assert.equal(result.changed, 0);
  assert.equal(result.cancelled, false);

  const names = fs.readdirSync(dest).sort();
  assert.deepEqual(names, ['other.3mf', 'part (2).stl', 'part (3).stl', 'part.stl', 'rared (2).stl', 'rared.stl', 'sevened.stl', 'zipped.stl']);
  assert.equal(fs.readFileSync(path.join(dest, 'rared.stl'), 'utf8'), 'already here, must survive');
  assert.equal(fs.readFileSync(path.join(dest, 'rared (2).stl'), 'utf8'), 'solid rared');
  assert.equal(fs.readFileSync(path.join(dest, 'zipped.stl'), 'utf8'), 'solid zipped');
  assert.equal(fs.readFileSync(path.join(dest, 'sevened.stl'), 'utf8'), 'solid sevened');
  const contents = ['part.stl', 'part (2).stl', 'part (3).stl'].map((n) => fs.readFileSync(path.join(dest, n), 'utf8')).sort();
  assert.deepEqual(contents, ['solid loose part', 'solid other part', 'solid zip part']);
  assert.ok(progress.length >= 7);
  assert.equal(progress[progress.length - 1].done, 7);
  // the copy of a loose file keeps its modified time
  const original = rows.find((r) => r.path === lib.at('loose/part.stl'));
  const copied = [...names].map((n) => path.join(dest, n)).find((p) => fs.readFileSync(p, 'utf8') === 'solid loose part');
  assert.ok(Math.abs(fs.statSync(copied).mtimeMs - original.modifiedMs) < 1000);
  lib.cleanup();
});

test('download reports a file that vanished, an archive that is gone, and a file that changed since the scan', { skip }, async () => {
  const lib = await makeLibrary();
  lib.write('plain.stl', 'solid plain');
  write7z(lib.at('a.7z'), { 'keep.stl': 'solid keep', 'drop.stl': 'solid drop' });
  fs.writeFileSync(lib.at('z.zip'), Buffer.from(zipSync({ 'z1.stl': strToU8('solid z1') })));
  await lib.scan();
  const rows = listLocations(lib.db, { sort: 'path', limit: 1000 }).rows;
  // after the scan: edit the loose file, replace the 7z without one entry, delete the zip
  fs.writeFileSync(lib.at('plain.stl'), 'solid plain, edited');
  write7z(lib.at('a.7z'), { 'keep.stl': 'solid keep' });
  fs.rmSync(lib.at('z.zip'));
  const dest = path.join(lib.dir, 'dest');
  fs.mkdirSync(dest);
  const result = await downloadRows(rows, dest, {});
  assert.equal(result.copied, 2);                                   // plain.stl (changed) and keep.stl
  assert.equal(result.changed, 1);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.some((f) => /drop\.stl/.test(f.path) && /no longer in the archive/.test(f.message)));
  assert.ok(result.failed.some((f) => /z1\.stl/.test(f.path) && /could not read the archive/.test(f.message)));
  assert.deepEqual(fs.readdirSync(dest).sort(), ['keep.stl', 'plain.stl']);
  lib.cleanup();
});

test('a download can be cancelled, and leaves no half-written files', { skip }, async () => {
  const lib = await makeLibrary();
  for (let i = 0; i < 6; i++) lib.write('f' + i + '.stl', 'solid ' + i + 'x'.repeat(2000));
  await lib.scan();
  const rows = listLocations(lib.db, { sort: 'name', limit: 100 }).rows;
  const dest = path.join(lib.dir, 'dest');
  fs.mkdirSync(dest);
  const controller = new AbortController();
  const result = await downloadRows(rows, dest, { signal: controller.signal, onProgress: (p) => { if (p.done >= 2) controller.abort(); } });
  assert.equal(result.cancelled, true);
  assert.ok(result.copied >= 2 && result.copied < 6);
  assert.equal(fs.readdirSync(dest).length, result.copied);        // exactly the finished files, no partial ones
  for (const n of fs.readdirSync(dest)) assert.equal(sha(fs.readFileSync(path.join(dest, n))).length, 64);
  lib.cleanup();
});
