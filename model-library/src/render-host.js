'use strict';
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { nullLogger } = require('./logger');

const START_TIMEOUT_MS = 30_000;

const infrastructureError = (message) => Object.assign(new Error(message), { infrastructure: true });

/**
 * Owns the hidden window that renders thumbnails and gives the queue a simple `render(job)` function.
 * If the window cannot start, `render` rejects with an error marked `infrastructure`, so the queue pauses
 * instead of marking every model as failed. A model that crashes or hangs the renderer fails on its own.
 */
class RenderHost {
  constructor({ appRoot, log = nullLogger }) {
    this.appRoot = appRoot;
    this.log = log;
    this.win = null;
    this.ready = null;        // promise for the current window starting up
    this.settleReady = null;  // { resolve, reject } for that promise
    this.pending = new Map(); // job id -> { resolve, reject, timer }
    this.nextId = 1;

    ipcMain.on('thumb:ready', (event) => { if (this._isOurs(event.sender) && this.settleReady) this.settleReady.resolve(); });
    ipcMain.on('thumb:fatal', (event, message) => { if (this._isOurs(event.sender)) this._windowFailed(infrastructureError(String(message))); });
    ipcMain.on('thumb:done', (event, result) => {
      if (!this._isOurs(event.sender) || !result) return;
      const job = this.pending.get(result.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(result.id);
      if (result.error) job.reject(new Error(result.error));
      else job.resolve(Buffer.from(result.png.buffer, result.png.byteOffset, result.png.byteLength));
    });
  }

  ownsWindow(win) { return !!this.win && win === this.win; }

  _isOurs(sender) { return !!this.win && !this.win.isDestroyed() && sender === this.win.webContents; }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready;

    const win = new BrowserWindow({
      show: false,
      width: 512,
      height: 512,
      webPreferences: {
        preload: path.join(this.appRoot, 'thumb-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,   // a hidden window must not be slowed down
      },
    });
    this.win = win;
    let startTimer;
    this.ready = new Promise((resolve, reject) => {
      this.settleReady = {
        resolve: (value) => { clearTimeout(startTimer); resolve(value); },
        reject: (error) => { clearTimeout(startTimer); reject(error); },
      };
      startTimer = setTimeout(() => this._windowFailed(infrastructureError('The thumbnail renderer did not start.')), START_TIMEOUT_MS);
    });
    // Avoid an unhandled-rejection warning if nobody is waiting when startup fails.
    this.ready.catch(() => {});

    win.webContents.on('did-fail-load', (_event, _code, description) => {
      this._windowFailed(infrastructureError('The thumbnail renderer failed to load: ' + description));
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      this._windowFailed(new Error('The renderer process stopped (' + details.reason + ').'), win);
    });
    win.loadFile(path.join(this.appRoot, 'renderer', 'thumbnail-worker.html'));
    return this.ready;
  }

  /** The window is unusable: fail every waiting job, drop the window, and start a fresh one next time. */
  _windowFailed(error, win = this.win) {
    if (!error.shuttingDown) this.log.error('renderer.failed', { message: error.message });   // not when the app is just closing
    if (this.settleReady) this.settleReady.reject(error);
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(error);
      this.pending.delete(id);
    }
    this._destroy(win);
  }

  _destroy(win = this.win) {
    if (win === this.win) { this.win = null; this.ready = null; this.settleReady = null; }
    if (win && !win.isDestroyed()) win.destroy();
  }

  /** Renders one model. Resolves to the PNG as a Buffer. */
  async render({ sha256, ext, name, sizeBytes, bytes, view = null }) {
    await this._ensureWindow();
    const id = this.nextId++;
    const timeoutMs = 60_000 + Math.ceil(sizeBytes / 5_000_000) * 1000;   // more time for big files
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this._destroy();                                  // a stuck renderer cannot be trusted; start a fresh one
        reject(new Error('Rendering took too long and was stopped.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.win.webContents.send('thumb:job', { id, sha256, ext, name, sizeBytes, bytes, view });
    });
  }

  close() {
    const error = new Error('The app is closing.');
    error.shuttingDown = true;   // the queue must not record this as a failed model
    this._windowFailed(error);
  }
}

module.exports = { RenderHost };
