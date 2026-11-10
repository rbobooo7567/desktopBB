const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("doro", {
  onPointer: (cb) => ipcRenderer.on("pointer", (_event, payload) => cb(payload)),
  onLedges: (cb) => ipcRenderer.on("ledges", (_event, payload) => cb(payload)),
  onAction: (cb) => ipcRenderer.on("action", (_event, payload) => cb(payload)),
  onState: (cb) => ipcRenderer.on("state", (_event, payload) => cb(payload)),
  place: (rect) => ipcRenderer.send("place", rect),
  hover: (over) => ipcRenderer.send("hover", over),
  say: (payload) => ipcRenderer.send("say", payload),
  hunger: (value) => ipcRenderer.send("hunger", value),
  save: (state) => ipcRenderer.send("save", state),
  menu: () => ipcRenderer.send("menu"),
  log: (message) => ipcRenderer.send("log", String(message)),
  preview: (dataUrl) => ipcRenderer.send("preview", dataUrl),
  snapshot: process.argv.includes("--snapshot"),
});
