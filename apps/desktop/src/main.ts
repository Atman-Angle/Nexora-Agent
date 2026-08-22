import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { RuntimeWorkerClient } from "./runtime-worker-client.js";
import type { DesktopSnapshot, ModelProfileInput, SessionControl } from "./shared.js";

const RunIdSchema = z.string().trim().min(1).max(256);
const GoalSchema = z.string().trim().min(1).max(200_000);
const PathSchema = z.string().trim().min(1).max(32_000);
const ModelProfileSchema = z.object({
  id: RunIdSchema.optional(),
  name: z.string().trim().min(1).max(128),
  baseUrl: z.string().url().max(4_000),
  apiKey: z.string().max(20_000).optional(),
  model: z.string().trim().min(1).max(256),
  contextWindowTokens: z.number().int().positive().max(10_000_000).optional(),
  decisionOutputTokens: z.number().int().positive().max(1_000_000),
  transport: z.enum(["native_tools", "structured_output"])
}).strict();
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
let exitCode = 0;
let uatRunning = false;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const initialWorkspace = resolve(process.env.NEXORA_DESKTOP_WORKSPACE?.trim() || repositoryRoot);

function runtime(): RuntimeWorkerClient {
  if (service !== null) return service;
  service = new RuntimeWorkerClient({
    workspace: initialWorkspace,
    onSnapshot: (snapshot) => window?.webContents.send("desktop:snapshot", snapshot),
    onError: (message) => window?.webContents.send("desktop:error", message),
    onPublicOutput: (event) => window?.webContents.send("desktop:public-output", event)
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
  const uatReportPath = process.env.NEXORA_DESKTOP_UAT_REPORT_PATH?.trim();
  if (uatReportPath) {
    uatRunning = true;
    window.on("close", (event) => {
      if (uatRunning) event.preventDefault();
    });
    try {
      await runDesktopUat(uatReportPath);
    } finally {
      uatRunning = false;
    }
    app.quit();
    return;
  }
  const capturePath = process.env.NEXORA_DESKTOP_CAPTURE_PATH?.trim();
  if (capturePath) {
    window.show();
    window.focus();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 800 });
    if (image.isEmpty()) throw new Error("Electron rendered an empty capture.");
    await mkdir(dirname(capturePath), { recursive: true });
    await writeFile(capturePath, image.toPNG());
    app.quit();
  }
}

async function runDesktopUat(reportPath: string): Promise<void> {
  const goal = process.env.NEXORA_DESKTOP_UAT_GOAL?.trim()
    || "Inspect docs/NEXORA_DESKTOP_WORKSPACE_SPEC.md and summarize the two-column Desktop product boundary. Do not modify files.";
  const capturePath = process.env.NEXORA_DESKTOP_UAT_CAPTURE_PATH?.trim()
    || resolve(dirname(reportPath), "desktop-uat.png");
  const timeoutMs = Number(process.env.NEXORA_DESKTOP_UAT_TIMEOUT_MS ?? 180_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("NEXORA_DESKTOP_UAT_TIMEOUT_MS must be a positive integer.");
  }

  await window!.webContents.executeJavaScript(`new Promise((resolveSubmit, rejectSubmit) => {
    const deadline = Date.now() + 10000;
    const submit = () => {
      const settingsButton = document.querySelector('[data-action="settings"]');
      if (settingsButton instanceof HTMLButtonElement) {
        settingsButton.click();
        const settingsForm = document.querySelector('[data-form="model-profile"]');
        const modelInput = settingsForm?.querySelector('input[name="model"]');
        if (!(settingsForm instanceof HTMLFormElement) || !(modelInput instanceof HTMLInputElement) || modelInput.value.length === 0) {
          rejectSubmit(new Error('Desktop model Profile Settings did not project the Workspace model.'));
          return;
        }
        document.querySelector('.settings-modal [data-action="close-settings"]')?.click();
      }
      const form = document.querySelector('[data-form="goal"]');
      const input = form?.querySelector('textarea[name="goal"]');
      if (form instanceof HTMLFormElement && input instanceof HTMLTextAreaElement) {
        input.value = ${JSON.stringify(goal)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        resolveSubmit(true);
      } else if (Date.now() >= deadline) rejectSubmit(new Error('Desktop goal Composer did not become ready.'));
      else setTimeout(submit, 100);
    };
    submit();
  })`, true);

  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  let snapshot: DesktopSnapshot | null = null;
  while (Date.now() < deadline) {
    snapshot = await runtime().snapshot();
    const status = snapshot.session?.inspection.status;
    if (status === "succeeded") break;
    if (["waiting_for_input", "waiting_for_approval", "blocked", "failed", "cancelled"].includes(status ?? "")) {
      throw new Error(`Desktop UAT stopped in ${status}.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  if (snapshot?.session?.inspection.status !== "succeeded") {
    throw new Error(`Desktop UAT did not succeed within ${timeoutMs}ms.`);
  }

  const continuation = process.env.NEXORA_DESKTOP_UAT_CONTINUATION?.trim();
  if (continuation) {
    await window!.webContents.executeJavaScript(`(() => {
      const form = document.querySelector('[data-form="follow-up"]');
      const input = form?.querySelector('textarea[name="text"]');
      if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLTextAreaElement)) throw new Error('Desktop follow-up Composer is not ready.');
      input.value = ${JSON.stringify(continuation)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`, true);
    const continuationDeadline = Date.now() + timeoutMs;
    while (Date.now() < continuationDeadline) {
      snapshot = await runtime().snapshot();
      const status = snapshot.session?.inspection.status;
      if (status === "succeeded" && snapshot.session!.runs.length >= 2) break;
      if (["waiting_for_input", "waiting_for_approval", "blocked", "failed", "cancelled"].includes(status ?? "")) {
        throw new Error(`Desktop continuation UAT stopped in ${status}.`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    if (snapshot?.session?.inspection.status !== "succeeded" || snapshot.session.runs.length < 2) {
      throw new Error(`Desktop continuation UAT did not succeed within ${timeoutMs}ms.`);
    }
  }

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const publicOutputCount = await window!.webContents.executeJavaScript(`document.querySelectorAll('.public-output .markdown-body').length`, true) as number;
  if (publicOutputCount < 1) throw new Error("Desktop UAT did not render Provider public output.");
  const image = await window!.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 800 });
  if (image.isEmpty()) throw new Error("Electron rendered an empty UAT capture.");
  await mkdir(dirname(capturePath), { recursive: true });
  await writeFile(capturePath, image.toPNG());

  const inspection = snapshot.session.inspection;
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    goal,
    workspace: snapshot.workspace.path,
    runId: inspection.runId,
    runIds: snapshot.session.runs.map((run) => run.inspection.runId),
    sessionId: snapshot.session.id,
    status: inspection.status,
    result: inspection.result,
    planSteps: inspection.plan?.orderedSteps.length ?? 0,
    invocations: inspection.invocations.map((invocation) => ({
      id: invocation.id,
      toolName: invocation.toolName,
      status: invocation.status,
      startedAt: invocation.startedAt,
      completedAt: invocation.completedAt
    })),
    evidence: inspection.evidence.map((item) => ({ id: item.id, kind: item.kind, producedAt: item.producedAt })),
    eventCount: snapshot.session.history.records.length,
    publicOutputCount,
    modelProfileCount: snapshot.workspace.modelProfiles.length,
    capturePath
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Desktop UAT passed: ${inspection.runId}`);
}

ipcMain.handle("desktop:bootstrap", async () => await runtime().snapshot());
ipcMain.handle("desktop:choose-workspace", async () => {
  const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"] });
  const path = result.filePaths[0];
  return result.canceled || path === undefined ? null : await runtime().addProject(path);
});
ipcMain.handle("desktop:add-project", async (_event, path: unknown) => await runtime().addProject(PathSchema.parse(path)));
ipcMain.handle("desktop:switch-project", async (_event, path: unknown) => (
  await runtime().setWorkspace(PathSchema.parse(path))
));
ipcMain.handle("desktop:start-session", async (_event, goal: unknown) => (
  await runtime().startSession(GoalSchema.parse(goal))
));
ipcMain.handle("desktop:continue-session", async (_event, sessionId: unknown, text: unknown) => (
  await runtime().continueSession(RunIdSchema.parse(sessionId), GoalSchema.parse(text))
));
ipcMain.handle("desktop:open-session", async (_event, projectPath: unknown, sessionId: unknown) => (
  await runtime().openSession(PathSchema.parse(projectPath), RunIdSchema.parse(sessionId))
));
ipcMain.handle("desktop:archive-session", async (_event, projectPath: unknown, sessionId: unknown, archived: unknown) => (
  await runtime().archiveSession(PathSchema.parse(projectPath), RunIdSchema.parse(sessionId), z.boolean().parse(archived))
));
ipcMain.handle("desktop:remove-session", async (_event, projectPath: unknown, sessionId: unknown) => (
  await runtime().removeSession(PathSchema.parse(projectPath), RunIdSchema.parse(sessionId))
));
ipcMain.handle("desktop:save-model-profile", async (_event, input: unknown) => (
  await runtime().saveModelProfile(ModelProfileSchema.parse(input) as ModelProfileInput)
));
ipcMain.handle("desktop:delete-model-profile", async (_event, profileId: unknown) => (
  await runtime().deleteModelProfile(RunIdSchema.parse(profileId))
));
ipcMain.handle("desktop:select-model-profile", async (_event, profileId: unknown) => (
  await runtime().selectModelProfile(RunIdSchema.parse(profileId))
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
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.NEXORA_DESKTOP_UAT_REPORT_PATH) console.error(message);
  else dialog.showErrorBox("Nexora Desktop", message);
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
  void closing.close().finally(() => app.exit(exitCode));
});
