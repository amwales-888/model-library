'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Lets the viewer receive a file opened from the library window.
contextBridge.exposeInMainWorld('viewerHost', {
  replaceThumbnail: (sha256, png, view) => ipcRenderer.invoke('thumbs:replace', { sha256, png, view }),
  setRating: (sha256, stars) => ipcRenderer.invoke('rating:set', sha256, stars),
  revertThumbnail: (sha256) => ipcRenderer.invoke('thumbs:revert', sha256),
  onFile: (callback) => ipcRenderer.on('viewer:file', (_event, file) => callback(file)),
});
