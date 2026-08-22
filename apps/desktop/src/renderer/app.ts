import type {
  DesktopBridge,
  DesktopSnapshot,
  SessionControl,
  SessionView
} from "../shared.js";
import type { AgentPublicOutputEvent } from "@nexora/harness";
import { shouldSendOnEnter } from "./keyboard.js";
import { renderMarkdown } from "./markdown.js";

declare global {
  interface Window { nexora: DesktopBridge }
}

const root = document.querySelector<HTMLElement>("#app")!;
let snapshot: DesktopSnapshot | null = null;
let mode: "conversation" | "activity" = "conversation";
let planOpen = false;
let settingsOpen = false;
let editingProfileId: string | "new" | null = null;
let busy = false;
let error: string | null = null;
let draft = "";
const expandedTools = new Set<string>();
const collapsedProjects = new Set<string>();
type PublicOutputSegment = {
  readonly key: string;
  readonly runId: string;
  readonly occurredAt: string;
  text: string;
  completed: boolean;
};
const publicOutputs = new Map<string, PublicOutputSegment>();

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
window.nexora.onPublicOutput((event) => updatePublicOutput(event));

void window.nexora.bootstrap()
  .then((next) => { snapshot = next; render(); })
  .catch((cause: unknown) => { error = messageOf(cause); render(); });

function render(): void {
  const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
  const focusedName = focused?.name;
  const selection = focused === null ? null : [focused.selectionStart, focused.selectionEnd] as const;
  const previousScroll = document.querySelector<HTMLElement>(".content-scroll")?.scrollTop ?? null;
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
  if (focusedName !== undefined) {
    const next = document.querySelector<HTMLTextAreaElement>(`textarea[name='${focusedName}']`);
    if (next !== null) {
      next.focus();
      if (selection !== null) next.setSelectionRange(selection[0], selection[1]);
    }
  }
  const content = document.querySelector<HTMLElement>(".content-scroll");
  if (content !== null && previousScroll !== null) content.scrollTop = previousScroll;
}

function sidebar(state: DesktopSnapshot): string {
  const projects = state.workspace.projects.map((project) => {
    const current = project.path.toLowerCase() === state.workspace.path.toLowerCase();
    const collapsed = collapsedProjects.has(project.path.toLowerCase());
    const active = project.sessions.filter((session) => !session.archived);
    const archived = project.sessions.filter((session) => session.archived);
    const rows = (sessions: typeof project.sessions, archivedGroup: boolean) => sessions.map((session) => `
      <div class="session-row ${state.session?.id === session.id ? "selected" : ""}">
        <button class="session-open" data-session="${escapeAttr(session.id)}" data-project-path="${escapeAttr(project.path)}">
          <span class="session-copy"><strong>${escapeHtml(session.title)}</strong><small>${statusLabel(session.status)}</small></span>
          ${session.pendingRequestKind === null ? "" : `<span class="attention" title="需要处理"></span>`}
        </button>
        <span class="session-actions">
          <button title="${archivedGroup ? "Restore" : "Archive"}" data-session-action="archive" data-session="${escapeAttr(session.id)}" data-project-path="${escapeAttr(project.path)}" data-archived="${archivedGroup ? "false" : "true"}">${archivedGroup ? "↥" : "⌄"}</button>
          <button title="Remove from Desktop" data-session-action="remove" data-session="${escapeAttr(session.id)}" data-project-path="${escapeAttr(project.path)}">×</button>
        </span>
      </div>
    `).join("");
    return `<section class="project-group ${current ? "current" : ""}">
      <div class="project-heading"><button class="project-disclosure" data-project-toggle="${escapeAttr(project.path)}" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? "›" : "⌄"}</button><button class="project-select" data-project-switch="${escapeAttr(project.path)}"><strong>${escapeHtml(project.name)}</strong></button></div>
      ${collapsed ? "" : `<div class="project-sessions">${rows(active, false) || `<p class="sidebar-empty">No sessions yet</p>`}${archived.length === 0 ? "" : `<details class="archived"><summary>Archived · ${archived.length}</summary>${rows(archived, true)}</details>`}</div>`}
    </section>`;
  }).join("");
  return `
    <aside class="sidebar">
      <div class="workspace">
        <span class="workspace-mark">N</span>
        <span><strong>Nexora</strong><small>Projects</small></span>
        <button class="add-project" data-action="workspace" title="Add project">＋</button>
      </div>
      <button class="new-task" data-action="new-task"><span>＋</span> New Task</button>
      <div class="session-list" aria-label="Projects and Sessions">${projects}</div>
      <button class="settings-button" data-action="settings">⚙ <span>Settings</span></button>
    </aside>
  `;
}

function header(state: DesktopSnapshot): string {
  const session = state.session;
  const running = session?.inspection.status === "running";
  return `
    <header class="session-header">
      <div>
        <strong>${session === null ? "New task" : escapeHtml(session.title)}</strong>
        ${session === null ? "" : `<small>${statusLabel(session.inspection.status)}</small>`}
      </div>
      <div class="header-actions">
        ${state.workspace.modelProfiles.length === 0 ? "" : `<select class="model-switch" data-profile-select title="Model for new Runs" ${running ? "disabled" : ""}>${state.workspace.modelProfiles.map((profile) => `<option value="${escapeAttr(profile.id)}" ${profile.id === state.workspace.selectedModelProfileId ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}</select>`}
      ${session === null ? "" : `
        <nav class="view-switch" aria-label="Session view">
          <button class="${mode === "conversation" ? "active" : ""}" data-view="conversation">Conversation</button>
          <button class="${mode === "activity" ? "active" : ""}" data-view="activity">Activity</button>
        </nav>
      `}
      </div>
    </header>
  `;
}

function emptyState(): string {
  const providerError = snapshot?.workspace.providerError ?? (snapshot?.workspace.providerConfigured === false ? "A Provider is required before starting a Session." : null);
  return `
    <section class="empty-state">
      <div class="empty-mark">N</div>
      <h1>${providerError ? "Configure your model" : "What should Nexora do?"}</h1>
      <p>${providerError ? escapeHtml(providerError) : "Start a task in this workspace. Nexora will show its real plan, tool activity and verified result here."}</p>
      ${providerError ? `<button class="primary empty-settings" data-action="settings">Open Settings</button>` : ""}
    </section>
  `;
}

function conversation(session: SessionView): string {
  type Item = { at: string; order: number; html: string };
  const items: Item[] = [];
  for (const [runIndex, run] of session.runs.entries()) {
    const firstInput = run.inspection.inputs[0];
    if (firstInput !== undefined) items.push({ at: firstInput.receivedAt, order: runIndex * 1_000_000, html: `
      <article class="message user-message">
        <div class="message-label">You</div>
        <p>${escapeHtml(run.userInput)}</p>
      </article>
    ` });
    for (const input of run.inspection.inputs.slice(1)) items.push({ at: input.receivedAt, order: runIndex * 1_000_000 + input.sequence, html: `
      <article class="message user-message"><div class="message-label">You</div><p>${escapeHtml(input.text)}</p></article>
    ` });
    for (const invocation of run.inspection.invocations) {
      const expanded = expandedTools.has(invocation.id);
      items.push({ at: invocation.startedAt, order: runIndex * 1_000_000 + invocation.planVersion * 1000, html: `
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
    for (const segment of publicOutputs.values()) {
      if (segment.runId !== run.inspection.runId) continue;
      items.push({ at: segment.occurredAt, order: runIndex * 1_000_000 + 500, html: `
        <article class="message agent-message public-output ${segment.completed ? "completed" : "streaming"}" data-public-output="${escapeAttr(segment.key)}">
          <div class="message-label">Nexora ${segment.completed ? "" : "· Working"}</div>
          <div class="markdown-body">${renderMarkdown(segment.text)}</div>
        </article>
      ` });
    }
    for (const record of run.history.records) {
      if (record.type !== "validation.passed" && record.type !== "validation.failed") continue;
      items.push({ at: record.occurredAt, order: runIndex * 1_000_000 + record.sequence, html: `
      <article class="validation ${record.type.endsWith("passed") ? "passed" : "failed"}">
        <span>${record.type.endsWith("passed") ? "✓" : "!"}</span>
        <strong>${record.type.endsWith("passed") ? "Validation passed" : "Validation failed"}</strong>
      </article>
    ` });
    }
    if (run.inspection.result !== null) {
      const result = run.inspection.result;
      const summaryAlreadyStreamed = [...publicOutputs.values()].some((segment) => (
        segment.runId === run.inspection.runId
        && segment.completed
        && segment.text.trim() === result.summary.trim()
      ));
      items.push({ at: result.delivery.createdAt, order: runIndex * 1_000_000 + 999_999, html: `
      <article class="result ${result.status}">
        <div class="result-icon">${result.status === "succeeded" ? "✓" : "!"}</div>
        <div><small>${result.status === "succeeded" ? "Nexora completed this turn" : result.status === "cancelled" ? "Turn interrupted" : "Turn ended"}</small>${summaryAlreadyStreamed ? "" : `<div class="markdown-body">${renderMarkdown(result.summary)}</div>`}
        ${result.resultArtifact === null ? "" : `<button class="text-button" data-artifact="${escapeAttr(result.resultArtifact)}">View full result</button>`}</div>
      </article>
    ` });
    } else if (run.inspection.error !== null) {
      items.push({ at: new Date().toISOString(), order: runIndex * 1_000_000 + 999_999, html: `
      <article class="result failed"><div class="result-icon">!</div><div><small>Runtime error</small><p>${escapeHtml(run.inspection.error.message)}</p></div></article>
    ` });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  return `<section class="conversation">${items.map((item) => item.html).join("")}</section>`;
}

function activity(session: SessionView): string {
  const runs = session.runs.map((run, index) => {
    const records = run.history.records.map((record) => `
    <article class="trajectory-row">
      <span class="sequence">${record.sequence}</span>
      <div><strong>${escapeHtml(record.type)}</strong><small>${formatTime(record.occurredAt)}</small>
        <details><summary>Details</summary><pre>${escapeHtml(pretty(record.payload))}</pre>
          <dl><dt>ID</dt><dd>${escapeHtml(record.runId)}:${record.sequence}</dd><dt>Actor</dt><dd>${escapeHtml(record.actorType ?? "unknown")}</dd></dl>
        </details>
      </div>
    </article>
    `).join("");
    const evidence = run.inspection.evidence.map((item) => `
    <article class="trajectory-row evidence-row"><span class="sequence">E</span><div><strong>${escapeHtml(item.kind)}</strong><small>${formatTime(item.producedAt)}</small><details><summary>Evidence</summary><pre>${escapeHtml(pretty(item))}</pre></details></div></article>
    `).join("");
    return `<section class="run-trajectory"><h3>Turn ${index + 1} · ${escapeHtml(run.inspection.runId)}</h3>${records}${evidence}</section>`;
  }).join("");
  return `<section class="trajectory"><div class="trajectory-heading"><h2>Activity</h2><p>Persisted Runtime trajectory across every Run in this Session.</p></div>${runs}</section>`;
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
    return followUpComposer(session, true);
  }
  if (run.status === "blocked") {
    if (run.recovery !== null) {
      return `<section class="composer recovery"><div><small>Recovery required · ${escapeHtml(run.recovery.toolName)}</small><p>The Tool result is unknown. Confirm the real external outcome.</p><input id="subject-ref" placeholder="Subject reference for confirmed success" /></div><div class="recovery-actions"><button data-recovery="abandon_run">Abandon</button><button data-recovery="confirmed_failed">It failed</button><button class="primary" data-recovery="confirmed_succeeded">It succeeded</button></div></section>`;
    }
    const budget = run.stopReason?.endsWith("BUDGET_EXCEEDED") === true;
    return `<section class="composer blocked"><div><small>Session paused</small><p>${escapeHtml(run.delivery?.summary ?? run.stopReason ?? "The Runtime requires intervention.")}</p></div><button class="primary" data-action="${budget ? "extend-budget" : "resume"}" ${busy ? "disabled" : ""}>${budget ? "Extend budget & resume" : "Resume"}</button></section>`;
  }
  return followUpComposer(session, false);
}

function goalComposer(): string {
  return `<section class="composer goal"><form data-form="goal"><textarea name="goal" placeholder="Describe a task for Nexora…" required>${escapeHtml(draft)}</textarea><button class="send-button" aria-label="Start task" ${busy ? "disabled" : ""}>↑</button></form></section>`;
}

function followUpComposer(session: SessionView, running: boolean): string {
  return `<section class="composer follow-up ${running ? "is-running" : ""}">
    <form data-form="follow-up">
      <textarea name="text" placeholder="${running ? "Type to interrupt and send…" : "Continue this Session…"}" required>${escapeHtml(draft)}</textarea>
      <div class="composer-actions">
        ${running ? `<button type="button" class="stop-button" data-action="cancel" title="Stop current Run" ${busy ? "disabled" : ""}>■</button>` : ""}
        <button class="send-button" aria-label="${running ? "Interrupt and send" : "Send follow-up"}" ${busy ? "disabled" : ""}>↑</button>
      </div>
    </form>
    <small>${running ? "Sending interrupts the current Run safely, then starts the next turn." : `${statusLabel(session.inspection.status)} · Continue in this Session.`}</small>
  </section>`;
}

function settings(state: DesktopSnapshot): string {
  const profiles = state.workspace.modelProfiles;
  const editingId = editingProfileId ?? state.workspace.selectedModelProfileId ?? "new";
  const profile = profiles.find((item) => item.id === editingId);
  return `<div class="modal-backdrop" data-action="close-settings"><section class="settings-modal" role="dialog" aria-modal="true">
    <header><div><h2>Model settings</h2><small>${escapeHtml(state.workspace.name)}</small></div><button data-action="close-settings">×</button></header>
    <div class="model-profile-list">${profiles.map((item) => `<div class="model-profile-row ${item.id === state.workspace.selectedModelProfileId ? "selected" : ""}"><button data-profile-edit="${escapeAttr(item.id)}"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.model)}</small></button><button data-profile-delete="${escapeAttr(item.id)}" title="Delete model">×</button></div>`).join("")}<button class="new-model" data-profile-edit="new">＋ Add model</button></div>
    <form data-form="model-profile" class="settings-form">
      ${profile === undefined ? "" : `<input type="hidden" name="id" value="${escapeAttr(profile.id)}" />`}
      <label>Name<input name="name" value="${escapeAttr(profile?.name ?? "")}" placeholder="Work model" required /></label>
      <label>Base URL<input name="baseUrl" type="url" value="${escapeAttr(profile?.baseUrl ?? "")}" placeholder="https://provider.example/v1" required /></label>
      <label>API Key<input name="apiKey" type="password" placeholder="${profile?.apiKeyConfigured ? "Configured · leave blank to keep" : "Required"}" ${profile === undefined ? "required" : ""} /></label>
      <label>Model ID<input name="model" value="${escapeAttr(profile?.model ?? "")}" placeholder="Model identifier" required /></label>
      <div class="settings-grid"><label>Context window<input name="contextWindowTokens" type="number" min="1" value="${profile?.contextWindowTokens ?? ""}" placeholder="Known model default" /></label><label>Decision tokens<input name="decisionOutputTokens" type="number" min="1" value="${profile?.decisionOutputTokens ?? 4096}" required /></label></div>
      <label>Tool transport<select name="transport"><option value="native_tools" ${profile?.transport !== "structured_output" ? "selected" : ""}>Native tools · streaming</option><option value="structured_output" ${profile?.transport === "structured_output" ? "selected" : ""}>Structured output</option></select></label>
      <button class="primary" ${busy ? "disabled" : ""}>${profile === undefined ? "Add model" : "Save model"}</button>
    </form>
    <p>The selected profile applies to new Runs in this Workspace. API Keys are never returned to the Renderer. The selected profile is mirrored to <code>.env</code> for CLI compatibility.</p>
  </section></div>`;
}

function bindActions(): void {
  document.querySelector<HTMLElement>(".settings-modal")?.addEventListener("click", (event) => event.stopPropagation());
  document.querySelectorAll<HTMLElement>("[data-session]").forEach((element) => element.addEventListener("click", () => {
    if (element.dataset.sessionAction !== undefined) return;
    const sessionId = element.dataset.session;
    const projectPath = element.dataset.projectPath;
    if (sessionId !== undefined && projectPath !== undefined) {
      draft = "";
      void perform(() => window.nexora.openSession(projectPath, sessionId).then(setSnapshot));
    }
  }));
  document.querySelectorAll<HTMLElement>("[data-project-toggle]").forEach((element) => element.addEventListener("click", () => {
    const path = element.dataset.projectToggle;
    if (path === undefined) return;
    const key = path.toLowerCase();
    if (collapsedProjects.has(key)) collapsedProjects.delete(key); else collapsedProjects.add(key);
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-project-switch]").forEach((element) => element.addEventListener("click", () => {
    const path = element.dataset.projectSwitch;
    if (path !== undefined && path.toLowerCase() !== snapshot?.workspace.path.toLowerCase()) {
      draft = "";
      void perform(() => window.nexora.switchProject(path).then(setSnapshot));
    }
  }));
  document.querySelectorAll<HTMLElement>("[data-session-action]").forEach((element) => element.addEventListener("click", () => {
    const sessionId = element.dataset.session;
    const projectPath = element.dataset.projectPath;
    if (sessionId === undefined || projectPath === undefined) return;
    if (element.dataset.sessionAction === "archive") {
      const archived = element.dataset.archived === "true";
      void perform(() => window.nexora.archiveSession(projectPath, sessionId, archived).then(setSnapshot));
    } else if (window.confirm("Remove this Session from Nexora Desktop? Persisted Runtime Runs and audit evidence will be retained.")) {
      void perform(() => window.nexora.removeSession(projectPath, sessionId).then(setSnapshot));
    }
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
    if (action === "workspace") { draft = ""; void perform(() => window.nexora.chooseWorkspace().then((next) => { if (next !== null) setSnapshot(next); })); }
    else if (action === "new-task") { snapshot = snapshot === null ? null : { ...snapshot, session: null }; draft = ""; mode = "conversation"; render(); }
    else if (action === "settings") { settingsOpen = true; editingProfileId = null; render(); }
    else if (action === "close-settings") { if (event.target === element || element.tagName === "BUTTON") { settingsOpen = false; render(); } }
    else if (action === "dismiss-error") { error = null; render(); }
    else if (action === "plan") { planOpen = !planOpen; render(); }
    else if (["approve", "deny", "cancel", "resume", "extend-budget"].includes(action ?? "")) void controlAction(action!);
  }));
  document.querySelectorAll<HTMLElement>("[data-recovery]").forEach((element) => element.addEventListener("click", () => void recoveryAction(element.dataset.recovery!)));
  document.querySelector<HTMLSelectElement>("[data-profile-select]")?.addEventListener("change", (event) => {
    const id = (event.currentTarget as HTMLSelectElement).value;
    void perform(() => window.nexora.selectModelProfile(id).then(setSnapshot));
  });
  document.querySelectorAll<HTMLElement>("[data-profile-edit]").forEach((element) => element.addEventListener("click", () => {
    editingProfileId = element.dataset.profileEdit ?? "new";
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-profile-delete]").forEach((element) => element.addEventListener("click", () => {
    const id = element.dataset.profileDelete;
    if (id === undefined || !window.confirm("Delete this model profile?")) return;
    void perform(() => window.nexora.deleteModelProfile(id).then((next) => { editingProfileId = null; setSnapshot(next); }));
  }));
  document.querySelector<HTMLFormElement>("[data-form='goal']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const goal = new FormData(event.currentTarget as HTMLFormElement).get("goal");
    if (typeof goal === "string") void perform(async () => { const next = await window.nexora.startSession(goal); draft = ""; setSnapshot(next); });
  });
  document.querySelector<HTMLFormElement>("[data-form='input']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget as HTMLFormElement).get("text");
    const request = snapshot?.session?.inspection.pendingRequest;
    if (typeof text === "string" && request?.kind === "input") void sendControl({ type: "input", text, requestId: request.id });
  });
  document.querySelector<HTMLFormElement>("[data-form='follow-up']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget as HTMLFormElement).get("text");
    const sessionId = snapshot?.session?.id;
    if (typeof text === "string" && sessionId !== undefined) void perform(async () => {
      const next = await window.nexora.continueSession(sessionId, text);
      draft = "";
      setSnapshot(next);
    });
  });
  document.querySelector<HTMLFormElement>("[data-form='model-profile']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const apiKey = data.get("apiKey");
    void perform(async () => {
      const contextWindowTokens = Number(data.get("contextWindowTokens"));
      const id = String(data.get("id") ?? "").trim();
      const next = await window.nexora.saveModelProfile({
        ...(id ? { id } : {}),
        name: String(data.get("name") ?? ""),
        baseUrl: String(data.get("baseUrl") ?? ""),
        ...(typeof apiKey === "string" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model: String(data.get("model") ?? ""),
        ...(Number.isInteger(contextWindowTokens) && contextWindowTokens > 0 ? { contextWindowTokens } : {}),
        decisionOutputTokens: Number(data.get("decisionOutputTokens")),
        transport: data.get("transport") === "structured_output" ? "structured_output" : "native_tools"
      });
      editingProfileId = next.workspace.selectedModelProfileId;
      setSnapshot(next);
    });
  });
  document.querySelectorAll<HTMLTextAreaElement>("textarea[name='goal'], textarea[name='text']").forEach((input) => input.addEventListener("input", () => { draft = input.value; }));
  document.querySelectorAll<HTMLTextAreaElement>("textarea[name='goal'], textarea[name='text']").forEach((input) => input.addEventListener("keydown", (event) => {
    if (!shouldSendOnEnter(event, busy)) return;
    event.preventDefault();
    input.form?.requestSubmit();
  }));
}

function updatePublicOutput(event: AgentPublicOutputEvent): void {
  const key = `${event.runId}:${event.modelCallId}:${event.attemptId}`;
  if (event.type === "text.discarded") {
    publicOutputs.delete(key);
    render();
    return;
  }
  const existing = publicOutputs.get(key);
  if (existing === undefined) {
    if (event.type !== "text.delta" || event.text === undefined) return;
    publicOutputs.set(key, {
      key,
      runId: event.runId,
      occurredAt: event.occurredAt,
      text: event.text,
      completed: false
    });
    render();
    return;
  }
  if (event.type === "text.delta" && event.text !== undefined) existing.text += event.text;
  if (event.type === "text.completed") existing.completed = true;
  const element = document.querySelector<HTMLElement>(`[data-public-output="${CSS.escape(key)}"]`);
  if (element === null) {
    render();
    return;
  }
  element.classList.toggle("streaming", !existing.completed);
  element.classList.toggle("completed", existing.completed);
  const label = element.querySelector<HTMLElement>(".message-label");
  if (label !== null) label.textContent = existing.completed ? "Nexora" : "Nexora · Working";
  const body = element.querySelector<HTMLElement>(".markdown-body");
  if (body !== null) body.innerHTML = renderMarkdown(existing.text);
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
  try {
    await operation();
    if (busy) { busy = false; render(); }
  } catch (cause) { error = messageOf(cause); busy = false; render(); }
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
