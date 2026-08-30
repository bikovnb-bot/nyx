const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vlessvpn", {
  addProfile: (name, link) => ipcRenderer.invoke("add-profile", { name, link }),
  editProfile: (id, name, link) => ipcRenderer.invoke("edit-profile", { id, name, link }),
  removeProfile: (id) => ipcRenderer.invoke("remove-profile", id),
  connect: (id) => ipcRenderer.invoke("connect-profile", id),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  getState: () => ipcRenderer.invoke("get-state"),
  onState: (cb) => ipcRenderer.on("state", (_evt, state) => cb(state)),
  setAutostart: (enabled) => ipcRenderer.invoke("set-autostart", enabled),
  openLog: () => ipcRenderer.invoke("open-log"),
  quit: () => ipcRenderer.invoke("quit"),
  pingProfile: (id) => ipcRenderer.invoke("ping-profile", id),
  copyLink: (id) => ipcRenderer.invoke("copy-link", id),
  exportProfiles: () => ipcRenderer.invoke("export-profiles"),
  importProfiles: () => ipcRenderer.invoke("import-profiles"),
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  onTraffic: (cb) => ipcRenderer.on("traffic", (_evt, data) => cb(data)),
});
