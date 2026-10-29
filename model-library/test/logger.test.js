'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createLogger, formatLine, timestamp } = require('../src/logger');
const { openDb, addRoot } = require('../src/db');
const { scanRoot } = require('../src/indexer');
const { ThumbnailQueue } = require('../src/thumbnail-queue');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'model-log-test-'));

test('lines carry a local timestamp with offset, a level, an event and key=value fields', () => {
  assert.match(timestamp(new Date()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  const line = formatLine('WARN', 'problem', { path: '/models/my file.stl', message: 'bad "quote"\nsecond line', n: 3, skipped: undefined, nothing: null });
  assert.match(line, / WARN  problem path="\/models\/my file.stl" message="bad \\"quote\\"\\nsecond line" n=3 nothing=-$/);
  assert.equal(line.includes('\n'), false);            // one event, one line
});

test('the logger writes the file and rolls it over at the size limit', () => {
  const dir = tmp();
  const file = path.join(dir, 'logs', 'x.log');
  const log = createLogger({ file, maxBytes: 600, keep: 2 });
  for (let i = 0; i < 40; i++) log.info('event', { i, pad: 'x'.repeat(30) });
  log.close();
  const names = fs.readdirSync(path.dirname(file)).sort();
  assert.deepEqual(names, ['x.log', 'x.log.1', 'x.log.2']);   // never more than `keep` old files
  const all = names.map((n) => fs.readFileSync(path.join(path.dirname(file), n), 'utf8')).join('');
  assert.ok(all.includes('i=39'));                     // the newest line is in the current file
  assert.ok(fs.statSync(file).size <= 600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a log that cannot be written never throws', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'blocker'), 'a file, not a folder');
  assert.throws(() => createLogger({ file: path.join(dir, 'blocker', 'x.log') }));   // the app falls back to no log
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a scan logs its start, every file hashed with its hash, problems, and the end with the time taken', async () => {
  const dir = tmp();
  const root = path.join(dir, 'models');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.stl'), 'solid a');
  fs.writeFileSync(path.join(root, 'b.stl'), 'solid b');
  fs.writeFileSync(path.join(root, 'broken.zip'), 'PK\x03\x04 not a zip');
  const file = path.join(dir, 'log.txt');
  const log = createLogger({ file });
  const db = openDb(':memory:');
  addRoot(db, root);
  await scanRoot(db, root, { log });
  await scanRoot(db, root, { log });                   // nothing changed: no hashes the second time
  log.close();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  assert.equal(lines.filter((l) => / scan\.start /.test(l)).length, 2);
  assert.equal(lines.filter((l) => / scan\.end /.test(l)).length, 2);
  const hashed = lines.filter((l) => / INFO  hash /.test(l));
  assert.equal(hashed.length, 2);
  assert.ok(hashed.some((l) => l.includes('path=' + path.join(root, 'a.stl')) && l.includes('sha256=' + sha('solid a')) && /ms=\d+/.test(l)));
  const problem = lines.find((l) => / WARN  problem /.test(l));
  assert.ok(problem && problem.includes('broken.zip'));
  const ends = lines.filter((l) => / scan\.end /.test(l));
  assert.match(ends[0], /duration_ms=\d+/);
  assert.match(ends[0], / WARN  scan\.end /);          // it had an error, so it is a warning
  assert.match(ends[0], /hashed=2/);
  assert.match(ends[1], /unchanged=2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the thumbnail queue logs the time for each thumbnail, failures, and the totals', async () => {
  const dir = tmp();
  const root = path.join(dir, 'models');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'good.stl'), 'solid good');
  fs.writeFileSync(path.join(root, 'bad.stl'), 'solid bad');
  const db = openDb(':memory:');
  addRoot(db, root);
  await scanRoot(db, root);
  const file = path.join(dir, 'log.txt');
  const log = createLogger({ file });
  const queue = new ThumbnailQueue({
    db, dir: path.join(dir, 'thumbs'), renderVersion: 1, log,
    render: async (job) => { if (job.name === 'bad.stl') throw new Error('cannot parse this'); return Buffer.from('png'); },
  });
  queue.start();
  await new Promise((resolve) => queue.once('idle', resolve));
  log.close();
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, / INFO  thumbs\.start pending=2/);
  assert.match(text, / INFO  thumb\.ok path=\S*good\.stl sha256=[0-9a-f]{64} ms=\d+ read_ms=\d+/);
  assert.match(text, / WARN  thumb\.fail path=\S*bad\.stl sha256=[0-9a-f]{64} ms=\d+ message="cannot parse this"/);
  assert.match(text, / WARN  thumbs\.end duration_ms=\d+ made=1 failed=1/);
  fs.rmSync(dir, { recursive: true, force: true });
});
