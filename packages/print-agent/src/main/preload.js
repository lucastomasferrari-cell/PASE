// preload.js — puente seguro entre renderer (HTML/JS sandbox) y main process.
// contextIsolation=true asegura que el renderer no toca Node directo.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentAPI', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  openComanda: () => ipcRenderer.invoke('open-comanda'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  setLoginStartup: (enable) => ipcRenderer.invoke('set-login-startup', enable),
  installUsbDriver: () => ipcRenderer.invoke('install-usb-driver'),
  onPrintServerStatus: (cb) => {
    ipcRenderer.on('print-server-status', (_e, payload) => cb(payload));
  },
});
