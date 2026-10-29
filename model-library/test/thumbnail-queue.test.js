'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, addRoot, listLocations, getThumbnailCounts, resetFailedThumbnails } = require('../src/db');
const { scanRoot } = require('../src/indexer');
const { ThumbnailQueue } = require('../src/thumbnail-queue');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const RENDER_VERSION = 1;

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-queue-test-'));
  const thumbs = path.join(dir, '_thumbs');                       // a sibling of the scanned folder
  const root = path.join(dir, 'models');
  fs.mkdirSync(root);
  const write = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };
  const db = openDb(':memory:');
  addRoot(db, root);
  const calls = [];
  const defaultRender = async (job) => { calls.push(job.name); return Buffer.from('PNG-for-' + job.sha256); };
  const makeQueue = (render = defaultRender, extra = {}) => new ThumbnailQueue({ db, dir: thumbs, render, renderVersion: RENDER_VERSION, ...extra });
  return {
    root, thumbs, write, db, calls, makeQueue,
    scan: () => scanRoot(db, root),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
const imageFor = (lib, text) => path.join(lib.thumbs, sha(text) + '.png');

test('every model gets a <sha256>.png and is recorded as done; nothing is left half written', async () => {
  const lib = makeLibrary();
  lib.write('a.stl', 'content a');
  lib.write('sub/b.3mf', 'content b');
  await lib.scan();

  const queue = lib.makeQueue();
  await queue.start();

  assert.ok(fs.existsSync(imageFor(lib, 'content a')));
  assert.ok(fs.existsSync(imageFor(lib, 'content b')));
  assert.equal(fs.readFileSync(imageFor(lib, 'content a'), 'utf8'), 'PNG-for-' + sha('content a'));
  assert.deepEqual(fs.readdirSync(lib.thumbs).filter((f) => f.endsWith('.tmp')), []);
  assert.deepEqual(getThumbnailCounts(lib.db, RENDER_VERSION), { ok: 2, failed: 0, pending: 0 });
  assert.equal(queue.getStatus().done, 2);
  assert.ok(listLocations(lib.db).rows.every((r) => r.thumbStatus === 'ok'));
  lib.cleanup();
});

test('identical files share one thumbnail, and the renderer is asked only once', async () => {
  const lib = makeLibrary();
  lib.write('one/gear.stl', 'same bytes');
  lib.write('two/gear copy.stl', 'same bytes');
  await lib.scan();
  await lib.makeQueue().start();
  assert.equal(lib.calls.length, 1);
  assert.equal(fs.readdirSync(lib.thumbs).length, 1);
  lib.cleanup();
});

test('a file that cannot be rendered is recorded as failed, the others carry on, and it is not retried until asked', async () => {
  const lib = makeLibrary();
  lib.write('good.stl', 'fine');
  lib.write('broken.stl', 'this one is corrupt');
  await lib.scan();

  const render = async (job) => {
    if (job.name === 'broken.stl') throw new Error('the file contains no triangles');
    return Buffer.from('png');
  };
  const queue = lib.makeQueue(render);
  await queue.start();
  assert.deepEqual(getThumbnailCounts(lib.db, RENDER_VERSION), { ok: 1, failed: 1, pending: 0 });
  const broken = listLocations(lib.db).rows.find((r) => r.name === 'broken.stl');
  assert.equal(broken.thumbStatus, 'failed');
  assert.equal(broken.thumbError, 'the file contains no triangles');
  assert.ok(!fs.existsSync(imageFor(lib, 'this one is corrupt')));

  await queue.start();                                // nothing pending: the failure is not retried
  assert.equal(queue.getStatus().total, 0);

  assert.equal(resetFailedThumbnails(lib.db), 1);     // "Retry failed"
  const retry = lib.makeQueue(async () => Buffer.from('png'));
  await retry.start();
  assert.deepEqual(getThumbnailCounts(lib.db, RENDER_VERSION), { ok: 2, failed: 0, pending: 0 });
  lib.cleanup();
});

test('a file edited since the scan is skipped, never saved under the old hash, and is fixed by a rescan', async () => {
  const lib = makeLibrary();
  const file = lib.write('part.stl', 'version one');
  await lib.scan();

  fs.writeFileSync(file, 'version two, edited after the scan');
  const queue = lib.makeQueue();
  await queue.start();
  assert.equal(queue.getStatus().stale, 1);
  assert.equal(lib.calls.length, 0);
  assert.equal(fs.existsSync(lib.thumbs) ? fs.readdirSync(lib.thumbs).length : 0, 0);
  assert.equal(getThumbnailCounts(lib.db, RENDER_VERSION).failed, 0);

  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  await lib.scan();                                   // the rescan notices the change and hashes the new content
  await lib.makeQueue().start();
  assert.ok(fs.existsSync(imageFor(lib, 'version two, edited after the scan')));
  lib.cleanup();
});

test('a file deleted since the scan is skipped quietly', async () => {
  const lib = makeLibrary();
  const file = lib.write('gone.stl', 'soon deleted');
  await lib.scan();
  fs.rmSync(file);
  const queue = lib.makeQueue();
  await queue.start();
  assert.equal(queue.getStatus().stale, 1);
  assert.equal(getThumbnailCounts(lib.db, RENDER_VERSION).failed, 0);
  lib.cleanup();
});

test('if the renderer itself is broken, the queue pauses with a message and does not mark models as failed', async () => {
  const lib = makeLibrary();
  lib.write('a.stl', 'aaa');
  lib.write('b.stl', 'bbb');
  await lib.scan();

  let broken = true;
  const render = async () => {
    if (broken) throw Object.assign(new Error('WebGL could not start'), { infrastructure: true });
    return Buffer.from('png');
  };
  const queue = lib.makeQueue(render);
  const running = queue.start();
  await new Promise((resolve) => queue.on('progress', (s) => { if (s.blocked) resolve(); }));
  assert.equal(queue.getStatus().blocked, 'WebGL could not start');
  assert.equal(queue.getStatus().paused, true);
  assert.equal(getThumbnailCounts(lib.db, RENDER_VERSION).failed, 0);

  broken = false;
  queue.resume();
  await running;
  assert.deepEqual(getThumbnailCounts(lib.db, RENDER_VERSION), { ok: 2, failed: 0, pending: 0 });
  lib.cleanup();
});

test('pause holds the queue between models, resume continues, and cancel stops with work left over', async () => {
  const lib = makeLibrary();
  for (let i = 0; i < 6; i++) lib.write(`m${i}.stl`, 'model ' + i);
  await lib.scan();

  let queue;
  const order = [];
  const render = async (job) => {
    order.push(job.name);
    if (order.length === 2) queue.pause();            // pause while the second model is being rendered
    return Buffer.from('png');
  };
  queue = lib.makeQueue(render);
  const running = queue.start();
  await new Promise((resolve) => queue.on('progress', (s) => { if (s.paused && s.done === 2) resolve(); }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(order.length, 2);                      // nothing more rendered while paused
  assert.equal(queue.getStatus().paused, true);

  queue.cancel();
  await running;
  assert.equal(getThumbnailCounts(lib.db, RENDER_VERSION).pending, 4);   // work left for next time
  assert.equal(queue.getStatus().running, false);

  const again = lib.makeQueue();
  await again.start();                                // picks up exactly where it left off
  assert.deepEqual(getThumbnailCounts(lib.db, RENDER_VERSION), { ok: 6, failed: 0, pending: 0 });
  lib.cleanup();
});

test('a thumbnail image deleted from disk is made again', async () => {
  const lib = makeLibrary();
  lib.write('a.stl', 'content a');
  await lib.scan();
  await lib.makeQueue().start();
  fs.rmSync(imageFor(lib, 'content a'));
  await lib.makeQueue().start();
  assert.ok(fs.existsSync(imageFor(lib, 'content a')));
  assert.equal(lib.calls.length, 2);
  lib.cleanup();
});

test('thumbnails made with an older render version are made again', async () => {
  const lib = makeLibrary();
  lib.write('a.stl', 'content a');
  await lib.scan();
  await lib.makeQueue().start();
  assert.equal(lib.calls.length, 1);

  const newer = new ThumbnailQueue({ db: lib.db, dir: lib.thumbs, render: async () => Buffer.from('v2'), renderVersion: RENDER_VERSION + 1 });
  assert.equal(getThumbnailCounts(lib.db, RENDER_VERSION + 1).pending, 1);
  await newer.start();
  assert.equal(fs.readFileSync(imageFor(lib, 'content a'), 'utf8'), 'v2');
  lib.cleanup();
});

test('a file over the size limit is recorded as failed without being read', async () => {
  const lib = makeLibrary();
  lib.write('big.stl', 'x'.repeat(5000));
  await lib.scan();
  const queue = lib.makeQueue(undefined, { maxBytes: 1000 });
  await queue.start();
  const row = listLocations(lib.db).rows[0];
  assert.equal(row.thumbStatus, 'failed');
  assert.match(row.thumbError, /too large/);
  assert.equal(lib.calls.length, 0);
  lib.cleanup();
});

test('models added by a scan while the queue is running are picked up in the same run', async () => {
  const lib = makeLibrary();
  lib.write('first.stl', 'first');
  await lib.scan();

  let queue;
  let added = false;
  const render = async (job) => {
    if (!added) { added = true; lib.write('second.stl', 'second'); await lib.scan(); }
    return Buffer.from('png');
  };
  queue = lib.makeQueue(render);
  await queue.start();
  assert.deepEqual(getThumbnailCounts(lib.db, RENDER_VERSION), { ok: 2, failed: 0, pending: 0 });
  lib.cleanup();
});

test('a model being rendered when the app closes stays pending instead of being recorded as failed', async () => {
  const lib = makeLibrary();
  lib.write('a.stl', 'content a');
  await lib.scan();
  const render = async () => { const e = new Error('The app is closing.'); e.shuttingDown = true; throw e; };
  const queue = lib.makeQueue(render);
  await queue.start();
  assert.deepEqual(getThumbnailCounts(lib.db, RENDER_VERSION), { ok: 0, failed: 0, pending: 1 });
  lib.cleanup();
});

test('the renderer is given the stored hand-made view for a model, and nothing for the others', async () => {
  const lib = makeLibrary();
  lib.write('custom.stl', 'content custom');
  lib.write('plain.stl', 'content plain');
  await lib.scan();
  const { setView } = require('../src/db');
  const view = { position: [1, 2, 3], target: [0, 0, 0], fovDeg: 35, zUp: false };
  setView(lib.db, sha('content custom'), view);
  const seen = {};
  const queue = lib.makeQueue(async (job) => { seen[job.name] = job.view; return Buffer.from('png'); });
  await queue.start();
  assert.deepEqual(seen['custom.stl'], view);
  assert.equal(seen['plain.stl'], null);
  lib.cleanup();
});
