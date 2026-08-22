import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { RuntimeWorkerClient } from "./runtime-worker-client.js";
import type { SessionControl } from "./shared.js";

const RunIdSchema = z.string().trim().min(1).max(256);
const GoalSchema = z.string().trim().min(1).max(200_000);
const ControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), text: GoalSchema, requestId: RunIdSchema }).strict(),
  z.object({ type: z.literal("approve"), requestId: RunIdSchema }).strict(),
  z.object({ type: z.literal("deny"), requestId: RunIdSchema, reason: z.string().max(4_000).optional() }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z.object({ type: z.literal("extend_budget") }).strict(),
  z.object({
    type: z.literal("recover"),
    recovery: z.discriminatedUnion("outcome", [
      z.object({ invocationId: RunIdSchema, outcome: z.literal("confirmed_succeeded"), subjectRef: GoalSchema }).strict(),
      z.object({ invocationId: RunIdSchema, outcome: z.literal("confirmed_failed"), reason: z.string().max(4_000).optional() }).strict(),
      z.object({ invocationId: RunIdSchema, outcome: z.literal("abandon_run"), reason: z.string().max(4_000).optional() }).strict()
    ])
  }).strict()
]);

let window: BrowserWindow | null = null;
let service: RuntimeWorkerClient | null = null;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function runtime(): RuntimeWorkerClient {
  if (service !== null) return service;
  service = new RuntimeWorkerClient({
    workspace: repositoryRoot,
    onSnapshot: (snapshot) => window?.webContents.send("desktop:snapshot", snapshot),
    onError: (message) => window?.webContents.send("desktop:error", message)
  });
  return service;
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: "#f7f7f5",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: resolve(repositoryRoot, "apps", "desktop", "src", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(resolve(repositoryRoot, "apps", "desktop", "src", "renderer", "index.html"));
  const capturePath = process.env.NEXORA_DESKTOP_CAPTURE_PATH?.trim();
  if (capturePath) {
    window.show();
    window.focus();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 800 });
    if (image.isEmpty()) throw new Error("Electron rendered an empty capture.");
    await writeFile(capturePath, image.toPNG());
    app.quit();
  }
}

ipcMain.handle("desktop:bootstrap", async () => await runtime().snapshot());
ipcMain.handle("desktop:choose-workspace", async () => {
  const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"] });
  const path = result.filePaths[0];
  return result.canceled || path === undefined ? null : await runtime().setWorkspace(path);
});
ipcMain.handle("desktop:start-session", async (_event, goal: unknown) => (
  await runtime().startSession(GoalSchema.parse(goal))
));
ipcMain.handle("desktop:open-session", async (_event, runId: unknown) => (
  await runtime().openSession(RunIdSchema.parse(runId))
));
ipcMain.handle("desktop:control", async (_event, runId: unknown, input: unknown) => {
  await runtime().control(RunIdSchema.parse(runId), ControlSchema.parse(input) as SessionControl);
});
ipcMain.handle("desktop:read-artifact", async (_event, digest: unknown) => (
  await runtime().readArtifact(z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(digest))
));

app.whenReady().then(async () => {
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error: unknown) => {
  dialog.showErrorBox("Nexora Desktop", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (service === null) return;
  event.preventDefault();
  const closing = service;
  service = null;
  void closing.close().finally(() => app.exit(0));
});
