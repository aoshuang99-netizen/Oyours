// MSCMS v14 Desktop - Preload Script
// Provides secure bridge between Electron and web console

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mscmsDesktop', {
  // App info
  : process.,
  version: '3.0.0',
  isDesktop: true,

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Events from main process
  onServerStatus: (callback) => {
    ipcRenderer.on('server-status', (_, status) => callback(status));
  },

  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});

// Notify main process that renderer is ready
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('renderer-ready');
});
