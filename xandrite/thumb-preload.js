'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The hidden renderer page can receive jobs and send results back. Nothing else.
contextBridge.exposeInMainWorld('thumbs', {
  onJob: (callback) => ipcRenderer.on('thumb:job', (_event, job) => callback(job)),
  done: (result) => ipcRenderer.send('thumb:done', result),
  ready: () => ipcRenderer.send('thumb:ready'),
  fatal: (message) => ipcRenderer.send('thumb:fatal', message),
});
