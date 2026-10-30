'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyData } = require('../src/migrate');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrite-migrate-'));
  const legacyDir = path.join(base, 'model-library');
  const dataDir = path.join(base, 'xandrite');
  return { base, legacyDir, dataDir, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('the old library, thumbnails and logs are copied once, and the old folder is left alone', () => {
  const t = setup();
  fs.mkdirSync(path.join(t.legacyDir, 'thumbnails'), { recursive: true });
  fs.mkdirSync(path.join(t.legacyDir, 'logs'));
  fs.mkdirSync(path.join(t.legacyDir, 'Cache'));
  fs.writeFileSync(path.join(t.legacyDir, 'library.sqlite'), 'db');
  fs.writeFileSync(path.join(t.legacyDir, 'thumbnails', 'abc.png'), 'png');
  fs.writeFileSync(path.join(t.legacyDir, 'logs', 'model-library.log'), 'log');
  fs.writeFileSync(path.join(t.legacyDir, 'Cache', 'junk'), 'junk');
  assert.equal(migrateLegacyData({ legacyDir: t.legacyDir, dataDir: t.dataDir }), 'copied');
  assert.equal(fs.readFileSync(path.join(t.dataDir, 'library.sqlite'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(t.dataDir, 'thumbnails', 'abc.png'), 'utf8'), 'png');
  assert.ok(fs.existsSync(path.join(t.dataDir, 'logs', 'model-library.log')));
  assert.ok(!fs.existsSync(path.join(t.dataDir, 'Cache')), 'browser caches are not copied');
  assert.ok(fs.existsSync(path.join(t.legacyDir, 'library.sqlite')), 'the old folder is untouched');
  fs.writeFileSync(path.join(t.dataDir, 'library.sqlite'), 'changed');
  assert.equal(migrateLegacyData({ legacyDir: t.legacyDir, dataDir: t.dataDir }), 'exists');   // second start: nothing is overwritten
  assert.equal(fs.readFileSync(path.join(t.dataDir, 'library.sqlite'), 'utf8'), 'changed');
  t.done();
});

test('nothing happens when there is no old library, or the folders are the same', () => {
  const t = setup();
  assert.equal(migrateLegacyData({ legacyDir: t.legacyDir, dataDir: t.dataDir }), 'none');
  fs.mkdirSync(t.legacyDir);
  fs.writeFileSync(path.join(t.legacyDir, 'library.sqlite'), 'db');
  assert.equal(migrateLegacyData({ legacyDir: t.legacyDir, dataDir: t.legacyDir }), 'none');
  t.done();
});
