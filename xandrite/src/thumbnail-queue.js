'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { readModelBytes, isGone } = require('./model-source');
const { pendingThumbnailJobs, recordThumbnail, okThumbnailShas, deleteThumbnailRow, getThumbnailCounts, getView } = require('./db');

const { nullLogger } = require('./logger');

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Makes a thumbnail for every model that does not have one yet, one at a time, and saves it as <dir>/<sha256>.png.
 *
 * The rendering itself is done by the `render` function you pass in, so this class can be tested without Electron.
 * render({ sha256, ext, name, sizeBytes, bytes }) resolves to the PNG bytes, or rejects. A rejection whose
 * `infrastructure` property is true (for example "WebGL could not start") pauses the queue instead of marking the
 * model as failed, because the model itself is not at fault.
 *
 * Events:
 *   'progress'  a snapshot of the queue state (see getStatus)
 *   'job'       { sha256, status: 'ok' | 'failed', error, createdAt } after each model
 *   'idle'      the queue ran out of work
 */
class ThumbnailQueue extends EventEmitter {
  constructor({ db, dir, render, renderVersion, maxBytes = DEFAULT_MAX_BYTES, log = nullLogger }) {
    super();
    this.log = log;
    this.db = db;
    this.dir = dir;
    this.render = render;
    this.renderVersion = renderVersion;
    this.maxBytes = maxBytes;

    this.running = false;
    this.paused = false;
    this.cancelled = false;
    this.blocked = null;           // message when the renderer itself is broken
    this.gate = null;              // resolves when a paused queue is resumed
    this.skip = new Set();         // models skipped in this run (file changed or vanished): rescan fixes them
    this.stats = { total: 0, done: 0, failed: 0, stale: 0, current: null };
  }

  /** Starts working through the pending models. Does nothing if the queue is already running. */
  start() {
    if (this.running) return this._runPromise;
    this.running = true;
    this.cancelled = false;
    this.blocked = null;
    this.stats = { total: 0, done: 0, failed: 0, stale: 0, current: null };
    const startedAt = Date.now();
    this.log.info('thumbs.start', { pending: pendingThumbnailJobs(this.db, this.renderVersion).length });
    this._runPromise = this._run().catch((error) => {
      this.blocked = 'The thumbnail queue stopped: ' + error.message;
      this.log.error('thumbs.crashed', { message: error.message });
    }).finally(() => {
      const { done, failed, stale } = this.stats;
      (failed || this.cancelled ? this.log.warn : this.log.info)('thumbs.end', { duration_ms: Date.now() - startedAt, made: done, failed, skipped: stale, cancelled: this.cancelled });
      this.running = false;
      this.stats.current = null;
      this._emitProgress();
      this.emit('idle');
    });
    return this._runPromise;
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.log.info('thumbs.paused');
    this._emitProgress();
  }

  resume() {
    this.blocked = null;
    if (!this.running) { this.start(); return; }
    if (!this.paused) return;
    this.paused = false;
    this.log.info('thumbs.resumed');
    if (this.gate) { this.gate(); this.gate = null; }
    this._emitProgress();
  }

  /** Stops after the current model. Pending models stay pending. */
  cancel() {
    this.cancelled = true;
    this.paused = false;
    if (this.gate) { this.gate(); this.gate = null; }
  }

  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      blocked: this.blocked,
      ...this.stats,
      counts: getThumbnailCounts(this.db, this.renderVersion),
    };
  }

  _emitProgress() { this.emit('progress', this.getStatus()); }

  async _run() {
    await fs.mkdir(this.dir, { recursive: true });
    await this._forgetMissingImages();

    // Loop until nothing new is left, so models added by a scan while the queue is running are picked up too.
    for (;;) {
      const jobs = pendingThumbnailJobs(this.db, this.renderVersion).filter((j) => !this.skip.has(j.sha256));
      if (!jobs.length || this.cancelled) break;
      this.stats.total += jobs.length;
      this._emitProgress();

      for (const job of jobs) {
        if (this.cancelled) return;
        if (this.paused) await new Promise((resolve) => { this.gate = resolve; });
        if (this.cancelled) return;
        this.stats.current = path.basename(job.path);
        this._emitProgress();
        await this._processJob(job);
        if (this.blocked) { this.paused = true; await new Promise((resolve) => { this.gate = resolve; }); }
      }
    }
  }

  /** A thumbnail row whose image file has been deleted from disk is forgotten, so the image is made again. */
  async _forgetMissingImages() {
    for (const sha of okThumbnailShas(this.db)) {
      try { await fs.access(this.imagePath(sha)); } catch { deleteThumbnailRow(this.db, sha); }
    }
  }

  imagePath(sha256) { return path.join(this.dir, sha256 + '.png'); }

  async _processJob(job) {
    const t0 = Date.now();
    const fail = (message) => {
      this.log.warn('thumb.fail', { path: job.path, sha256: job.sha256, ms: Date.now() - t0, message });
      recordThumbnail(this.db, job.sha256, { status: 'failed', renderVersion: this.renderVersion, error: message });
      this.stats.failed++;
      this.emit('job', { sha256: job.sha256, status: 'failed', error: message, createdAt: Date.now() });
    };

    if (job.size > this.maxBytes) return fail('The file is too large to thumbnail (limit ' + Math.round(this.maxBytes / 1048576) + ' MB).');

    let bytes;
    try {
      bytes = await readModelBytes(job, { maxBytes: this.maxBytes });
    } catch (error) {
      if (isGone(error)) { this.skip.add(job.sha256); this.stats.stale++; this.log.warn('thumb.skip', { path: job.path, sha256: job.sha256, reason: 'the file is no longer where the scan found it' }); return; }   // gone since the last scan
      return fail('Could not read the file: ' + error.message);
    }

    // The file may have been edited since the scan. Only save a thumbnail under the hash of the bytes it was made from.
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== job.sha256) {
      this.skip.add(job.sha256);
      this.stats.stale++;
      this.log.warn('thumb.skip', { path: job.path, sha256: job.sha256, reason: 'the file changed since it was scanned' });
      return;
    }
    const readMs = Date.now() - t0;

    let png;
    try {
      png = await this.render({ sha256: job.sha256, ext: job.format, name: path.basename(job.path), sizeBytes: bytes.length, bytes, view: getView(this.db, job.sha256) });
    } catch (error) {
      if (this.cancelled || (error && error.shuttingDown)) {   // the app is closing: leave the model pending for next time
        this.skip.add(job.sha256);                              // but do not loop on it in this run
        return;
      }
      if (error && error.infrastructure) {
        this.blocked = error.message;
        this.log.error('thumbs.blocked', { message: error.message });
        this.paused = true;           // wait here until the person resumes, rather than failing every model
        this._emitProgress();
        return;
      }
      return fail(error && error.message ? error.message : String(error));
    }

    try {
      const final = this.imagePath(job.sha256);
      const temporary = final + '.tmp';
      await fs.writeFile(temporary, png);
      await fs.rename(temporary, final);   // never leaves a half-written image under the real name
    } catch (error) {
      return fail('Could not save the thumbnail: ' + error.message);
    }

    recordThumbnail(this.db, job.sha256, { status: 'ok', renderVersion: this.renderVersion });
    this.log.info('thumb.ok', { path: job.path, sha256: job.sha256, ms: Date.now() - t0, read_ms: readMs, size: job.size });
    this.stats.done++;
    this.emit('job', { sha256: job.sha256, status: 'ok', error: null, createdAt: Date.now() });
    this._emitProgress();
  }
}

module.exports = { ThumbnailQueue };
