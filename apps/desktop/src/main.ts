import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { RuntimeWorkerClient } from "./runtime-worker-client.js";
import type { AttachmentView, DesktopMessageInput, DesktopSnapshot, ModelProfileInput, SessionControl } from "./shared.js";
import { resolveExternalUrl, resolveKnownWorkspaceEntry } from "./workspace-entry.js";

const RunIdSchema = z.string().trim().min(1).max(256);
const GoalSchema = z.string().trim().min(1).max(200_000);
const PathSchema = z.string().trim().min(1).max(32_000);
const AttachmentSchema = z.object({
  id: z.string().regex(/^attachment:[a-f0-9]{64}$/u),
  name: z.string().trim().min(1).max(512),
  workspacePath: z.string().trim().min(1).max(1_024),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  byteLength: z.number().int().positive().max(50_000_000),
  mediaType: z.string().trim().min(1).max(256),
  kind: z.enum(["office", "image", "pdf"]),
  source: z.object({
    kind: z.literal("folder"),
    id: z.string().regex(/^folder:[a-f0-9]{64}$/u),
    name: z.string().trim().min(1).max(512),
    fileCount: z.number().int().positive().max(8),
    totalBytes: z.number().int().positive().max(100_000_000)
  }).strict().optional()
}).strict();
const MessageSchema = z.object({ text: GoalSchema, attachments: z.array(AttachmentSchema).max(8) }).strict();
const ModelProfileSchema = z.object({
  id: RunIdSchema.optional(),
  name: z.string().trim().min(1).max(128),
  baseUrl: z.string().url().max(4_000),
  apiKey: z.string().max(20_000).optional(),
  model: z.string().trim().min(1).max(256),
  contextWindowTokens: z.number().int().positive().max(10_000_000).optional(),
  activeInputTargetTokens: z.number().int().positive().max(10_000_000).nullable().optional(),
  decisionOutputTokens: z.number().int().positive().max(1_000_000),
  transport: z.enum(["native_tools", "structured_output"]),
  reasoning: z.enum(["off", "dynamic", "on"]).optional(),
  thinkingToggleParam: z.string().trim().min(1).max(128).nullable().optional()
}).strict();
const ControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), text: GoalSchema, requestId: RunIdSchema }).strict(),
  z.object({ type: z.literal("approve"), requestId: RunIdSchema }).strict(),
  z.object({ type: z.literal("deny"), requestId: RunIdSchema, reason: z.string().max(4_000).optional() }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z.object({
    type: z.literal("extend_budget"),
    budgetExtension: z.object({
      iterations: z.number().int().positive().optional(),
      modelCalls: z.number().int().positive().optional(),
      toolCalls: z.number().int().positive().optional(),
      retries: z.number().int().positive().optional()
    }).strict().refine((extension) => Object.values(extension).some((value) => value !== undefined), {
      message: "A Budget Extension must add at least one quota."
    })
  }).strict(),
  z.object({ type: z.literal("worker_resume"), branchId: z.string().min(1), childRunId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("worker_discard"), branchId: z.string().min(1) }).strict(),
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
  const scrollUatReportPath = process.env.NEXORA_DESKTOP_SCROLL_UAT_REPORT_PATH?.trim();
  if (scrollUatReportPath) {
    await runSidebarScrollUat(scrollUatReportPath);
    app.quit();
    return;
  }
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
    const captureWidth = Math.max(820, Number(process.env.NEXORA_DESKTOP_CAPTURE_WIDTH ?? 1180));
    const captureHeight = Math.max(600, Number(process.env.NEXORA_DESKTOP_CAPTURE_HEIGHT ?? 800));
    window.setSize(captureWidth, captureHeight);
    window.show();
    window.focus();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: captureWidth, height: captureHeight });
    if (image.isEmpty()) throw new Error("Electron rendered an empty capture.");
    await mkdir(dirname(capturePath), { recursive: true });
    await writeFile(capturePath, image.toPNG());
    app.quit();
  }
}

async function runSidebarScrollUat(reportPath: string): Promise<void> {
  const capturePath = process.env.NEXORA_DESKTOP_SCROLL_UAT_CAPTURE_PATH?.trim()
    || resolve(dirname(reportPath), "desktop-sidebar-scroll-uat.png");
  const measurements = await window!.webContents.executeJavaScript(`new Promise((resolveScroll, rejectScroll) => {
    const deadline = Date.now() + 15000;
    const inspect = async () => {
      const list = document.querySelector('.session-list');
      const session = document.querySelector('[data-session]');
      if (!(list instanceof HTMLElement) || !(session instanceof HTMLButtonElement)) {
        if (Date.now() >= deadline) return rejectScroll(new Error('Sidebar navigation did not become ready.'));
        return setTimeout(inspect, 100);
      }
      session.click();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      const activeList = document.querySelector('.session-list');
      if (!(activeList instanceof HTMLElement) || activeList.scrollHeight <= activeList.clientHeight) {
        return rejectScroll(new Error('Sidebar does not contain enough real rows for scroll QA.'));
      }
      const maximum = activeList.scrollHeight - activeList.clientHeight;
      activeList.scrollTop = Math.max(1, Math.round(maximum * .72));
      activeList.dispatchEvent(new Event('scroll'));
      const before = activeList.scrollTop;
      const read = () => document.querySelector('.session-list') instanceof HTMLElement
        ? document.querySelector('.session-list').scrollTop
        : -1;
      const pause = () => new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      document.querySelector('[data-form="follow-up"] textarea')?.focus();
      await pause();
      const afterComposer = read();
      const sessions = [...document.querySelectorAll('[data-session]')];
      const alternateSession = sessions.find((candidate) => candidate !== session) ?? session;
      alternateSession.click();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      const afterSession = read();
      const projectToggles = [...document.querySelectorAll('[data-project-toggle]')];
      const projectToggle = projectToggles.find((candidate) => candidate.getAttribute('title') === '收起工作区')
        ?? projectToggles.at(-1);
      if (projectToggle instanceof HTMLButtonElement) {
        const projectPath = projectToggle.dataset.projectToggle ?? '';
        projectToggle.click();
        await pause();
        const matchingToggle = [...document.querySelectorAll('[data-project-toggle]')]
          .find((candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.projectToggle === projectPath);
        if (matchingToggle instanceof HTMLButtonElement) matchingToggle.click();
        await pause();
      }
      const afterWorkspaceToggle = read();
      document.querySelector('[data-project-menu]')?.click();
      await pause();
      const afterWorkspaceMenu = read();
      document.querySelector('[data-action="settings"]')?.click();
      await pause();
      const afterSettingsOpen = read();
      document.querySelector('[data-action="close-settings"]')?.click();
      await pause();
      const afterSettingsClose = read();
      const bottomList = document.querySelector('.session-list');
      if (!(bottomList instanceof HTMLElement)) return rejectScroll(new Error('Sidebar disappeared before bottom-position QA.'));
      bottomList.scrollTop = bottomList.scrollHeight - bottomList.clientHeight;
      bottomList.dispatchEvent(new Event('scroll'));
      const bottomBefore = read();
      const workspaceMenus = [...document.querySelectorAll('[data-project-menu]')];
      const bottomWorkspaceMenu = workspaceMenus.at(-1);
      if (bottomWorkspaceMenu instanceof HTMLButtonElement) bottomWorkspaceMenu.click();
      await pause();
      const afterBottomWorkspaceMenu = read();
      resolveScroll({
        maximum,
        before,
        afterComposer,
        afterSession,
        afterWorkspaceToggle,
        afterWorkspaceMenu,
        afterSettingsOpen,
        afterSettingsClose,
        bottomBefore,
        afterBottomWorkspaceMenu
      });
    };
    inspect();
  })`, true) as Record<string, number>;
  const conversationMeasurements = await window!.webContents.executeJavaScript(`new Promise((resolveScroll, rejectScroll) => {
    const pause = (ms = 180) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
    const deadline = Date.now() + 15000;
    const inspect = async () => {
      const sessions = [...document.querySelectorAll('[data-session]')];
      if (sessions.length === 0) {
        if (Date.now() >= deadline) return rejectScroll(new Error('No real Sessions are available for Conversation scroll QA.'));
        setTimeout(inspect, 100);
        return;
      }
      let selected = null;
      let content = null;
      for (const candidate of sessions) {
        if (!(candidate instanceof HTMLButtonElement)) continue;
        candidate.click();
        await pause(350);
        const next = document.querySelector('.content-scroll');
        if (next instanceof HTMLElement && next.scrollHeight > next.clientHeight + 120) {
          selected = candidate;
          content = next;
          break;
        }
      }
      if (!(selected instanceof HTMLButtonElement) || !(content instanceof HTMLElement)) {
        return rejectScroll(new Error('No long real Conversation is available for scroll QA.'));
      }
      const selectedSessionId = selected.dataset.session ?? '';
      content.scrollTop = Math.round((content.scrollHeight - content.clientHeight) * .46);
      content.dispatchEvent(new Event('scroll'));
      const before = content.scrollTop;
      const originalNode = content;
      const read = () => {
        const node = document.querySelector('.content-scroll');
        return node instanceof HTMLElement ? node.scrollTop : -1;
      };
      document.querySelector('[data-project-menu]')?.click();
      await pause();
      const afterMenuOpen = read();
      document.querySelector('[data-project-menu]')?.click();
      await pause();
      const afterMenuClose = read();
      document.querySelector('[data-form="follow-up"] textarea, [data-form="input"] textarea')?.focus();
      await pause();
      const afterComposerFocus = read();
      document.querySelector('[data-action="settings"]')?.click();
      await pause();
      const afterSettingsOpen = read();
      document.querySelector('[data-action="close-settings"]')?.click();
      await pause();
      const afterSettingsClose = read();
      const alternate = sessions.find((candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.session !== selectedSessionId);
      if (alternate instanceof HTMLButtonElement) {
        alternate.click();
        await pause(350);
        const selectedAgain = [...document.querySelectorAll('[data-session]')].find((candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.session === selectedSessionId);
        if (selectedAgain instanceof HTMLButtonElement) selectedAgain.click();
        await pause(350);
      }
      const afterSessionReturn = read();
      const current = document.querySelector('.content-scroll');
      if (!(current instanceof HTMLElement)) return rejectScroll(new Error('Conversation disappeared during scroll QA.'));
      current.scrollTop = current.scrollHeight;
      current.dispatchEvent(new Event('scroll'));
      const bottomBefore = current.scrollTop;
      document.querySelector('[data-project-menu]')?.click();
      await pause();
      const bottomAfter = read();
      resolveScroll({
        before,
        afterMenuOpen,
        afterMenuClose,
        afterComposerFocus,
        afterSettingsOpen,
        afterSettingsClose,
        afterSessionReturn,
        bottomBefore,
        bottomAfter,
        sameNodeAfterRerender: document.querySelector('.content-scroll') === originalNode ? 1 : 0
      });
    };
    inspect();
  })`, true) as Record<string, number>;
  const middleValues = [
    measurements.afterComposer,
    measurements.afterSession,
    measurements.afterWorkspaceToggle,
    measurements.afterWorkspaceMenu,
    measurements.afterSettingsOpen,
    measurements.afterSettingsClose
  ];
  const middleStable = middleValues.every((value) => value !== undefined && Math.abs(value - measurements.before!) <= 1);
  const bottomStable = measurements.bottomBefore !== undefined
    && measurements.afterBottomWorkspaceMenu !== undefined
    && Math.abs(measurements.afterBottomWorkspaceMenu - measurements.bottomBefore) <= 1;
  const conversationMiddleValues = [
    conversationMeasurements.afterMenuOpen,
    conversationMeasurements.afterMenuClose,
    conversationMeasurements.afterComposerFocus,
    conversationMeasurements.afterSettingsOpen,
    conversationMeasurements.afterSettingsClose,
    conversationMeasurements.afterSessionReturn
  ];
  const conversationMiddleStable = conversationMiddleValues.every((value) => value !== undefined && Math.abs(value - conversationMeasurements.before!) <= 1);
  const conversationBottomStable = Math.abs(conversationMeasurements.bottomAfter! - conversationMeasurements.bottomBefore!) <= 1;
  const stable = middleStable && bottomStable && conversationMiddleStable && conversationBottomStable && conversationMeasurements.sameNodeAfterRerender === 1;
  window!.show();
  window!.focus();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const image = await window!.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 800 });
  if (image.isEmpty()) throw new Error("Electron rendered an empty Sidebar scroll capture.");
  await mkdir(dirname(capturePath), { recursive: true });
  await writeFile(capturePath, image.toPNG());
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ stable, measurements, conversationMeasurements, capturePath }, null, 2)}\n`, "utf8");
  if (!stable) throw new Error(`Desktop scroll changed across rerenders: ${JSON.stringify({ measurements, conversationMeasurements })}.`);
}

async function runDesktopUat(reportPath: string): Promise<void> {
  const goal = process.env.NEXORA_DESKTOP_UAT_GOAL?.trim()
    || "Inspect docs/NEXORA_DESKTOP_WORKSPACE_SPEC.md and summarize the two-column Desktop product boundary. Do not modify files.";
  const capturePath = process.env.NEXORA_DESKTOP_UAT_CAPTURE_PATH?.trim()
    || resolve(dirname(reportPath), "desktop-uat.png");
  const captureWidth = Math.max(820, Number(process.env.NEXORA_DESKTOP_CAPTURE_WIDTH ?? 1180));
  const captureHeight = Math.max(600, Number(process.env.NEXORA_DESKTOP_CAPTURE_HEIGHT ?? 800));
  window!.setSize(captureWidth, captureHeight);
  const timeoutMs = Number(process.env.NEXORA_DESKTOP_UAT_TIMEOUT_MS ?? 180_000);
  const autoApprove = process.env.NEXORA_DESKTOP_UAT_AUTO_APPROVE === "true";
  const expectDeliverable = process.env.NEXORA_DESKTOP_UAT_EXPECT_DELIVERABLE === "true";
  const expectedFileChanges = Number(process.env.NEXORA_DESKTOP_UAT_EXPECT_FILE_CHANGES ?? 0);
  const expectCodeCopy = process.env.NEXORA_DESKTOP_UAT_EXPECT_CODE_COPY === "true";
  const expectReasoningStream = process.env.NEXORA_DESKTOP_UAT_EXPECT_REASONING_STREAM === "true";
  const recoverBoundary = process.env.NEXORA_DESKTOP_UAT_RECOVER_BOUNDARY === "true"
    || process.env.NEXORA_DESKTOP_UAT_RECOVER_BLOCKED === "true";
  const recoveryInput = process.env.NEXORA_DESKTOP_UAT_RECOVERY_INPUT?.trim()
    || "Use a materially different strategy to locate and read the requested target.";
  const existingSessionId = process.env.NEXORA_DESKTOP_UAT_SESSION_ID?.trim() || null;
  const approvedRequestIds = new Set<string>();
  let recoveredBoundaryRunId: string | null = null;
  let recoveredBoundaryStatus: "blocked" | "failed" | null = null;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("NEXORA_DESKTOP_UAT_TIMEOUT_MS must be a positive integer.");
  }

  const startedAt = new Date().toISOString();
  if (existingSessionId === null) {
    await window!.webContents.executeJavaScript(`new Promise((resolveSettings, rejectSettings) => {
      const deadline = Date.now() + 10000;
      const inspect = () => {
        const settingsButton = document.querySelector('[data-action="settings"]');
        if (settingsButton instanceof HTMLButtonElement) {
          settingsButton.click();
          const modal = document.querySelector('.settings-modal');
          const footer = document.querySelector('.settings-footer');
          const save = document.querySelector('[data-action="save-settings"]');
          const context = document.querySelector('input[name="contextWindow"]');
          const decision = document.querySelector('input[name="decisionOutput"]');
          const advanced = document.querySelector('.advanced-settings');
          if (!(modal instanceof HTMLElement) || !(footer instanceof HTMLElement) || !(save instanceof HTMLButtonElement)
            || !(context instanceof HTMLInputElement) || !(decision instanceof HTMLInputElement) || !(advanced instanceof HTMLDetailsElement)) {
            rejectSettings(new Error('Desktop model Settings default state did not render.'));
            return;
          }
          const footerRect = footer.getBoundingClientRect();
          if (!save.disabled || footerRect.bottom > window.innerHeight || getComputedStyle(document.body).overflow !== 'hidden'
            || (context.value.length > 0 && !/[KM]$/u.test(context.value)) || !/[KM]$/u.test(decision.value) || advanced.open) {
            rejectSettings(new Error('Desktop model Settings default shell or compact fields were invalid.'));
            return;
          }
          resolveSettings(true);
        } else if (Date.now() >= deadline) rejectSettings(new Error('Desktop model Settings button did not become ready.'));
        else setTimeout(inspect, 100);
      };
      inspect();
    })`, true);
    window!.show();
    window!.focus();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const settingsImage = await window!.webContents.capturePage();
    if (settingsImage.isEmpty()) throw new Error("Electron rendered an empty Model Settings capture.");
    const settingsCapturePath = capturePath.replace(/(\.[^.]+)$/u, "-model-settings$1");
    await mkdir(dirname(settingsCapturePath), { recursive: true });
    await writeFile(settingsCapturePath, settingsImage.toPNG());
    await window!.webContents.executeJavaScript(`document.querySelector('.settings-modal [data-action="close-settings"]')?.click()`, true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    window!.show();
    window!.focus();
    const emptyImage = await window!.webContents.capturePage({ x: 0, y: 0, width: captureWidth, height: captureHeight });
    if (emptyImage.isEmpty()) throw new Error("Electron rendered an empty new-task capture.");
    const emptyCapturePath = capturePath.replace(/(\.[^.]+)$/u, "-empty$1");
    await mkdir(dirname(emptyCapturePath), { recursive: true });
    await writeFile(emptyCapturePath, emptyImage.toPNG());
    await window!.webContents.executeJavaScript(`new Promise((resolveSubmit, rejectSubmit) => {
      const deadline = Date.now() + 10000;
      const submit = () => {
        const settingsButton = document.querySelector('[data-action="settings"]');
        if (settingsButton instanceof HTMLButtonElement) {
          settingsButton.click();
          const settingsForm = document.querySelector('[data-form="model-profile"]');
          const modelInput = settingsForm?.querySelector('input[name="model"]');
          const settingsFooter = document.querySelector('.settings-footer');
          const saveButton = document.querySelector('[data-action="save-settings"]');
          const footerRect = settingsFooter?.getBoundingClientRect();
          if (!(settingsForm instanceof HTMLFormElement) || !(modelInput instanceof HTMLInputElement) || modelInput.value.length === 0) {
            rejectSubmit(new Error('Desktop model Profile Settings did not project the Workspace model.'));
            return;
          }
          if (!(saveButton instanceof HTMLButtonElement) || !saveButton.disabled || footerRect === undefined || footerRect.bottom > window.innerHeight || getComputedStyle(document.body).overflow !== 'hidden') {
            rejectSubmit(new Error('Desktop model Settings shell did not keep a clean disabled Save action and visible sticky footer.'));
            return;
          }
          const nameInput = settingsForm.querySelector('input[name="name"]');
          if (!(nameInput instanceof HTMLInputElement)) {
            rejectSubmit(new Error('Desktop model Settings did not expose the editable model name.'));
            return;
          }
          nameInput.value = nameInput.value + " UAT";
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          const contextInput = settingsForm.querySelector('input[name="contextWindow"]');
          if (!(contextInput instanceof HTMLInputElement)) {
            rejectSubmit(new Error('Desktop model Settings did not expose the context window field.'));
            return;
          }
          if (contextInput.value.length === 0) {
            contextInput.value = '128K';
            contextInput.dispatchEvent(new Event('input', { bubbles: true }));
            contextInput.dispatchEvent(new Event('blur', { bubbles: true }));
          }
          const dirtySaveButton = document.querySelector('[data-action="save-settings"]');
          if (!(dirtySaveButton instanceof HTMLButtonElement) || dirtySaveButton.disabled) {
            rejectSubmit(new Error('Desktop model Settings did not enable Save for a dirty draft.'));
            return;
          }
          const originalConfirm = window.confirm;
          let confirmationCount = 0;
          window.confirm = () => { confirmationCount += 1; return false; };
          document.querySelector('.settings-modal [data-action="close-settings"]')?.click();
          if (document.querySelector('.settings-modal') === null || confirmationCount !== 1) {
            window.confirm = originalConfirm;
            rejectSubmit(new Error('Desktop model Settings did not retain a dirty draft when discard was rejected.'));
            return;
          }
          window.confirm = () => { confirmationCount += 1; return true; };
          document.querySelector('.settings-modal [data-action="close-settings"]')?.click();
          window.confirm = originalConfirm;
          if (document.querySelector('.settings-modal') !== null || confirmationCount !== 2 || document.body.classList.contains('settings-open')) {
            rejectSubmit(new Error('Desktop model Settings did not close after discard confirmation.'));
            return;
          }
        }
        const form = document.querySelector('[data-form="goal"]');
        const input = form?.querySelector('textarea[name="goal"]');
        if (form instanceof HTMLFormElement && input instanceof HTMLTextAreaElement) {
          window.__nexoraTranscriptProbe = { reasoningTexts: [], maxReasoningRows: 0 };
          window.__nexoraTranscriptObserver?.disconnect();
          window.__nexoraTranscriptObserver = new MutationObserver(() => {
            const probe = window.__nexoraTranscriptProbe;
            const rows = document.querySelectorAll('.reasoning-entry');
            probe.maxReasoningRows = Math.max(probe.maxReasoningRows, rows.length);
            const text = document.querySelector('.reasoning-entry.streaming .think-preview')?.textContent?.trim();
            if (text && probe.reasoningTexts.at(-1) !== text) probe.reasoningTexts.push(text);
          });
          window.__nexoraTranscriptObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
          input.value = ${JSON.stringify(goal)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          resolveSubmit(true);
        } else if (Date.now() >= deadline) rejectSubmit(new Error('Desktop goal Composer did not become ready.'));
        else setTimeout(submit, 100);
      };
      submit();
    })`, true);
  } else {
    await runtime().continueSession(existingSessionId, goal);
  }

  const deadline = Date.now() + timeoutMs;
  let snapshot: DesktopSnapshot | null = null;
  while (Date.now() < deadline) {
    snapshot = await runtime().snapshot();
    const status = snapshot.session?.inspection.status;
    if (status === "succeeded") break;
    if (autoApprove && approvePendingUatRequest(snapshot, approvedRequestIds)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      continue;
    }
    if ((status === "blocked" || status === "failed") && recoverBoundary && recoveredBoundaryRunId === null) {
      recoveredBoundaryRunId = snapshot.session!.inspection.runId;
      recoveredBoundaryStatus = status;
      await window!.webContents.executeJavaScript(`new Promise((resolveSubmit, rejectSubmit) => {
        const deadline = Date.now() + 10000;
        const submit = () => {
          const form = document.querySelector('[data-form="follow-up"]');
          const input = form?.querySelector('textarea[name="text"]');
          if (form instanceof HTMLFormElement && input instanceof HTMLTextAreaElement) {
            input.value = ${JSON.stringify(recoveryInput)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            form.requestSubmit();
            resolveSubmit(true);
          } else if (Date.now() >= deadline) rejectSubmit(new Error('Desktop recovery Composer did not become ready.'));
          else setTimeout(submit, 100);
        };
        submit();
      })`, true);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      continue;
    }
    if (["waiting_for_input", "waiting_for_approval", "blocked", "failed", "cancelled"].includes(status ?? "")) {
      throw new Error(`Desktop UAT stopped in ${status}.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  if (snapshot?.session?.inspection.status !== "succeeded") {
    throw new Error(`Desktop UAT did not succeed within ${timeoutMs}ms.`);
  }
  if (recoverBoundary && (recoveredBoundaryRunId === null || snapshot.session.runs.length < 2)) {
    throw new Error("Desktop recovery UAT did not continue the stopped Run through a new product turn.");
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
      if (autoApprove && approvePendingUatRequest(snapshot, approvedRequestIds)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        continue;
      }
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
  if (expectDeliverable) {
    const deliverable = snapshot.session.deliverables[0];
    if (snapshot.session.deliverables.length !== 1 || deliverable?.revision !== 2) {
      throw new Error("Desktop document UAT did not project exactly one revision 2 Deliverable.");
    }
    await window!.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-view="conversation"]')?.click();
      const content = document.querySelector('.content-scroll');
      if (content instanceof HTMLElement) content.scrollTop = content.scrollHeight;
      return true;
    })()`, true);
    window!.show();
    window!.focus();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const conversationImage = await window!.webContents.capturePage({ x: 0, y: 0, width: captureWidth, height: captureHeight });
    if (conversationImage.isEmpty()) throw new Error("Electron rendered an empty document Conversation capture.");
    const conversationCapturePath = capturePath.replace(/(\.[^.]+)$/u, "-conversation$1");
    await mkdir(dirname(conversationCapturePath), { recursive: true });
    await writeFile(conversationCapturePath, conversationImage.toPNG());
    await window!.webContents.executeJavaScript(`new Promise((resolveOutput, rejectOutput) => {
      document.querySelector('[data-view="output"]')?.click();
      const deadline = Date.now() + 10000;
      const inspect = () => {
        const frame = document.querySelector('[data-deliverable-preview]');
        const officeFiles = ['docx', 'xlsx', 'pptx', 'pdf'].map((extension) => document.querySelector('[data-workspace-entry$=".' + extension + '"]'));
        if (frame instanceof HTMLIFrameElement && frame.contentDocument?.querySelector('[data-revision="2"]') && officeFiles.every((item) => item instanceof HTMLButtonElement)) resolveOutput(true);
        else if (Date.now() >= deadline) rejectOutput(new Error('Desktop Output revision 2 preview did not render.'));
        else setTimeout(inspect, 100);
      };
      inspect();
    })`, true);
  }
  const transcriptEvidence = await window!.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-view="conversation"]')?.click();
    const reasoning = document.querySelector('.reasoning-entry .execution-row');
    const chevron = document.querySelector('.reasoning-entry .execution-chevron');
    const collapsedChevronOpacity = chevron instanceof HTMLElement ? getComputedStyle(chevron).opacity : null;
    if (reasoning instanceof HTMLButtonElement) reasoning.click();
    const reasoningExpanded = document.querySelector('.reasoning-entry .reasoning-detail-body') instanceof HTMLElement;
    const tool = document.querySelector('.tool-entry .execution-row');
    if (tool instanceof HTMLButtonElement) tool.click();
    const toolExpanded = document.querySelector('.tool-entry .execution-detail') instanceof HTMLElement;
    document.querySelector('.reasoning-entry .execution-row[aria-expanded="true"]')?.click();
    document.querySelector('.tool-entry .execution-row[aria-expanded="true"]')?.click();
    const probe = window.__nexoraTranscriptProbe ?? { reasoningTexts: [], maxReasoningRows: 0 };
    window.__nexoraTranscriptObserver?.disconnect();
    return {
      reasoningRows: document.querySelectorAll('.reasoning-entry').length,
      toolRows: document.querySelectorAll('.tool-entry').length,
      reasoningExpanded,
      toolExpanded,
      collapsedChevronOpacity,
      reasoningTexts: probe.reasoningTexts,
      maxReasoningRows: probe.maxReasoningRows,
      oldUiCount: document.querySelectorAll('.live-model-feedback, .activity-timeline, .activity-group, [data-view="activity"]').length
    };
  })()`, true) as { reasoningRows: number; toolRows: number; reasoningExpanded: boolean; toolExpanded: boolean; collapsedChevronOpacity: string | null; reasoningTexts: string[]; maxReasoningRows: number; oldUiCount: number };
  if (transcriptEvidence.toolRows < 1
    || !transcriptEvidence.toolExpanded
    || transcriptEvidence.oldUiCount !== 0
    || (expectReasoningStream && (transcriptEvidence.reasoningRows < 1
      || !transcriptEvidence.reasoningExpanded
      || transcriptEvidence.collapsedChevronOpacity !== "0"
      || transcriptEvidence.reasoningTexts.length < 2))) {
    throw new Error(`Desktop inline transcript did not satisfy the Spec: ${JSON.stringify(transcriptEvidence)}`);
  }
  const publicOutputCount = await window!.webContents.executeJavaScript(`document.querySelectorAll('.reasoning-entry, .public-content .markdown-body, .result .markdown-body').length`, true) as number;
  if (!expectDeliverable && publicOutputCount < 1) throw new Error("Desktop UAT did not render Provider public output.");
  if (expectedFileChanges > 0) {
    const fileChangesReady = await window!.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-view="conversation"]')?.click();
      const content = document.querySelector('.content-scroll');
      if (content instanceof HTMLElement) content.scrollTop = content.scrollHeight;
      const rows = [...document.querySelectorAll('.tool-entry .execution-row')];
      const changes = rows.filter((row) => row.querySelector('.execution-action')?.textContent === '修改文件');
      return changes.length === ${expectedFileChanges} && (changes[0]?.querySelector('.execution-target')?.textContent ?? '').includes('src/features/portfolio/components');
    })()`, true) as boolean;
    if (!fileChangesReady) throw new Error("Desktop file-change UAT did not render the authoritative long-path file summary.");
  }
  if (expectCodeCopy) {
    const copied = await window!.webContents.executeJavaScript(`new Promise((resolveCopy) => {
      const button = document.querySelector('.copy-code');
      if (!(button instanceof HTMLButtonElement)) { resolveCopy(false); return; }
      button.click();
      setTimeout(() => resolveCopy(button.textContent === '已复制'), 100);
    })`, true) as boolean;
    if (!copied) throw new Error("Desktop UAT code copy feedback did not become visible.");
  }
  window!.show();
  window!.focus();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const image = await window!.webContents.capturePage({ x: 0, y: 0, width: captureWidth, height: captureHeight });
  if (image.isEmpty()) throw new Error("Electron rendered an empty UAT capture.");
  await mkdir(dirname(capturePath), { recursive: true });
  await writeFile(capturePath, image.toPNG());

  const inspection = snapshot.session.inspection;
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    goal,
    continuedExistingSession: existingSessionId !== null,
    recoveredBoundaryRunId,
    recoveredBoundaryStatus,
    recoveredBlockedRunId: recoveredBoundaryStatus === "blocked" ? recoveredBoundaryRunId : null,
    workspace: snapshot.workspace.path,
    runId: inspection.runId,
    runIds: snapshot.session.runs.map((run) => run.inspection.runId),
    runs: snapshot.session.runs.map((run) => ({
      runId: run.inspection.runId,
      userInput: run.userInput,
      status: run.inspection.status,
      stopReason: run.inspection.stopReason,
      modelCalls: run.inspection.executionMetrics.modelCalls,
      invocations: run.inspection.invocations.map((invocation) => ({
        toolName: invocation.toolName,
        status: invocation.status
      })),
      evidence: run.inspection.evidence.length
    })),
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
    deliverables: snapshot.session.deliverables,
    eventCount: snapshot.session.history.records.length,
    publicOutputCount,
    transcriptEvidence,
    modelProfileCount: snapshot.workspace.modelProfiles.length,
    capturePath
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Desktop UAT passed: ${inspection.runId}`);
}

function approvePendingUatRequest(snapshot: DesktopSnapshot, approvedRequestIds: Set<string>): boolean {
  const inspection = snapshot.session?.inspection;
  const request = inspection?.pendingRequest;
  if (inspection === undefined || request?.kind !== "approval" || approvedRequestIds.has(request.id)) return false;
  approvedRequestIds.add(request.id);
  runtime().control(inspection.runId, { type: "approve", requestId: request.id });
  return true;
}

ipcMain.handle("desktop:bootstrap", async () => await runtime().snapshot());
ipcMain.handle("desktop:choose-workspace", async () => {
  const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"] });
  const path = result.filePaths[0];
  return result.canceled || path === undefined ? null : await runtime().addProject(path);
});
ipcMain.handle("desktop:choose-attachments", async () => {
  const result = await dialog.showOpenDialog(window!, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Documents and images", extensions: ["docx", "xlsx", "pptx", "pdf", "png", "jpg", "jpeg"] }]
  });
  return result.canceled ? [] : await runtime().stageAttachments(result.filePaths.map((path) => PathSchema.parse(path)));
});
ipcMain.handle("desktop:choose-attachment-folder", async () => {
  const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"] });
  return result.canceled ? [] : await runtime().stageAttachments(result.filePaths.map((path) => PathSchema.parse(path)));
});
ipcMain.handle("desktop:stage-attachments", async (_event, paths: unknown) => (
  await runtime().stageAttachments(z.array(PathSchema).min(1).max(8).parse(paths))
));
ipcMain.handle("desktop:add-project", async (_event, path: unknown) => await runtime().addProject(PathSchema.parse(path)));
ipcMain.handle("desktop:remove-project", async (_event, path: unknown) => await runtime().removeProject(PathSchema.parse(path)));
ipcMain.handle("desktop:switch-project", async (_event, path: unknown) => (
  await runtime().setWorkspace(PathSchema.parse(path))
));
ipcMain.handle("desktop:start-session", async (_event, goal: unknown) => (
  await runtime().startSession(MessageSchema.parse(goal) as DesktopMessageInput)
));
ipcMain.handle("desktop:continue-session", async (_event, sessionId: unknown, text: unknown) => (
  await runtime().continueSession(RunIdSchema.parse(sessionId), MessageSchema.parse(text) as DesktopMessageInput)
));
ipcMain.handle("desktop:compact-session", async (_event, sessionId: unknown) => (
  await runtime().compactSession(RunIdSchema.parse(sessionId))
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
ipcMain.handle("desktop:set-selected-model-reasoning", async (_event, reasoning: unknown) => (
  await runtime().setSelectedModelReasoning(z.enum(["off", "dynamic", "on"]).parse(reasoning))
));
ipcMain.handle("desktop:control", async (_event, runId: unknown, input: unknown) => {
  await runtime().control(RunIdSchema.parse(runId), ControlSchema.parse(input) as SessionControl);
});
ipcMain.handle("desktop:read-artifact", async (_event, digest: unknown) => (
  await runtime().readArtifact(z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(digest))
));
ipcMain.handle("desktop:read-deliverable", async (
  _event,
  projectPath: unknown,
  manifestPath: unknown,
  expectedRevision: unknown,
  expectedPreviewDigest: unknown
) => await runtime().readDeliverable(
  PathSchema.parse(projectPath),
  PathSchema.parse(manifestPath),
  z.number().int().positive().parse(expectedRevision),
  z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(expectedPreviewDigest)
));
ipcMain.handle("desktop:open-workspace-entry", async (_event, projectPath: unknown, entryPath: unknown) => {
  const snapshot = await runtime().snapshot();
  const target = resolveKnownWorkspaceEntry(
    snapshot.workspace.projects,
    PathSchema.parse(projectPath),
    PathSchema.parse(entryPath)
  );
  const openError = await shell.openPath(target);
  if (openError) throw new Error(openError);
});
ipcMain.handle("desktop:open-external", async (_event, input: unknown) => {
  const url = resolveExternalUrl(z.string().trim().min(1).max(8_000).parse(input));
  await shell.openExternal(url);
});

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
