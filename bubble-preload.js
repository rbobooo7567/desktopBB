const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bubble", {
  onShow: (cb) => ipcRenderer.on("show-bubble", (_event, payload) => cb(payload)),
  send: (text) => ipcRenderer.send("user-text", text),
  feed: (food) => ipcRenderer.send("user-feed", food),
  close: () => ipcRenderer.send("user-close"),
});
