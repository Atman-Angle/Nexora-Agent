import type {
  DesktopBridge,
  DesktopSnapshot,
  SessionControl,
  SessionView
} from "../shared.js";

declare global {
  interface Window { nexora: DesktopBridge }
}

const root = document.querySelector<HTMLElement>("#app")!;
let snapshot: DesktopSnapshot | null = null;
let mode: "conversation" | "activity" = "conversation";
let planOpen = false;
let settingsOpen = false;
let busy = false;
let error: string | null = null;
const expandedTools = new Set<string>();

window.nexora.onSnapshot((next) => {
  snapshot = next;
  busy = false;
  render();
});
window.nexora.onError((message) => {
  busy = false;
  error = message;
  render();
});

void window.nexora.bootstrap()
  .then((next) => { snapshot = next; render(); })
  .catch((cause: unknown) => { error = messageOf(cause); render(); });

function render(): void {
  if (snapshot === null) {
    root.innerHTML = `<section class="loading">${error === null ? "正在打开 Nexora…" : errorView(error)}</section>`;
    return;
  }
  root.innerHTML = `
    <div class="shell">
      ${sidebar(snapshot)}
      <section class="main-column">
        ${header(snapshot)}
        <div class="content-scroll">
          ${snapshot.session === null ? emptyState() : mode === "conversation" ? conversation(snapshot.session) : activity(snapshot.session)}
        </div>
        ${plan(snapshot.session)}
        ${composer(snapshot.session)}
      </section>
    </div>
    ${settingsOpen ? settings(snapshot) : ""}
    ${error === null ? "" : `<div class="toast" role="alert"><span>${escapeHtml(error)}</span><button data-action="dismiss-error">×</button></div>`}
  `;
  bindActions();
}

function sidebar(state: DesktopSnapshot): string {
  const sessions = state.workspace.sessions.map((session) => `
    <button class="session-row ${state.session?.inspection.runId === session.runId ? "selected" : ""}" data-session="${escapeAttr(session.runId)}">
      <span class="session-copy"><strong>${escapeHtml(session.title)}</strong><small>${statusLabel(session.status)}</small></span>
      ${session.pendingRequestKind === null ? "" : `<span class="attention" title="需要处理"></span>`}
    </button>
  `).join("");
  return `
    <aside class="sidebar">
      <button class="workspace" data-action="workspace">
        <span class="workspace-mark">N</span>
        <span><strong>${escapeHtml(state.workspace.name)}</strong><small>${escapeHtml(state.workspace.path)}</small></span>
        <span class="chevron">⌄</span>
      </button>
      <button class="new-task" data-action="new-task"><span>＋</span> New Task</button>
      <div class="session-list" aria-label="Sessions">${sessions || `<p class="sidebar-empty">No sessions yet</p>`}</div>
      <button class="settings-button" data-action="settings">⚙ <span>Settings</span></button>
    </aside>
  `;
}

function header(state: DesktopSnapshot): string {
  const session = state.session;
  return `
    <header class="session-header">
      <div>
        <strong>${session === null ? "New task" : escapeHtml(session.inspection.inputs[0]?.text.slice(0, 96) ?? "Session")}</strong>
        ${session === null ? "" : `<small>${statusLabel(session.inspection.status)}</small>`}
      </div>
      ${session === null ? "" : `
        <nav class="view-switch" aria-label="Session view">
          <button class="${mode === "conversation" ? "active" : ""}" data-view="conversation">Conversation</button>
          <button class="${mode === "activity" ? "active" : ""}" data-view="activity">Activity</button>
        </nav>
      `}
    </header>
  `;
}

function emptyState(): string {
  return `
    <section class="empty-state">
      <div class="empty-mark">N</div>
      <h1>What should Nexora do?</h1>
      <p>Start a task in this workspace. Nexora will show its real plan, tool activity and verified result here.</p>
    </section>
  `;
}

function conversation(session: SessionView): string {
  type Item = { at: string; order: number; html: string };
  const items: Item[] = [];
  for (const input of session.inspection.inputs) {
    items.push({ at: input.receivedAt, order: input.sequence, html: `
      <article class="message user-message">
        <div class="message-label">You</div>
        <p>${escapeHtml(input.text)}</p>
      </article>
    ` });
  }
  for (const invocation of session.inspection.invocations) {
    const expanded = expandedTools.has(invocation.id);
    items.push({ at: invocation.startedAt, order: invocation.planVersion * 1000, html: `
      <article class="activity-line ${statusClass(invocation.status)}">
        <button class="activity-summary" data-tool="${escapeAttr(invocation.id)}">
          <span class="activity-icon">${toolIcon(invocation.toolName)}</span>
          <span>${escapeHtml(toolLabel(invocation.toolName, invocation.inputJson))}</span>
          <small>${invocationStatus(invocation.status)}${duration(invocation.startedAt, invocation.completedAt)}</small>
          <span class="disclosure">${expanded ? "⌃" : "⌄"}</span>
        </button>
        ${expanded ? `<div class="activity-detail">
          <dl><dt>Tool</dt><dd>${escapeHtml(invocation.toolName)}</dd><dt>Invocation</dt><dd>${escapeHtml(invocation.id)}</dd><dt>Step</dt><dd>${escapeHtml(invocation.stepId)}</dd></dl>
          <details open><summary>Input</summary><pre>${escapeHtml(pretty(invocation.inputJson))}</pre></details>
          ${invocation.resultJson === null ? "" : `<details><summary>Result</summary><pre>${escapeHtml(pretty(invocation.resultJson))}</pre></details>`}
          ${invocation.errorJson === null ? "" : `<details open><summary>Error</summary><pre>${escapeHtml(pretty(invocation.errorJson))}</pre></details>`}
          ${invocation.payloadArtifactRef === null ? "" : `<button class="text-button" data-artifact="${escapeAttr(invocation.payloadArtifactRef)}">Open artifact</button>`}
        </div>` : ""}
      </article>
    ` });
  }
  for (const record of session.history.records) {
    if (record.type !== "validation.passed" && record.type !== "validation.failed") continue;
    items.push({ at: record.occurredAt, order: record.sequence, html: `
      <article class="validation ${record.type.endsWith("passed") ? "passed" : "failed"}">
        <span>${record.type.endsWith("passed") ? "✓" : "!"}</span>
        <strong>${record.type.endsWith("passed") ? "Validation passed" : "Validation failed"}</strong>
      </article>
    ` });
  }
  if (session.inspection.result !== null) {
    const result = session.inspection.result;
    items.push({ at: result.delivery.createdAt, order: Number.MAX_SAFE_INTEGER, html: `
      <article class="result ${result.status}">
        <div class="result-icon">${result.status === "succeeded" ? "✓" : "!"}</div>
        <div><small>${result.status === "succeeded" ? "Nexora completed the task" : "Session ended"}</small><p>${escapeHtml(result.summary)}</p>
        ${result.resultArtifact === null ? "" : `<button class="text-button" data-artifact="${escapeAttr(result.resultArtifact)}">View full result</button>`}</div>
      </article>
    ` });
  } else if (session.inspection.error !== null) {
    items.push({ at: new Date().toISOString(), order: Number.MAX_SAFE_INTEGER, html: `
      <article class="result failed"><div class="result-icon">!</div><div><small>Runtime error</small><p>${escapeHtml(session.inspection.error.message)}</p></div></article>
    ` });
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  return `<section class="conversation">${items.map((item) => item.html).join("")}</section>`;
}

function activity(session: SessionView): string {
  const records = session.history.records.map((record) => `
    <article class="trajectory-row">
      <span class="sequence">${record.sequence}</span>
      <div><strong>${escapeHtml(record.type)}</strong><small>${formatTime(record.occurredAt)}</small>
        <details><summary>Details</summary><pre>${escapeHtml(pretty(record.payload))}</pre>
          <dl><dt>ID</dt><dd>${escapeHtml(record.runId)}:${record.sequence}</dd><dt>Actor</dt><dd>${escapeHtml(record.actorType ?? "unknown")}</dd></dl>
        </details>
      </div>
    </article>
  `).join("");
  const evidence = session.inspection.evidence.map((item) => `
    <article class="trajectory-row evidence-row"><span class="sequence">E</span><div><strong>${escapeHtml(item.kind)}</strong><small>${formatTime(item.producedAt)}</small><details><summary>Evidence</summary><pre>${escapeHtml(pretty(item))}</pre></details></div></article>
  `).join("");
  return `<section class="trajectory"><div class="trajectory-heading"><h2>Activity</h2><p>Complete persisted Runtime trajectory for this Session.</p></div>${records}${evidence}</section>`;
}

function plan(session: SessionView | null): string {
  const current = session?.inspection.plan;
  if (current === null || current === undefined) return "";
  const progress = new Map(session!.inspection.progress.map((item) => [item.stepId, item.status]));
  const active = current.orderedSteps.find((step) => progress.get(step.id) === "active") ?? current.orderedSteps.find((step) => progress.get(step.id) !== "completed");
  const completed = current.orderedSteps.filter((step) => progress.get(step.id) === "completed").length;
  return `
    <section class="plan-strip ${planOpen ? "open" : ""}">
      <button data-action="plan"><span class="plan-dot"></span><strong>${escapeHtml(active?.objective ?? "Plan complete")}</strong><span>${completed} / ${current.orderedSteps.length}</span><span>${planOpen ? "⌃" : "⌄"}</span></button>
      ${planOpen ? `<ol>${current.orderedSteps.map((step) => `<li class="${progress.get(step.id) ?? "pending"}"><span>${progress.get(step.id) === "completed" ? "✓" : progress.get(step.id) === "active" ? "●" : "○"}</span>${escapeHtml(step.objective)}</li>`).join("")}</ol>` : ""}
    </section>
  `;
}

function composer(session: SessionView | null): string {
  if (session === null) return goalComposer();
  const run = session.inspection;
  if (run.status === "waiting_for_input" && run.pendingRequest?.kind === "input") {
    return `<section class="composer request"><p>${escapeHtml(run.pendingRequest.prompt)}</p><form data-form="input"><textarea name="text" placeholder="Reply…" required></textarea><button class="primary" ${busy ? "disabled" : ""}>Send</button></form></section>`;
  }
  if (run.status === "waiting_for_approval" && run.pendingRequest?.kind === "approval") {
    return `<section class="composer approval"><div><small>Approval required · ${escapeHtml(run.pendingRequest.toolName)}</small><p>${escapeHtml(run.pendingRequest.prompt)}</p><details><summary>Operation</summary><pre>${escapeHtml(pretty(run.pendingRequest.input))}</pre></details></div><div class="approval-actions"><button data-action="deny" ${busy ? "disabled" : ""}>Reject</button><button class="primary" data-action="approve" ${busy ? "disabled" : ""}>Approve</button></div></section>`;
  }
  if (run.status === "running") {
    return `<section class="composer running"><span class="pulse"></span><span>Nexora is working…</span><button data-action="cancel" ${busy ? "disabled" : ""}>Cancel</button></section>`;
  }
  if (run.status === "blocked") {
    if (run.recovery !== null) {
      return `<section class="composer recovery"><div><small>Recovery required · ${escapeHtml(run.recovery.toolName)}</small><p>The Tool result is unknown. Confirm the real external outcome.</p><input id="subject-ref" placeholder="Subject reference for confirmed success" /></div><div class="recovery-actions"><button data-recovery="abandon_run">Abandon</button><button data-recovery="confirmed_failed">It failed</button><button class="primary" data-recovery="confirmed_succeeded">It succeeded</button></div></section>`;
    }
    const budget = run.stopReason?.endsWith("BUDGET_EXCEEDED") === true;
    return `<section class="composer blocked"><div><small>Session paused</small><p>${escapeHtml(run.delivery?.summary ?? run.stopReason ?? "The Runtime requires intervention.")}</p></div><button class="primary" data-action="${budget ? "extend-budget" : "resume"}" ${busy ? "disabled" : ""}>${budget ? "Extend budget & resume" : "Resume"}</button></section>`;
  }
  return `<section class="composer terminal"><span>${run.status === "succeeded" ? "Task complete" : statusLabel(run.status)}</span><button class="primary" data-action="new-task">New follow-up</button></section>`;
}

function goalComposer(): string {
  return `<section class="composer goal"><form data-form="goal"><textarea name="goal" placeholder="Describe a task for Nexora…" required></textarea><button class="send-button" aria-label="Start task" ${busy ? "disabled" : ""}>↑</button></form></section>`;
}

function settings(state: DesktopSnapshot): string {
  return `<div class="modal-backdrop" data-action="close-settings"><section class="settings-modal" role="dialog" aria-modal="true"><header><h2>Settings</h2><button data-action="close-settings">×</button></header><dl><dt>Workspace</dt><dd>${escapeHtml(state.workspace.path)}</dd><dt>Provider</dt><dd>${state.workspace.providerConfigured ? "Configured" : "Not configured"}</dd><dt>Model</dt><dd>${escapeHtml(state.workspace.model ?? "—")}</dd></dl><p>Provider secrets remain in the Desktop main process and are never exposed here.</p></section></div>`;
}

function bindActions(): void {
  document.querySelector<HTMLElement>(".settings-modal")?.addEventListener("click", (event) => event.stopPropagation());
  document.querySelectorAll<HTMLElement>("[data-session]").forEach((element) => element.addEventListener("click", () => {
    const runId = element.dataset.session;
    if (runId !== undefined) void perform(() => window.nexora.openSession(runId).then(setSnapshot));
  }));
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => {
    mode = element.dataset.view === "activity" ? "activity" : "conversation";
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-tool]").forEach((element) => element.addEventListener("click", () => {
    const id = element.dataset.tool!;
    if (expandedTools.has(id)) expandedTools.delete(id); else expandedTools.add(id);
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-artifact]").forEach((element) => element.addEventListener("click", () => {
    const digest = element.dataset.artifact!;
    void perform(async () => {
      const artifact = await window.nexora.readArtifact(digest);
      showArtifact(artifact.text, artifact.truncated);
    });
  }));
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => element.addEventListener("click", (event) => {
    const action = element.dataset.action;
    if (action === "workspace") void perform(() => window.nexora.chooseWorkspace().then((next) => { if (next !== null) setSnapshot(next); }));
    else if (action === "new-task") { snapshot = snapshot === null ? null : { ...snapshot, session: null }; mode = "conversation"; render(); }
    else if (action === "settings") { settingsOpen = true; render(); }
    else if (action === "close-settings") { if (event.target === element || element.tagName === "BUTTON") { settingsOpen = false; render(); } }
    else if (action === "dismiss-error") { error = null; render(); }
    else if (action === "plan") { planOpen = !planOpen; render(); }
    else if (["approve", "deny", "cancel", "resume", "extend-budget"].includes(action ?? "")) void controlAction(action!);
  }));
  document.querySelectorAll<HTMLElement>("[data-recovery]").forEach((element) => element.addEventListener("click", () => void recoveryAction(element.dataset.recovery!)));
  document.querySelector<HTMLFormElement>("[data-form='goal']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const goal = new FormData(event.currentTarget as HTMLFormElement).get("goal");
    if (typeof goal === "string") void perform(() => window.nexora.startSession(goal).then(setSnapshot));
  });
  document.querySelector<HTMLFormElement>("[data-form='input']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget as HTMLFormElement).get("text");
    const request = snapshot?.session?.inspection.pendingRequest;
    if (typeof text === "string" && request?.kind === "input") void sendControl({ type: "input", text, requestId: request.id });
  });
}

async function controlAction(action: string): Promise<void> {
  const request = snapshot?.session?.inspection.pendingRequest;
  if (action === "approve" && request?.kind === "approval") return await sendControl({ type: "approve", requestId: request.id });
  if (action === "deny" && request?.kind === "approval") {
    const reason = window.prompt("Reason for rejection (optional)")?.trim();
    return await sendControl({ type: "deny", requestId: request.id, ...(reason ? { reason } : {}) });
  }
  if (action === "cancel") return await sendControl({ type: "cancel" });
  if (action === "extend-budget") return await sendControl({ type: "extend_budget" });
  if (action === "resume") return await sendControl({ type: "resume" });
}

async function recoveryAction(outcome: string): Promise<void> {
  const recovery = snapshot?.session?.inspection.recovery;
  if (recovery === null || recovery === undefined) return;
  if (outcome === "confirmed_succeeded") {
    const subjectRef = document.querySelector<HTMLInputElement>("#subject-ref")?.value.trim();
    if (!subjectRef) { error = "A subject reference is required to confirm success."; render(); return; }
    return await sendControl({ type: "recover", recovery: { invocationId: recovery.invocationId, outcome, subjectRef } });
  }
  if (outcome === "confirmed_failed") return await sendControl({ type: "recover", recovery: { invocationId: recovery.invocationId, outcome } });
  await sendControl({ type: "recover", recovery: { invocationId: recovery.invocationId, outcome: "abandon_run" } });
}

async function sendControl(control: SessionControl): Promise<void> {
  const runId = snapshot?.session?.inspection.runId;
  if (runId === undefined) return;
  await perform(() => window.nexora.control(runId, control));
}

async function perform(operation: () => Promise<void>): Promise<void> {
  busy = true;
  error = null;
  render();
  try { await operation(); } catch (cause) { error = messageOf(cause); busy = false; render(); }
}

function setSnapshot(next: DesktopSnapshot): void { snapshot = next; busy = false; error = null; render(); }
function showArtifact(text: string, truncated: boolean): void {
  const dialog = document.createElement("dialog");
  dialog.className = "artifact-dialog";
  dialog.innerHTML = `<header><strong>Artifact${truncated ? " · preview" : ""}</strong><button>×</button></header><pre>${escapeHtml(text)}</pre>`;
  dialog.querySelector("button")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function toolLabel(name: string, input: unknown): string {
  const value = objectValue(input);
  const target = stringValue(value.path) ?? stringValue(value.query) ?? stringValue(value.command) ?? stringValue(value.pattern);
  const lower = name.toLowerCase();
  const action = lower.includes("read") ? "Read" : lower.includes("search") ? "Search" : lower.includes("write") || lower.includes("patch") ? "Edited" : lower.includes("shell") || lower.includes("command") ? "Run" : humanize(name);
  return target === null ? action : `${action} ${compact(target, 100)}`;
}
function toolIcon(name: string): string { const lower = name.toLowerCase(); return lower.includes("read") ? "⌘" : lower.includes("search") ? "⌕" : lower.includes("write") || lower.includes("patch") ? "✎" : lower.includes("shell") || lower.includes("command") ? ">_" : "·"; }
function statusLabel(status: string): string { return ({ running: "正在工作", waiting_for_input: "需要回复", waiting_for_approval: "需要确认", blocked: "已暂停", succeeded: "已完成", failed: "未完成", cancelled: "已取消" } as Record<string, string>)[status] ?? humanize(status); }
function invocationStatus(status: string): string { return ({ prepared: "Queued", started: "Running", succeeded: "Done", failed: "Failed", unknown: "Unknown" } as Record<string, string>)[status] ?? humanize(status); }
function statusClass(status: string): string { return status === "failed" || status === "unknown" ? "problem" : status === "started" || status === "prepared" ? "active" : "done"; }
function duration(start: string, end: string | null): string { if (end === null) return ""; const ms = Date.parse(end) - Date.parse(start); return Number.isFinite(ms) && ms >= 0 ? ` · ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}` : ""; }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function objectValue(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function compact(value: string, limit: number): string { const line = value.replace(/\s+/g, " "); return line.length <= limit ? line : `${line.slice(0, limit - 3)}...`; }
function humanize(value: string): string { return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function errorView(value: string): string { return `<div class="fatal"><div class="empty-mark">!</div><h1>Could not open Nexora</h1><p>${escapeHtml(value)}</p></div>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!); }
function escapeAttr(value: string): string { return escapeHtml(value); }
