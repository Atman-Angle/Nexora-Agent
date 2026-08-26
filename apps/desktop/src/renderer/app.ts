import type {
  DesktopBridge,
  DesktopSnapshot,
  SessionControl,
  SessionView
} from "../shared.js";
import type { AgentPublicOutputEvent } from "@nexora/harness";
import { shouldSendOnEnter } from "./keyboard.js";
import { renderMarkdown } from "./markdown.js";
import { createPublicOutputBatcher, PUBLIC_OUTPUT_FLUSH_MS } from "./public-output-batcher.js";
import { compactLatest, isFormalResultContent } from "./public-output-view.js";
import { workspaceOutputs, type WorkspaceOutput } from "./workspace-outputs.js";

declare global {
  interface Window { nexora: DesktopBridge }
}

const root = document.querySelector<HTMLElement>("#app")!;
let snapshot: DesktopSnapshot | null = null;
let mode: "conversation" | "activity" = "conversation";
let planOpen = false;
let settingsOpen = false;
let editingProfileId: string | "new" | null = null;
let editingProviderBaseUrl: string | "new" | null = null;
let busy = false;
let error: string | null = null;
let draft = "";
let sidebarQuery = "";
let sidebarStatus: "all" | "running" | "waiting" | "succeeded" | "failed" = "all";
let skillNotice: { readonly names: readonly string[]; readonly key: string } | null = null;
let skillNoticeTimer: number | null = null;
let snapshotInitialized = false;
const seenSkillSelections = new Set<string>();
const expandedTools = new Set<string>();
const expandedPublicOutputs = new Set<string>();
const collapsedProjects = new Set<string>();
type PublicOutputSegment = {
  readonly key: string;
  readonly baseKey: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly channel: "reasoning" | "content";
  text: string;
  completed: boolean;
};
const publicOutputs = new Map<string, PublicOutputSegment>();
const publicOutputBatcher = createPublicOutputBatcher(
  (flush) => window.setTimeout(flush, PUBLIC_OUTPUT_FLUSH_MS),
  flushPublicOutputs
);

window.setInterval(() => updateElapsedLabels(), 1_000);

window.nexora.onSnapshot((next) => {
  detectSkillSelection(next, snapshotInitialized);
  snapshot = next;
  snapshotInitialized = true;
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
    ${skillNotice === null ? "" : `<div class="skill-toast" role="status"><span class="skill-toast-icon">✦</span><span>已自动加载 Skill：${escapeHtml(skillNotice.names.join("、"))}</span><button data-action="dismiss-skill-notice" aria-label="关闭 Skill 提示">×</button></div>`}
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
  const allSessions = state.workspace.projects.flatMap((project) => project.sessions);
  const visibleSessionCount = allSessions.filter((session) => !session.archived).length;
  const activeCount = allSessions.filter((session) => !session.archived && session.status === "running").length;
  const waitingCount = allSessions.filter((session) => !session.archived && (session.status === "waiting_for_input" || session.status === "waiting_for_approval")).length;
  const doneCount = allSessions.filter((session) => !session.archived && session.status === "succeeded").length;
  const projects = state.workspace.projects.map((project) => {
    const current = project.path.toLowerCase() === state.workspace.path.toLowerCase();
    const collapsed = collapsedProjects.has(project.path.toLowerCase());
    const active = project.sessions.filter((session) => !session.archived);
    const archived = project.sessions.filter((session) => session.archived);
    const rows = (sessions: typeof project.sessions, archivedGroup: boolean) => sessions.filter((session) => archivedGroup || matchesSidebarFilter(session)).map((session) => `
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
      <div class="project-heading"><button class="project-disclosure" data-project-toggle="${escapeAttr(project.path)}" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? "›" : "⌄"}</button><button class="project-select" data-project-switch="${escapeAttr(project.path)}"><strong>${escapeHtml(project.name)}</strong><small>${active.length} active · ${archived.length} archived</small></button></div>
      ${collapsed ? "" : `<div class="project-sessions">${rows(active, false) || `<p class="sidebar-empty">No matching sessions</p>`}${archived.length === 0 ? "" : `<details class="archived"><summary>Archived · ${archived.length}</summary>${rows(archived, true)}</details>`}</div>`}
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
      <section class="workspace-overview" aria-label="Workspace overview">
        <div class="overview-heading"><span>Workspace overview</span><span class="overview-live"><i></i> Live</span></div>
        <div class="overview-stats"><span><strong>${visibleSessionCount}</strong><small>Sessions</small></span><span><strong>${activeCount}</strong><small>Running</small></span><span><strong>${doneCount}</strong><small>Done</small></span></div>
        <div class="overview-progress"><span><b style="width:${visibleSessionCount === 0 ? 0 : Math.round(doneCount / visibleSessionCount * 100)}%"></b></span><small>${waitingCount > 0 ? `${waitingCount} need attention` : "All clear"}</small></div>
      </section>
      <div class="sidebar-tools">
        <label class="session-search"><span>⌕</span><input value="${escapeAttr(sidebarQuery)}" data-session-search placeholder="Search sessions" aria-label="Search sessions" /></label>
        <select class="status-filter" data-status-filter aria-label="Filter sessions"><option value="all" ${sidebarStatus === "all" ? "selected" : ""}>All statuses</option><option value="running" ${sidebarStatus === "running" ? "selected" : ""}>Running</option><option value="waiting" ${sidebarStatus === "waiting" ? "selected" : ""}>Needs attention</option><option value="succeeded" ${sidebarStatus === "succeeded" ? "selected" : ""}>Completed</option><option value="failed" ${sidebarStatus === "failed" ? "selected" : ""}>Failed</option></select>
      </div>
      <div class="session-list" aria-label="Projects and Sessions">${projects}</div>
      <button class="settings-button" data-action="settings">⚙ <span>Settings</span></button>
    </aside>
  `;
}

function header(state: DesktopSnapshot): string {
  const session = state.session;
  const context = session === null ? null : contextUsage(session);
  const compression = session === null ? null : latestCompaction(session);
  return `
    <header class="session-header">
      <div>
        <strong>${session === null ? "New task" : escapeHtml(session.title)}</strong>
        ${session === null ? "" : `<small>${statusLabel(session.inspection.status)}</small>`}
      </div>
      <div class="header-actions">
        ${compression === null ? "" : `<span class="compaction-chip" title="Persisted Runtime Context compaction event">手动压缩</span>`}
        ${context === null ? "" : `<div class="context-usage" title="Current Session · latest Run model call: ${context.used.toLocaleString()} input tokens of the ${context.window.toLocaleString()} model window; policy target ${context.target.toLocaleString()}. This is not a Project total."><span>Context ${formatTokens(context.used)} / ${formatTokens(context.window)}</span><i><b style="width:${context.percent}%"></b></i></div>`}
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
    const processedUntil = processingEnd(run);
    if (firstInput !== undefined) items.push({ at: firstInput.receivedAt, order: runIndex * 1_000_000, html: `
      <article class="message user-message">
        <div class="message-meta"><div class="message-label">You</div><small class="turn-duration" data-elapsed-start="${escapeAttr(firstInput.receivedAt)}" ${processedUntil === null ? "" : `data-elapsed-end="${escapeAttr(processedUntil)}"`}>${processingDuration(firstInput.receivedAt, processedUntil)}</small></div>
        <p>${escapeHtml(run.userInput)}</p>
      </article>
    ` });
    for (const input of run.inspection.inputs.slice(1)) items.push({ at: input.receivedAt, order: runIndex * 1_000_000 + input.sequence, html: `
      <article class="message user-message"><div class="message-label">You</div><p>${escapeHtml(input.text)}</p></article>
    ` });
    for (const invocation of run.inspection.invocations) {
      const expanded = expandedTools.has(invocation.id);
      const presentation = toolPresentation(invocation.toolName, invocation.inputJson);
      items.push({ at: invocation.startedAt, order: runIndex * 1_000_000 + invocation.planVersion * 1000, html: `
      <article class="activity-line ${statusClass(invocation.status)}">
        <div class="activity-summary">
          <span class="activity-icon">${toolIcon(invocation.toolName)}</span>
          <button class="activity-toggle" data-tool="${escapeAttr(invocation.id)}" aria-expanded="${expanded}">
            <span class="activity-kind">${escapeHtml(presentation.action)}</span>${presentation.target === null ? "" : `<span class="activity-separator">·</span>`}
          </button>
          ${presentation.target === null ? `<span class="activity-target"></span>` : presentation.workspacePath === null
            ? `<span class="activity-target">${escapeHtml(presentation.target)}</span>`
            : `<button class="activity-target workspace-target" data-workspace-entry="${escapeAttr(presentation.workspacePath)}" title="Open in workspace">${escapeHtml(presentation.target)}</button>`}
          <small>${invocationStatus(invocation.status)}${duration(invocation.startedAt, invocation.completedAt)}</small>
          <button class="disclosure" data-tool="${escapeAttr(invocation.id)}" aria-label="${expanded ? "Collapse" : "Expand"} Tool details">${expanded ? "⌃" : "⌄"}</button>
        </div>
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
    const runPublicOutputs = publicOutputSegments(run);
    const reasoningAttempts = new Set(runPublicOutputs.filter(({ channel }) => channel === "reasoning").map(({ baseKey }) => baseKey));
    for (const segment of runPublicOutputs) {
      const expanded = expandedPublicOutputs.has(segment.key);
      const formalResult = segment.channel === "content" && isFormalResultContent({
        completed: segment.completed,
        text: segment.text,
        resultSummary: run.inspection.result?.summary ?? null
      });
      if (segment.channel === "content" && !formalResult && reasoningAttempts.has(segment.baseKey)) continue;
      const order = runIndex * 1_000_000 + 500 + (segment.channel === "reasoning" ? 0 : 1);
      items.push({ at: segment.occurredAt, order, html: segment.channel === "reasoning" ? `
        <article class="think-output public-output ${segment.completed ? "completed" : "streaming"} ${expanded ? "expanded" : ""}" data-public-output="${escapeAttr(segment.key)}">
          <button class="think-summary" data-public-output-toggle="${escapeAttr(segment.key)}" aria-expanded="${expanded}">
            <span class="think-icon">⌘</span><span class="public-output-label">Think</span><span class="activity-separator">·</span><span class="think-preview">${escapeHtml(compactLatest(segment.text, 180))}</span><span class="disclosure">${expanded ? "⌃" : "⌄"}</span>
          </button>
          ${expanded ? `<div class="public-output-body"><div class="markdown-body">${renderMarkdown(segment.text)}</div></div>` : ""}
        </article>
      ` : formalResult ? `
        <article class="message agent-message public-content ${segment.completed ? "completed" : "streaming"}" data-public-output="${escapeAttr(segment.key)}">
          <div class="message-label">Nexora ${segment.completed ? "" : "· Streaming"}</div>
          <div class="markdown-body">${renderMarkdown(segment.text)}</div>
        </article>
      ` : `
        <article class="think-output working-output public-output ${segment.completed ? "completed" : "streaming"} ${expanded ? "expanded" : ""}" data-public-output="${escapeAttr(segment.key)}">
          <button class="think-summary" data-public-output-toggle="${escapeAttr(segment.key)}" aria-expanded="${expanded}">
            <span class="think-icon">·</span><span class="public-output-label">Working</span><span class="activity-separator">·</span><span class="think-preview">${escapeHtml(compactLatest(segment.text, 180))}</span><span class="disclosure">${expanded ? "⌃" : "⌄"}</span>
          </button>
          ${expanded ? `<div class="public-output-body"><div class="markdown-body">${renderMarkdown(segment.text)}</div></div>` : ""}
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
    for (const record of run.history.records) {
      if (record.type !== "context.compaction.requested") continue;
      items.push({ at: record.occurredAt, order: runIndex * 1_000_000 + record.sequence, html: `
        <article class="context-compaction manual">
          <span>⌁</span><strong>上下文已压缩</strong><small>将在下一条消息中使用</small>
        </article>
      ` });
    }
    const projectedInputRequestIds = new Set<string>();
    for (const record of run.history.records) {
      if (record.type !== "run.waiting") continue;
      const payload = objectValue(record.payload);
      const requestId = stringValue(payload.requestId);
      const prompt = stringValue(payload.prompt);
      if (payload.kind !== "input" || requestId === null || prompt === null) continue;
      projectedInputRequestIds.add(requestId);
      items.push({ at: record.occurredAt, order: runIndex * 1_000_000 + record.sequence, html: `
        <article class="message agent-message input-request-message">
          <div class="message-label">Nexora</div>
          <div class="markdown-body">${renderMarkdown(prompt)}</div>
        </article>
      ` });
    }
    const pendingInput = run.inspection.pendingRequest?.kind === "input" ? run.inspection.pendingRequest : null;
    if (pendingInput !== null && !projectedInputRequestIds.has(pendingInput.id)) {
      items.push({ at: pendingInput.createdAt, order: runIndex * 1_000_000 + 999_998, html: `
        <article class="message agent-message input-request-message">
          <div class="message-label">Nexora</div>
          <div class="markdown-body">${renderMarkdown(pendingInput.prompt)}</div>
        </article>
      ` });
    }
    if (run.inspection.status === "running") {
      items.push({ at: new Date().toISOString(), order: runIndex * 1_000_000 + 999_997, html: `
        <article class="agent-working" aria-live="polite">
          <span class="working-dots"><i></i><i></i><i></i></span>
          <span>Nexora 正在处理</span>
          ${firstInput === undefined ? "" : `<small class="turn-duration" data-elapsed-start="${escapeAttr(firstInput.receivedAt)}">${processingDuration(firstInput.receivedAt, null)}</small>`}
        </article>
      ` });
    }
    if (run.inspection.result !== null) {
      const result = run.inspection.result;
      const outputs = workspaceOutputs(run.inspection.invocations);
      const summaryAlreadyStreamed = publicOutputSegments(run).some((segment) => (
        segment.channel === "content"
        && segment.completed
        && segment.text.trim() === result.summary.trim()
      ));
      items.push({ at: result.delivery.createdAt, order: runIndex * 1_000_000 + 999_999, html: `
      <article class="result ${result.status}">
        <div class="result-icon">${result.status === "succeeded" ? "✓" : "!"}</div>
        <div><small>${result.status === "succeeded" ? "Nexora completed this turn" : result.status === "cancelled" ? "Turn interrupted" : "Turn ended"}</small>${summaryAlreadyStreamed ? "" : `<div class="markdown-body">${renderMarkdown(result.summary)}</div>`}
        ${result.resultArtifact === null ? "" : `<button class="text-button" data-artifact="${escapeAttr(result.resultArtifact)}">View full result</button>`}
        ${deliverableLinks(outputs)}</div>
      </article>
    ` });
    } else if (run.inspection.error !== null) {
      const outputs = workspaceOutputs(run.inspection.invocations);
      items.push({ at: new Date().toISOString(), order: runIndex * 1_000_000 + 999_999, html: `
      <article class="result failed"><div class="result-icon">!</div><div><small>Runtime error</small><p>${escapeHtml(run.inspection.error.message)}</p>${deliverableLinks(outputs)}</div></article>
    ` });
    }
  }
  const processInvocations = session.runs.flatMap((run) => run.inspection.invocations);
  const processCards = managedProcessCards(session.managedProcesses);
  if (processCards !== "") items.push({
    at: processInvocations.at(-1)?.completedAt ?? new Date().toISOString(),
    order: Number.MAX_SAFE_INTEGER - 1,
    html: processCards
  });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  return `<section class="conversation">${items.map((item) => item.html).join("")}</section>`;
}

function managedProcessCards(services: SessionView["managedProcesses"]): string {
  return services.map((service) => `
    <article class="managed-process-card">
      <span class="process-live ${service.status}"><i></i> ${escapeHtml(managedProcessStatusLabel(service.status))}</span>
      <div class="process-copy"><strong>${escapeHtml(service.serviceKey)}</strong><small>${service.pid === null ? "Managed service" : `PID ${service.pid}`} · ${formatTime(service.readyAt ?? service.startedAt)}</small></div>
      ${service.status === "ready" && service.endpoint?.startsWith("http") === true ? `<a class="process-action primary" href="${escapeAttr(service.endpoint)}" target="_blank" rel="noreferrer">Open</a>` : ""}
      <button class="process-action" data-process-logs="${escapeAttr(service.processHandle)}">Logs</button>
      ${service.status === "ready" || service.status === "starting" || service.status === "stopping" ? `<button class="process-action danger" data-process-stop="${escapeAttr(service.processHandle)}">Stop</button>` : ""}
    </article>
  `).join("");
}

function managedProcessStatusLabel(status: SessionView["managedProcesses"][number]["status"]): string {
  if (status === "ready") return "Running";
  if (status === "starting") return "Starting";
  if (status === "stopping") return "Stopping";
  if (status === "lost") return "Supervisor lost";
  if (status === "failed") return "Failed";
  return "Exited";
}

function activity(session: SessionView): string {
  const timeline = activityTimeline(session);
  const runs = session.runs.map((run, index) => {
    const records = run.history.records.map((record) => `
    <article class="trajectory-row" id="activity-event-${index}-${record.sequence}" data-activity-stage="${activityStage(record.type)}">
      <span class="sequence">${record.sequence}</span>
      <div class="trajectory-main"><strong>${escapeHtml(record.type)}</strong><small>${formatTime(record.occurredAt)}</small>
        <details><summary>Details</summary><pre>${escapeHtml(pretty(record.payload))}</pre>
          <dl><dt>ID</dt><dd>${escapeHtml(record.runId)}:${record.sequence}</dd><dt>Actor</dt><dd>${escapeHtml(record.actorType ?? "unknown")}</dd></dl>
        </details>
      </div>
    </article>
    `).join("");
    const evidence = run.inspection.evidence.map((item) => `
    <article class="trajectory-row evidence-row" data-activity-stage="verify"><span class="sequence">E</span><div class="trajectory-main"><strong>${escapeHtml(item.kind)}</strong><small>${formatTime(item.producedAt)}</small><details><summary>Evidence</summary><pre>${escapeHtml(pretty(item))}</pre></details></div></article>
    `).join("");
    return `<section class="run-trajectory"><h3>Turn ${index + 1} · ${escapeHtml(run.inspection.runId)}</h3>${records}${evidence}</section>`;
  }).join("");
  return `<section class="trajectory"><div class="trajectory-heading"><div><span class="eyebrow">SESSION TRACE</span><h2>Activity</h2><p>Follow the execution path from request to verified result.</p></div><div class="trajectory-summary"><strong>${timeline.total}</strong><span>events</span><i></i><strong>${timeline.runs}</strong><span>turns</span></div></div>${timeline.html}${runs}</section>`;
}

function matchesSidebarFilter(session: DesktopSnapshot["workspace"]["projects"][number]["sessions"][number]): boolean {
  const query = sidebarQuery.trim().toLowerCase();
  if (query !== "" && !session.title.toLowerCase().includes(query)) return false;
  if (sidebarStatus === "all") return true;
  if (sidebarStatus === "waiting") return session.status === "waiting_for_input" || session.status === "waiting_for_approval";
  return session.status === sidebarStatus;
}

function activityStage(type: string): "start" | "think" | "tools" | "verify" | "done" {
  const lower = type.toLowerCase();
  if (lower.startsWith("input") || lower.startsWith("run.created") || lower.startsWith("session")) return "start";
  if (lower.includes("model") || lower.includes("provider") || lower.includes("context")) return "think";
  if (lower.startsWith("tool") || lower.includes("invocation") || lower.includes("approval")) return "tools";
  if (lower.includes("validation") || lower.includes("evidence") || lower.includes("artifact")) return "verify";
  return "done";
}

function activityTimeline(session: SessionView): { html: string; total: number; runs: number } {
  const stages = [
    ["start", "Start", "Input received"],
    ["think", "Think", "Model and context"],
    ["tools", "Tools", "Tool execution"],
    ["verify", "Verify", "Evidence checks"],
    ["done", "Done", "Run delivered"]
  ] as const;
  const records = session.runs.flatMap((run, runIndex) => run.history.records.map((record) => ({ runIndex, record })));
  const html = `<nav class="activity-timeline" aria-label="Activity timeline">${stages.map(([key, label, hint]) => {
    const first = records.find(({ record }) => activityStage(record.type) === key);
    const count = records.filter(({ record }) => activityStage(record.type) === key).length;
    return `<button class="timeline-step ${count > 0 ? "has-events" : "muted"}" data-timeline-target="${first === undefined ? "" : `activity-event-${first.runIndex}-${first.record.sequence}`}" title="${hint}"><span class="timeline-dot"></span><strong>${label}</strong><small>${count} ${count === 1 ? "event" : "events"}</small></button>`;
  }).join('<span class="timeline-connector"></span>')}</nav>`;
  return { html, total: records.length, runs: session.runs.length };
}

function plan(session: SessionView | null): string {
  const current = session?.inspection.plan;
  if (current === null || current === undefined) return "";
  const progress = new Map(session!.inspection.progress.map((item) => [item.stepId, item.status]));
  const active = current.orderedSteps.find((step) => progress.get(step.id) === "active") ?? current.orderedSteps.find((step) => progress.get(step.id) !== "completed");
  const completed = current.orderedSteps.filter((step) => progress.get(step.id) === "completed").length;
  const activeCount = current.orderedSteps.filter((step) => progress.get(step.id) === "active").length;
  const pending = current.orderedSteps.length - completed - activeCount;
  return `
    <section class="plan-strip ${planOpen ? "open" : ""}">
      <button data-action="plan" aria-expanded="${planOpen}"><span class="plan-icon">☷</span><span class="plan-title">Tasks</span><strong>${escapeHtml(active?.objective ?? "Plan complete")}</strong><span class="plan-counts">${completed} completed · ${activeCount} active · ${pending} pending</span><span class="disclosure">${planOpen ? "⌃" : "⌄"}</span></button>
      ${planOpen ? `<ol>${current.orderedSteps.map((step) => `<li class="${progress.get(step.id) ?? "pending"}"><span>${progress.get(step.id) === "completed" ? "✓" : progress.get(step.id) === "active" ? "●" : "○"}</span>${escapeHtml(step.objective)}</li>`).join("")}</ol>` : ""}
    </section>
  `;
}

function composer(session: SessionView | null): string {
  if (session === null) return goalComposer();
  const run = session.inspection;
  if (run.status === "waiting_for_input" && run.pendingRequest?.kind === "input") {
    return inputReplyComposer();
  }
  if (run.status === "waiting_for_approval" && run.pendingRequest?.kind === "approval") {
    return `<section class="composer approval"><div><small>Approval required · ${escapeHtml(run.pendingRequest.toolName)}</small><p>${escapeHtml(run.pendingRequest.prompt)}</p><details><summary>Operation</summary><pre>${escapeHtml(pretty(run.pendingRequest.input))}</pre></details></div><div class="approval-actions"><button data-action="deny" ${busy ? "disabled" : ""}>Reject</button><button class="primary" data-action="approve" ${busy ? "disabled" : ""}>Approve</button></div></section>`;
  }
  if (run.status === "running") {
    return followUpComposer(session, true);
  }
  if (run.status === "blocked") {
    if (run.workerRecoveries.length > 0) {
      return `<section class="composer recovery"><div><small>Worker recovery required</small><p>${run.workerRecoveries.length} delegated Worker Run(s) paused. Resume the same Worker or discard its isolated Branch.</p></div><div class="recovery-actions">${run.workerRecoveries.map((item) => `<button data-worker-action="discard" data-branch-id="${escapeAttr(item.branchId)}">Discard</button><button class="primary" data-worker-action="resume" data-child-id="${escapeAttr(item.childRunId)}">Resume Worker</button>`).join("")}</div></section>`;
    }
    if (run.recovery !== null) {
      return `<section class="composer recovery"><div><small>Recovery required · ${escapeHtml(run.recovery.toolName)}</small><p>The Tool result is unknown. Confirm the real external outcome.</p><input id="subject-ref" placeholder="Subject reference for confirmed success" /></div><div class="recovery-actions"><button data-recovery="abandon_run">Abandon</button><button data-recovery="confirmed_failed">It failed</button><button class="primary" data-recovery="confirmed_succeeded">It succeeded</button></div></section>`;
    }
    if (run.stopReason === "NO_PROGRESS_DETECTED") {
      return `<section class="composer recovery"><div><small>Recovery required · no progress</small><p>${escapeHtml(run.delivery?.summary ?? "The same strategy produced no new authoritative facts.")}</p></div><form data-form="follow-up"><textarea name="text" placeholder="Describe a materially different next step..." required>${escapeHtml(draft)}</textarea><div class="composer-toolbar"><small>New input creates a bounded recovery Run</small><div class="composer-controls"><button class="send-button" aria-label="Replan and continue" ${busy ? "disabled" : ""}>↑</button></div></div></form><button data-action="cancel" ${busy ? "disabled" : ""}>End task</button></section>`;
    }
    if (
      (run.stopReason === "PROVIDER_UNAVAILABLE" || run.stopReason === "CONTEXT_CAPACITY_EXCEEDED")
      && providerRecoveryExhausted(session)
    ) {
      return `<section class="composer recovery"><div><small>Recovery required · Provider retry exhausted</small><p>${escapeHtml(run.delivery?.summary ?? "The bounded Provider retry did not restore execution.")}</p></div><form data-form="follow-up"><textarea name="text" placeholder="Provide a corrective instruction after Provider connectivity is restored..." required>${escapeHtml(draft)}</textarea><div class="composer-toolbar"><small>New input creates a bounded continuation Run</small><div class="composer-controls"><button class="send-button" aria-label="Continue in a new recovery turn" ${busy ? "disabled" : ""}>↑</button></div></div></form><button data-action="cancel" ${busy ? "disabled" : ""}>End task</button></section>`;
    }
    const durationWithoutProgress = run.stopReason === "DURATION_BUDGET_EXCEEDED" && run.executionMetrics.repeatedToolCalls > 0;
    if (durationWithoutProgress) {
      return `<section class="composer recovery"><div><small>Recovery required · no recent progress</small><p>${escapeHtml(run.delivery?.summary ?? "The time budget ended while execution was repeating work.")}</p></div><form data-form="follow-up"><textarea name="text" placeholder="Provide a new constraint or next step..." required>${escapeHtml(draft)}</textarea><div class="composer-toolbar"><small>Continue with new input or start a new task</small><div class="composer-controls"><button class="send-button" aria-label="Continue with new input" ${busy ? "disabled" : ""}>↑</button></div></div></form><button data-action="cancel" ${busy ? "disabled" : ""}>End task</button></section>`;
    }
    const budget = run.stopReason?.endsWith("BUDGET_EXCEEDED") === true;
    const metrics = run.executionMetrics;
    const quality = budget ? ` · ${metrics.modelCalls} model / ${metrics.toolCalls} tool calls · ${metrics.repeatedToolCalls} repeated` : "";
    return `<section class="composer blocked"><div><small>Session paused${quality}</small><p>${escapeHtml(run.delivery?.summary ?? run.stopReason ?? "The Runtime requires intervention.")}</p></div><button class="${budget && metrics.repeatedToolCalls === 0 ? "primary" : ""}" data-action="${budget ? "extend-budget" : "resume"}" ${busy ? "disabled" : ""}>${budget ? "Extend budget & resume" : "Resume"}</button></section>`;
  }
  return followUpComposer(session, false);
}

function providerRecoveryExhausted(session: SessionView): boolean {
  let progressSequence = 0;
  for (const record of session.history.records) {
    const payload = record.payload as Record<string, unknown>;
    const progress = (record.type === "run.resumed" && typeof payload.inputSequence === "number")
      || (record.type === "plan.set" && payload.noOp !== true)
      || record.type === "tool.attempt.succeeded"
      || record.type === "context.evidence_recorded"
      || record.type === "validation.passed"
      || record.type === "recovery.confirmed_succeeded"
      || record.type === "recovery.confirmed_failed"
      || record.type === "branch.merged";
    if (progress) progressSequence = record.sequence;
  }
  return session.history.records.some((record) => (
    record.sequence > progressSequence
    && record.type === "run.resumed"
    && (record.payload as Record<string, unknown>).reason === "provider_retry"
  ));
}

function inputReplyComposer(): string {
  return `<section class="composer follow-up">
    <form data-form="input">
      <textarea name="text" placeholder="Reply to Nexora…" required>${escapeHtml(draft)}</textarea>
      ${composerToolbar(`<button class="send-button" aria-label="Send reply" ${busy ? "disabled" : ""}>↑</button>`, "Waiting for your reply")}
    </form>
  </section>`;
}

function goalComposer(): string {
  return `<section class="composer goal"><form data-form="goal"><textarea name="goal" placeholder="Describe a task for Nexora…" required>${escapeHtml(draft)}</textarea>${composerToolbar(`<button class="send-button" aria-label="Start task" ${busy ? "disabled" : ""}>↑</button>`, "Enter to send · Shift+Enter for a new line")}</form></section>`;
}

function followUpComposer(session: SessionView, running: boolean): string {
  return `<section class="composer follow-up ${running ? "is-running" : ""}">
    <form data-form="follow-up">
      <textarea name="text" placeholder="${running ? "Type to interrupt and send…" : "Continue this Session…"}" required>${escapeHtml(draft)}</textarea>
      ${composerToolbar(`
        ${running ? `<button type="button" class="stop-button" data-action="cancel" title="Stop current Run" ${busy ? "disabled" : ""}>■</button>` : ""}
        <button class="send-button" aria-label="${running ? "Interrupt and send" : "Send follow-up"}" ${busy ? "disabled" : ""}>↑</button>
      `, running ? "Running · sending safely interrupts this turn" : `${statusLabel(session.inspection.status)} · /压缩上下文`)}
    </form>
  </section>`;
}

function composerToolbar(actions: string, hint: string): string {
  return `<div class="composer-toolbar"><small>${escapeHtml(hint)}</small><div class="composer-controls">${modelSelector()}${actions}</div></div>`;
}

function modelSelector(): string {
  const workspace = snapshot?.workspace;
  if (workspace === undefined || workspace.modelProfiles.length === 0) return "";
  return `<select class="model-switch" data-profile-select title="Model for new Runs in this Project">${workspace.modelProfiles.map((profile) => `<option value="${escapeAttr(profile.id)}" ${profile.id === workspace.selectedModelProfileId ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}</select>`;
}

function settings(state: DesktopSnapshot): string {
  const profiles = state.workspace.modelProfiles;
  const editingId = editingProfileId ?? state.workspace.selectedModelProfileId ?? "new";
  const profile = profiles.find((item) => item.id === editingId);
  const providers = [...new Map(profiles.map((item) => [item.baseUrl.trim().replace(/\/+$/, "").toLowerCase(), item])).values()];
  const providerValue = profile?.baseUrl ?? editingProviderBaseUrl ?? providers[0]?.baseUrl ?? "new";
  const addingProvider = providerValue === "new";
  return `<div class="modal-backdrop" data-action="close-settings"><section class="settings-modal" role="dialog" aria-modal="true">
    <header><div><h2>Global model settings</h2><small>Available to all Projects · ${escapeHtml(state.workspace.name)} selects one model</small></div><button data-action="close-settings">×</button></header>
    <div class="model-profile-list">${profiles.map((item) => `<div class="model-profile-row ${item.id === state.workspace.selectedModelProfileId ? "selected" : ""}"><button data-profile-edit="${escapeAttr(item.id)}"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.model)}</small></button><button data-profile-delete="${escapeAttr(item.id)}" title="Delete model">×</button></div>`).join("")}<button class="new-model" data-profile-edit="new">＋ Add model</button></div>
    <form data-form="model-profile" class="settings-form">
      ${profile === undefined ? "" : `<input type="hidden" name="id" value="${escapeAttr(profile.id)}" />`}
      <label>Name<input name="name" value="${escapeAttr(profile?.name ?? "")}" placeholder="Work model" required /></label>
      <label>Provider<select name="providerBaseUrl" data-provider-select>${providers.map((item) => `<option value="${escapeAttr(item.baseUrl)}" ${providerValue === item.baseUrl ? "selected" : ""}>${escapeHtml(providerName(item.baseUrl))}</option>`).join("")}<option value="new" ${addingProvider ? "selected" : ""}>＋ New provider</option></select></label>
      ${addingProvider ? `<label>Base URL<input name="baseUrl" type="url" value="" placeholder="https://provider.example/v1" required /></label>` : ""}
      <label>API Key<input name="apiKey" type="password" placeholder="${addingProvider ? "Required for new provider" : "Shared by this provider · leave blank to keep"}" ${addingProvider ? "required" : ""} /></label>
      <label>Model ID<input name="model" value="${escapeAttr(profile?.model ?? "")}" placeholder="Model identifier" required /></label>
      <div class="settings-grid"><label>Context window<input name="contextWindowTokens" type="number" min="1" value="${profile?.contextWindowTokens ?? ""}" placeholder="Known model default" /></label><label>Active context target<input name="activeInputTargetTokens" type="number" min="1" value="${profile?.activeInputTargetTokens ?? ""}" placeholder="Optional cost limit" /></label><label>Decision tokens<input name="decisionOutputTokens" type="number" min="1" value="${profile?.decisionOutputTokens ?? 4096}" required /></label></div>
      <label>Tool transport<select name="transport"><option value="native_tools" ${profile?.transport !== "structured_output" ? "selected" : ""}>Native tools · streaming</option><option value="structured_output" ${profile?.transport === "structured_output" ? "selected" : ""}>Structured output</option></select></label>
      <div class="settings-grid"><label>Reasoning<select name="reasoning"><option value="dynamic" ${profile?.reasoning !== "off" && profile?.reasoning !== "on" ? "selected" : ""}>Dynamic</option><option value="off" ${profile?.reasoning === "off" ? "selected" : ""}>Off</option><option value="on" ${profile?.reasoning === "on" ? "selected" : ""}>On</option></select></label><label>Thinking parameter<input name="thinkingToggleParam" value="${escapeAttr(profile?.thinkingToggleParam ?? "")}" placeholder="DashScope: enable_thinking" /></label></div>
      <button class="primary" ${busy ? "disabled" : ""}>${profile === undefined ? "Add model" : "Save model"}</button>
    </form>
    <p>Providers, API Keys and models are global to Nexora Desktop. Each Project selects one model for future Runs. Active Runs keep their existing Provider. API Keys are never returned to the Renderer; a Project selection is mirrored to its <code>.env</code> for CLI compatibility.</p>
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
  document.querySelector<HTMLInputElement>("[data-session-search]")?.addEventListener("input", (event) => {
    sidebarQuery = (event.currentTarget as HTMLInputElement).value;
    render();
    const input = document.querySelector<HTMLInputElement>("[data-session-search]");
    input?.focus();
    input?.setSelectionRange(sidebarQuery.length, sidebarQuery.length);
  });
  document.querySelector<HTMLSelectElement>("[data-status-filter]")?.addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    sidebarStatus = value === "running" || value === "waiting" || value === "succeeded" || value === "failed" ? value : "all";
    render();
  });
  document.querySelectorAll<HTMLElement>("[data-timeline-target]").forEach((element) => element.addEventListener("click", () => {
    const target = element.dataset.timelineTarget;
    if (target === undefined || target === "") return;
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  document.querySelectorAll<HTMLElement>("[data-process-logs]").forEach((element) => element.addEventListener("click", () => {
    const handle = element.dataset.processLogs;
    const sessionId = snapshot?.session?.id;
    if (handle === undefined || sessionId === undefined) return;
    void perform(async () => setSnapshot(await window.nexora.continueSession(sessionId, `查看受管理进程 ${handle} 的最新日志并报告当前状态。`)));
  }));
  document.querySelectorAll<HTMLElement>("[data-process-stop]").forEach((element) => element.addEventListener("click", () => {
    const handle = element.dataset.processStop;
    const sessionId = snapshot?.session?.id;
    if (handle === undefined || sessionId === undefined || !window.confirm("Stop this managed process and its descendants?")) return;
    void perform(async () => setSnapshot(await window.nexora.continueSession(sessionId, `停止受管理进程 ${handle}，确认完整进程树已经退出。`)));
  }));
  document.querySelectorAll<HTMLElement>("[data-tool]").forEach((element) => element.addEventListener("click", () => {
    const id = element.dataset.tool!;
    if (expandedTools.has(id)) expandedTools.delete(id); else expandedTools.add(id);
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-public-output-toggle]").forEach((element) => element.addEventListener("click", () => {
    const key = element.dataset.publicOutputToggle!;
    if (expandedPublicOutputs.has(key)) expandedPublicOutputs.delete(key); else expandedPublicOutputs.add(key);
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-workspace-entry]").forEach((element) => element.addEventListener("click", () => {
    const entryPath = element.dataset.workspaceEntry;
    const projectPath = snapshot?.workspace.path;
    if (entryPath !== undefined && projectPath !== undefined) void perform(() => window.nexora.openWorkspaceEntry(projectPath, entryPath));
  }));
  document.querySelectorAll<HTMLAnchorElement>(".markdown-body a[href]").forEach((element) => element.addEventListener("click", (event) => {
    event.preventDefault();
    void perform(() => window.nexora.openExternal(element.href));
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
    else if (action === "dismiss-skill-notice") { skillNotice = null; render(); }
    else if (action === "plan") { planOpen = !planOpen; render(); }
    else if (["approve", "deny", "cancel", "resume", "extend-budget"].includes(action ?? "")) void controlAction(action!);
  }));
  document.querySelectorAll<HTMLElement>("[data-recovery]").forEach((element) => element.addEventListener("click", () => void recoveryAction(element.dataset.recovery!)));
  document.querySelectorAll<HTMLElement>("[data-worker-action]").forEach((element) => element.addEventListener("click", () => {
    if (element.dataset.workerAction === "resume" && element.dataset.childId !== undefined) {
      const recovery = snapshot?.session?.inspection.workerRecoveries.find((item) => item.childRunId === element.dataset.childId);
      if (recovery !== undefined) void sendControl({ type: "worker_resume", branchId: recovery.branchId, childRunId: recovery.childRunId });
    } else if (element.dataset.workerAction === "discard" && element.dataset.branchId !== undefined) {
      void sendControl({ type: "worker_discard", branchId: element.dataset.branchId });
    }
  }));
  document.querySelector<HTMLSelectElement>("[data-profile-select]")?.addEventListener("change", (event) => {
    const id = (event.currentTarget as HTMLSelectElement).value;
    void perform(() => window.nexora.selectModelProfile(id).then(setSnapshot));
  });
  document.querySelectorAll<HTMLElement>("[data-profile-edit]").forEach((element) => element.addEventListener("click", () => {
    editingProfileId = element.dataset.profileEdit ?? "new";
    const selected = snapshot?.workspace.modelProfiles.find((item) => item.id === editingProfileId);
    editingProviderBaseUrl = selected?.baseUrl ?? snapshot?.workspace.modelProfiles[0]?.baseUrl ?? "new";
    render();
  }));
  document.querySelector<HTMLSelectElement>("[data-provider-select]")?.addEventListener("change", (event) => {
    editingProviderBaseUrl = (event.currentTarget as HTMLSelectElement).value;
    render();
  });
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
    if (typeof text === "string" && request?.kind === "input") {
      draft = "";
      void sendControl({ type: "input", text, requestId: request.id });
    }
  });
  document.querySelector<HTMLFormElement>("[data-form='follow-up']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget as HTMLFormElement).get("text");
    const sessionId = snapshot?.session?.id;
    if (typeof text === "string" && sessionId !== undefined) void perform(async () => {
      const command = text.trim().toLowerCase();
      const next = command === "/压缩上下文" || command === "/compact"
        ? await window.nexora.compactSession(sessionId)
        : await window.nexora.continueSession(sessionId, text);
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
      const activeInputTargetTokens = Number(data.get("activeInputTargetTokens"));
      const id = String(data.get("id") ?? "").trim();
      const providerBaseUrl = String(data.get("providerBaseUrl") ?? "new");
      const reasoning = String(data.get("reasoning") ?? "dynamic");
      const next = await window.nexora.saveModelProfile({
        ...(id ? { id } : {}),
        name: String(data.get("name") ?? ""),
        baseUrl: providerBaseUrl === "new" ? String(data.get("baseUrl") ?? "") : providerBaseUrl,
        ...(typeof apiKey === "string" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model: String(data.get("model") ?? ""),
        ...(Number.isInteger(contextWindowTokens) && contextWindowTokens > 0 ? { contextWindowTokens } : {}),
        ...(Number.isInteger(activeInputTargetTokens) && activeInputTargetTokens > 0 ? { activeInputTargetTokens } : {}),
        decisionOutputTokens: Number(data.get("decisionOutputTokens")),
        transport: data.get("transport") === "structured_output" ? "structured_output" : "native_tools",
        reasoning: reasoning === "off" || reasoning === "on" ? reasoning : "dynamic",
        thinkingToggleParam: String(data.get("thinkingToggleParam") ?? "").trim() || null
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

function publicOutputSegments(run: SessionView["runs"][number]): PublicOutputSegment[] {
  const segments = new Map<string, PublicOutputSegment>();
  for (const output of run.publicOutputs) {
    if (output.reasoning !== "") {
      const key = `${output.key}:reasoning`;
      segments.set(key, {
        key,
        baseKey: output.key,
        runId: output.runId,
        occurredAt: output.occurredAt,
        channel: "reasoning",
        text: output.reasoning,
        completed: true
      });
    }
    if (output.content !== "") {
      const key = `${output.key}:content`;
      segments.set(key, {
        key,
        baseKey: output.key,
        runId: output.runId,
        occurredAt: output.occurredAt,
        channel: "content",
        text: output.content,
        completed: true
      });
    }
  }
  for (const output of publicOutputs.values()) {
    if (output.runId === run.inspection.runId) segments.set(output.key, output);
  }
  return [...segments.values()];
}

function updatePublicOutput(event: AgentPublicOutputEvent): void {
  const baseKey = `${event.runId}:${event.modelCallId}:${event.attemptId}`;
  if (event.type === "text.discarded") {
    for (const [key, output] of publicOutputs) {
      if (output.baseKey !== baseKey) continue;
      publicOutputBatcher.discard(key);
      publicOutputs.delete(key);
    }
    render();
    return;
  }
  if (event.type === "text.completed") {
    for (const [key, output] of publicOutputs) {
      if (output.baseKey !== baseKey) continue;
      output.completed = true;
      publicOutputBatcher.queue(key);
    }
    return;
  }
  if (event.type !== "text.delta") return;
  const key = `${baseKey}:${event.channel}`;
  const existing = publicOutputs.get(key);
  if (existing === undefined) {
    publicOutputs.set(key, {
      key,
      baseKey,
      runId: event.runId,
      occurredAt: event.occurredAt,
      channel: event.channel,
      text: event.text,
      completed: false
    });
    render();
    return;
  }
  existing.text += event.text;
  publicOutputBatcher.queue(key);
}

function flushPublicOutputs(keys: readonly string[]): void {
  for (const key of keys) {
    const output = publicOutputs.get(key);
    if (output === undefined) continue;
    const element = document.querySelector<HTMLElement>(`[data-public-output="${CSS.escape(key)}"]`);
    if (element === null) continue;
    element.classList.toggle("streaming", !output.completed);
    element.classList.toggle("completed", output.completed);
    const label = element.querySelector<HTMLElement>(".message-label, .public-output-label");
    if (label !== null) {
      const prefix = output.channel === "reasoning" ? "Think" : "Nexora";
      label.textContent = output.completed ? prefix : `${prefix} · Streaming`;
    }
    const preview = element.querySelector<HTMLElement>(".think-preview");
    if (preview !== null) preview.textContent = compactLatest(output.text, 180);
    const body = element.querySelector<HTMLElement>(".markdown-body");
    if (body === null) continue;
    body.innerHTML = renderMarkdown(output.text);
  }
}

function deliverableLinks(outputs: readonly WorkspaceOutput[]): string {
  if (outputs.length === 0) return "";
  return `<div class="deliverables"><small>Outputs</small><div class="deliverable-links">${outputs.map((output) => `
    <button class="deliverable-link" data-workspace-entry="${escapeAttr(output.path)}"><span>↗</span><span>Open ${output.kind} · ${escapeHtml(output.name)}</span></button>
  `).join("")}</div></div>`;
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

function setSnapshot(next: DesktopSnapshot): void {
  detectSkillSelection(next, snapshotInitialized);
  snapshot = next;
  snapshotInitialized = true;
  busy = false;
  error = null;
  render();
}

function detectSkillSelection(next: DesktopSnapshot, allowNotice: boolean): void {
  for (const run of next.session?.runs ?? []) {
    for (const record of run.history.records) {
      if (record.type !== "model.turn") continue;
      const payload = objectValue(record.payload);
      if (!arrayValue(payload.compiledActionTypes).includes("select_skills")) continue;
      const call = arrayValue(payload.toolCalls).find((item) => objectValue(item).name === "nexora_select_skills");
      const args = call === undefined ? {} : objectValue(objectValue(call).arguments);
      const names = arrayValue(args.skills).flatMap((item) => {
        const id = stringValue(objectValue(item).id);
        return id === null ? [] : [id];
      });
      if (names.length === 0) continue;
      const key = `${record.runId}:${record.sequence}`;
      if (seenSkillSelections.has(key)) continue;
      seenSkillSelections.add(key);
      if (!allowNotice) continue;
      skillNotice = { names, key };
      if (skillNoticeTimer !== null) window.clearTimeout(skillNoticeTimer);
      skillNoticeTimer = window.setTimeout(() => { skillNotice = null; render(); }, 5_000);
    }
  }
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function showArtifact(text: string, truncated: boolean): void {
  const dialog = document.createElement("dialog");
  dialog.className = "artifact-dialog";
  dialog.innerHTML = `<header><strong>Artifact${truncated ? " · preview" : ""}</strong><button>×</button></header><pre>${escapeHtml(text)}</pre>`;
  dialog.querySelector("button")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function toolPresentation(name: string, input: unknown): { action: string; target: string | null; workspacePath: string | null } {
  const value = objectValue(input);
  const target = stringValue(value.path) ?? stringValue(value.query) ?? stringValue(value.command) ?? stringValue(value.pattern);
  const lower = name.toLowerCase();
  const action = lower.includes("read") ? "Read" : lower.includes("search") ? "Search" : lower.includes("write") || lower.includes("patch") ? "Write" : lower.includes("shell") || lower.includes("command") ? "Run" : humanize(name);
  return {
    action,
    target: target === null ? null : compact(target, 120),
    workspacePath: stringValue(value.path)
  };
}
function contextUsage(session: SessionView): { used: number; target: number; window: number; percent: number } | null {
  const usage = session.inspection.contextUsage;
  if (usage === null) return null;
  return { used: usage.inputTokens, target: usage.softInputLimitTokens, window: usage.contextWindowTokens, percent: Math.min(100, Math.round(usage.inputTokens / usage.contextWindowTokens * 100)) };
}
function latestCompaction(session: SessionView): "manual" | null {
  const records = session.history.records;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type === "context.compaction.requested") return "manual";
  }
  return null;
}
function processingEnd(run: SessionView["runs"][number]): string | null {
  if (run.inspection.result !== null) return run.inspection.result.delivery.createdAt;
  if (run.inspection.pendingRequest !== null) return run.inspection.pendingRequest.createdAt;
  if (run.inspection.status === "running") return null;
  const candidates = [
    ...run.history.records.map((record) => record.occurredAt),
    ...run.inspection.invocations.map((invocation) => invocation.completedAt ?? invocation.startedAt)
  ];
  return candidates.sort().at(-1) ?? run.inspection.inputs.at(-1)?.receivedAt ?? null;
}
function processingDuration(start: string, end: string | null): string {
  const elapsed = Math.max(0, Date.parse(end ?? new Date().toISOString()) - Date.parse(start));
  return `${end === null ? "已处理" : "处理耗时"} ${formatElapsed(elapsed)}`;
}
function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
function updateElapsedLabels(): void {
  document.querySelectorAll<HTMLElement>("[data-elapsed-start]").forEach((element) => {
    const start = element.dataset.elapsedStart;
    if (start !== undefined) element.textContent = processingDuration(start, element.dataset.elapsedEnd ?? null);
  });
}
function formatTokens(value: number): string { return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value); }
function providerName(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.replace(/^api\./, ""); }
  catch { return baseUrl; }
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
