'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only things the page can do. It cannot read files or reach Node directly.
contextBridge.exposeInMainWorld('library', {
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  scan: (root) => ipcRenderer.invoke('library:scan', root),
  removeRoot: (root, purge) => ipcRenderer.invoke('library:removeRoot', root, purge),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setScanZips: (on) => ipcRenderer.invoke('settings:setScanZips', on),
  cancelScan: () => ipcRenderer.invoke('library:cancel'),
  logRescan: (phase, info) => ipcRenderer.invoke('log:rescan', phase, info),
  openLog: () => ipcRenderer.invoke('log:open'),
  showItemMenu: (info) => ipcRenderer.invoke('menu:item', info),
  showFolderMenu: (info) => ipcRenderer.invoke('menu:folder', info),
  onMenuAction: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  selectionInfo: (selection) => ipcRenderer.invoke('selection:info', selection),
  reveal: (selection) => ipcRenderer.invoke('shell:reveal', selection),
  download: (selection) => ipcRenderer.invoke('downloads:start', selection),
  cancelDownload: () => ipcRenderer.invoke('downloads:cancel'),
  onDownloadProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('downloads:progress', handler);
    return () => ipcRenderer.removeListener('downloads:progress', handler);
  },
  revealFolder: (dir) => ipcRenderer.invoke('shell:revealFolder', dir),
  rateMany: (shas, stars) => ipcRenderer.invoke('ratings:setMany', shas, stars),
  regenerateThumbs: (shas) => ipcRenderer.invoke('thumbs:regenerate', shas),
  revertViews: (shas) => ipcRenderer.invoke('views:revertMany', shas),
  onRatingsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('ratings:changed', handler);
    return () => ipcRenderer.removeListener('ratings:changed', handler);
  },
  onThumbsUpdatedMany: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('thumbs:updated-many', handler);
    return () => ipcRenderer.removeListener('thumbs:updated-many', handler);
  },
  roots: () => ipcRenderer.invoke('library:roots'),
  stats: () => ipcRenderer.invoke('library:stats'),
  list: (query) => ipcRenderer.invoke('library:list', query),
  tree: () => ipcRenderer.invoke('library:tree'),
  openViewer: (filePath) => ipcRenderer.invoke('viewer:open', filePath),
  thumbStatus: () => ipcRenderer.invoke('thumbs:status'),
  pauseThumbs: () => ipcRenderer.invoke('thumbs:pause'),
  resumeThumbs: () => ipcRenderer.invoke('thumbs:resume'),
  retryFailedThumbs: () => ipcRenderer.invoke('thumbs:retryFailed'),
  onThumbProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('thumbs:progress', handler);
    return () => ipcRenderer.removeListener('thumbs:progress', handler);
  },
  onThumbUpdated: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('thumbs:updated', handler);
    return () => ipcRenderer.removeListener('thumbs:updated', handler);
  },
  onRatingChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('rating:changed', handler);
    return () => ipcRenderer.removeListener('rating:changed', handler);
  },
  onProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('library:progress', handler);
    return () => ipcRenderer.removeListener('library:progress', handler);
  },
});
