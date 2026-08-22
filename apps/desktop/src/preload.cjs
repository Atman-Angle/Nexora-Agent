const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nexora", Object.freeze({
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  switchProject: (path) => ipcRenderer.invoke("desktop:switch-project", path),
  startSession: (goal) => ipcRenderer.invoke("desktop:start-session", goal),
  continueSession: (sessionId, text) => ipcRenderer.invoke("desktop:continue-session", sessionId, text),
  openSession: (projectPath, sessionId) => ipcRenderer.invoke("desktop:open-session", projectPath, sessionId),
  archiveSession: (sessionId, archived) => ipcRenderer.invoke("desktop:archive-session", sessionId, archived),
  removeSession: (sessionId) => ipcRenderer.invoke("desktop:remove-session", sessionId),
  saveModelProfile: (profile) => ipcRenderer.invoke("desktop:save-model-profile", profile),
  deleteModelProfile: (profileId) => ipcRenderer.invoke("desktop:delete-model-profile", profileId),
  selectModelProfile: (profileId) => ipcRenderer.invoke("desktop:select-model-profile", profileId),
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
  },
  onPublicOutput: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("desktop:public-output", handler);
    return () => ipcRenderer.removeListener("desktop:public-output", handler);
  }
}));
