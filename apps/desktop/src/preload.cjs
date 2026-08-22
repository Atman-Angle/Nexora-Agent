const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nexora", Object.freeze({
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  startSession: (goal) => ipcRenderer.invoke("desktop:start-session", goal),
  openSession: (runId) => ipcRenderer.invoke("desktop:open-session", runId),
  control: (runId, control) => ipcRenderer.invoke("desktop:control", runId, control),
  readArtifact: (digest) => ipcRenderer.invoke("desktop:read-artifact", digest),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("desktop:snapshot", handler);
    return () => ipcRenderer.removeListener("desktop:snapshot", handler);
  },
  onError: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on("desktop:error", handler);
    return () => ipcRenderer.removeListener("desktop:error", handler);
  }
}));
