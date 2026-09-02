import type {
  AttachmentView,
  DeliverablePreview,
  DeliverableSummary,
  DesktopBridge,
  DesktopSnapshot,
  ModelProfileView,
  SessionControl,
  SessionView
} from "../shared.js";
import type { AgentPublicOutputEvent } from "@nexora/harness";
import { shouldSendOnEnter } from "./keyboard.js";
import { renderMarkdown } from "./markdown.js";
import { createPublicOutputBatcher, PUBLIC_OUTPUT_FLUSH_MS } from "./public-output-batcher.js";
import { compactLatest, isFormalResultContent } from "./public-output-view.js";
import { formatTokenCount, parseTokenCount, resolveTokenInput } from "./token-units.js";
import {
  contentViewportKey,
  isContentAtBottom,
  modelIdValidationMessage,
  projectRuntimeControls,
  shouldShowTaskExecution,
  type DesktopViewMode
} from "./ui-projection.js";

declare global {
  interface Window { nexora: DesktopBridge }
}

const root = document.querySelector<HTMLElement>("#app")!;
let snapshot: DesktopSnapshot | null = null;
let mode: DesktopViewMode = "conversation";
let planOpen = false;
let settingsOpen = false;
let editingProfileId: string | null = null;
type ModelSettingsDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: string;
  contextWindowTokens: number | null;
  contextWindowEdited: boolean;
  activeMode: "auto" | "custom";
  activeTarget: string;
  activeTargetTokens: number | null;
  activeTargetEdited: boolean;
  decisionOutput: string;
  decisionOutputTokens: number;
  decisionOutputEdited: boolean;
  transport: "native_tools" | "structured_output";
  reasoning: "off" | "dynamic" | "on";
  thinkingToggleParam: string;
};
type AddModelDraft = { providerBaseUrl: string; baseUrl: string; apiKey: string; model: string; name: string; contextWindow: string };
let settingsDraft: ModelSettingsDraft | null = null;
let settingsErrors: Partial<Record<keyof ModelSettingsDraft, string>> = {};
let settingsAdvancedOpen = false;
let apiKeyEditing = false;
let addModelOpen = false;
let addModelDraft: AddModelDraft | null = null;
let addModelError: string | null = null;
let busy = false;
let error: string | null = null;
let draft = "";
let draftAttachments: AttachmentView[] = [];
let composerAddOpen = false;
let modelMenuOpen = false;
let modelMenuIndex = 0;
let sidebarQuery = "";
let sidebarSearchOpen = false;
let sidebarStatus: "all" | "running" | "waiting" | "succeeded" | "failed" = "all";
let sidebarMenuOpen = false;
let sessionMenuKey: string | null = null;
let workspaceMenuKey: string | null = null;
let removeWorkspacePath: string | null = null;
let showAllSessions = new Set<string>();
let sidebarScrollTop = 0;
const contentScrollPositions = new Map<string, { top: number; following: boolean }>();
let lastContentMarkup = "";
let lastContentKey: string | null = null;
const pinnedSessions = new Set<string>();
const pinnedWorkspaces = new Set<string>();
let skillNotice: { readonly names: readonly string[]; readonly key: string } | null = null;
let skillNoticeTimer: number | null = null;
let snapshotInitialized = false;
const seenSkillSelections = new Set<string>();
const expandedTools = new Set<string>();
const expandedPublicOutputs = new Set<string>();
const expandedEvidence = new Set<string>();
const collapsedProjects = new Set<string>();
const deliverablePreviews = new Map<string, DeliverablePreview>();
const loadingDeliverables = new Set<string>();
const unavailableDeliverables = new Map<string, string>();
let selectedDeliverableId: string | null = null;
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
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (addModelOpen) { event.preventDefault(); closeAddModel(); return; }
  if (settingsOpen) { event.preventDefault(); requestCloseSettings(); }
});

window.nexora.onSnapshot((next) => {
  setSnapshot(next);
});
window.nexora.onError((message) => {
  busy = false;
  error = message;
  render();
});
window.nexora.onPublicOutput((event) => updatePublicOutput(event));

void window.nexora.bootstrap()
  .then((next) => setSnapshot(next))
  .catch((cause: unknown) => { error = messageOf(cause); render(); });

function render(): void {
  document.body.classList.toggle("settings-open", settingsOpen);
  const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
  const focusedName = focused?.name;
  const selection = focused === null ? null : [focused.selectionStart, focused.selectionEnd] as const;
  if (snapshot === null) {
    root.innerHTML = `<section class="loading">${error === null ? "正在打开 Nexora…" : errorView(error)}</section>`;
    return;
  }
  const contentMarkup = snapshot.session === null
    ? emptyState()
    : mode === "conversation"
      ? conversation(snapshot.session)
      : outputView(snapshot.session);
  const nextContentKey = contentViewportKey(snapshot.workspace.path, snapshot.session?.id ?? null, mode);
  const persistentContent = root.querySelector<HTMLElement>(".content-scroll");
  const previousContentKey = persistentContent?.dataset.contentKey ?? null;
  const previousScrollTop = persistentContent?.scrollTop ?? 0;
  const previousFollowing = persistentContent === null ? true : isContentAtBottom(persistentContent);
  if (persistentContent !== null && previousContentKey !== null) {
    contentScrollPositions.set(previousContentKey, { top: persistentContent.scrollTop, following: previousFollowing });
    persistentContent.remove();
  }
  root.innerHTML = `
    <div class="shell">
      ${sidebar(snapshot)}
      <section class="main-column">
        ${header(snapshot)}
        <div class="content-scroll" data-content-key="${escapeAttr(nextContentKey)}"></div>
        ${plan(snapshot.session)}
        ${composer(snapshot.session)}
        <button class="back-to-bottom" data-action="back-to-bottom" ${previousFollowing ? "hidden" : ""} aria-label="回到底部">↓ 回到底部</button>
      </section>
    </div>
    ${settingsOpen ? settings(snapshot) : ""}
    ${removeWorkspacePath === null ? "" : `<div class="modal-backdrop workspace-remove-dialog"><section class="workspace-remove-modal" role="dialog" aria-modal="true" aria-labelledby="remove-workspace-title"><h2 id="remove-workspace-title">移除“${escapeHtml(removeWorkspacePath.split("\\").pop() ?? removeWorkspacePath)}”？</h2><p>这只会将工作区从 Nexora 中移除，不会删除本地文件。</p><div class="dialog-actions"><button data-action="cancel-remove-workspace">取消</button><button class="danger-action" data-action="confirm-remove-workspace">移除</button></div></section></div>`}
    ${skillNotice === null ? "" : `<div class="skill-toast" role="status"><span class="skill-toast-icon">✦</span><span>已自动加载 Skill：${escapeHtml(skillNotice.names.join("、"))}</span><button data-action="dismiss-skill-notice" aria-label="关闭 Skill 提示">×</button></div>`}
    ${error === null ? "" : `<div class="toast" role="alert"><span>${escapeHtml(error)}</span><button data-action="dismiss-error">×</button></div>`}
  `;
  const contentPlaceholder = root.querySelector<HTMLElement>(".content-scroll")!;
  const content = persistentContent ?? contentPlaceholder;
  if (persistentContent !== null) contentPlaceholder.replaceWith(persistentContent);
  const contentChanged = lastContentKey !== nextContentKey || lastContentMarkup !== contentMarkup;
  if (contentChanged) content.innerHTML = contentMarkup;
  content.dataset.contentKey = nextContentKey;
  lastContentKey = nextContentKey;
  lastContentMarkup = contentMarkup;
  bindActions();
  if (focusedName !== undefined) {
    const next = document.querySelector<HTMLTextAreaElement>(`textarea[name='${focusedName}']`);
    if (next !== null) {
      next.focus();
      if (selection !== null) next.setSelectionRange(selection[0], selection[1]);
    }
  }
  if (previousContentKey === nextContentKey) {
    content.scrollTop = previousFollowing ? content.scrollHeight : previousScrollTop;
  } else {
    const saved = contentScrollPositions.get(nextContentKey);
    if (saved !== undefined) content.scrollTop = saved.following ? content.scrollHeight : saved.top;
    else content.scrollTop = mode === "conversation" && snapshot.session !== null ? content.scrollHeight : 0;
  }
  const nextSidebar = document.querySelector<HTMLElement>(".session-list");
  if (nextSidebar !== null) nextSidebar.scrollTop = Math.min(sidebarScrollTop, Math.max(0, nextSidebar.scrollHeight - nextSidebar.clientHeight));
}

function sidebar(state: DesktopSnapshot): string {
  const projects = [...state.workspace.projects].sort((a, b) => Number(pinnedWorkspaces.has(b.path.toLowerCase())) - Number(pinnedWorkspaces.has(a.path.toLowerCase()))).map((project) => {
    const current = project.path.toLowerCase() === state.workspace.path.toLowerCase();
    const collapsed = collapsedProjects.has(project.path.toLowerCase());
    const active = project.sessions.filter((session) => !session.archived);
    const archived = project.sessions.filter((session) => session.archived);
    const rows = (sessions: typeof project.sessions, archivedGroup: boolean) => {
      const visible = sessions.filter((session) => archivedGroup || matchesSidebarFilter(session)).sort((a, b) => Number(pinnedSessions.has(b.id)) - Number(pinnedSessions.has(a.id)));
      const key = project.path.toLowerCase();
      const limited = archivedGroup || showAllSessions.has(key) ? visible : visible.slice(0, 10);
      return limited.map((session) => `
      <div class="session-row ${state.session?.id === session.id ? "selected" : ""}" data-session-row="${escapeAttr(session.id)}">
        <button class="session-open" data-session="${escapeAttr(session.id)}" data-project-path="${escapeAttr(project.path)}">
          <span class="session-copy"><strong>${escapeHtml(session.title)}</strong>${pinnedSessions.has(session.id) ? `<span class="pin-mark" aria-label="已置顶">${icon("pin")}</span>` : ""}</span>
          ${threadIndicator(session.status, session.pendingRequestKind)}
        </button>
        <span class="session-actions">
          <button class="session-quick-action" title="${pinnedSessions.has(session.id) ? "取消置顶" : "置顶"}" aria-label="${pinnedSessions.has(session.id) ? "取消置顶" : "置顶"}" data-session-pin="${escapeAttr(session.id)}">${icon("pin")}</button>
          <button class="session-quick-action" title="${archivedGroup ? "恢复" : "归档"}" aria-label="${archivedGroup ? "恢复" : "归档"}" data-session-action="archive" data-session="${escapeAttr(session.id)}" data-project-path="${escapeAttr(project.path)}" data-archived="${archivedGroup ? "false" : "true"}">${icon("archive")}</button>
        </span>
      </div>
    `).join("") + (!archivedGroup && visible.length > 10 ? `<button class="show-more" data-show-sessions="${escapeAttr(key)}">${showAllSessions.has(key) ? "收起" : "展开显示"}</button>` : "");
    };
    return `<section class="project-group ${current ? "current" : ""}">
      <div class="project-heading" data-project-row="${escapeAttr(project.path)}"><button class="project-disclosure" data-project-toggle="${escapeAttr(project.path)}" title="${collapsed ? "展开工作区" : "收起工作区"}">${icon(collapsed ? "folder" : "folderOpen")}</button><button class="project-select" data-project-switch="${escapeAttr(project.path)}"><strong>${escapeHtml(project.name)}</strong></button><span class="project-actions"><button class="project-quick-action" data-project-new="${escapeAttr(project.path)}" aria-label="在此工作区新建任务" title="在此工作区新建任务">${icon("plus")}</button><button class="project-quick-action" data-project-menu="${escapeAttr(project.path)}" aria-label="管理工作区" title="管理工作区">${icon("more")}</button></span>${workspaceMenuKey === project.path ? `<div class="workspace-menu" role="menu"><button data-workspace-pin="${escapeAttr(project.path)}">${icon("pin")}${pinnedWorkspaces.has(project.path.toLowerCase()) ? "取消置顶" : "置顶"}</button><div class="menu-divider"></div><button class="danger" data-workspace-remove="${escapeAttr(project.path)}">${icon("trash")}移除工作区</button></div>` : ""}</div>
      ${collapsed ? "" : `<div class="project-sessions">${rows(active, false) || `<p class="sidebar-empty">没有匹配的任务</p>`}${archived.length === 0 ? "" : `<details class="archived"><summary>已归档 · ${archived.length}</summary>${rows(archived, true)}</details>`}</div>`}
    </section>`;
  }).join("");
  return `
    <aside class="sidebar">
      <div class="brand-identity"><img src="./logo.png" alt="" /><strong>Nexora</strong></div>
      <button class="new-task" data-action="new-task"><span>${icon("plus")}</span><span>新建任务</span></button>
      <div class="projects-heading"><span>工作区</span><span class="sidebar-heading-actions"><button class="sidebar-search-trigger" data-action="sidebar-search" aria-label="搜索" title="搜索">${icon("search")}</button><button class="sidebar-search-trigger" data-action="add-workspace" aria-label="添加工作区" title="添加工作区">${icon("plus")}</button><button class="sidebar-search-trigger" data-action="sidebar-menu" aria-label="整理侧边栏" title="整理侧边栏">${icon("more")}</button></span></div>
      ${sidebarSearchOpen ? `<label class="session-search"><span>${icon("search")}</span><input value="${escapeAttr(sidebarQuery)}" data-session-search placeholder="搜索工作区和任务" aria-label="搜索工作区和任务" /></label>` : ""}
      ${sidebarMenuOpen ? `<div class="sidebar-menu" role="menu"><div class="menu-label">整理侧边栏</div><div class="menu-note">${icon("folder")}当前按工作区显示</div><div class="menu-divider"></div><button data-action="sidebar-menu-close">关闭菜单</button></div>` : ""}
      <div class="session-list" aria-label="工作区和任务">${projects}</div>
      <button class="settings-button" data-action="settings">${icon("settings")}<span>设置</span></button>
    </aside>
  `;
}

function icon(name: "plus" | "search" | "more" | "pin" | "folder" | "folderOpen" | "clock" | "settings" | "archive" | "trash" | "file" | "check" | "chevronDown" | "spark"): string {
  const paths: Record<string, string> = { plus: "M12 5v14M5 12h14", search: "m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4", more: "M5 12h.01M12 12h.01M19 12h.01", pin: "M8 4h8l-1 5 3 3H6l3-3-1-5M12 12v8", folder: "M3 6.5h6l2 2H21v10H3z", folderOpen: "M3 7h6l2 2h10l-2 10H3z", clock: "M12 7v5l3 2", settings: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0", archive: "M4 7h16v13H4zM3 4h18v3H3zM9 11h6", trash: "M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3", file: "M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6", check: "m5 12 4 4L19 6", chevronDown: "m7 9 5 5 5-5", spark: "M12 3l1.4 4.1L17 9l-3.6 1.9L12 15l-1.4-4.1L7 9l3.6-1.9z" };
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

function header(state: DesktopSnapshot): string {
  const session = state.session;
  const compression = session === null ? null : latestCompaction(session);
  const hasOutput = (session?.deliverables.length ?? 0) > 0;
  return `
    <header class="session-header">
      <div>
        <strong>${session === null ? "新建任务" : escapeHtml(session.title)}</strong>
      </div>
      <div class="header-actions">
        ${compression === null ? "" : `<span class="compaction-chip" title="Persisted Runtime Context compaction event">手动压缩</span>`}
      ${session === null ? "" : `
        <nav class="view-switch" aria-label="会话视图">
          <button class="${mode === "conversation" ? "active" : ""}" data-view="conversation">对话</button>
          ${hasOutput ? `<button class="${mode === "output" ? "active" : ""}" data-view="output">产物</button>` : ""}
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
      <h1>${providerError ? "配置模型" : "开始一个新任务"}</h1>
      <p>${providerError ? escapeHtml(providerError) : "告诉 Nexora 你想完成什么。"}</p>
      ${providerError ? `<button class="primary empty-settings" data-action="settings">打开设置</button>` : ""}
    </section>
  `;
}

function outputView(session: SessionView): string {
  const selected = activeDeliverable(session);
  if (selected === null) return `<section class="output-empty"><div class="empty-mark">□</div><h2>No current output</h2><p>This Session has no committed Deliverable.</p></section>`;
  const key = deliverablePreviewKey(selected);
  const preview = deliverablePreviews.get(key);
  const unavailable = unavailableDeliverables.get(key);
  const choices = session.deliverables.map((deliverable) => `
    <button class="output-choice ${deliverable.deliverableId === selected.deliverableId ? "active" : ""}" data-deliverable-select="${escapeAttr(deliverable.deliverableId)}">
      <strong>${escapeHtml(deliverable.title)}</strong><small>Revision ${deliverable.revision} · ${deliverable.validation}</small>
    </button>
  `).join("");
  const changed = selected.stage === "imported"
    ? "Source imported · requested changes not yet committed"
    : selected.stage === "exported"
      ? "Additional format exported from the committed revision"
      : selected.stage === "created" && selected.changedBlockIds.length === 0
        ? "Created as a new Deliverable"
        : `Updated ${selected.changedBlockIds.length} target${selected.changedBlockIds.length === 1 ? "" : "s"} · preserved ${selected.preservedBlockCount}`;
  const draft = ["succeeded", "failed", "blocked", "cancelled"].includes(session.inspection.status) ? "" : "Draft updated · ";
  const officeFiles = selected.files.map((file) => `<button data-workspace-entry="${escapeAttr(file.path)}">Open ${file.format.toUpperCase()} · ${formatBytes(file.byteLength)}</button>`).join("");
  const partial = partialOfficeOutcome(session);
  return `<section class="output-workbench">
    ${session.deliverables.length > 1 ? `<nav class="output-choices" aria-label="Session outputs">${choices}</nav>` : ""}
    <header class="output-header">
      <div><span class="output-kind">Rich document</span><h2>${escapeHtml(selected.title)}</h2><small>${draft}Revision ${selected.revision} · Run ${escapeHtml(compact(selected.sourceRunId, 18))} · ${escapeHtml(changed)}</small></div>
      <div class="output-actions"><span class="validation-chip ${unavailable === undefined && !partial && selected.stage !== "imported" ? "" : "failed"}">${unavailable !== undefined ? "Unavailable" : partial ? "Partial delivery · committed files preserved" : selected.stage === "imported" ? "Imported · modification pending" : "✓ Committed"}</span>${unavailable === undefined ? `${officeFiles}<button data-workspace-entry="${escapeAttr(selected.previewPath)}">Open preview</button>` : ""}</div>
    </header>
    <div class="output-preview-shell">
      ${unavailable !== undefined
        ? `<div class="output-empty"><strong>Output unavailable</strong><p>${escapeHtml(unavailable)}</p></div>`
        : preview === undefined
        ? `<div class="output-loading"><span class="spinner"></span><p>${loadingDeliverables.has(key) ? "Loading validated preview…" : "Preparing validated preview…"}</p></div>`
        : `<iframe class="output-preview" title="${escapeAttr(selected.title)} preview" sandbox="allow-same-origin" referrerpolicy="no-referrer" data-deliverable-preview="${escapeAttr(key)}"></iframe>`}
    </div>
  </section>`;
}

function conversation(session: SessionView): string {
  type Item = { at: string; order: number; html: string };
  const items: Item[] = [];
  for (const [runIndex, run] of session.runs.entries()) {
    const firstInput = run.inspection.inputs[0];
    const processedUntil = processingEnd(run);
    if (firstInput !== undefined) items.push({ at: firstInput.receivedAt, order: runIndex * 1_000_000, html: `
      <article class="message user-message">
        <p>${escapeHtml(run.userInput)}</p>
        ${attachmentChips(run.attachments, false)}
      </article>
    ` });
    for (const input of run.inspection.inputs.slice(1)) items.push({ at: input.receivedAt, order: runIndex * 1_000_000 + input.sequence, html: `
      <article class="message user-message"><p>${escapeHtml(input.text)}</p></article>
    ` });
    const runPublicOutputs = publicOutputSegments(run);
    const transcript = executionTranscript(run, session.managedProcesses);
    if (transcript !== "") items.push({ at: runPublicOutputs[0]?.occurredAt ?? firstInput?.receivedAt ?? new Date().toISOString(), order: runIndex * 1_000_000 + 450, html: transcript });
    for (const segment of runPublicOutputs) {
      if (segment.channel === "reasoning") continue;
      const formalResult = segment.channel === "content" && isFormalResultContent({
        completed: segment.completed,
        text: segment.text,
        resultSummary: run.inspection.result?.summary ?? null
      });
        if (segment.channel !== "content") continue;
        // Live deltas are visible before completion; completed non-formal output stays hidden.
        if (segment.completed && !formalResult) continue; // if (!formalResult) continue
        const liveProjection = publicOutputs.has(segment.key);
        const projectionClass = liveProjection ? "streaming" : (segment.completed ? "completed" : "streaming");
        items.push({ at: segment.occurredAt, order: runIndex * 1_000_000 + 501, html: `
          <article class="message agent-message public-content ${projectionClass}" data-public-output="${escapeAttr(segment.key)}">
          <div class="markdown-body">${liveProjection ? "" : renderMarkdown(segment.text)}</div>
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
          <div class="markdown-body">${renderMarkdown(prompt)}</div>
        </article>
      ` });
    }
    const pendingInput = run.inspection.pendingRequest?.kind === "input" ? run.inspection.pendingRequest : null;
    if (pendingInput !== null && !projectedInputRequestIds.has(pendingInput.id)) {
      items.push({ at: pendingInput.createdAt, order: runIndex * 1_000_000 + 999_998, html: `
        <article class="message agent-message input-request-message">
          <div class="markdown-body">${renderMarkdown(pendingInput.prompt)}</div>
        </article>
      ` });
    }
    if (run.inspection.result !== null) {
      const result = run.inspection.result;
      const artifacts = session.deliverables.filter((deliverable) => deliverable.sourceRunId === run.inspection.runId);
      const summaryAlreadyStreamed = publicOutputSegments(run).some((segment) => (
        segment.channel === "content"
        && segment.completed
        && segment.text.trim() === result.summary.trim()
      ));
      items.push({ at: result.delivery.createdAt, order: runIndex * 1_000_000 + 999_999, html: `
      ${resultMeta(firstInput, processedUntil)}<article class="result ${result.status}">
        <div>${summaryAlreadyStreamed ? "" : `<div class="markdown-body">${renderMarkdown(result.summary)}</div>`}
        ${result.resultArtifact === null ? "" : `<button class="text-button" data-artifact="${escapeAttr(result.resultArtifact)}">View full result</button>`}
        ${artifactSummary(artifacts)}</div>
      </article>
    ` });
    } else if (run.inspection.delivery !== null && ["blocked", "failed", "cancelled"].includes(run.inspection.status)) {
      const delivery = run.inspection.delivery;
      const artifacts = session.deliverables.filter((deliverable) => deliverable.sourceRunId === run.inspection.runId);
      const unfinished = delivery.unfinishedWork.slice(0, 6);
      const presentation = deliveryPresentation(run.inspection.status, delivery.exactCause.code);
      items.push({ at: delivery.createdAt, order: runIndex * 1_000_000 + 999_999, html: `
      ${resultMeta(firstInput, processedUntil)}<article class="result ${escapeAttr(run.inspection.status)}"><div><p class="result-guidance">${escapeHtml(presentation.message)}</p>${unfinished.length === 0 ? "" : `<p><strong>尚未完成</strong></p><ul>${unfinished.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`}<details><summary>查看技术详情</summary><p>${escapeHtml(delivery.exactCause.code)} · ${escapeHtml(delivery.exactCause.message)}</p><div class="technical-summary">${renderMarkdown(delivery.summary)}</div></details>${artifactSummary(artifacts)}</div></article>
    ` });
    } else if (run.inspection.error !== null) {
      const artifacts = session.deliverables.filter((deliverable) => deliverable.sourceRunId === run.inspection.runId);
      items.push({ at: new Date().toISOString(), order: runIndex * 1_000_000 + 999_999, html: `
      ${resultMeta(firstInput, processedUntil)}<article class="result failed"><div><p>${escapeHtml(run.inspection.error.message)}</p>${artifactSummary(artifacts)}</div></article>
    ` });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const turns = session.runs.map((_, runIndex) => {
    const start = runIndex * 1_000_000;
    const end = start + 1_000_000;
    return `<section class="conversation-turn" data-turn="${runIndex + 1}">${items.filter((item) => item.order >= start && item.order < end).map((item) => item.html).join("")}</section>`;
  }).join("");
  const sessionItems = items.filter((item) => item.order >= session.runs.length * 1_000_000).map((item) => item.html).join("");
  return `<section class="conversation">${turns}${sessionItems}</section>`;
}

function executionTranscript(run: SessionView["runs"][number], services: SessionView["managedProcesses"]): string {
  type Entry = { at: string; html: string };
  const entries: Entry[] = [];
  for (const segment of publicOutputSegments(run)) {
    if (segment.channel !== "reasoning") continue;
    const live = publicOutputs.get(segment.key);
    const output = live ?? segment;
    const expanded = expandedPublicOutputs.has(segment.key);
    entries.push({
      at: segment.occurredAt,
      html: `<article class="execution-entry reasoning-entry public-output ${output.completed ? "completed" : "streaming"}" data-public-output="${escapeAttr(segment.key)}"><button class="execution-row" data-public-output-toggle="${escapeAttr(segment.key)}" aria-expanded="${expanded}"><span class="execution-kind">深度思考</span><span class="execution-chevron">›</span><span class="execution-target think-preview">${escapeHtml(compactLatest(output.text, 220))}</span><span class="execution-cursor" aria-hidden="true">${output.completed ? "" : "▍"}</span></button>${expanded ? `<div class="execution-detail"><strong>Reasoning detail</strong><div class="markdown-body reasoning-detail-body">${renderMarkdown(output.text)}</div></div>` : ""}</article>`
    });
  }
  for (const invocation of run.inspection.invocations) {
    const presentation = toolPresentation(invocation.toolName, invocation.inputJson);
    const result = toolResultSummary(invocation.status, invocation.resultJson, invocation.errorJson);
    const key = invocation.id;
    const expanded = expandedTools.has(key);
    entries.push({ at: invocation.startedAt, html: `<article class="execution-entry tool-entry"><button class="execution-row" data-tool="${escapeAttr(key)}" aria-expanded="${expanded}"><span class="execution-icon">${toolIcon(invocation.toolName)}</span><span class="execution-action">${escapeHtml(presentation.action)}</span><span class="execution-chevron">›</span><span class="execution-target">${escapeHtml(presentation.target ?? invocation.toolName)}</span><span class="execution-result ${invocation.status}">${escapeHtml(result)}</span></button>${expanded ? toolDetail(invocation, services) : ""}</article>` });
  }
  for (const evidence of run.inspection.evidence) {
    if (evidence.invocationId !== null || evidence.source !== "validator") continue;
    const expanded = expandedEvidence.has(evidence.id);
    entries.push({ at: evidence.producedAt, html: `<article class="execution-entry validation-entry"><button class="execution-row" data-evidence="${escapeAttr(evidence.id)}" aria-expanded="${expanded}"><span class="execution-icon">◇</span><span class="execution-action">验证结果</span><span class="execution-chevron">›</span><span class="execution-target">${escapeHtml(evidence.subjectRef)}</span><span class="execution-result succeeded">通过</span></button>${expanded ? `<div class="execution-detail">${detailField("Evidence", pretty(evidence), true)}</div>` : ""}</article>` });
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  return entries.length === 0 ? "" : `<section class="execution-transcript" aria-label="Agent execution transcript">${entries.map((entry) => entry.html).join("")}</section>`;
}

function toolDetail(invocation: SessionView["inspection"]["invocations"][number], services: SessionView["managedProcesses"]): string {
  const input = objectValue(invocation.inputJson);
  const result = objectValue(invocation.resultJson);
  const command = shellCommand(input);
  const fields = invocation.toolName === "shell.execute"
    ? `${detailField("Command", command)}${detailField("Working directory", stringValue(input.cwd) ?? ".")}${detailField("Exit code", numberValue(result.exitCode))}${detailField("Duration", duration(invocation.startedAt, invocation.completedAt).replace(/^ · /u, ""))}${detailField("Output", stringValue(result.stdout) ?? stringValue(result.stderr))}`
    : `${detailField("Input", pretty(invocation.inputJson), true)}${invocation.resultJson === null ? "" : detailField("Output", pretty(invocation.resultJson), true)}${invocation.errorJson === null ? "" : detailField("Error", pretty(invocation.errorJson), true)}`;
  const handle = stringValue(result.processHandle);
  const service = handle === null ? null : services.find((item) => item.processHandle === handle) ?? null;
  const controls = service === null ? "" : `<div class="process-inline-actions">${service.status === "ready" && service.endpoint?.startsWith("http") === true ? `<a class="process-action primary" href="${escapeAttr(service.endpoint)}" target="_blank" rel="noreferrer">Open</a>` : ""}<button class="process-action" data-process-logs="${escapeAttr(service.processHandle)}">Logs</button>${service.status === "ready" || service.status === "starting" || service.status === "stopping" ? `<button class="process-action danger" data-process-stop="${escapeAttr(service.processHandle)}">Stop</button>` : ""}</div>`;
  return `<div class="execution-detail">${fields}${controls}<small>Invocation ${escapeHtml(invocation.id)}</small></div>`;
}

function detailField(label: string, value: string | number | null, pre = false): string {
  if (value === null || value === "") return "";
  return `<strong>${escapeHtml(label)}</strong>${pre ? `<pre>${escapeHtml(String(value))}</pre>` : `<div>${escapeHtml(String(value))}</div>`}`;
}

function toolResultSummary(status: string, resultJson: unknown, errorJson: unknown): string {
  if (status === "prepared" || status === "started") return "Running…";
  if (status === "failed") return compact(stringValue(objectValue(errorJson).message) ?? "失败", 42);
  if (status === "unknown") return "结果待确认";
  const result = objectValue(resultJson);
  const output = `${stringValue(result.stdout) ?? ""}\n${stringValue(result.stderr) ?? ""}`;
  const failed = /(?:^|\s)(\d+)\s+(?:tests?\s+)?failed\b/iu.exec(output);
  if (failed !== null && Number(failed[1]) > 0) return `${failed[1]} failed`;
  const passed = /(?:^|\s)(\d+)\s+(?:tests?\s+)?passed\b/iu.exec(output);
  if (passed !== null) return `${passed[1]} passed`;
  if (Array.isArray(result.matches)) return `${result.matches.length} matches`;
  if (Array.isArray(result.entries)) return `${result.entries.length} items`;
  if (typeof result.exitCode === "number") return result.exitCode === 0 ? "Exit 0" : `Exit ${result.exitCode}`;
  if (typeof result.byteLength === "number") return `${result.byteLength} bytes`;
  if (result.status === "ready" || result.endpoint !== undefined) return "Running";
  return "完成";
}

function shellCommand(input: Record<string, unknown>): string | null {
  const command = stringValue(input.command);
  if (command === null) return null;
  return [command, ...arrayValue(input.args).filter((item): item is string => typeof item === "string")].join(" ");
}

function activePlanObjective(run: SessionView["runs"][number]): string | null {
  const plan = run.inspection.plan;
  if (plan === null) return null;
  const progress = new Map(run.inspection.progress.map((item) => [item.stepId, item.status]));
  return plan.orderedSteps.find((step) => progress.get(step.id) === "active")?.objective
    ?? plan.orderedSteps.find((step) => progress.get(step.id) !== "completed")?.objective
    ?? null;
}

function resultMeta(firstInput: SessionView["inspection"]["inputs"][number] | undefined, processedUntil: string | null): string {
  if (firstInput === undefined) return "";
  return `<div class="result-meta"><small class="turn-duration" data-elapsed-start="${escapeAttr(firstInput.receivedAt)}" ${processedUntil === null ? "" : `data-elapsed-end="${escapeAttr(processedUntil)}"`}>${processingDuration(firstInput.receivedAt, processedUntil)}</small></div>`;
}

function deliveryPresentation(status: string, code: string): { label: string; message: string } {
  if (status === "cancelled") return { label: "本回合已暂停", message: "已完成和确认的内容仍然保留。你可以调整要求后继续这个任务。" };
  if (code === "NO_PROGRESS_DETECTED") return { label: "运行已失败", message: "Nexora 已耗尽当前可观察策略空间。可以基于交接信息创建新的后续运行。" };
  if (status === "blocked") return { label: "需要你的帮助", message: "Nexora 暂时缺少继续所需的条件。补充信息或调整任务方向后即可继续。" };
  return { label: "本回合未完成", message: "这次处理没有完整结束。已经确认的内容仍然保留，你可以补充要求后继续。" };
}

function matchesSidebarFilter(session: DesktopSnapshot["workspace"]["projects"][number]["sessions"][number]): boolean {
  const query = sidebarQuery.trim().toLowerCase();
  if (query !== "" && !session.title.toLowerCase().includes(query)) return false;
  if (sidebarStatus === "all") return true;
  if (sidebarStatus === "waiting") return session.status === "waiting_for_input" || session.status === "waiting_for_approval";
  return session.status === sidebarStatus;
}

function plan(session: SessionView | null): string {
  if (session === null || !shouldShowTaskExecution(session.inspection.status)) return "";
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
  const projection = projectRuntimeControls(run);
  if (projection.kind === "input") {
    return inputReplyComposer(run.pendingRequest?.kind === "input" ? run.pendingRequest.prompt : null);
  }
  if (projection.kind === "approval" && run.pendingRequest?.kind === "approval") {
    return statusComposer(session, "approval", `<small>需要你的批准</small><p>${escapeHtml(run.pendingRequest.prompt)}</p><span class="request-impact">将执行：${escapeHtml(run.pendingRequest.toolName)}</span><details><summary>查看操作详情</summary><pre>${escapeHtml(pretty(run.pendingRequest.input))}</pre></details>`, `<button data-action="deny" ${busy ? "disabled" : ""}>拒绝</button><button class="primary" data-action="approve" ${busy ? "disabled" : ""}>批准</button>`);
  }
  if (projection.kind === "running") {
    return followUpComposer(session, true);
  }
  if (projection.kind === "provider_reconnecting") {
    return statusComposer(session, "blocked", `<small>等待 Runtime Provider 恢复探测</small><p>${escapeHtml(run.delivery?.summary ?? "Runtime 将在满足已持久化的恢复条件后继续。")}</p><span class="request-impact">验证：bounded provider probe</span>`, `<button data-action="cancel" ${busy ? "disabled" : ""}>结束任务</button>`);
  }
  if (projection.kind === "budget_extension") {
    return statusComposer(session, "blocked", `<small>需要扩展执行预算</small><p>${escapeHtml(run.delivery?.summary ?? "Runtime 要求扩展指定预算后才能继续。")}</p><span class="request-impact">允许维度：${projection.allowedDimensions.map(escapeHtml).join("、")}</span>${projection.allowedDimensions.map((dimension) => `<label><input type="checkbox" data-budget-dimension="${dimension}" checked />${dimension}</label>`).join("")}`, `<button class="primary" data-action="extend-budget" ${busy ? "disabled" : ""}>扩展所选预算</button>`);
  }
  if (projection.kind === "legacy_blocked") {
    return statusComposer(session, "blocked", `<small>兼容性暂停状态</small><p>${escapeHtml(run.delivery?.summary ?? "此历史 Run 没有 typed resume predicate，Desktop 不会推断恢复操作。")}</p>`, `<button data-action="cancel" ${busy ? "disabled" : ""}>结束任务</button>`);
  }
  if (projection.kind === "failed") {
    const handoff = run.result?.failureHandoff;
    const completed = handoff?.completedWork.length ? handoff.completedWork.join("；") : "尚无可确认的已完成工作";
    const remaining = handoff?.unfinishedRequirements.length ? handoff.unfinishedRequirements.join("；") : handoff?.nextAction ?? "没有 Runtime 声明的恢复条件";
    return `<div class="recovery-stack"><div class="recovery-hint"><span class="recovery-dot"></span><div><strong>运行已失败</strong><span>${escapeHtml(run.delivery?.summary ?? "Runtime 已终止当前 Run。")} 当前原因：${escapeHtml(run.stopReason ?? "unknown")}</span><details><summary>查看交接信息</summary><p>已完成：${escapeHtml(completed)}</p><p>未完成：${escapeHtml(remaining)}</p></details></div></div>${followUpComposer(session, false)}</div>`;
  }
  if (run.status === "blocked") {
    if (projection.kind === "worker_recovery") {
      return statusComposer(session, "recovery", `<small>需要恢复执行</small><p>${run.workerRecoveries.length} 个协作运行已暂停。可以恢复原协作运行，或放弃其隔离分支。</p>`, run.workerRecoveries.map((item) => `<button data-worker-action="discard" data-branch-id="${escapeAttr(item.branchId)}">放弃分支</button><button class="primary" data-worker-action="resume" data-child-id="${escapeAttr(item.childRunId)}">恢复运行</button>`).join(""));
    }
    if (projection.kind === "tool_recovery" && run.recovery !== null) {
      return statusComposer(session, "recovery", `<small>需要确认恢复 · ${escapeHtml(run.recovery.toolName)}</small><p>自动核对无法确定工具结果。Invocation：${escapeHtml(run.recovery.invocationId)}</p><input id="subject-ref" placeholder="成功结果的对象标识（可选）" />`, `<button data-recovery="abandon_run">放弃运行</button><button data-recovery="confirmed_failed">确认失败</button><button class="primary" data-recovery="confirmed_succeeded">确认成功</button>`);
    }
    if (run.stopReason === "NO_PROGRESS_DETECTED") {
      return `<div class="recovery-stack"><div class="recovery-hint"><span class="recovery-dot"></span><div><strong>暂时停在这里</strong><span>${escapeHtml(run.delivery?.summary ?? "当前方法没有带来新的进展。")} 换一个方向继续输入即可。</span><details><summary>查看技术原因</summary><p>${escapeHtml(run.stopReason)}</p></details></div><button data-action="cancel" ${busy ? "disabled" : ""}>结束任务</button></div>${followUpComposer(session, false)}</div>`;
    }
    if (
      (run.stopReason === "PROVIDER_UNAVAILABLE" || run.stopReason === "CONTEXT_CAPACITY_EXCEEDED")
      && projection.kind === "other"
    ) {
      return `<div class="recovery-stack"><div class="recovery-hint"><span class="recovery-dot"></span><div><strong>暂时无法继续</strong><span>${escapeHtml(run.delivery?.summary ?? "当前方法没有恢复执行。")} 换一个方向继续输入即可。</span></div><button data-action="cancel" ${busy ? "disabled" : ""}>结束任务</button></div>${followUpComposer(session, false)}</div>`;
    }
    const durationWithoutProgress = run.stopReason === "DURATION_BUDGET_EXCEEDED" && run.executionMetrics.repeatedToolCalls > 0;
    if (durationWithoutProgress) {
      return `<div class="recovery-stack"><div class="recovery-hint"><span class="recovery-dot"></span><div><strong>需要新的方向</strong><span>${escapeHtml(run.delivery?.summary ?? "当前方法没有带来新的进展。")}</span></div><button data-action="cancel" ${busy ? "disabled" : ""}>结束任务</button></div>${followUpComposer(session, false)}</div>`;
    }
    const budget = run.stopReason?.endsWith("BUDGET_EXCEEDED") === true;
    const metrics = run.executionMetrics;
    const quality = budget ? ` · ${metrics.modelCalls} model / ${metrics.toolCalls} tool calls · ${metrics.repeatedToolCalls} repeated` : "";
    return statusComposer(session, "blocked", `<small>任务已暂停${quality}</small><p>${escapeHtml(run.delivery?.summary ?? "当前执行需要你的介入。")}</p>`, `<button class="${budget && metrics.repeatedToolCalls === 0 ? "primary" : ""}" data-action="${budget ? "extend-budget" : "resume"}" ${busy ? "disabled" : ""}>${budget ? "延长预算并继续" : "继续运行"}</button>`);
  }
  return followUpComposer(session, false);
}

function statusComposer(session: SessionView, variant: string, content: string, actions: string): string {
  return `<section class="composer status-composer ${variant}"><div class="status-composer-copy">${content}</div>${composerToolbar(actions, "", false, session)}</section>`;
}

function inputReplyComposer(prompt: string | null): string {
  return `<section class="composer follow-up">
    ${prompt === null ? "" : `<div class="status-composer-copy"><small>需要你的信息</small><p>${escapeHtml(prompt)}</p></div>`}
    <form data-form="input">
      <textarea name="text" placeholder="回复 Nexora…" required>${escapeHtml(draft)}</textarea>
      ${composerToolbar(`<button class="send-button" aria-label="发送回复" ${busy || draft.trim() === "" ? "disabled" : ""}>↑</button>`, "", true)}
    </form>
  </section>`;
}

function goalComposer(): string {
  return `<section class="composer goal"><form data-form="goal"><textarea name="goal" placeholder="给 Nexora 一个任务…" required>${escapeHtml(draft)}</textarea>${attachmentChips(draftAttachments, true)}${composerToolbar(`<button class="send-button" aria-label="开始任务" ${busy || draft.trim() === "" ? "disabled" : ""}>↑</button>`, "", true, null, true)}</form></section>`;
}

function followUpComposer(session: SessionView, running: boolean): string {
  const placeholder = running ? "继续输入…" : session.inspection.status === "succeeded" ? "继续这个会话…" : "继续这个任务…";
  return `<section class="composer follow-up ${running ? "is-running" : ""}">
    <form data-form="follow-up">
      <textarea name="text" placeholder="${placeholder}" required>${escapeHtml(draft)}</textarea>
      ${attachmentChips(draftAttachments, true)}
      ${composerToolbar(`
        ${running ? `<button type="button" class="stop-button" data-action="cancel" title="停止当前运行" aria-label="停止当前运行" ${busy ? "disabled" : ""}>■</button>` : `<button class="send-button" aria-label="发送后续消息" ${busy || draft.trim() === "" ? "disabled" : ""}>↑</button>`}
      `, "", true, session)}
    </form>
  </section>`;
}

function composerToolbar(actions: string, hint: string, attachments = true, contextSession: SessionView | null | undefined = snapshot?.session, emptyContext = false): string {
  return `<div class="composer-toolbar"><div class="composer-add-slot">${attachments ? `<button type="button" class="attach-button" data-action="attach" aria-label="添加" title="添加">${icon("plus")}</button>${composerAddOpen ? `<div class="composer-add-menu" role="menu"><div class="menu-label">添加</div><button type="button" role="menuitem" data-action="attach">${icon("file")}<span>文件</span></button><button type="button" role="menuitem" data-action="attach-folder">${icon("folder")}<span>文件夹</span></button></div>` : ""}` : ""}</div><div class="composer-controls">${contextRing(contextSession, emptyContext)}${modelSelector()}${actions}</div></div>`;
}

function contextRing(session: SessionView | null | undefined, emptyState = false): string {
  const context = session === null || session === undefined ? null : contextUsage(session);
  // Keep the control visible and stable for every task. When Runtime has not
  // projected a usage fact yet, render an empty ring instead of inventing a
  // percentage or leaving an unexplained gap in the Composer toolbar.
  if (session === null && !emptyState) return "";
  const label = context === null ? "上下文使用量暂不可用" : `上下文已使用 ${context.percent.toFixed(1)}%`;
  const lowUsage = context !== null && context.percent > 0 && context.percent < 3;
  return `<button type="button" class="context-control ${context === null ? "unavailable" : ""} ${lowUsage ? "low-usage" : ""}" style="--context-percent:${context?.percent ?? 0}%" aria-label="${label}"><span class="context-ring"><i></i></span>${context === null ? "" : `<span class="context-compact">${formatTokenCount(context.used)}</span>`}<span class="context-tooltip" role="tooltip"><strong>上下文使用量</strong>${context === null ? `<span>任务开始后显示真实使用量</span>` : `<span>${formatTokenCount(context.used)} / ${formatTokenCount(context.window)} · ${context.percent.toFixed(1)}%</span><small>${context.used.toLocaleString()} / ${context.window.toLocaleString()} tokens</small>`}</span></button>`;
}

function attachmentChips(attachments: readonly AttachmentView[], removable: boolean): string {
  if (attachments.length === 0) return "";
  const folderGroups = new Map<string, NonNullable<AttachmentView["source"]>>();
  for (const attachment of attachments) if (attachment.source !== undefined) folderGroups.set(attachment.source.id, attachment.source);
  const files = attachments.filter((attachment) => attachment.source === undefined).map((attachment) => `<span class="attachment-chip" title="${escapeAttr(`${attachment.name} · ${attachment.digest}`)}"><span>${attachmentIcon(attachment.kind)}</span><strong>${escapeHtml(attachment.name)}</strong><small>${attachmentBytesLabel(attachment.byteLength)}</small>${removable ? `<button type="button" data-remove-attachment="${escapeAttr(attachment.id)}" aria-label="移除 ${escapeAttr(attachment.name)}">×</button>` : ""}</span>`);
  const folders = [...folderGroups.values()].map((folder) => `<span class="attachment-chip folder" title="${escapeAttr(`${folder.name} · ${folder.fileCount} 个文件 · ${attachmentBytesLabel(folder.totalBytes)}`)}"><span>${icon("folder")}</span><strong>${escapeHtml(folder.name)}</strong><small>${folder.fileCount} 个文件</small>${removable ? `<button type="button" data-remove-attachment-group="${escapeAttr(folder.id)}" aria-label="移除文件夹 ${escapeAttr(folder.name)}">×</button>` : ""}</span>`);
  return `<div class="attachment-chips">${[...folders, ...files].join("")}</div>`;
}

function attachmentIcon(kind: AttachmentView["kind"]): string { return kind === "office" ? icon("file") : kind === "pdf" ? "PDF" : icon("file"); }
function attachmentBytesLabel(value: number): string { return value < 1_024_000 ? `${Math.max(1, Math.round(value / 1_024))} KB` : `${(value / 1_048_576).toFixed(1)} MB`; }

function modelSelector(): string {
  const workspace = snapshot?.workspace;
  if (workspace === undefined || workspace.modelProfiles.length === 0) return "";
  const selected = workspace.modelProfiles.find((profile) => profile.id === workspace.selectedModelProfileId) ?? workspace.modelProfiles[0];
  const selectedIndex = Math.max(0, workspace.modelProfiles.findIndex((profile) => profile.id === selected?.id));
  if (!modelMenuOpen) modelMenuIndex = selectedIndex;
  const reasoningOptions = [["dynamic", "动态"], ["on", "开启"], ["off", "关闭"]] as const;
  return `<div class="model-picker"><button type="button" class="model-switch" data-model-trigger aria-haspopup="menu" aria-expanded="${modelMenuOpen}"><span>${escapeHtml(selected?.name ?? "模型")}</span>${icon("chevronDown")}</button>${modelMenuOpen ? `<div class="model-menu" role="menu" aria-label="模型设置"><div class="menu-label">模型</div>${workspace.modelProfiles.map((profile, index) => `<button type="button" role="menuitemradio" aria-checked="${profile.id === selected?.id}" data-model-menu-option data-profile-option="${escapeAttr(profile.id)}" class="${profile.id === selected?.id ? "selected" : ""} ${index === modelMenuIndex ? "keyboard-active" : ""}"><span class="menu-check">${profile.id === selected?.id ? icon("check") : ""}</span><span>${escapeHtml(profile.name)}</span></button>`).join("")}<div class="menu-divider"></div><div class="menu-label">推理方式</div><div class="reasoning-options">${reasoningOptions.map(([value, label], index) => `<button type="button" role="menuitemradio" aria-checked="${selected?.reasoning === value}" data-model-menu-option data-reasoning-option="${value}" class="${selected?.reasoning === value ? "selected" : ""} ${workspace.modelProfiles.length + index === modelMenuIndex ? "keyboard-active" : ""}"><span class="menu-check">${selected?.reasoning === value ? icon("check") : ""}</span><span>${label}</span></button>`).join("")}</div></div>` : ""}</div>`;
}

function settings(state: DesktopSnapshot): string {
  const profiles = state.workspace.modelProfiles;
  const profile = profiles.find((item) => item.id === editingProfileId)
    ?? profiles.find((item) => item.id === state.workspace.selectedModelProfileId)
    ?? profiles[0];
  if (profile !== undefined && (settingsDraft === null || settingsDraft.id !== profile.id)) settingsDraft = modelSettingsDraft(profile);
  const draft = settingsDraft;
  const providerProfiles = uniqueProviderProfiles(profiles);
  const provider = draft === null ? null : providerProfiles.find((item) => sameProviderUrl(item.baseUrl, draft.baseUrl)) ?? profile ?? null;
  const dirty = draft !== null && profile !== undefined && modelSettingsDirty(draft, profile);
  return `<div class="modal-backdrop settings-backdrop" data-action="close-settings"><section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
    <header class="settings-header"><div><h2 id="model-settings-title">模型设置</h2><small>全局模型配置 · 当前工作区：${escapeHtml(state.workspace.name)}</small></div><button type="button" class="icon-button" data-action="close-settings" aria-label="关闭">×</button></header>
    <div class="settings-body">
      <aside class="model-profile-list" aria-label="模型列表"><div class="settings-section-title">模型</div><div class="model-profile-rows">${profiles.map((item) => `<button type="button" class="model-profile-row ${item.id === profile?.id ? "editing" : ""}" data-profile-edit="${escapeAttr(item.id)}"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.model)}</small></span>${item.id === state.workspace.selectedModelProfileId ? `<span class="active-model" title="当前工作区正在使用">${icon("check")}</span>` : ""}</button>`).join("")}</div><button type="button" class="new-model" data-action="add-model">＋ 添加模型</button></aside>
      <main class="model-settings-detail">${profile === undefined || draft === null ? `<div class="settings-empty"><strong>还没有模型</strong><span>添加一个模型以开始使用 Nexora。</span><button type="button" class="primary" data-action="add-model">添加模型</button></div>` : `
        <div class="model-detail-heading"><div><h3>${escapeHtml(draft.name || "未命名模型")}</h3><small>${escapeHtml(draft.model || "Model ID")} · ${escapeHtml(providerDisplayName(draft.baseUrl))}</small></div></div>
        <form data-form="model-profile" class="settings-form" novalidate>
          <input type="hidden" name="id" value="${escapeAttr(draft.id)}" />
          <section class="settings-section"><div class="settings-section-title">基础设置</div>
            ${settingsField("名称", "name", `<input name="name" value="${escapeAttr(draft.name)}" autocomplete="off" required />`)}
            <label class="settings-field"><span>Provider</span><div class="provider-card"><strong>${escapeHtml(providerDisplayName(draft.baseUrl))}</strong><small>${escapeHtml(providerEndpoint(draft.baseUrl))}</small></div></label>
            <label class="settings-field"><span>API Key</span><div class="api-key-row"><div class="api-key-status"><strong>${profile.apiKeyConfigured ? "••••••••••••" : "尚未配置"}</strong><small>${profile.apiKeyConfigured ? `由 ${escapeHtml(providerDisplayName(draft.baseUrl))} Provider 共享` : "此 Provider 需要 API Key"}</small></div><button type="button" data-action="replace-api-key">${apiKeyEditing ? "取消更换" : "更换"}</button></div>${apiKeyEditing ? `<input name="apiKey" type="password" value="${escapeAttr(draft.apiKey)}" placeholder="输入新的 API Key" autocomplete="new-password" />` : ""}</label>
            ${settingsField("Model ID", "model", `<input name="model" value="${escapeAttr(draft.model)}" autocomplete="off" required />`)}
            <div class="settings-grid">
              ${settingsField("上下文窗口", "contextWindow", `<input name="contextWindow" inputmode="decimal" value="${escapeAttr(draft.contextWindow)}" placeholder="1M" /><small>模型支持的最大上下文长度</small>`)}
              ${settingsField("Decision token limit", "decisionOutput", `<input name="decisionOutput" inputmode="decimal" value="${escapeAttr(draft.decisionOutput)}" placeholder="16K" /><small>单次模型决策的最大输出</small>`)}
            </div>
            <fieldset class="settings-field active-context"><legend>Active Context Target</legend><div class="segmented"><label><input type="radio" name="activeMode" value="auto" ${draft.activeMode === "auto" ? "checked" : ""} /><span>自动</span></label><label><input type="radio" name="activeMode" value="custom" ${draft.activeMode === "custom" ? "checked" : ""} /><span>自定义</span></label></div>${draft.activeMode === "custom" ? `${settingsField("自定义上限", "activeTarget", `<input name="activeTarget" inputmode="decimal" value="${escapeAttr(draft.activeTarget)}" placeholder="800K" />`)}` : `<small>由系统根据模型上下文窗口自动确定</small>`}</fieldset>
          </section>
          <details class="advanced-settings" ${settingsAdvancedOpen ? "open" : ""}><summary>高级设置 <span>Tool transport、推理与 Provider 参数</span></summary><div class="advanced-content">
            <label class="settings-field"><span>Tool transport</span><select name="transport"><option value="native_tools" ${draft.transport === "native_tools" ? "selected" : ""}>Native tools · streaming</option><option value="structured_output" ${draft.transport === "structured_output" ? "selected" : ""}>Structured output</option></select></label>
            <div class="settings-grid"><label class="settings-field"><span>Reasoning</span><select name="reasoning"><option value="dynamic" ${draft.reasoning === "dynamic" ? "selected" : ""}>动态</option><option value="off" ${draft.reasoning === "off" ? "selected" : ""}>关闭</option><option value="on" ${draft.reasoning === "on" ? "selected" : ""}>开启</option></select></label>${settingsField("Thinking parameter", "thinkingToggleParam", `<input name="thinkingToggleParam" value="${escapeAttr(draft.thinkingToggleParam)}" placeholder="enable_thinking" />`)}</div>
          </div></details>
          <div class="danger-zone"><div><strong>删除模型</strong><small>模型删除后，使用它的工作区会切换到其他可用模型。</small></div><button type="button" class="danger-action" data-profile-delete="${escapeAttr(profile.id)}">删除</button></div>
        </form>`}</main>
    </div>
    <footer class="settings-footer"><span class="settings-save-status">${dirty ? "有未保存的更改" : "所有更改已保存"}</span><div><button type="button" data-action="cancel-settings">取消</button><button type="submit" form="model-settings-form" class="primary" data-action="save-settings" ${!dirty || busy || Object.keys(settingsErrors).length > 0 ? "disabled" : ""}>保存更改</button></div></footer>
    ${addModelOpen ? addModelDialog(state, providerProfiles) : ""}
  </section></div>`.replace('data-form="model-profile"', 'id="model-settings-form" data-form="model-profile"');
}

function settingsField(label: string, key: keyof ModelSettingsDraft, control: string): string {
  const fieldError = settingsErrors[key];
  return `<label class="settings-field ${fieldError === undefined ? "" : "invalid"}"><span>${label}</span>${control}<small class="field-error" data-field-error="${key}">${fieldError === undefined ? "" : escapeHtml(fieldError)}</small></label>`;
}

function addModelDialog(state: DesktopSnapshot, providers: readonly ModelProfileView[]): string {
  const fallback = providers[0];
  const draft = addModelDraft ?? { providerBaseUrl: fallback?.baseUrl ?? "new", baseUrl: "", apiKey: "", model: "", name: "", contextWindow: "" };
  addModelDraft = draft;
  const custom = draft.providerBaseUrl === "new";
  return `<div class="nested-dialog-backdrop"><section class="add-model-dialog" role="dialog" aria-modal="true" aria-labelledby="add-model-title"><header><div><h3 id="add-model-title">添加模型</h3><small>添加到全局模型列表，并设为当前工作区「${escapeHtml(state.workspace.name)}」的模型。其他工作区保持原选择。</small></div><button type="button" data-action="close-add-model" aria-label="关闭">×</button></header><form data-form="add-model"><label class="settings-field"><span>Provider</span><select name="providerBaseUrl" data-add-provider>${providers.map((item) => `<option value="${escapeAttr(item.baseUrl)}" ${sameProviderUrl(draft.providerBaseUrl, item.baseUrl) ? "selected" : ""}>${escapeHtml(providerDisplayName(item.baseUrl))}</option>`).join("")}<option value="new" ${custom ? "selected" : ""}>自定义 Provider</option></select></label>${custom ? `<label class="settings-field"><span>Provider endpoint</span><input name="baseUrl" type="url" value="${escapeAttr(draft.baseUrl)}" placeholder="https://provider.example/v1" required /></label><label class="settings-field"><span>API Key</span><input name="apiKey" type="password" value="${escapeAttr(draft.apiKey)}" placeholder="输入 API Key" required /></label>` : ""}<label class="settings-field ${addModelError === null ? "" : "invalid"}"><span>Model ID</span><input name="model" value="${escapeAttr(draft.model)}" placeholder="qwen3.8-flash" required /><small>Provider 使用的精确标识，不是显示名称。</small><small class="field-error">${addModelError === null ? "" : escapeHtml(addModelError)}</small></label><label class="settings-field"><span>显示名称</span><input name="name" value="${escapeAttr(draft.name)}" placeholder="Qwen 3.8 Flash" required /><small>仅用于 Nexora 界面显示。</small></label><label class="settings-field"><span>上下文窗口</span><input name="contextWindow" value="${escapeAttr(draft.contextWindow)}" placeholder="例如 1M 或 128K" required /><small>运行所需的模型能力声明。</small></label><footer><button type="button" data-action="close-add-model">取消</button><button class="primary" ${busy || addModelError !== null ? "disabled" : ""}>添加并用于当前工作区</button></footer></form></section></div>`;
}

function modelSettingsDraft(profile: ModelProfileView): ModelSettingsDraft {
  return { id: profile.id, name: profile.name, baseUrl: profile.baseUrl, apiKey: "", model: profile.model, contextWindow: profile.contextWindowTokens === null ? "" : formatTokenCount(profile.contextWindowTokens), contextWindowTokens: profile.contextWindowTokens, contextWindowEdited: false, activeMode: profile.activeInputTargetTokens === null ? "auto" : "custom", activeTarget: profile.activeInputTargetTokens === null ? "" : formatTokenCount(profile.activeInputTargetTokens), activeTargetTokens: profile.activeInputTargetTokens, activeTargetEdited: false, decisionOutput: formatTokenCount(profile.decisionOutputTokens), decisionOutputTokens: profile.decisionOutputTokens, decisionOutputEdited: false, transport: profile.transport, reasoning: profile.reasoning, thinkingToggleParam: profile.thinkingToggleParam ?? "" };
}

function modelSettingsDirty(draft: ModelSettingsDraft, profile: ModelProfileView): boolean {
  return draft.name.trim() !== profile.name || draft.baseUrl !== profile.baseUrl || draft.apiKey.trim() !== "" || draft.model.trim() !== profile.model || resolveTokenInput(draft.contextWindow, draft.contextWindowTokens, draft.contextWindowEdited) !== profile.contextWindowTokens || (draft.activeMode === "auto" ? null : resolveTokenInput(draft.activeTarget, draft.activeTargetTokens, draft.activeTargetEdited)) !== profile.activeInputTargetTokens || resolveTokenInput(draft.decisionOutput, draft.decisionOutputTokens, draft.decisionOutputEdited) !== profile.decisionOutputTokens || draft.transport !== profile.transport || draft.reasoning !== profile.reasoning || (draft.thinkingToggleParam.trim() || null) !== profile.thinkingToggleParam;
}

function uniqueProviderProfiles(profiles: readonly ModelProfileView[]): ModelProfileView[] { return [...new Map(profiles.map((item) => [normalizeProviderUrl(item.baseUrl), item])).values()]; }
function normalizeProviderUrl(value: string): string { return value.trim().replace(/\/+$/u, "").toLowerCase(); }
function sameProviderUrl(left: string, right: string): boolean { return normalizeProviderUrl(left) === normalizeProviderUrl(right); }
function providerEndpoint(baseUrl: string): string { try { return new URL(baseUrl).hostname; } catch { return baseUrl; } }
function providerDisplayName(baseUrl: string): string {
  const host = providerEndpoint(baseUrl).toLowerCase();
  if (host.includes("dashscope") || host.includes("aliyuncs")) return "DashScope";
  if (host.includes("deepseek")) return "DeepSeek";
  if (host.includes("openai")) return "OpenAI";
  if (host.includes("anthropic")) return "Anthropic";
  const name = host.replace(/^api\./u, "").split(".")[0] ?? host;
  return name.length === 0 ? "自定义 Provider" : name.charAt(0).toUpperCase() + name.slice(1);
}


function openSettings(): void {
  if (snapshot === null) return;
  settingsOpen = true;
  editingProfileId = snapshot.workspace.selectedModelProfileId ?? snapshot.workspace.modelProfiles[0]?.id ?? null;
  const selected = snapshot.workspace.modelProfiles.find((item) => item.id === editingProfileId);
  settingsDraft = selected === undefined ? null : modelSettingsDraft(selected);
  settingsErrors = {};
  settingsAdvancedOpen = false;
  apiKeyEditing = false;
  addModelOpen = false;
  addModelDraft = null;
  render();
  document.querySelector<HTMLElement>(".settings-modal button, .settings-modal input")?.focus();
}

function ensureSelectedModelReady(): boolean {
  const workspace = snapshot?.workspace;
  const selected = workspace?.modelProfiles.find((profile) => profile.id === workspace.selectedModelProfileId);
  if (selected !== undefined && modelIdValidationMessage(selected.model) === null && selected.contextWindowTokens !== null) return true;
  error = "当前工作区的模型配置不完整：请填写正确的 Model ID 和上下文窗口后再开始会话。";
  openSettings();
  settingsErrors = {
    model: selected === undefined ? "请选择一个模型。" : modelIdValidationMessage(selected.model) ?? "请填写上下文窗口。",
    contextWindow: "上下文窗口为必填项，例如 128K、1M 或整数 token 数。"
  };
  render();
  return false;
}

function settingsHasUnsavedChanges(): boolean {
  if (snapshot === null || settingsDraft === null) return false;
  const profile = snapshot.workspace.modelProfiles.find((item) => item.id === settingsDraft?.id);
  return profile !== undefined && modelSettingsDirty(settingsDraft, profile);
}

function requestCloseSettings(): void {
  if (settingsHasUnsavedChanges() && !window.confirm("放弃未保存的更改？")) return;
  settingsOpen = false;
  editingProfileId = null;
  settingsDraft = null;
  settingsErrors = {};
  settingsAdvancedOpen = false;
  apiKeyEditing = false;
  addModelOpen = false;
  addModelDraft = null;
  render();
}

function openAddModel(): void {
  if (snapshot === null) return;
  const fallback = uniqueProviderProfiles(snapshot.workspace.modelProfiles)[0];
  addModelDraft = { providerBaseUrl: fallback?.baseUrl ?? "new", baseUrl: "", apiKey: "", model: "", name: "", contextWindow: fallback?.contextWindowTokens === null || fallback?.contextWindowTokens === undefined ? "" : formatTokenCount(fallback.contextWindowTokens) };
  addModelError = null;
  addModelOpen = true;
  render();
  document.querySelector<HTMLInputElement>("[data-form='add-model'] input[name='model']")?.focus();
}

function closeAddModel(): void { addModelOpen = false; addModelDraft = null; addModelError = null; render(); }

function isNamedFormControl(target: EventTarget | null): target is HTMLInputElement | HTMLSelectElement {
  const control = target as { name?: unknown; value?: unknown } | null;
  return typeof control?.name === "string" && typeof control.value === "string";
}

function updateSettingsDraft(target: EventTarget | null): void {
  if (settingsDraft === null || !isNamedFormControl(target)) return;
  const value = target.value;
  switch (target.name) {
    case "name": settingsDraft.name = value; break;
    case "apiKey": settingsDraft.apiKey = value; break;
    case "model": settingsDraft.model = value; break;
    case "contextWindow": settingsDraft.contextWindow = value; settingsDraft.contextWindowEdited = true; break;
    case "activeTarget": settingsDraft.activeTarget = value; settingsDraft.activeTargetEdited = true; break;
    case "decisionOutput": settingsDraft.decisionOutput = value; settingsDraft.decisionOutputEdited = true; break;
    case "activeMode":
      if (value === "auto" || value === "custom") { settingsDraft.activeMode = value; settingsErrors = {}; render(); }
      return;
    case "transport": settingsDraft.transport = value === "structured_output" ? "structured_output" : "native_tools"; break;
    case "reasoning": settingsDraft.reasoning = value === "off" || value === "on" ? value : "dynamic"; break;
    case "thinkingToggleParam": settingsDraft.thinkingToggleParam = value; break;
    default: return;
  }
  validateSettingsDraft();
  refreshSettingsFooter();
}

function updateAddModelDraft(target: EventTarget | null): void {
  if (addModelDraft === null || !isNamedFormControl(target)) return;
  if (target.name === "providerBaseUrl") addModelDraft.providerBaseUrl = target.value;
  else if (target.name === "baseUrl") addModelDraft.baseUrl = target.value;
  else if (target.name === "apiKey") addModelDraft.apiKey = target.value;
  else if (target.name === "model") addModelDraft.model = target.value;
  else if (target.name === "name") addModelDraft.name = target.value;
  else if (target.name === "contextWindow") addModelDraft.contextWindow = target.value;
  if (target.name === "model") {
    addModelError = modelIdValidationMessage(target.value);
    target.setCustomValidity(addModelError ?? "");
    const field = target.closest(".settings-field");
    field?.classList.toggle("invalid", addModelError !== null);
    const errorElement = field?.querySelector<HTMLElement>(".field-error");
    if (errorElement !== null && errorElement !== undefined) errorElement.textContent = addModelError ?? "";
    const submit = target.form?.querySelector<HTMLButtonElement>("button[type='submit'], button:not([type])");
    if (submit !== null && submit !== undefined) submit.disabled = busy || addModelError !== null;
  }
}

function validateSettingsDraft(): boolean {
  if (settingsDraft === null) return false;
  const next: typeof settingsErrors = {};
  if (settingsDraft.name.trim() === "") next.name = "请输入模型名称。";
  const modelError = modelIdValidationMessage(settingsDraft.model);
  if (modelError !== null) next.model = modelError;
  if (parseTokenCount(settingsDraft.contextWindow) === null) next.contextWindow = "上下文窗口为必填项，例如 128K、1M 或整数 token 数。";
  if (settingsDraft.activeMode === "custom" && parseTokenCount(settingsDraft.activeTarget) === null) next.activeTarget = "请输入例如 128K、1M 或整数 token 数。";
  if (parseTokenCount(settingsDraft.decisionOutput) === null) next.decisionOutput = "请输入例如 16K、32K 或整数 token 数。";
  settingsErrors = next;
  for (const key of ["name", "model", "contextWindow", "activeTarget", "decisionOutput"] as const) {
    const errorElement = document.querySelector<HTMLElement>(`[data-field-error='${key}']`);
    if (errorElement !== null) errorElement.textContent = next[key] ?? "";
    errorElement?.closest(".settings-field")?.classList.toggle("invalid", next[key] !== undefined);
  }
  return Object.keys(next).length === 0;
}

function refreshSettingsFooter(): void {
  const save = document.querySelector<HTMLButtonElement>("[data-action='save-settings']");
  const status = document.querySelector<HTMLElement>(".settings-save-status");
  const dirty = settingsHasUnsavedChanges();
  if (save !== null) save.disabled = !dirty || busy || Object.keys(settingsErrors).length > 0;
  if (status !== null) status.textContent = dirty ? "有未保存的更改" : "所有更改已保存";
}

function bindActions(): void {
  const conversationContent = document.querySelector<HTMLElement>(".content-scroll");
  if (conversationContent !== null) conversationContent.onclick = (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tool], [data-public-output-toggle], [data-evidence]") : null;
    if (button === null) return;
    const toolId = button.dataset.tool;
    const outputKey = button.dataset.publicOutputToggle;
    const evidenceId = button.dataset.evidence;
    if (toolId !== undefined) toggleSet(expandedTools, toolId);
    else if (outputKey !== undefined) toggleSet(expandedPublicOutputs, outputKey);
    else if (evidenceId !== undefined) toggleSet(expandedEvidence, evidenceId);
    render();
  };
  const content = document.querySelector<HTMLElement>(".content-scroll");
  if (content !== null) {
    content.onscroll = () => {
      const key = content.dataset.contentKey;
      if (key !== undefined) contentScrollPositions.set(key, { top: content.scrollTop, following: isContentAtBottom(content) });
      const button = document.querySelector<HTMLButtonElement>("[data-action='back-to-bottom']");
      if (button !== null) button.hidden = isContentAtBottom(content);
    };
  }
  document.querySelector<HTMLButtonElement>("[data-action='back-to-bottom']")?.addEventListener("click", () => {
    const target = document.querySelector<HTMLElement>(".content-scroll");
    if (target === null) return;
    target.scrollTop = target.scrollHeight;
    const key = target.dataset.contentKey;
    if (key !== undefined) contentScrollPositions.set(key, { top: target.scrollTop, following: true });
    const button = document.querySelector<HTMLButtonElement>("[data-action='back-to-bottom']");
    if (button !== null) button.hidden = true;
  });
  document.querySelector<HTMLElement>(".session-list")?.addEventListener("scroll", (event) => {
    const list = event.currentTarget as HTMLElement;
    const maximum = Math.max(0, list.scrollHeight - list.clientHeight);
    if (maximum >= sidebarScrollTop) sidebarScrollTop = list.scrollTop;
  }, { passive: true });
  document.querySelector<HTMLElement>(".settings-modal")?.addEventListener("click", (event) => event.stopPropagation());
  document.querySelectorAll<HTMLElement>("[data-session]").forEach((element) => element.addEventListener("click", () => {
    if (element.dataset.sessionAction !== undefined || element.dataset.sessionPin !== undefined) return;
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
  document.querySelectorAll<HTMLElement>("[data-project-row]").forEach((element) => element.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button") !== null) return;
    const path = element.dataset.projectRow; if (path === undefined) return;
    const key = path.toLowerCase(); if (collapsedProjects.has(key)) collapsedProjects.delete(key); else collapsedProjects.add(key); render();
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
  document.querySelectorAll<HTMLElement>("[data-project-menu]").forEach((element) => element.addEventListener("click", (event) => { event.stopPropagation(); workspaceMenuKey = workspaceMenuKey === element.dataset.projectMenu ? null : element.dataset.projectMenu ?? null; render(); }));
  document.querySelectorAll<HTMLElement>("[data-project-new]").forEach((element) => element.addEventListener("click", () => { const path = element.dataset.projectNew; if (path === undefined) return; workspaceMenuKey = null; if (path.toLowerCase() === snapshot?.workspace.path.toLowerCase()) { snapshot = snapshot === null ? null : { ...snapshot, session: null }; draft = ""; draftAttachments = []; mode = "conversation"; render(); } else void perform(async () => { const next = await window.nexora.switchProject(path); setSnapshot(next); snapshot = { ...next, session: null }; render(); }); }));
  document.querySelectorAll<HTMLElement>("[data-workspace-pin]").forEach((element) => element.addEventListener("click", () => { const path = element.dataset.workspacePin; if (path === undefined) return; const key = path.toLowerCase(); if (pinnedWorkspaces.has(key)) pinnedWorkspaces.delete(key); else pinnedWorkspaces.add(key); workspaceMenuKey = null; render(); }));
  document.querySelectorAll<HTMLElement>("[data-workspace-remove]").forEach((element) => element.addEventListener("click", () => { removeWorkspacePath = element.dataset.workspaceRemove ?? null; workspaceMenuKey = null; render(); }));
  document.querySelector<HTMLElement>("[data-action='cancel-remove-workspace']")?.addEventListener("click", () => { removeWorkspacePath = null; render(); });
  document.querySelector<HTMLElement>("[data-action='confirm-remove-workspace']")?.addEventListener("click", () => { const path = removeWorkspacePath; if (path === null) return; removeWorkspacePath = null; void perform(() => window.nexora.removeProject(path).then(setSnapshot)); });
  document.querySelectorAll<HTMLElement>("[data-show-sessions]").forEach((element) => element.addEventListener("click", () => {
    const key = element.dataset.showSessions;
    if (key === undefined) return;
    if (showAllSessions.has(key)) showAllSessions.delete(key); else showAllSessions.add(key);
    render();
  }));
  document.querySelector<HTMLElement>("[data-action='sidebar-menu']")?.addEventListener("click", () => { sidebarMenuOpen = !sidebarMenuOpen; sessionMenuKey = null; render(); });
  document.querySelector<HTMLElement>("[data-action='sidebar-menu-close']")?.addEventListener("click", () => { sidebarMenuOpen = false; render(); });
  document.querySelector<HTMLElement>("[data-action='add-workspace']")?.addEventListener("click", () => { sidebarMenuOpen = false; void perform(async () => { const next = await window.nexora.chooseWorkspace(); if (next !== null) setSnapshot(next); }); });
  document.querySelectorAll<HTMLElement>("[data-sidebar-sort]").forEach((element) => element.addEventListener("click", () => { sidebarMenuOpen = false; render(); }));
  document.querySelectorAll<HTMLElement>("[data-session-pin]").forEach((element) => element.addEventListener("click", () => {
    const id = element.dataset.sessionPin;
    if (id === undefined) return;
    if (pinnedSessions.has(id)) pinnedSessions.delete(id); else pinnedSessions.add(id);
    sessionMenuKey = null;
    render();
  }));
  document.onclick = () => { if (workspaceMenuKey !== null || sessionMenuKey !== null || composerAddOpen || modelMenuOpen) { workspaceMenuKey = null; sessionMenuKey = null; composerAddOpen = false; modelMenuOpen = false; render(); } };
  document.onkeydown = (event) => { if (event.key === "Escape" && (workspaceMenuKey !== null || sessionMenuKey !== null || composerAddOpen || modelMenuOpen)) { workspaceMenuKey = null; sessionMenuKey = null; composerAddOpen = false; modelMenuOpen = false; render(); } };
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => {
    const nextMode = element.dataset.view === "output" ? "output" : "conversation";
    if (nextMode === "output" && snapshot?.session !== null && snapshot?.session !== undefined) {
      const selected = activeDeliverable(snapshot.session);
      if (selected !== null) {
        const key = deliverablePreviewKey(selected);
        deliverablePreviews.delete(key);
        unavailableDeliverables.delete(key);
      }
    }
    mode = nextMode;
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-deliverable-select]").forEach((element) => element.addEventListener("click", () => {
    selectedDeliverableId = element.dataset.deliverableSelect ?? null;
    if (snapshot?.session !== null && snapshot?.session !== undefined) {
      const selected = activeDeliverable(snapshot.session);
      if (selected !== null) {
        const key = deliverablePreviewKey(selected);
        deliverablePreviews.delete(key);
        unavailableDeliverables.delete(key);
      }
    }
    render();
  }));
  document.querySelector<HTMLInputElement>("[data-session-search]")?.addEventListener("input", (event) => {
    sidebarQuery = (event.currentTarget as HTMLInputElement).value;
    render();
    const input = document.querySelector<HTMLInputElement>("[data-session-search]");
    input?.focus();
    input?.setSelectionRange(sidebarQuery.length, sidebarQuery.length);
  });
  document.querySelector<HTMLElement>("[data-action='sidebar-search']")?.addEventListener("click", () => {
    sidebarSearchOpen = !sidebarSearchOpen;
    if (!sidebarSearchOpen) sidebarQuery = "";
    render();
    document.querySelector<HTMLInputElement>("[data-session-search]")?.focus();
  });
  document.querySelector<HTMLSelectElement>("[data-status-filter]")?.addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    sidebarStatus = value === "running" || value === "waiting" || value === "succeeded" || value === "failed" ? value : "all";
    render();
  });
  document.querySelectorAll<HTMLElement>("[data-process-logs]").forEach((element) => element.addEventListener("click", () => {
    const handle = element.dataset.processLogs;
    const sessionId = snapshot?.session?.id;
    if (handle === undefined || sessionId === undefined) return;
    void perform(async () => setSnapshot(await window.nexora.continueSession(sessionId, { text: `查看受管理进程 ${handle} 的最新日志并报告当前状态。`, attachments: [] })));
  }));
  document.querySelectorAll<HTMLElement>("[data-process-stop]").forEach((element) => element.addEventListener("click", () => {
    const handle = element.dataset.processStop;
    const sessionId = snapshot?.session?.id;
    if (handle === undefined || sessionId === undefined || !window.confirm("Stop this managed process and its descendants?")) return;
    void perform(async () => setSnapshot(await window.nexora.continueSession(sessionId, { text: `停止受管理进程 ${handle}，确认完整进程树已经退出。`, attachments: [] })));
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
  document.querySelectorAll<HTMLButtonElement>(".copy-code").forEach((button) => button.addEventListener("click", async () => {
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    if (code === "") return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = code;
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.append(fallback);
      fallback.select();
      document.execCommand("copy");
      fallback.remove();
    }
    button.textContent = "已复制";
    button.classList.add("copied");
    window.setTimeout(() => { button.textContent = "复制"; button.classList.remove("copied"); }, 1_400);
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
    else if (action === "new-task") { snapshot = snapshot === null ? null : { ...snapshot, session: null }; draft = ""; draftAttachments = []; mode = "conversation"; selectedDeliverableId = null; render(); }
    else if (action === "attach") {
      event.stopPropagation();
      if (element.classList.contains("attach-button")) {
        composerAddOpen = !composerAddOpen;
        modelMenuOpen = false;
        render();
        if (composerAddOpen) document.querySelector<HTMLElement>(".composer-add-menu [role='menuitem']")?.focus();
      } else {
        composerAddOpen = false;
        void chooseAttachments();
      }
    }
    else if (action === "attach-folder") { event.stopPropagation(); composerAddOpen = false; void chooseAttachmentFolder(); }
    else if (action === "settings") { openSettings(); }
    else if (action === "close-settings" || action === "cancel-settings") { if (event.target === element || element.tagName === "BUTTON") requestCloseSettings(); }
    else if (action === "add-model") { openAddModel(); }
    else if (action === "close-add-model") { closeAddModel(); }
    else if (action === "replace-api-key") { apiKeyEditing = !apiKeyEditing; if (!apiKeyEditing && settingsDraft !== null) settingsDraft.apiKey = ""; render(); }
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
  document.querySelectorAll<HTMLElement>(".composer-add-menu, .model-menu").forEach((element) => element.addEventListener("click", (event) => event.stopPropagation()));
  document.querySelectorAll<HTMLElement>(".composer-add-menu [role='menuitem']").forEach((element) => element.addEventListener("keydown", (event) => {
    const options = Array.from(document.querySelectorAll<HTMLElement>(".composer-add-menu [role='menuitem']"));
    const current = options.indexOf(element);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[(current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      composerAddOpen = false;
      render();
      document.querySelector<HTMLElement>(".attach-button")?.focus();
    }
  }));
  const modelTrigger = document.querySelector<HTMLElement>("[data-model-trigger]");
  modelTrigger?.addEventListener("click", (event) => {
    event.stopPropagation();
    modelMenuOpen = !modelMenuOpen;
    composerAddOpen = false;
    render();
  });
  modelTrigger?.addEventListener("keydown", (event) => {
    const profiles = snapshot?.workspace.modelProfiles ?? [];
    if (profiles.length === 0) return;
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!modelMenuOpen) modelMenuOpen = true;
      modelMenuIndex = event.key === "ArrowUp" ? profiles.length + 2 : Math.max(0, profiles.findIndex((profile) => profile.id === snapshot?.workspace.selectedModelProfileId));
      render();
      document.querySelector<HTMLElement>("[data-model-menu-option].keyboard-active")?.focus();
    }
  });
  document.querySelectorAll<HTMLElement>("[data-model-menu-option]").forEach((element) => element.addEventListener("keydown", (event) => {
    const options = Array.from(document.querySelectorAll<HTMLElement>("[data-model-menu-option]"));
    const current = options.indexOf(element);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      modelMenuIndex = next;
      options[next]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      element.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      modelMenuOpen = false;
      render();
      document.querySelector<HTMLElement>("[data-model-trigger]")?.focus();
    }
  }));
  document.querySelectorAll<HTMLElement>("[data-profile-option]").forEach((element) => element.addEventListener("click", () => { const id = element.dataset.profileOption; if (id === undefined) return; modelMenuOpen = false; void perform(() => window.nexora.selectModelProfile(id).then(setSnapshot)); }));
  document.querySelectorAll<HTMLElement>("[data-reasoning-option]").forEach((element) => element.addEventListener("click", () => {
    const reasoning = element.dataset.reasoningOption;
    if (reasoning !== "off" && reasoning !== "dynamic" && reasoning !== "on") return;
    modelMenuOpen = false;
    void perform(() => window.nexora.setSelectedModelReasoning(reasoning).then(setSnapshot));
  }));
  document.querySelectorAll<HTMLElement>("[data-profile-edit]").forEach((element) => element.addEventListener("click", () => {
    const id = element.dataset.profileEdit;
    if (id === undefined || id === editingProfileId) return;
    if (settingsHasUnsavedChanges() && !window.confirm("放弃未保存的更改？")) return;
    const selected = snapshot?.workspace.modelProfiles.find((item) => item.id === id);
    if (selected === undefined) return;
    editingProfileId = id;
    settingsDraft = modelSettingsDraft(selected);
    settingsErrors = {};
    settingsAdvancedOpen = false;
    apiKeyEditing = false;
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-profile-delete]").forEach((element) => element.addEventListener("click", () => {
    const id = element.dataset.profileDelete;
    if (id === undefined || !window.confirm("删除这个模型？此操作不会删除 Provider 中的模型。")) return;
    void perform(() => window.nexora.deleteModelProfile(id).then((next) => {
      editingProfileId = next.workspace.selectedModelProfileId ?? next.workspace.modelProfiles[0]?.id ?? null;
      const selected = next.workspace.modelProfiles.find((item) => item.id === editingProfileId);
      settingsDraft = selected === undefined ? null : modelSettingsDraft(selected);
      settingsErrors = {};
      setSnapshot(next);
    }));
  }));
  document.querySelector<HTMLFormElement>("[data-form='goal']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const goal = new FormData(event.currentTarget as HTMLFormElement).get("goal");
    if (typeof goal === "string") {
      if (!ensureSelectedModelReady()) return;
      void perform(async () => { const next = await window.nexora.startSession({ text: goal, attachments: draftAttachments }); draft = ""; draftAttachments = []; setSnapshot(next); });
    }
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
    if (typeof text === "string" && sessionId !== undefined && ensureSelectedModelReady()) void perform(async () => {
      const command = text.trim().toLowerCase();
      const next = command === "/压缩上下文" || command === "/compact"
        ? await window.nexora.compactSession(sessionId)
        : await window.nexora.continueSession(sessionId, { text, attachments: draftAttachments });
      draft = "";
      draftAttachments = [];
      setSnapshot(next);
    });
  });
  const settingsForm = document.querySelector<HTMLFormElement>("[data-form='model-profile']");
  settingsForm?.addEventListener("input", (event) => updateSettingsDraft(event.target));
  settingsForm?.addEventListener("change", (event) => updateSettingsDraft(event.target));
  settingsForm?.querySelector("details")?.addEventListener("toggle", (event) => { settingsAdvancedOpen = (event.currentTarget as HTMLDetailsElement).open; });
  settingsForm?.querySelectorAll<HTMLInputElement>("input[name='contextWindow'], input[name='activeTarget'], input[name='decisionOutput']").forEach((input) => input.addEventListener("blur", () => {
    const parsed = parseTokenCount(input.value);
    if (parsed !== null && settingsDraft !== null) {
      const original = input.name === "contextWindow" ? settingsDraft.contextWindowTokens : input.name === "activeTarget" ? settingsDraft.activeTargetTokens : settingsDraft.decisionOutputTokens;
      const originalText = original === null ? "" : formatTokenCount(original);
      input.value = formatTokenCount(parsed);
      if (input.name === "contextWindow") { settingsDraft.contextWindow = input.value; if (input.value !== originalText) settingsDraft.contextWindowTokens = parsed; }
      else if (input.name === "activeTarget") { settingsDraft.activeTarget = input.value; if (input.value !== originalText) settingsDraft.activeTargetTokens = parsed; }
      else { settingsDraft.decisionOutput = input.value; if (input.value !== originalText) settingsDraft.decisionOutputTokens = parsed; }
      validateSettingsDraft();
      refreshSettingsFooter();
    }
  }));
  settingsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (settingsDraft === null || !validateSettingsDraft()) { render(); return; }
    const draft = settingsDraft;
    const contextWindowTokens = resolveTokenInput(draft.contextWindow, draft.contextWindowTokens, draft.contextWindowEdited);
    const activeInputTargetTokens = draft.activeMode === "auto" ? null : resolveTokenInput(draft.activeTarget, draft.activeTargetTokens, draft.activeTargetEdited);
    const decisionOutputTokens = resolveTokenInput(draft.decisionOutput, draft.decisionOutputTokens, draft.decisionOutputEdited);
    if (decisionOutputTokens === null) return;
    void perform(async () => {
      const next = await window.nexora.saveModelProfile({
        id: draft.id,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        model: draft.model.trim(),
        ...(contextWindowTokens === null ? {} : { contextWindowTokens }),
        activeInputTargetTokens,
        decisionOutputTokens,
        transport: draft.transport,
        reasoning: draft.reasoning,
        thinkingToggleParam: draft.thinkingToggleParam.trim() || null
      });
      const saved = next.workspace.modelProfiles.find((item) => item.id === draft.id);
      settingsDraft = saved === undefined ? null : modelSettingsDraft(saved);
      settingsErrors = {};
      apiKeyEditing = false;
      setSnapshot(next);
    });
  });
  const addForm = document.querySelector<HTMLFormElement>("[data-form='add-model']");
  addForm?.addEventListener("input", (event) => updateAddModelDraft(event.target));
  addForm?.addEventListener("change", (event) => {
    updateAddModelDraft(event.target);
    if (event.target instanceof HTMLSelectElement && event.target.name === "providerBaseUrl") render();
  });
  addForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (addModelDraft === null || snapshot === null) return;
    addModelError = modelIdValidationMessage(addModelDraft.model);
    const modelInput = form.elements.namedItem("model") as HTMLInputElement | null;
    modelInput?.setCustomValidity(addModelError ?? "");
    if (!form.reportValidity() || addModelError !== null) { render(); return; }
    const providerProfile = snapshot.workspace.modelProfiles.find((item) => sameProviderUrl(item.baseUrl, addModelDraft!.providerBaseUrl));
    const baseUrl = addModelDraft.providerBaseUrl === "new" ? addModelDraft.baseUrl.trim() : addModelDraft.providerBaseUrl;
    const contextWindowTokens = parseTokenCount(addModelDraft.contextWindow);
    if (contextWindowTokens === null) { error = "请填写有效的上下文窗口，例如 1M 或 128K。"; render(); return; }
    const id = crypto.randomUUID();
    const defaults = providerProfile;
    void perform(async () => {
      let next = await window.nexora.saveModelProfile({ id, name: addModelDraft!.name.trim(), baseUrl, ...(addModelDraft!.apiKey.trim() ? { apiKey: addModelDraft!.apiKey.trim() } : {}), model: addModelDraft!.model.trim(), contextWindowTokens, ...(defaults?.activeInputTargetTokens === null || defaults?.activeInputTargetTokens === undefined ? {} : { activeInputTargetTokens: defaults.activeInputTargetTokens }), decisionOutputTokens: defaults?.decisionOutputTokens ?? 4096, transport: defaults?.transport ?? "native_tools", reasoning: defaults?.reasoning ?? "dynamic", thinkingToggleParam: defaults?.thinkingToggleParam ?? null });
      next = await window.nexora.selectModelProfile(id);
      const created = next.workspace.modelProfiles.find((item) => item.id === id)!;
      editingProfileId = id;
      settingsDraft = modelSettingsDraft(created);
      addModelOpen = false;
      addModelDraft = null;
      settingsErrors = {};
      setSnapshot(next);
    });
  });
  document.querySelectorAll<HTMLTextAreaElement>("textarea[name='goal'], textarea[name='text']").forEach((input) => input.addEventListener("input", () => { draft = input.value; input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; document.querySelector<HTMLButtonElement>(".composer .send-button")?.toggleAttribute("disabled", draft.trim() === "" || busy); }));
  document.querySelectorAll<HTMLTextAreaElement>("textarea[name='goal'], textarea[name='text']").forEach((input) => input.addEventListener("keydown", (event) => {
    if (!shouldSendOnEnter(event, busy)) return;
    event.preventDefault();
    input.form?.requestSubmit();
  }));
  document.querySelectorAll<HTMLElement>("[data-remove-attachment]").forEach((element) => element.addEventListener("click", () => {
    draftAttachments = draftAttachments.filter(({ id }) => id !== element.dataset.removeAttachment);
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-remove-attachment-group]").forEach((element) => element.addEventListener("click", () => {
    draftAttachments = draftAttachments.filter((attachment) => attachment.source?.id !== element.dataset.removeAttachmentGroup);
    render();
  }));
  document.querySelectorAll<HTMLFormElement>("[data-form='goal'], [data-form='follow-up']").forEach((form) => {
    form.addEventListener("dragenter", (event) => { event.preventDefault(); form.classList.add("is-dragging"); });
    form.addEventListener("dragover", (event) => { event.preventDefault(); form.classList.add("is-dragging"); });
    form.addEventListener("dragleave", () => form.classList.remove("is-dragging"));
    form.addEventListener("drop", (event) => {
      event.preventDefault();
      form.classList.remove("is-dragging");
      const files = event.dataTransfer?.files;
      if (files !== undefined && files.length > 0) void stageDroppedAttachments(files);
    });
  });
  bindDeliverablePreview();
  if (mode === "output") void ensureActiveDeliverablePreview();
}

function activeDeliverable(session: SessionView): DeliverableSummary | null {
  const selected = session.deliverables.find((deliverable) => deliverable.deliverableId === selectedDeliverableId);
  return selected ?? session.deliverables.at(-1) ?? null;
}

function deliverablePreviewKey(deliverable: DeliverableSummary): string {
  return `${deliverable.deliverableId}:${deliverable.revision}:${deliverable.previewDigest}`;
}

async function ensureActiveDeliverablePreview(): Promise<void> {
  const state = snapshot;
  const session = state?.session;
  if (state === null || state === undefined || session === null || session === undefined) return;
  const deliverable = activeDeliverable(session);
  if (deliverable === null) return;
  selectedDeliverableId = deliverable.deliverableId;
  const key = deliverablePreviewKey(deliverable);
  if (deliverablePreviews.has(key) || loadingDeliverables.has(key) || unavailableDeliverables.has(key)) return;
  loadingDeliverables.add(key);
  render();
  try {
    const preview = await window.nexora.readDeliverable(
      state.workspace.path,
      deliverable.manifestPath,
      deliverable.revision,
      deliverable.previewDigest
    );
    deliverablePreviews.set(key, preview);
    unavailableDeliverables.delete(key);
  } catch (cause) {
    unavailableDeliverables.set(key, messageOf(cause));
  } finally {
    loadingDeliverables.delete(key);
    render();
  }
}

function bindDeliverablePreview(): void {
  const iframe = document.querySelector<HTMLIFrameElement>("[data-deliverable-preview]");
  const key = iframe?.dataset.deliverablePreview;
  if (iframe === null || iframe === undefined || key === undefined) return;
  const preview = deliverablePreviews.get(key);
  if (preview === undefined) return;
  iframe.addEventListener("load", () => {
    const documentView = iframe.contentDocument;
    if (documentView === null) return;
    documentView.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      const href = link.getAttribute("href");
      if (href !== null) void perform(() => window.nexora.openExternal(href));
    }));
  }, { once: true });
  iframe.srcdoc = preview.html;
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
    publicOutputBatcher.queue(key);
    return;
  }
  existing.text += event.text;
  publicOutputBatcher.queue(key);
}

function flushPublicOutputs(keys: readonly string[]): void {
  const content = document.querySelector<HTMLElement>(".content-scroll");
  const follow = content === null || isContentAtBottom(content);
  for (const key of keys) {
    const output = publicOutputs.get(key);
    if (output === undefined) continue;
    const element = document.querySelector<HTMLElement>(`[data-public-output="${CSS.escape(key)}"]`);
    if (element === null) continue;
    element.classList.toggle("streaming", !output.completed);
    element.classList.toggle("completed", output.completed);
    const preview = element.querySelector<HTMLElement>(".think-preview");
    if (preview !== null) preview.textContent = compactLatest(output.text, 220);
    const cursor = element.querySelector<HTMLElement>(".execution-cursor");
    if (cursor !== null) cursor.textContent = output.completed ? "" : "▍";
    const body = element.querySelector<HTMLElement>(".markdown-body");
    if (body === null) continue;
    body.innerHTML = renderMarkdown(output.text);
  }
  if (content !== null) {
    if (follow) content.scrollTop = content.scrollHeight;
    const button = document.querySelector<HTMLButtonElement>("[data-action='back-to-bottom']");
    if (button !== null) button.hidden = follow;
  }
}

function artifactSummary(deliverables: readonly DeliverableSummary[]): string {
  const files = deliverables.flatMap((deliverable) => deliverable.files.map((file) => ({ ...file, title: deliverable.title })));
  if (files.length === 0) return "";
  return `<section class="artifact-outputs"><header><strong>产物</strong><small>${files.length} 个可打开文件</small></header><div>${files.map((file) => `
    <button data-workspace-entry="${escapeAttr(file.path)}" title="${escapeAttr(file.path)}"><span class="artifact-format">${escapeHtml(file.format.toUpperCase())}</span><span><strong>${escapeHtml(file.title)}</strong><small>${escapeHtml(file.path)}</small></span><span class="artifact-open">打开</span></button>
  `).join("")}</div></section>`;
}

async function controlAction(action: string): Promise<void> {
  const request = snapshot?.session?.inspection.pendingRequest;
  if (action === "approve" && request?.kind === "approval") return await sendControl({ type: "approve", requestId: request.id });
  if (action === "deny" && request?.kind === "approval") {
    const reason = window.prompt("Reason for rejection (optional)")?.trim();
    return await sendControl({ type: "deny", requestId: request.id, ...(reason ? { reason } : {}) });
  }
  if (action === "cancel") return await sendControl({ type: "cancel" });
  if (action === "extend-budget") {
    const dimensions = Array.from(document.querySelectorAll<HTMLInputElement>("[data-budget-dimension]:checked"))
      .map((element) => element.dataset.budgetDimension)
      .filter((dimension): dimension is "iterations" | "modelCalls" | "toolCalls" | "retries" => dimension === "iterations" || dimension === "modelCalls" || dimension === "toolCalls" || dimension === "retries");
    if (dimensions.length === 0) { error = "Select at least one Runtime-approved budget dimension."; render(); return; }
    return await sendControl({ type: "extend_budget", budgetExtension: Object.fromEntries(dimensions.map((dimension) => [dimension, 10])) });
  }
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

async function chooseAttachments(): Promise<void> {
  await perform(async () => {
    const attachments = await window.nexora.chooseAttachments();
    mergeDraftAttachments(attachments);
  });
}

async function chooseAttachmentFolder(): Promise<void> {
  await perform(async () => {
    const attachments = await window.nexora.chooseAttachmentFolder();
    mergeDraftAttachments(attachments);
  });
}

async function stageDroppedAttachments(files: FileList): Promise<void> {
  await perform(async () => {
    const attachments = await window.nexora.stageDroppedAttachments(Array.from(files));
    mergeDraftAttachments(attachments);
  });
}

function mergeDraftAttachments(attachments: readonly AttachmentView[]): void {
  const byId = new Map(draftAttachments.map((attachment) => [attachment.id, attachment]));
  for (const attachment of attachments) byId.set(attachment.id, attachment);
  draftAttachments = [...byId.values()].slice(0, 8);
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
  const previousIdentity = snapshot === null ? null : `${snapshot.workspace.path.toLowerCase()}::${snapshot.session?.id ?? ""}`;
  const nextIdentity = `${next.workspace.path.toLowerCase()}::${next.session?.id ?? ""}`;
  if (previousIdentity !== nextIdentity) {
    deliverablePreviews.clear();
    unavailableDeliverables.clear();
    loadingDeliverables.clear();
  }
  snapshot = next;
  if (next.session === null || next.session.deliverables.length === 0) {
    if (mode === "output") mode = "conversation";
    selectedDeliverableId = null;
  } else if (!next.session.deliverables.some((deliverable) => deliverable.deliverableId === selectedDeliverableId)) {
    selectedDeliverableId = next.session.deliverables.at(-1)?.deliverableId ?? null;
  }
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
function toggleSet(values: Set<string>, value: string): void { if (values.has(value)) values.delete(value); else values.add(value); }

function showArtifact(text: string, truncated: boolean): void {
  const dialog = document.createElement("dialog");
  dialog.className = "artifact-dialog";
  dialog.innerHTML = `<header><strong>Artifact${truncated ? " · preview" : ""}</strong><button>×</button></header><pre>${escapeHtml(text)}</pre>`;
  dialog.querySelector("button")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function toolPresentation(name: string, input: unknown): { action: string; target: string | null; workspacePath: string | null } {
  const value = objectValue(input);
  const command = shellCommand(value);
  const target = stringValue(value.path) ?? stringValue(value.manifestPath) ?? stringValue(value.outputDirectory) ?? stringValue(value.query) ?? command ?? stringValue(value.pattern) ?? stringValue(value.endpoint);
  const lower = name.toLowerCase();
  const isTest = command !== null && /(?:^|\s)(?:test|vitest|jest|pytest|playwright|cypress|mocha|ava)(?:\s|$)|--test\b/iu.test(command);
  const action = name === "document.create" ? "创建文件" : name === "document.inspect" ? "检查文件" : name === "document.apply_patch" ? "修改文件" : name === "document.export" ? "导出文件" : lower.includes("process.start") ? "启动服务" : lower.includes("browser") || lower.includes("http") ? "检查页面" : lower.includes("read") ? "读取文件" : lower.includes("list") ? "检查文件" : lower.includes("search") ? "搜索代码" : lower.includes("write") || lower.includes("patch") ? "修改文件" : lower.includes("shell") || lower.includes("command") ? isTest ? "运行测试" : "运行命令" : humanize(name);
  return {
    action,
    target: target === null ? null : compact(target, 120),
    workspacePath: stringValue(value.path) ?? stringValue(value.manifestPath) ?? stringValue(value.outputDirectory)
  };
}
function contextUsage(session: SessionView): { used: number; target: number; window: number; percent: number } | null {
  const usage = session.inspection.contextUsage;
  if (usage === null) return null;
  return { used: usage.inputTokens, target: usage.softInputLimitTokens, window: usage.contextWindowTokens, percent: Math.min(100, usage.inputTokens / usage.contextWindowTokens * 100) };
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
function toolIcon(name: string): string { const lower = name.toLowerCase(); return lower.includes("shell") || lower.includes("command") || lower.includes("process") ? "⌘" : lower.includes("browser") || lower.includes("http") ? "◎" : lower.includes("read") || lower.includes("list") || lower.includes("search") || lower.includes("inspect") ? "⌕" : lower.includes("create") ? "＋" : lower.includes("write") || lower.includes("patch") ? "✎" : "·"; }
function statusLabel(status: string): string { return ({ running: "正在工作", waiting_for_input: "需要回复", waiting_for_approval: "需要确认", blocked: "已暂停", succeeded: "已完成", failed: "未完成", cancelled: "已取消" } as Record<string, string>)[status] ?? humanize(status); }
function threadIndicator(status: string, pendingRequestKind: string | null): string {
  if (pendingRequestKind === "approval") return `<span class="thread-indicator approval" title="需要批准">!</span>`;
  if (pendingRequestKind === "input") return `<span class="thread-indicator input" title="需要回复">?</span>`;
  if (status === "running") return `<span class="thread-indicator running" title="正在工作"></span>`;
  if (status === "failed" || status === "blocked") return `<span class="thread-indicator problem" title="需要处理">!</span>`;
  return "";
}
function sessionStatusLabel(session: SessionView): string { return partialOfficeOutcome(session) ? "部分完成（已提交格式保留）" : statusLabel(session.inspection.status); }
function partialOfficeOutcome(session: SessionView): boolean {
  if (!["blocked", "failed", "cancelled"].includes(session.inspection.status) || session.deliverables.length === 0) return false;
  return true;
}
function duration(start: string, end: string | null): string { if (end === null) return ""; const ms = Date.parse(end) - Date.parse(start); return Number.isFinite(ms) && ms >= 0 ? ` · ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}` : ""; }
function objectValue(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function compact(value: string, limit: number): string { const line = value.replace(/\s+/g, " "); return line.length <= limit ? line : `${line.slice(0, limit - 3)}...`; }
function humanize(value: string): string { return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function errorView(value: string): string { return `<div class="fatal"><div class="empty-mark">!</div><h1>Could not open Nexora</h1><p>${escapeHtml(value)}</p></div>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!); }
function escapeAttr(value: string): string { return escapeHtml(value); }
