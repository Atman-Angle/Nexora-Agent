import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  createAgent,
  createAgentProfileSnapshot,
  createBuiltInTools,
  openAICompatibleProviderFromEnv,
  type AgentPublicOutputEvent,
  type RunHandle,
  type RunInspection,
  type RuntimeSubscription
} from "@nexora/harness";

import type {
  DesktopSessionSummary,
  DesktopSnapshot,
  ProjectView,
  ModelProfileInput,
  ModelProfileView,
  SessionControl,
  PersistedPublicOutput,
  SessionRunView,
  SessionView,
  WorkspaceView
} from "./shared.js";

const DESKTOP_PROFILE = createAgentProfileSnapshot({
  schemaVersion: 1,
  id: "nexora-desktop-workspace-agent",
  version: "1",
  role: { identity: "Workspace development agent", objective: "Complete the user's workspace task while preserving repository contracts." },
  strategy: { principles: ["Inspect workspace facts before changing files.", "Keep changes scoped to the requested outcome.", "Verify changed behavior proportionately."] },
  communication: { audience: "Software project contributors", tone: "Direct and factual" }
}, { kind: "host", ref: "apps/desktop" });

type AgentRuntime = ReturnType<typeof createAgent>;
type ProviderEnvironment = Record<string, string | undefined>;
type StoredTurn = { runId: string; userInput: string };
type StoredSession = {
  id: string;
  title: string;
  turns: StoredTurn[];
  archived: boolean;
  status: RunInspection["status"];
  pendingRequestKind: "input" | "approval" | null;
  updatedAt: string;
};
type StoredModelProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  contextWindowTokens: number | null;
  activeInputTargetTokens: number | null;
  decisionOutputTokens: number;
  transport: "native_tools" | "structured_output";
  reasoning: "off" | "dynamic" | "on";
  thinkingToggleParam: string | null;
};
type StoredProject = {
  path: string;
  name: string;
  sessions: StoredSession[];
  hiddenRunIds: string[];
  selectedModelProfileId: string | null;
};
type HostConfig = { version: 2; modelProfiles: StoredModelProfile[]; projects: StoredProject[] };
type LegacyStoredProject = StoredProject & { modelProfiles?: StoredModelProfile[] };

export class DesktopRuntimeService {
  readonly #onSnapshot: (snapshot: DesktopSnapshot) => void;
  readonly #onError: (message: string) => void;
  readonly #onPublicOutput: (event: AgentPublicOutputEvent) => void;
  readonly #hostConfigPath: string;
  readonly #hostSecretsPath: string;
  #hostConfig: HostConfig;
  #workspace: string;
  readonly #runtimes = new Map<string, AgentRuntime>();
  #providerError: string | null = null;
  readonly #activeSessionIds = new Map<string, string>();
  readonly #subscriptions = new Map<string, RuntimeSubscription>();
  readonly #dirtyRuntimeKeys = new Set<string>();
  readonly #publicOutputArtifacts = new Map<string, { readonly reasoning: string; readonly content: string }>();

  constructor(input: { readonly workspace: string; readonly onSnapshot: (snapshot: DesktopSnapshot) => void; readonly onError: (message: string) => void; readonly onPublicOutput?: (event: AgentPublicOutputEvent) => void }) {
    this.#workspace = resolve(input.workspace);
    this.#hostConfigPath = join(this.#workspace, ".nexora", "desktop-host.json");
    this.#hostSecretsPath = join(dirname(this.#hostConfigPath), "desktop-secrets.env");
    this.#hostConfig = this.#readHostConfig();
    this.#ensureProject(this.#workspace);
    this.#migrateGlobalSecrets();
    this.#writeHostConfig();
    this.#onSnapshot = input.onSnapshot;
    this.#onError = input.onError;
    this.#onPublicOutput = input.onPublicOutput ?? (() => {});
  }

  async snapshot(): Promise<DesktopSnapshot> {
    let runtime: AgentRuntime | null = null;
    this.#providerError = null;
    if (this.#providerConfigured()) {
      try { runtime = this.#requireRuntime(); }
      catch (error) { this.#providerError = errorMessage(error); }
    }
    if (runtime !== null) await this.#synchronizeProject(runtime);
    const workspace = this.#workspaceView();
    const activeSessionId = this.#activeSessionIds.get(workspaceKey(this.#workspace));
    const session = runtime === null || activeSessionId === undefined ? null : await this.#sessionView(runtime, this.#requireSession(activeSessionId));
    return { workspace, session };
  }

  async setWorkspace(path: string): Promise<DesktopSnapshot> {
    const next = resolve(path);
    this.#workspace = next;
    this.#ensureProject(next);
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async addProject(path: string): Promise<DesktopSnapshot> {
    const next = resolve(path);
    this.#ensureProject(next);
    this.#writeHostConfig();
    if (next.toLowerCase() === this.#workspace.toLowerCase()) return await this.snapshot();
    return await this.setWorkspace(next);
  }

  async startSession(goal: string): Promise<DesktopSnapshot> {
    const text = requireText(goal, "Task goal");
    await this.#prepareRuntimeForNewRun();
    const runtime = this.#requireRuntime();
    const handle = runtime.run(text);
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: handle.id,
      title: compact(text, 96),
      turns: [{ runId: handle.id, userInput: text }],
      archived: false,
      status: "running",
      pendingRequestKind: null,
      updatedAt: now
    };
    this.#currentProject().sessions.unshift(session);
    this.#activeSessionIds.set(workspaceKey(this.#workspace), session.id);
    this.#writeHostConfig();
    await this.#watch(handle);
    return await this.snapshot();
  }

  async continueSession(sessionId: string, input: string): Promise<DesktopSnapshot> {
    const text = requireText(input, "Session input");
    await this.#prepareRuntimeForNewRun();
    const runtime = this.#requireRuntime();
    const session = this.#requireSession(sessionId);
    const previousTurn = session.turns.at(-1);
    if (previousTurn === undefined) throw new Error("Desktop Session has no Runtime Run.");
    const previous = runtime.openRun(previousTurn.runId);
    let inspection = await previous.inspect();
    if (inspection.status === "running") {
      await previous.cancel("Interrupted by follow-up input from Nexora Desktop.");
      inspection = await previous.inspect();
    } else if (["waiting_for_input", "waiting_for_approval", "blocked"].includes(inspection.status)) {
      throw new Error(`Resolve the current ${inspection.status} state before sending a follow-up.`);
    }
    const handle = runtime.run(text, {
      continuation: { parentRunId: inspection.runId }
    });
    session.turns.push({ runId: handle.id, userInput: text });
    session.archived = false;
    session.status = "running";
    session.pendingRequestKind = null;
    session.updatedAt = new Date().toISOString();
    this.#activeSessionIds.set(workspaceKey(this.#workspace), session.id);
    this.#writeHostConfig();
    await this.#watch(handle);
    return await this.snapshot();
  }

  async compactSession(sessionId: string): Promise<DesktopSnapshot> {
    const runtime = this.#requireRuntime();
    const session = this.#requireSession(sessionId);
    const latest = session.turns.at(-1);
    if (latest === undefined) throw new Error("Desktop Session has no Runtime Run.");
    const handle = runtime.openRun(latest.runId);
    let inspection = await handle.inspect();
    if (inspection.status === "running") {
      await handle.cancel("Interrupted by manual Context compaction from Nexora Desktop.");
      inspection = await handle.inspect();
    }
    if (inspection.status !== "succeeded" && inspection.status !== "failed" && inspection.status !== "cancelled") {
      throw new Error(`Resolve the current ${inspection.status} state before compacting Context.`);
    }
    await handle.compactContext();
    session.status = inspection.status;
    session.pendingRequestKind = null;
    session.updatedAt = new Date().toISOString();
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async openSession(projectPath: string, sessionId: string): Promise<DesktopSnapshot> {
    const target = resolve(projectPath);
    if (target.toLowerCase() !== this.#workspace.toLowerCase()) await this.setWorkspace(target);
    const runtime = this.#requireRuntime();
    await this.#synchronizeProject(runtime);
    const session = this.#requireSession(sessionId);
    const latest = session.turns.at(-1);
    if (latest === undefined) throw new Error("Desktop Session has no Runtime Run.");
    this.#activeSessionIds.set(workspaceKey(this.#workspace), session.id);
    await this.#watch(runtime.openRun(latest.runId));
    return await this.snapshot();
  }

  async archiveSession(projectPath: string, sessionId: string, archived: boolean): Promise<DesktopSnapshot> {
    const project = this.#requireProject(projectPath);
    const session = this.#requireProjectSession(project, sessionId);
    this.#assertSessionNotRunning(session);
    session.archived = archived;
    session.updatedAt = new Date().toISOString();
    if (archived && this.#activeSessionIds.get(workspaceKey(project.path)) === sessionId) this.#activeSessionIds.delete(workspaceKey(project.path));
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async removeSession(projectPath: string, sessionId: string): Promise<DesktopSnapshot> {
    const project = this.#requireProject(projectPath);
    const session = this.#requireProjectSession(project, sessionId);
    this.#assertSessionNotRunning(session);
    project.hiddenRunIds = [...new Set([...project.hiddenRunIds, ...session.turns.map(({ runId }) => runId)])];
    project.sessions = project.sessions.filter(({ id }) => id !== sessionId);
    if (this.#activeSessionIds.get(workspaceKey(project.path)) === sessionId) this.#activeSessionIds.delete(workspaceKey(project.path));
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async saveModelProfile(input: ModelProfileInput): Promise<DesktopSnapshot> {
    const id = input.id?.trim() || randomUUID();
    const existing = this.#hostConfig.modelProfiles.find((profile) => profile.id === id);
    const profile: StoredModelProfile = {
      id,
      name: requireText(input.name, "Profile name"),
      baseUrl: requireText(input.baseUrl, "Provider base URL"),
      model: requireText(input.model, "Model name"),
      contextWindowTokens: input.contextWindowTokens ?? null,
      activeInputTargetTokens: input.activeInputTargetTokens ?? existing?.activeInputTargetTokens ?? null,
      decisionOutputTokens: input.decisionOutputTokens,
      transport: input.transport,
      reasoning: input.reasoning ?? existing?.reasoning ?? "dynamic",
      thinkingToggleParam: input.thinkingToggleParam === undefined
        ? existing?.thinkingToggleParam ?? null
        : input.thinkingToggleParam?.trim() || null
    };
    if (existing === undefined) this.#hostConfig.modelProfiles.push(profile);
    else this.#hostConfig.modelProfiles[this.#hostConfig.modelProfiles.indexOf(existing)] = profile;
    if (input.apiKey?.trim()) {
      this.#updateGlobalEnvFile({ [providerApiKeyName(profile.baseUrl)]: input.apiKey.trim() });
    }
    const project = this.#currentProject();
    project.selectedModelProfileId ??= id;
    if (project.selectedModelProfileId === id) this.#applySelectedModelProfile(project);
    for (const candidate of this.#hostConfig.projects) {
      if (candidate.selectedModelProfileId === id) this.#dirtyRuntimeKeys.add(workspaceKey(candidate.path));
    }
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async deleteModelProfile(profileId: string): Promise<DesktopSnapshot> {
    const id = requireText(profileId, "Model profile ID");
    const removed = this.#hostConfig.modelProfiles.find((profile) => profile.id === id);
    if (removed === undefined) throw new Error("Global model profile not found.");
    this.#hostConfig.modelProfiles = this.#hostConfig.modelProfiles.filter((profile) => profile.id !== id);
    this.#updateGlobalEnvFile({ [profileApiKeyName(id)]: null });
    if (!this.#hostConfig.modelProfiles.some((profile) => sameProvider(profile.baseUrl, removed.baseUrl))) {
      this.#updateGlobalEnvFile({ [providerApiKeyName(removed.baseUrl)]: null });
    }
    for (const project of this.#hostConfig.projects) {
      if (project.selectedModelProfileId !== id) continue;
      project.selectedModelProfileId = this.#hostConfig.modelProfiles[0]?.id ?? null;
      this.#applySelectedModelProfile(project);
      this.#dirtyRuntimeKeys.add(workspaceKey(project.path));
    }
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async selectModelProfile(profileId: string): Promise<DesktopSnapshot> {
    const project = this.#currentProject();
    const id = requireText(profileId, "Model profile ID");
    if (!this.#hostConfig.modelProfiles.some((profile) => profile.id === id)) throw new Error("Global model profile not found.");
    project.selectedModelProfileId = id;
    this.#applySelectedModelProfile(project);
    this.#dirtyRuntimeKeys.add(workspaceKey(project.path));
    this.#writeHostConfig();
    return await this.snapshot();
  }

  control(runId: string, control: SessionControl): void {
    const runtime = this.#requireRuntime();
    const handle = runtime.openRun(runId);
    let operation: Promise<void>;
    if (control.type === "input") operation = handle.input(control.text, { requestId: control.requestId });
    else if (control.type === "approve") operation = handle.approve({ requestId: control.requestId });
    else if (control.type === "deny") operation = handle.deny({ requestId: control.requestId, ...(control.reason === undefined ? {} : { reason: control.reason }) });
    else if (control.type === "cancel") operation = handle.cancel("Cancelled from Nexora Desktop.");
    else if (control.type === "resume") operation = handle.resume();
    else if (control.type === "extend_budget") operation = handle.resume({ budgetExtension: { iterations: 20, modelCalls: 10, toolCalls: 20, retries: 2 } });
    else if (control.type === "worker_resume") operation = this.#recoverWorker(runtime, handle, control.childRunId, "resume");
    else if (control.type === "worker_discard") operation = this.#recoverWorker(runtime, handle, control.branchId, "discard");
    else operation = handle.resume({ recovery: control.recovery });
    void operation.then(() => this.#emit()).catch((error: unknown) => this.#onError(errorMessage(error)));
  }

  async readArtifact(digest: string) { return await this.#requireRuntime().readArtifactText(digest); }

  async #recoverWorker(runtime: AgentRuntime, parent: RunHandle, id: string, action: "resume" | "discard"): Promise<void> {
    if (action === "discard") {
      runtime.discardBranch(id, "Discarded from Nexora Desktop recovery.");
    } else {
      const child = runtime.openRun(id);
      const inspection = await child.inspect();
      await child.resume(inspection.stopReason?.endsWith("BUDGET_EXCEEDED") === true
        ? { budgetExtension: { iterations: 12, modelCalls: 12, toolCalls: 24, retries: 1 } }
        : {});
    }
    await parent.resume();
  }
  async close(): Promise<void> {
    await Promise.all([...this.#subscriptions.values()].map(async (subscription) => await subscription.close()));
    this.#subscriptions.clear();
    await Promise.all([...this.#runtimes.values()].map(async (runtime) => await runtime.close()));
    this.#runtimes.clear();
  }

  #requireRuntime(workspace = this.#workspace): AgentRuntime {
    const key = workspaceKey(workspace);
    const existing = this.#runtimes.get(key);
    if (existing !== undefined) return existing;
    const runtime = createAgent({
      workspace,
      provider: openAICompatibleProviderFromEnv(this.#providerEnvironment(workspace)),
      publicOutputListener: this.#onPublicOutput,
      profile: DESKTOP_PROFILE,
      tools: createBuiltInTools({ artifactDir: join(workspace, ".nexora", "artifacts") }),
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });
    this.#runtimes.set(key, runtime);
    this.#dirtyRuntimeKeys.delete(key);
    return runtime;
  }

  async #watch(handle: RunHandle, workspace = this.#workspace): Promise<void> {
    const key = workspaceKey(workspace);
    await this.#subscriptions.get(key)?.close();
    const inspection = await handle.inspect();
    this.#subscriptions.set(key, handle.subscribe(
      () => this.#emitWorkspace(workspace),
      { afterSequence: inspection.lastEventSequence }
    ));
  }

  async #emit(): Promise<void> {
    try { this.#onSnapshot(await this.snapshot()); }
    catch (error) { this.#onError(errorMessage(error)); }
  }

  async #emitWorkspace(workspace: string): Promise<void> {
    try {
      const runtime = this.#runtimes.get(workspaceKey(workspace));
      if (runtime !== undefined) await this.#synchronizeProject(runtime, this.#ensureProject(workspace));
      this.#onSnapshot(await this.snapshot());
    } catch (error) { this.#onError(errorMessage(error)); }
  }

  async #synchronizeProject(runtime: AgentRuntime, project = this.#currentProject()): Promise<void> {
    const summaries = await runtime.listRuns();
    const byRun = new Map(summaries.map((summary) => [summary.runId, summary]));
    const legacyInternalSessions = new Set(project.sessions.flatMap((session) => {
      const latest = session.turns.at(-1);
      const lineage = latest === undefined ? undefined : byRun.get(latest.runId)?.lineage;
      return lineage !== undefined && lineage.kind !== "root" ? [session.id] : [];
    }));
    if (legacyInternalSessions.size > 0) {
      project.sessions = project.sessions.filter((session) => !legacyInternalSessions.has(session.id));
      const key = workspaceKey(project.path);
      if (legacyInternalSessions.has(this.#activeSessionIds.get(key) ?? "")) {
        this.#activeSessionIds.delete(key);
        await this.#subscriptions.get(key)?.close();
        this.#subscriptions.delete(key);
      }
    }
    const hidden = new Set(project.hiddenRunIds);
    const mapped = new Set(project.sessions.flatMap(({ turns }) => turns.map(({ runId }) => runId)));
    for (const summary of summaries) {
      if (summary.lineage.kind === "root" && !mapped.has(summary.runId) && !hidden.has(summary.runId)) {
        const inspection = await runtime.openRun(summary.runId).inspect();
        const originalInput = inspection.inputs[0]?.text ?? summary.title;
        project.sessions.push({
          id: summary.runId,
          title: compact(originalInput, 96),
          turns: [{ runId: summary.runId, userInput: originalInput }],
          archived: false,
          status: summary.status,
          pendingRequestKind: summary.pendingRequestKind,
          updatedAt: summary.updatedAt
        });
      }
    }
    for (const session of project.sessions) {
      const latest = session.turns.at(-1);
      const summary = latest === undefined ? undefined : byRun.get(latest.runId);
      if (summary !== undefined) {
        session.status = summary.status;
        session.pendingRequestKind = summary.pendingRequestKind;
        session.updatedAt = summary.updatedAt;
      }
    }
    project.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.#writeHostConfig();
  }

  #workspaceView(): WorkspaceView {
    const environment = this.#providerEnvironment();
    return {
      path: this.#workspace,
      name: basename(this.#workspace),
      providerConfigured: this.#providerConfigured(environment),
      providerError: this.#providerError,
      model: environment.NEXORA_MODEL_NAME?.trim() || null,
      projects: this.#hostConfig.projects.map((project): ProjectView => ({
        path: project.path,
        name: project.name,
        sessions: project.sessions.map((session): DesktopSessionSummary => ({
          id: session.id,
          title: session.title,
          status: session.status,
          pendingRequestKind: session.pendingRequestKind,
          archived: session.archived,
          updatedAt: session.updatedAt
        }))
      })),
      modelProfiles: this.#hostConfig.modelProfiles.map((profile): ModelProfileView => ({
        ...profile,
        apiKeyConfigured: Boolean(this.#profileApiKey(profile, environment))
      })),
      selectedModelProfileId: this.#currentProject().selectedModelProfileId
    };
  }

  async #sessionView(runtime: AgentRuntime, session: StoredSession): Promise<SessionView> {
    const runs: SessionRunView[] = [];
    for (const turn of session.turns) {
      const handle = runtime.openRun(turn.runId);
      const [inspection, history, publicOutputHistory] = await Promise.all([
        handle.inspect(),
        handle.history({ limit: 200 }),
        handle.history({ types: ["provider.attempt.succeeded"], limit: 200 })
      ]);
      runs.push({
        userInput: turn.userInput,
        inspection,
        history,
        publicOutputs: await this.#persistedPublicOutputs(runtime, publicOutputHistory.records)
      });
    }
    const latest = runs.at(-1);
    if (latest === undefined) throw new Error("Desktop Session has no Runtime Run.");
    return { id: session.id, title: session.title, runs, inspection: latest.inspection, history: latest.history };
  }

  async #persistedPublicOutputs(
    runtime: AgentRuntime,
    records: SessionRunView["history"]["records"]
  ): Promise<PersistedPublicOutput[]> {
    const succeeded = records.filter((record) => record.type === "provider.attempt.succeeded");
    const outputs = await Promise.all(succeeded.map(async (record): Promise<PersistedPublicOutput | null> => {
      const payload = objectValue(record.payload);
      const modelCallId = stringValue(payload.callId);
      const attemptId = stringValue(payload.attemptId);
      const artifactRef = stringValue(payload.responseArtifactRef);
      if (modelCallId === null || attemptId === null || artifactRef === null) return null;
      try {
        let publicOutput = this.#publicOutputArtifacts.get(artifactRef);
        if (publicOutput === undefined) {
          const envelope = objectValue(JSON.parse((await runtime.readArtifactText(artifactRef, 1_000_000)).text));
          const value = objectValue(envelope.publicOutput);
          publicOutput = {
            reasoning: stringValue(value.reasoning) ?? "",
            content: stringValue(value.content) ?? ""
          };
          this.#publicOutputArtifacts.set(artifactRef, publicOutput);
        }
        const { reasoning, content } = publicOutput;
        if (reasoning === "" && content === "") return null;
        return {
          key: `${record.runId}:${modelCallId}:${attemptId}`,
          runId: record.runId,
          modelCallId,
          attemptId,
          occurredAt: record.occurredAt,
          reasoning,
          content
        };
      } catch {
        return null;
      }
    }));
    return outputs.filter((output): output is PersistedPublicOutput => output !== null);
  }

  async #prepareRuntimeForNewRun(): Promise<void> {
    const key = workspaceKey(this.#workspace);
    if (!this.#dirtyRuntimeKeys.has(key)) return;
    if (this.#currentProject().sessions.some((session) => session.status === "running")) return;
    await this.#closeRuntime();
    this.#dirtyRuntimeKeys.delete(key);
  }

  #assertSessionNotRunning(session: StoredSession): void {
    if (session.status === "running") throw new Error("Stop the running Session before archiving or removing it.");
  }

  async #closeRuntime(workspace = this.#workspace): Promise<void> {
    const key = workspaceKey(workspace);
    await this.#subscriptions.get(key)?.close();
    this.#subscriptions.delete(key);
    await this.#runtimes.get(key)?.close();
    this.#runtimes.delete(key);
  }

  #currentProject(): StoredProject { return this.#ensureProject(this.#workspace); }

  #ensureProject(path: string): StoredProject {
    const absolute = resolve(path);
    let project = this.#hostConfig.projects.find((item) => item.path.toLowerCase() === absolute.toLowerCase());
    if (project === undefined) {
      project = {
        path: absolute,
        name: basename(absolute),
        sessions: [],
        hiddenRunIds: [],
        selectedModelProfileId: null
      };
      this.#hostConfig.projects.push(project);
    }
    if ((project as Partial<StoredProject>).selectedModelProfileId === undefined) project.selectedModelProfileId = null;
    if (project.selectedModelProfileId === null || !this.#hostConfig.modelProfiles.some((profile) => profile.id === project.selectedModelProfileId)) {
      const imported = environmentModelProfile(absolute);
      if (imported !== null) {
        const existing = this.#hostConfig.modelProfiles.find((profile) => sameModelProfile(profile, imported));
        if (existing === undefined) {
          imported.id = uniqueProfileId(imported.id, this.#hostConfig.modelProfiles);
          this.#hostConfig.modelProfiles.push(imported);
          project.selectedModelProfileId = imported.id;
        } else project.selectedModelProfileId = existing.id;
      } else project.selectedModelProfileId = this.#hostConfig.modelProfiles[0]?.id ?? null;
    }
    return project;
  }

  #requireSession(sessionId: string): StoredSession {
    return this.#requireProjectSession(this.#currentProject(), sessionId);
  }

  #requireProject(path: string): StoredProject {
    const absolute = resolve(path);
    const project = this.#hostConfig.projects.find((item) => item.path.toLowerCase() === absolute.toLowerCase());
    if (project === undefined) throw new Error("Desktop Project not found.");
    return project;
  }

  #requireProjectSession(project: StoredProject, sessionId: string): StoredSession {
    const session = project.sessions.find(({ id }) => id === sessionId);
    if (session === undefined) throw new Error("Desktop Session not found in this Project.");
    return session;
  }

  #providerEnvironment(workspace = this.#workspace): ProviderEnvironment {
    const environment = { ...readEnv(join(workspace, ".env")), ...process.env };
    const project = this.#ensureProject(workspace);
    const selected = this.#hostConfig.modelProfiles.find((profile) => profile.id === project.selectedModelProfileId);
    if (selected === undefined) return { NEXORA_MODEL_PROVIDER: "openai-compatible", ...environment, NEXORA_MODEL_STREAM: "true" };
    const apiKey = this.#profileApiKey(selected, environment);
    return {
      ...environment,
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: selected.baseUrl,
      NEXORA_MODEL_NAME: selected.model,
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: String(selected.decisionOutputTokens),
      NEXORA_MODEL_TOOL_TRANSPORT: selected.transport,
      NEXORA_MODEL_REASONING: selected.reasoning,
      ...(selected.thinkingToggleParam === null ? {} : { NEXORA_MODEL_THINKING_PARAM: selected.thinkingToggleParam }),
      ...(selected.contextWindowTokens === null ? {} : { NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: String(selected.contextWindowTokens) }),
      ...(selected.activeInputTargetTokens === null ? {} : { NEXORA_MODEL_ACTIVE_INPUT_TOKENS: String(selected.activeInputTargetTokens) }),
      ...(apiKey === undefined ? {} : { NEXORA_MODEL_API_KEY: apiKey }),
      NEXORA_MODEL_STREAM: "true"
    };
  }

  #providerConfigured(environment = this.#providerEnvironment()): boolean {
    return Boolean(environment.NEXORA_MODEL_BASE_URL?.trim() && environment.NEXORA_MODEL_API_KEY?.trim() && environment.NEXORA_MODEL_NAME?.trim() && environment.NEXORA_MODEL_DECISION_OUTPUT_TOKENS?.trim());
  }

  #profileApiKey(profile: StoredModelProfile, environment: ProviderEnvironment): string | undefined {
    const globalEnvironment = readEnv(this.#hostSecretsPath);
    return globalEnvironment[providerApiKeyName(profile.baseUrl)]?.trim()
      || globalEnvironment[profileApiKeyName(profile.id)]?.trim()
      || environment[providerApiKeyName(profile.baseUrl)]?.trim()
      || environment[profileApiKeyName(profile.id)]?.trim()
      || (profile.id === "environment" ? environment.NEXORA_MODEL_API_KEY?.trim() : undefined);
  }

  #applySelectedModelProfile(project: StoredProject): void {
    const selected = this.#hostConfig.modelProfiles.find((profile) => profile.id === project.selectedModelProfileId);
    if (selected === undefined) {
      this.#updateWorkspaceEnvFile(project.path, {
        NEXORA_MODEL_BASE_URL: null,
        NEXORA_MODEL_API_KEY: null,
        NEXORA_MODEL_NAME: null,
        NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: null,
        NEXORA_MODEL_ACTIVE_INPUT_TOKENS: null,
        NEXORA_MODEL_DECISION_OUTPUT_TOKENS: null,
        NEXORA_MODEL_TOOL_TRANSPORT: null,
        NEXORA_MODEL_REASONING: null,
        NEXORA_MODEL_THINKING_PARAM: null
      });
      return;
    }
    const environment = readEnv(join(project.path, ".env"));
    const key = this.#profileApiKey(selected, environment);
    this.#updateWorkspaceEnvFile(project.path, {
      NEXORA_MODEL_BASE_URL: selected.baseUrl,
      NEXORA_MODEL_NAME: selected.model,
      NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: selected.contextWindowTokens === null ? null : String(selected.contextWindowTokens),
      NEXORA_MODEL_ACTIVE_INPUT_TOKENS: selected.activeInputTargetTokens === null ? null : String(selected.activeInputTargetTokens),
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: String(selected.decisionOutputTokens),
      NEXORA_MODEL_TOOL_TRANSPORT: selected.transport,
      NEXORA_MODEL_REASONING: selected.reasoning,
      NEXORA_MODEL_THINKING_PARAM: selected.thinkingToggleParam,
      NEXORA_MODEL_API_KEY: key ?? null
    });
  }

  #updateGlobalEnvFile(values: Record<string, string | null>): void {
    this.#updateEnvFile(this.#hostSecretsPath, values);
  }

  #updateWorkspaceEnvFile(workspace: string, values: Record<string, string | null>): void {
    this.#updateEnvFile(join(workspace, ".env"), values);
  }

  #updateEnvFile(path: string, values: Record<string, string | null>): void {
    const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
    const pending = new Map(Object.entries(values));
    const next = lines.map((line) => {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (match === null || !pending.has(match[1]!)) return line;
      const key = match[1]!;
      const value = pending.get(key)!;
      pending.delete(key);
      return value === null ? null : `${key}=${JSON.stringify(value)}`;
    });
    for (const [key, value] of pending) if (value !== null) next.push(`${key}=${JSON.stringify(value)}`);
    writeFileAtomic(path, `${next.filter((line): line is string => line !== null).join("\n").replace(/\n+$/, "")}\n`);
  }

  #readHostConfig(): HostConfig {
    try {
      const value = JSON.parse(readFileSync(this.#hostConfigPath, "utf8")) as {
        version?: number;
        modelProfiles?: StoredModelProfile[];
        projects?: LegacyStoredProject[];
      };
      if (value.version === 2 && Array.isArray(value.projects) && Array.isArray(value.modelProfiles)) {
        return {
          version: 2,
          projects: value.projects as StoredProject[],
          modelProfiles: value.modelProfiles.map(normalizeModelProfile)
        };
      }
      if (value.version === 1 && Array.isArray(value.projects)) return migrateHostConfig(value.projects);
    } catch { /* First Desktop launch has no Host metadata. */ }
    return { version: 2, modelProfiles: [], projects: [] };
  }

  #migrateGlobalSecrets(): void {
    const globalEnvironment = readEnv(this.#hostSecretsPath);
    for (const profile of this.#hostConfig.modelProfiles) {
      const providerKey = providerApiKeyName(profile.baseUrl);
      if (globalEnvironment[providerKey]?.trim()) continue;
      for (const project of this.#hostConfig.projects) {
        const environment = readEnv(join(project.path, ".env"));
        const secret = environment[providerKey]?.trim()
          || environment[profileApiKeyName(profile.id)]?.trim()
          || (profile.id === "environment" ? environment.NEXORA_MODEL_API_KEY?.trim() : undefined);
        if (secret === undefined) continue;
        this.#updateGlobalEnvFile({ [providerKey]: secret });
        globalEnvironment[providerKey] = secret;
        break;
      }
    }
  }

  #writeHostConfig(): void { writeFileAtomic(this.#hostConfigPath, `${JSON.stringify(this.#hostConfig, null, 2)}\n`); }
}

function readEnv(path: string): ProviderEnvironment {
  if (!existsSync(path)) return {};
  const environment: ProviderEnvironment = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || match[2] === "") continue;
    const raw = match[2]!;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try { environment[match[1]!] = String(JSON.parse(raw)); }
      catch { environment[match[1]!] = raw.slice(1, -1); }
    } else environment[match[1]!] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return environment;
}

function environmentModelProfile(workspace: string): StoredModelProfile | null {
  const environment = readEnv(join(workspace, ".env"));
  const baseUrl = environment.NEXORA_MODEL_BASE_URL?.trim();
  const model = environment.NEXORA_MODEL_NAME?.trim();
  const decisionOutputTokens = Number(environment.NEXORA_MODEL_DECISION_OUTPUT_TOKENS);
  if (!baseUrl || !model || !Number.isInteger(decisionOutputTokens) || decisionOutputTokens <= 0) return null;
  const contextWindowTokens = Number(environment.NEXORA_MODEL_CONTEXT_WINDOW_TOKENS);
  const activeInputTargetTokens = Number(environment.NEXORA_MODEL_ACTIVE_INPUT_TOKENS);
  return {
    id: "environment",
    name: model,
    baseUrl,
    model,
    contextWindowTokens: Number.isInteger(contextWindowTokens) && contextWindowTokens > 0 ? contextWindowTokens : null,
    activeInputTargetTokens: Number.isInteger(activeInputTargetTokens) && activeInputTargetTokens > 0 ? activeInputTargetTokens : null,
    decisionOutputTokens,
    transport: environment.NEXORA_MODEL_TOOL_TRANSPORT === "structured_output" ? "structured_output" : "native_tools",
    reasoning: environment.NEXORA_MODEL_REASONING === "off" || environment.NEXORA_MODEL_REASONING === "on"
      ? environment.NEXORA_MODEL_REASONING
      : "dynamic",
    thinkingToggleParam: environment.NEXORA_MODEL_THINKING_PARAM?.trim() || null
  };
}

function profileApiKeyName(profileId: string): string {
  const suffix = createHash("sha256").update(profileId).digest("hex").slice(0, 16).toUpperCase();
  return `NEXORA_DESKTOP_MODEL_${suffix}_API_KEY`;
}

function providerApiKeyName(baseUrl: string): string {
  const suffix = createHash("sha256").update(baseUrl.trim().replace(/\/+$/, "").toLowerCase()).digest("hex").slice(0, 16).toUpperCase();
  return `NEXORA_DESKTOP_PROVIDER_${suffix}_API_KEY`;
}

function sameProvider(left: string, right: string): boolean {
  return left.trim().replace(/\/+$/, "").toLowerCase() === right.trim().replace(/\/+$/, "").toLowerCase();
}

function sameModelProfile(left: StoredModelProfile, right: StoredModelProfile): boolean {
  return sameProvider(left.baseUrl, right.baseUrl)
    && left.model === right.model
    && left.contextWindowTokens === right.contextWindowTokens
    && left.activeInputTargetTokens === right.activeInputTargetTokens
    && left.decisionOutputTokens === right.decisionOutputTokens
    && left.transport === right.transport
    && left.reasoning === right.reasoning
    && left.thinkingToggleParam === right.thinkingToggleParam;
}

function normalizeModelProfile(profile: Partial<StoredModelProfile> & Pick<StoredModelProfile, "id" | "name" | "baseUrl" | "model" | "contextWindowTokens" | "decisionOutputTokens" | "transport">): StoredModelProfile {
  return {
    ...profile,
    activeInputTargetTokens: profile.activeInputTargetTokens ?? null,
    reasoning: profile.reasoning === "off" || profile.reasoning === "on" ? profile.reasoning : "dynamic",
    thinkingToggleParam: profile.thinkingToggleParam?.trim() || null
  };
}

function uniqueProfileId(preferred: string, profiles: readonly StoredModelProfile[]): string {
  if (!profiles.some((profile) => profile.id === preferred)) return preferred;
  return `${preferred}-${createHash("sha256").update(`${preferred}:${profiles.length}`).digest("hex").slice(0, 8)}`;
}

function migrateHostConfig(projects: readonly LegacyStoredProject[]): HostConfig {
  const modelProfiles: StoredModelProfile[] = [];
  const migratedProjects = projects.map((legacy): StoredProject => {
    const localProfiles = Array.isArray(legacy.modelProfiles) ? legacy.modelProfiles : [];
    let selectedModelProfileId: string | null = null;
    for (const local of localProfiles) {
      let global = modelProfiles.find((profile) => sameModelProfile(profile, local));
      if (global === undefined) {
        global = { ...local, id: uniqueProfileId(local.id, modelProfiles) };
        modelProfiles.push(global);
      }
      if (legacy.selectedModelProfileId === local.id) selectedModelProfileId = global.id;
    }
    return {
      path: legacy.path,
      name: legacy.name,
      sessions: legacy.sessions,
      hiddenRunIds: legacy.hiddenRunIds,
      selectedModelProfileId
    };
  });
  return { version: 2, modelProfiles, projects: migratedProjects };
}

function workspaceKey(path: string): string { return resolve(path).toLowerCase(); }

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must be non-empty.`);
  return text;
}

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
