const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("nexora", Object.freeze({
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  chooseAttachments: () => ipcRenderer.invoke("desktop:choose-attachments"),
  chooseAttachmentFolder: () => ipcRenderer.invoke("desktop:choose-attachment-folder"),
  stageDroppedAttachments: (files) => ipcRenderer.invoke("desktop:stage-attachments", Array.from(files, (file) => webUtils.getPathForFile(file))),
  addProject: (path) => ipcRenderer.invoke("desktop:add-project", path),
  removeProject: (path) => ipcRenderer.invoke("desktop:remove-project", path),
  switchProject: (path) => ipcRenderer.invoke("desktop:switch-project", path),
  startSession: (goal) => ipcRenderer.invoke("desktop:start-session", goal),
  continueSession: (sessionId, text) => ipcRenderer.invoke("desktop:continue-session", sessionId, text),
  compactSession: (sessionId) => ipcRenderer.invoke("desktop:compact-session", sessionId),
  openSession: (projectPath, sessionId) => ipcRenderer.invoke("desktop:open-session", projectPath, sessionId),
  archiveSession: (projectPath, sessionId, archived) => ipcRenderer.invoke("desktop:archive-session", projectPath, sessionId, archived),
  removeSession: (projectPath, sessionId) => ipcRenderer.invoke("desktop:remove-session", projectPath, sessionId),
  saveModelProfile: (profile) => ipcRenderer.invoke("desktop:save-model-profile", profile),
  deleteModelProfile: (profileId) => ipcRenderer.invoke("desktop:delete-model-profile", profileId),
  selectModelProfile: (profileId) => ipcRenderer.invoke("desktop:select-model-profile", profileId),
  setSelectedModelReasoning: (reasoning) => ipcRenderer.invoke("desktop:set-selected-model-reasoning", reasoning),
  control: (runId, control) => ipcRenderer.invoke("desktop:control", runId, control),
  readArtifact: (digest) => ipcRenderer.invoke("desktop:read-artifact", digest),
  readDeliverable: (projectPath, manifestPath, expectedRevision, expectedPreviewDigest) => ipcRenderer.invoke("desktop:read-deliverable", projectPath, manifestPath, expectedRevision, expectedPreviewDigest),
  openWorkspaceEntry: (projectPath, entryPath) => ipcRenderer.invoke("desktop:open-workspace-entry", projectPath, entryPath),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
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
