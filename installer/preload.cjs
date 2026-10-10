const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nyxInstaller", {
  info: () => ipcRenderer.invoke("info"),
  chooseDir: (current) => ipcRenderer.invoke("choose-dir", current),
  install: (dir) => ipcRenderer.invoke("install", dir),
  launch: () => ipcRenderer.invoke("launch"),
  minimize: () => ipcRenderer.invoke("minimize"),
  close: () => ipcRenderer.invoke("close"),
  isInstalling: () => ipcRenderer.invoke("is-installing"),
  on: (channel, cb) => {
    if (["progress", "stage", "bytes", "done", "failed"].includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
