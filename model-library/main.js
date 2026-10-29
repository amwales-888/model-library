'use strict';
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, net, shell, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  openDb, getLocationSource, getSetting, setSetting, addRoot, removeRoot, getRoots, hasRoot, listLocations, getFolderTree, getStats, resetFailedThumbnails, recordThumbnail, setView, getView, deleteView, deleteThumbnailRow, setRating, getRating,
} = require('./src/db');
const { scanRoot } = require('./src/indexer');
const { readModelBytes, isGone } = require('./src/model-source');
const { ThumbnailQueue } = require('./src/thumbnail-queue');
const { RenderHost } = require('./src/render-host');
const { createLogger, nullLogger } = require('./src/logger');
const { itemMenuTemplate, folderMenuTemplate } = require('./src/menus');
const { listOptionsFrom, selectedRows, describeSelection, downloadRows } = require('./src/selection-actions');
const { binaryPath } = require('./src/sevenzip-reader');

// Bump this number whenever lighting, material, background or framing change in renderer/lib/view.js
// (keep it in step with RENDER_VERSION there). Thumbnails made with an older version are then made again.
const RENDER_VERSION = 1;

// If the graphics card cannot be used (common in WSL and virtual machines), fall back to software WebGL
// instead of failing. It is only used when hardware WebGL is unavailable, so it costs nothing otherwise.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// thumb://local/<sha256>.png serves the saved thumbnails to the library window.
protocol.registerSchemesAsPrivileged([{ scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let db = null;
let libraryWindow = null;
let activeScan = null;     // { controller } while a scan is running
let thumbDir = null;
let renderHost = null;
let queue = null;
let log = nullLogger;       // the log file (see src/logger.js); replaced once the app is ready
let rescan = null;         // { startedAt, roots } while the Rescan button is working through the folders

function createWindow(page, options = {}) {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1317' : '#eceff2',
    autoHideMenuBar: true,
    ...options,
    webPreferences: {
      // The pages never get Node. They only see the small API that preload.js exposes.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(options.preload ? { preload: options.preload } : {}),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', page));
  // Keep the windows on our own pages: no pop-ups, no navigating away.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', quitIfNoWindowsLeft);
  return win;
}

// The hidden thumbnail renderer is also a window, so Electron's own "all windows closed" check never fires.
// Quit once the last window the person can see has been closed.
function quitIfNoWindowsLeft() {
  const visible = BrowserWindow.getAllWindows().filter((w) => !(renderHost && renderHost.ownsWindow(w)));
  if (visible.length === 0 && process.platform !== 'darwin') app.quit();
}

function createLibraryWindow() {
  libraryWindow = createWindow('index.html', { preload: path.join(__dirname, 'preload.js') });
  libraryWindow.on('closed', () => { libraryWindow = null; });
}

function sendToLibrary(channel, payload) {
  if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send(channel, payload);
}

/* ---------- thumbnails: queue progress is sent to the window in small batches ---------- */

function setUpThumbnails(dbFile) {
  thumbDir = path.join(path.dirname(dbFile), 'thumbnails');   // next to the database file
  renderHost = new RenderHost({ appRoot: __dirname, log });
  queue = new ThumbnailQueue({
    db,
    dir: thumbDir,
    render: (job) => renderHost.render(job),
    renderVersion: RENDER_VERSION,
    log,
  });

  let finished = [];
  let timer = null;
  const flush = () => {
    timer = null;
    sendToLibrary('thumbs:progress', { status: queue.getStatus(), finished: finished.splice(0) });
  };
  const scheduleFlush = () => { if (!timer) timer = setTimeout(flush, 150); };
  queue.on('job', (job) => { finished.push(job); scheduleFlush(); });
  queue.on('progress', scheduleFlush);
  queue.on('idle', scheduleFlush);

  // Serve thumbnails by hash. Only names that look like a SHA-256 are accepted, so nothing else on disk can be reached.
  protocol.handle('thumb', async (request) => {
    const match = /^\/([0-9a-f]{64})\.png$/.exec(new URL(request.url).pathname);
    if (!match) return new Response('Not found', { status: 404 });
    try {
      return await net.fetch(pathToFileURL(path.join(thumbDir, match[1] + '.png')).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/* ---------- IPC: everything the library window is allowed to ask for ---------- */

ipcMain.handle('library:addFolder', async () => {
  const result = await dialog.showOpenDialog(libraryWindow, {
    title: 'Choose a folder of 3D models',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = path.resolve(result.filePaths[0]);
  addRoot(db, root);
  log.info('folder.added', { root });
  return { root };
});

ipcMain.handle('library:scan', async (event, root) => {
  if (typeof root !== 'string' || !hasRoot(db, root)) return { error: 'That folder has not been added to the library.' };
  if (activeScan) return { error: 'A scan is already running.' };

  const controller = new AbortController();
  activeScan = { controller };
  let lastSent = 0;
  const onProgress = (progress) => {
    const now = Date.now();
    if (now - lastSent < 100 || event.sender.isDestroyed()) return;   // at most ten updates a second
    lastSent = now;
    event.sender.send('library:progress', progress);
  };
  try {
    const includeArchives = getSetting(db, 'scanZips', '1') === '1';
    const summary = await scanRoot(db, root, { onProgress, signal: controller.signal, includeArchives, log });
    queue.start();   // make thumbnails for anything new
    return { summary };
  } catch (error) {
    log.error('scan.failed', { root, message: error.message });
    return { error: error.message };
  } finally {
    activeScan = null;
  }
});

ipcMain.handle('library:removeRoot', async (_event, root, purge) => {
  if (typeof root !== 'string' || !hasRoot(db, root)) return { ok: false, error: 'That folder is not in the library.' };
  if (activeScan) return { ok: false, error: 'Wait for the running scan to finish (or cancel it) first.' };
  try {
    const result = removeRoot(db, root, { purge: purge === true });
    log.info('folder.removed', { root, purge: purge === true, files: result.removedLocations, models_purged: result.purgedShas.length });
    for (const sha of result.purgedShas) {
      await fs.promises.rm(queue.imagePath(sha), { force: true }).catch(() => {});
    }
    return { ok: true, removedFiles: result.removedLocations, purgedModels: result.purgedShas.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


/* ---------- right-click menus and actions on several models at once ---------- */

const fromLibrary = (event) => !!libraryWindow && !libraryWindow.isDestroyed() && event.sender === libraryWindow.webContents;
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
// The page sends lists of hashes; keep only well-formed ones that belong to models in the library.
const knownShas = (list) => (Array.isArray(list) ? [...new Set(list.filter(isSha))].slice(0, 200_000).filter((sha) => db.prepare('SELECT 1 FROM models WHERE sha256 = ?').get(sha)) : []);

// The menu is shown here (so it looks like the system's own menus); the choice goes back to the page as 'menu:action'.
function popupMenu(event, template) {
  Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(event.sender) });
}
const actionSender = (event) => (action, extra = {}) => () => { if (!event.sender.isDestroyed()) event.sender.send('menu:action', { action, ...extra }); };

ipcMain.handle('menu:item', (event, info = {}) => {
  if (!fromLibrary(event)) return;
  popupMenu(event, itemMenuTemplate({ count: Number(info.count), canRevert: info.canRevert === true, canReveal: info.canReveal === true }, actionSender(event)));
});
ipcMain.handle('menu:folder', (event, info = {}) => {
  if (!fromLibrary(event)) return;
  popupMenu(event, folderMenuTemplate({ isRoot: info.isRoot === true, busy: !!activeScan || info.busy === true }, actionSender(event)));
});

ipcMain.handle('clipboard:write', (event, text) => {
  if (!fromLibrary(event) || typeof text !== 'string' || text.length > 20_000_000) return { ok: false };
  clipboard.writeText(text);
  return { ok: true };
});

// What the right-click menu needs to know about the selection: how many, whether they are all in one folder, any hand-made views.
ipcMain.handle('selection:info', (event, selection) => {
  if (!fromLibrary(event)) return { count: 0, sameFolder: false, anyCustomView: false };
  return describeSelection(db, selection);
});

// Show the selected models in the file manager. Only done when they all sit in one folder. For a model inside an
// archive that is the folder holding the archive, which is opened directly (never the library's top folder); a single
// loose file is shown selected in its folder.
ipcMain.handle('shell:reveal', async (event, selection) => {
  if (!fromLibrary(event)) return { ok: false, error: 'Not allowed.' };
  const info = describeSelection(db, selection);
  if (!info.count) return { ok: false, error: 'Nothing is selected.' };
  if (!info.sameFolder) return { ok: false, error: 'The selected files are in different folders.' };
  const first = selectedRows(db, selection).next().value;
  if (info.count === 1 && !first.container) { shell.showItemInFolder(first.path); return { ok: true }; }
  const failure = await shell.openPath(info.folder);
  return failure ? { ok: false, error: failure } : { ok: true };
});

// Download: copy the selected models to a folder the person picks, extracting those that are inside archives.
let activeDownload = null;
ipcMain.handle('downloads:start', async (event, selection) => {
  if (!fromLibrary(event)) return { ok: false, error: 'Not allowed.' };
  if (activeDownload) return { ok: false, error: 'A download is already running.' };
  const rows = [...selectedRows(db, selection)];
  if (!rows.length) return { ok: false, error: 'Nothing is selected.' };
  const picked = await dialog.showOpenDialog(libraryWindow, {
    title: rows.length === 1 ? 'Choose a folder to copy the file to' : 'Choose a folder to copy ' + rows.length.toLocaleString('en') + ' files to',
    buttonLabel: 'Copy here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: true, cancelled: true, copied: 0, failed: [], changed: 0, total: rows.length, destination: null };
  const destination = path.resolve(picked.filePaths[0]);
  const controller = new AbortController();
  activeDownload = { controller };
  const startedAt = Date.now();
  log.info('download.start', { files: rows.length, destination });
  let lastSent = 0;
  try {
    const result = await downloadRows(rows, destination, {
      signal: controller.signal,
      log,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastSent < 100 && progress.current) return;
        lastSent = now;
        sendToLibrary('downloads:progress', progress);
      },
    });
    (result.failed.length || result.cancelled || result.changed ? log.warn : log.info)('download.end', { destination, duration_ms: Date.now() - startedAt, copied: result.copied, failed: result.failed.length, changed: result.changed, cancelled: result.cancelled });
    return { ok: true, ...result, failed: result.failed.slice(0, 20), failedCount: result.failed.length, destination };
  } catch (error) {
    log.error('download.failed', { destination, message: error.message });
    return { ok: false, error: error.message };
  } finally {
    activeDownload = null;
  }
});
ipcMain.handle('downloads:cancel', () => { if (activeDownload) activeDownload.controller.abort(); });

// Open a library folder (the top folder or one inside it) in the file manager.
ipcMain.handle('shell:revealFolder', async (event, dir) => {
  if (!fromLibrary(event) || typeof dir !== 'string') return { ok: false, error: 'Not allowed.' };
  const inside = getRoots(db).some((r) => { const rel = path.relative(r.path, dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
  if (!inside) return { ok: false, error: 'That folder is not in the library.' };
  const failure = await shell.openPath(dir);
  return failure ? { ok: false, error: failure } : { ok: true };
});

ipcMain.handle('ratings:setMany', (event, shas, stars) => {
  if (!fromLibrary(event)) return { ok: false, error: 'Not allowed.' };
  if (stars !== null && !(Number.isInteger(stars) && stars >= 0 && stars <= 5)) return { ok: false, error: 'A rating is a whole number from 0 to 5.' };
  const list = knownShas(shas);
  try {
    db.exec('BEGIN');
    for (const sha of list) setRating(db, sha, stars);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to undo */ }
    return { ok: false, error: e.message };
  }
  log.info('ratings.set', { models: list.length, stars });
  sendToLibrary('ratings:changed', { shas: list, stars });
  return { ok: true, changed: list.length };
});

// Draw the thumbnails again (keeping a hand-made view), or forget the hand-made views first with `revert`.
function redraw(shas, revert) {
  for (const sha of shas) {
    if (revert) deleteView(db, sha);
    deleteThumbnailRow(db, sha);                 // makes the model pending again
    queue.skip.delete(sha);
  }
  sendToLibrary('thumbs:updated-many', { shas, custom: revert ? false : undefined });
  queue.start();
}
ipcMain.handle('thumbs:regenerate', (event, shas) => {
  if (!fromLibrary(event)) return { ok: false, error: 'Not allowed.' };
  const list = knownShas(shas);
  redraw(list, false);
  log.info('thumbs.regenerate', { models: list.length });
  return { ok: true, count: list.length };
});
ipcMain.handle('views:revertMany', (event, shas) => {
  if (!fromLibrary(event)) return { ok: false, error: 'Not allowed.' };
  const list = knownShas(shas);
  redraw(list, true);
  log.info('views.revert', { models: list.length });
  return { ok: true, count: list.length };
});

// Settings the library window can change.
ipcMain.handle('settings:get', () => ({ scanZips: getSetting(db, 'scanZips', '1') === '1' }));
ipcMain.handle('settings:setScanZips', (_event, on) => { log.info('setting.changed', { name: 'search_inside_archives', value: on === true }); setSetting(db, 'scanZips', on === true ? '1' : '0'); return { scanZips: on === true }; });

ipcMain.handle('library:cancel', () => { if (activeScan) { log.warn('scan.cancel_requested'); activeScan.controller.abort(); } });

// The Rescan button works through every folder; these two calls let the log record that as one rescan.
ipcMain.handle('log:rescan', (_event, phase, info = {}) => {
  if (phase === 'start') {
    rescan = { startedAt: Date.now() };
    log.info('rescan.start', { folders: Number.isFinite(info.folders) ? info.folders : undefined });
  } else if (phase === 'end' && rescan) {
    const ok = info && info.ok === true;
    (ok ? log.info : log.warn)('rescan.end', { duration_ms: Date.now() - rescan.startedAt, folders: Number.isFinite(info.folders) ? info.folders : undefined, cancelled: info.cancelled === true, error: typeof info.error === 'string' ? info.error.slice(0, 300) : undefined });
    rescan = null;
  }
});

// Preferences > Show log file. Opens the file in the default program, or reveals it if nothing is set up to open .log files.
ipcMain.handle('log:open', async () => {
  if (!log.path) return { path: null };
  log.flush();
  const failure = await shell.openPath(log.path);
  if (failure) shell.showItemInFolder(log.path);
  return { path: log.path };
});
ipcMain.handle('library:roots', () => getRoots(db));
ipcMain.handle('library:stats', () => getStats(db));

ipcMain.handle('library:list', (_event, query = {}) => listLocations(db, listOptionsFrom(query)));

ipcMain.handle('library:tree', () => getFolderTree(db));

ipcMain.handle('thumbs:status', () => queue.getStatus());
ipcMain.handle('thumbs:pause', () => { queue.pause(); });
ipcMain.handle('thumbs:resume', () => { queue.resume(); });
ipcMain.handle('thumbs:retryFailed', () => {
  resetFailedThumbnails(db);
  queue.start();
});

// One viewer window is reused for files opened from the explorer. The main process reads the file, and only
// files the library knows about can be opened this way, so the page cannot ask for arbitrary paths.
let viewerWindow = null;
function openViewer(file) {
  if (!viewerWindow || viewerWindow.isDestroyed()) {
    viewerWindow = createWindow('viewer.html', { width: 1100, height: 780, preload: path.join(__dirname, 'viewer-preload.js') });
    viewerWindow.on('closed', () => { viewerWindow = null; });
  } else {
    if (viewerWindow.isMinimized()) viewerWindow.restore();
    viewerWindow.focus();
  }
  if (!file) return;
  const send = () => viewerWindow && !viewerWindow.isDestroyed() && viewerWindow.webContents.send('viewer:file', file);
  if (viewerWindow.webContents.isLoading()) viewerWindow.webContents.once('did-finish-load', send); else send();
}

// The viewer replaces a library thumbnail with the view the person set up. Only the viewer window may do this,
// only for a model the library knows, and only with something that really is a PNG.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
ipcMain.handle('thumbs:replace', async (event, payload = {}) => {
  if (!viewerWindow || viewerWindow.isDestroyed() || event.sender !== viewerWindow.webContents) return { ok: false, error: 'Not allowed.' };
  const { sha256, png, view } = payload;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, error: 'That is not a valid file hash.' };
  if (!db.prepare('SELECT 1 FROM models WHERE sha256 = ?').get(sha256)) return { ok: false, error: 'This file is not in the library, so it has no thumbnail to replace.' };
  const bytes = Buffer.from(png instanceof Uint8Array ? png : []);
  if (view !== undefined && view !== null) {
    try { setView(db, sha256, view); } catch (e) { return { ok: false, error: e.message }; }
  }
  if (bytes.length < 100 || bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, error: 'The image was not a valid PNG.' };
  try {
    const final = queue.imagePath(sha256);
    await fs.promises.mkdir(path.dirname(final), { recursive: true });
    const temporary = final + '.tmp';
    await fs.promises.writeFile(temporary, bytes);
    await fs.promises.rename(temporary, final);   // never leaves a half-written image under the real name
    recordThumbnail(db, sha256, { status: 'ok', renderVersion: RENDER_VERSION, sizePx: bytes.readUInt32BE(16) });
    queue.skip.add(sha256);                       // in case it was waiting in the queue
    sendToLibrary('thumbs:updated', { sha256, createdAt: Date.now(), custom: !!view });
    sendToLibrary('thumbs:progress', { status: queue.getStatus(), finished: [] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Could not save the thumbnail: ' + e.message };
  }
});

// Star rating from the viewer: 0 to 5, or null for unrated.
ipcMain.handle('rating:set', (event, sha256, stars) => {
  if (!viewerWindow || viewerWindow.isDestroyed() || event.sender !== viewerWindow.webContents) return { ok: false, error: 'Not allowed.' };
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, error: 'That is not a valid file hash.' };
  if (!db.prepare('SELECT 1 FROM models WHERE sha256 = ?').get(sha256)) return { ok: false, error: 'This file is not in the library, so it cannot be rated.' };
  if (stars !== null && !(Number.isInteger(stars) && stars >= 0 && stars <= 5)) return { ok: false, error: 'A rating is a whole number from 0 to 5.' };
  try {
    setRating(db, sha256, stars);
    sendToLibrary('rating:changed', { sha256, stars });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Go back to the automatic view: forget the hand-made view and draw the thumbnail again.
ipcMain.handle('thumbs:revert', (event, sha256) => {
  if (!viewerWindow || viewerWindow.isDestroyed() || event.sender !== viewerWindow.webContents) return { ok: false, error: 'Not allowed.' };
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, error: 'That is not a valid file hash.' };
  deleteView(db, sha256);
  deleteThumbnailRow(db, sha256);                 // makes the model pending again
  queue.skip.delete(sha256);
  sendToLibrary('thumbs:updated', { sha256, createdAt: Date.now(), custom: false, keepImage: true });
  queue.start();
  return { ok: true };
});

// The hand-made view for a file (looked up by its hash), so the viewer can start from it.
function viewFor(bytes) {
  const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  return { sha256: sha, ...(getView(db, sha) || {}), custom: !!getView(db, sha), rating: getRating(db, sha) };
}

ipcMain.handle('viewer:open', async (_event, filePath) => {
  if (typeof filePath !== 'string') { openViewer(null); return { ok: true }; }
  const source = getLocationSource(db, filePath);   // undefined: not in the library; null: a loose file; object: inside a zip
  if (source === undefined) return { ok: false, error: 'That file is not in the library.' };
  try {
    const bytes = await readModelBytes({ path: filePath, ...(source || {}) });
    openViewer({ name: path.basename(filePath), bytes, view: viewFor(bytes) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: isGone(e) ? 'That file is no longer where the library found it. Rescan to update the library.' : 'Could not read the file: ' + e.message };
  }
});

/* ---------- app lifecycle ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();   // a second copy would fight over the database file
} else {
  app.on('second-instance', () => {
    if (libraryWindow) { if (libraryWindow.isMinimized()) libraryWindow.restore(); libraryWindow.focus(); }
  });

  app.whenReady().then(() => {
    const dbFile = process.env.MODEL_LIBRARY_DB || path.join(app.getPath('userData'), 'library.sqlite');
    db = openDb(dbFile);
    try { log = createLogger({ file: path.join(path.dirname(dbFile), 'logs', 'model-library.log') }); } catch { log = nullLogger; }
    log.info('app.start', { version: app.getVersion(), electron: process.versions.electron, platform: process.platform + '-' + process.arch, database: dbFile, sevenzip: binaryPath() || 'not available' });
    process.on('uncaughtExceptionMonitor', (error) => { log.error('app.exception', { message: error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error) }); log.flush(); });
    process.on('unhandledRejection', (reason) => { log.error('app.rejection', { message: reason && reason.message ? reason.message : String(reason) }); });
    setUpThumbnails(dbFile);
    createLibraryWindow();
    setTimeout(() => { if (queue) queue.start(); }, 1000);   // pick up where the last session left off
    app.on('activate', () => { if (!libraryWindow) createLibraryWindow(); });
  });

  app.on('before-quit', () => {
    if (activeDownload) activeDownload.controller.abort();
    log.info('app.quit');
    log.flush();
    if (activeScan) activeScan.controller.abort();
    if (queue) queue.cancel();
    if (renderHost) renderHost.close();
  });
  app.on('quit', () => {
    log.close();
    if (db) { db.close(); db = null; }
  });
}
