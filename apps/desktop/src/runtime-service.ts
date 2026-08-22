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
  decisionOutputTokens: number;
  transport: "native_tools" | "structured_output";
};
type StoredProject = {
  path: string;
  name: string;
  sessions: StoredSession[];
  hiddenRunIds: string[];
  modelProfiles: StoredModelProfile[];
  selectedModelProfileId: string | null;
};
type HostConfig = { version: 1; projects: StoredProject[] };

export class DesktopRuntimeService {
  readonly #onSnapshot: (snapshot: DesktopSnapshot) => void;
  readonly #onError: (message: string) => void;
  readonly #onPublicOutput: (event: AgentPublicOutputEvent) => void;
  readonly #hostConfigPath: string;
  #hostConfig: HostConfig;
  #workspace: string;
  #runtime: AgentRuntime | null = null;
  #providerError: string | null = null;
  #activeSessionId: string | null = null;
  #subscription: RuntimeSubscription | null = null;

  constructor(input: { readonly workspace: string; readonly onSnapshot: (snapshot: DesktopSnapshot) => void; readonly onError: (message: string) => void; readonly onPublicOutput?: (event: AgentPublicOutputEvent) => void }) {
    this.#workspace = resolve(input.workspace);
    this.#hostConfigPath = join(this.#workspace, ".nexora", "desktop-host.json");
    this.#hostConfig = this.#readHostConfig();
    this.#ensureProject(this.#workspace);
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
    const session = runtime === null || this.#activeSessionId === null ? null : await this.#sessionView(runtime, this.#requireSession(this.#activeSessionId));
    return { workspace, session };
  }

  async setWorkspace(path: string): Promise<DesktopSnapshot> {
    const next = resolve(path);
    await this.#assertCanSwitchWorkspace();
    await this.#closeRuntime();
    this.#workspace = next;
    this.#activeSessionId = null;
    this.#ensureProject(next);
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async startSession(goal: string): Promise<DesktopSnapshot> {
    const text = requireText(goal, "Task goal");
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
    this.#activeSessionId = session.id;
    this.#writeHostConfig();
    await this.#watch(handle);
    return await this.snapshot();
  }

  async continueSession(sessionId: string, input: string): Promise<DesktopSnapshot> {
    const text = requireText(input, "Session input");
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
    const context = inspection.result?.summary ?? inspection.delivery?.summary ?? `The previous Run ended with status ${inspection.status}.`;
    const continuationGoal = [
      "Continue the same Desktop Session using the prior Runtime outcome as context.",
      `Prior Run ${inspection.runId}: ${compact(context, 4_000)}`,
      "New user input (preserve exactly):",
      text
    ].join("\n\n");
    const handle = runtime.run(continuationGoal);
    session.turns.push({ runId: handle.id, userInput: text });
    session.archived = false;
    session.status = "running";
    session.pendingRequestKind = null;
    session.updatedAt = new Date().toISOString();
    this.#activeSessionId = session.id;
    this.#writeHostConfig();
    await this.#watch(handle);
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
    this.#activeSessionId = session.id;
    await this.#watch(runtime.openRun(latest.runId));
    return await this.snapshot();
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<DesktopSnapshot> {
    const session = this.#requireSession(sessionId);
    this.#assertSessionNotRunning(session);
    session.archived = archived;
    session.updatedAt = new Date().toISOString();
    if (archived && this.#activeSessionId === sessionId) this.#activeSessionId = null;
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async removeSession(sessionId: string): Promise<DesktopSnapshot> {
    const project = this.#currentProject();
    const session = this.#requireSession(sessionId);
    this.#assertSessionNotRunning(session);
    project.hiddenRunIds = [...new Set([...project.hiddenRunIds, ...session.turns.map(({ runId }) => runId)])];
    project.sessions = project.sessions.filter(({ id }) => id !== sessionId);
    if (this.#activeSessionId === sessionId) this.#activeSessionId = null;
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async saveModelProfile(input: ModelProfileInput): Promise<DesktopSnapshot> {
    await this.#assertCanSwitchWorkspace();
    await this.#closeRuntime();
    const project = this.#currentProject();
    this.#preserveSelectedApiKey(project);
    const id = input.id?.trim() || randomUUID();
    const existing = project.modelProfiles.find((profile) => profile.id === id);
    const profile: StoredModelProfile = {
      id,
      name: requireText(input.name, "Profile name"),
      baseUrl: requireText(input.baseUrl, "Provider base URL"),
      model: requireText(input.model, "Model name"),
      contextWindowTokens: input.contextWindowTokens ?? null,
      decisionOutputTokens: input.decisionOutputTokens,
      transport: input.transport
    };
    if (existing === undefined) project.modelProfiles.push(profile);
    else project.modelProfiles[project.modelProfiles.indexOf(existing)] = profile;
    if (input.apiKey?.trim()) {
      this.#updateEnvFile({ [profileApiKeyName(id)]: input.apiKey.trim() });
    }
    project.selectedModelProfileId ??= id;
    if (project.selectedModelProfileId === id) this.#applySelectedModelProfile(project);
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async deleteModelProfile(profileId: string): Promise<DesktopSnapshot> {
    await this.#assertCanSwitchWorkspace();
    await this.#closeRuntime();
    const project = this.#currentProject();
    const id = requireText(profileId, "Model profile ID");
    if (!project.modelProfiles.some((profile) => profile.id === id)) throw new Error("Model profile not found in this Workspace.");
    this.#preserveSelectedApiKey(project);
    project.modelProfiles = project.modelProfiles.filter((profile) => profile.id !== id);
    this.#updateEnvFile({ [profileApiKeyName(id)]: null });
    if (project.selectedModelProfileId === id) {
      project.selectedModelProfileId = project.modelProfiles[0]?.id ?? null;
      this.#applySelectedModelProfile(project);
    }
    this.#writeHostConfig();
    return await this.snapshot();
  }

  async selectModelProfile(profileId: string): Promise<DesktopSnapshot> {
    await this.#assertCanSwitchWorkspace();
    await this.#closeRuntime();
    const project = this.#currentProject();
    const id = requireText(profileId, "Model profile ID");
    if (!project.modelProfiles.some((profile) => profile.id === id)) throw new Error("Model profile not found in this Workspace.");
    this.#preserveSelectedApiKey(project);
    project.selectedModelProfileId = id;
    this.#applySelectedModelProfile(project);
    this.#writeHostConfig();
    return await this.snapshot();
  }

  control(runId: string, control: SessionControl): void {
    const handle = this.#requireRuntime().openRun(runId);
    let operation: Promise<void>;
    if (control.type === "input") operation = handle.input(control.text, { requestId: control.requestId });
    else if (control.type === "approve") operation = handle.approve({ requestId: control.requestId });
    else if (control.type === "deny") operation = handle.deny({ requestId: control.requestId, ...(control.reason === undefined ? {} : { reason: control.reason }) });
    else if (control.type === "cancel") operation = handle.cancel("Cancelled from Nexora Desktop.");
    else if (control.type === "resume") operation = handle.resume();
    else if (control.type === "extend_budget") operation = handle.resume({ budgetExtension: { iterations: 20, modelCalls: 10, toolCalls: 20, retries: 2 } });
    else operation = handle.resume({ recovery: control.recovery });
    void operation.then(() => this.#emit()).catch((error: unknown) => this.#onError(errorMessage(error)));
  }

  async readArtifact(digest: string) { return await this.#requireRuntime().readArtifactText(digest); }
  async close(): Promise<void> { await this.#closeRuntime(); }

  #requireRuntime(): AgentRuntime {
    if (this.#runtime !== null) return this.#runtime;
    this.#runtime = createAgent({
      workspace: this.#workspace,
      provider: openAICompatibleProviderFromEnv(this.#providerEnvironment()),
      publicOutputListener: this.#onPublicOutput,
      profile: DESKTOP_PROFILE,
      tools: createBuiltInTools({ artifactDir: join(this.#workspace, ".nexora", "artifacts") })
    });
    return this.#runtime;
  }

  async #watch(handle: RunHandle): Promise<void> {
    await this.#subscription?.close();
    this.#subscription = handle.subscribe(() => this.#emit());
  }

  async #emit(): Promise<void> {
    try { this.#onSnapshot(await this.snapshot()); }
    catch (error) { this.#onError(errorMessage(error)); }
  }

  async #synchronizeProject(runtime: AgentRuntime): Promise<void> {
    const project = this.#currentProject();
    const summaries = await runtime.listRuns();
    const hidden = new Set(project.hiddenRunIds);
    const mapped = new Set(project.sessions.flatMap(({ turns }) => turns.map(({ runId }) => runId)));
    for (const summary of summaries) {
      if (!mapped.has(summary.runId) && !hidden.has(summary.runId)) {
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
    const byRun = new Map(summaries.map((summary) => [summary.runId, summary]));
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
      modelProfiles: this.#currentProject().modelProfiles.map((profile): ModelProfileView => ({
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
      runs.push({ userInput: turn.userInput, inspection: await handle.inspect(), history: await handle.history({ limit: 200 }) });
    }
    const latest = runs.at(-1);
    if (latest === undefined) throw new Error("Desktop Session has no Runtime Run.");
    return { id: session.id, title: session.title, runs, inspection: latest.inspection, history: latest.history };
  }

  async #assertCanSwitchWorkspace(): Promise<void> {
    if (this.#runtime === null) return;
    const active = (await this.#runtime.listRuns()).find((run) => run.status === "running");
    if (active !== undefined) throw new Error("A Session is still running. Stop it before changing Project or model settings.");
  }

  #assertSessionNotRunning(session: StoredSession): void {
    if (session.status === "running") throw new Error("Stop the running Session before archiving or removing it.");
  }

  async #closeRuntime(): Promise<void> {
    await this.#subscription?.close();
    this.#subscription = null;
    await this.#runtime?.close();
    this.#runtime = null;
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
        modelProfiles: [],
        selectedModelProfileId: null
      };
      this.#hostConfig.projects.push(project);
    }
    if (!Array.isArray(project.modelProfiles)) project.modelProfiles = [];
    if ((project as Partial<StoredProject>).selectedModelProfileId === undefined) project.selectedModelProfileId = null;
    if (project.modelProfiles.length === 0) {
      const imported = environmentModelProfile(absolute);
      if (imported !== null) {
        project.modelProfiles.push(imported);
        project.selectedModelProfileId = imported.id;
      }
    }
    return project;
  }

  #requireSession(sessionId: string): StoredSession {
    const session = this.#currentProject().sessions.find(({ id }) => id === sessionId);
    if (session === undefined) throw new Error("Desktop Session not found in this Project.");
    return session;
  }

  #providerEnvironment(): ProviderEnvironment {
    const environment = { ...readEnv(join(this.#workspace, ".env")), ...process.env };
    const project = this.#currentProject();
    const selected = project.modelProfiles.find((profile) => profile.id === project.selectedModelProfileId);
    if (selected === undefined) return { NEXORA_MODEL_PROVIDER: "openai-compatible", ...environment, NEXORA_MODEL_STREAM: "true" };
    const apiKey = this.#profileApiKey(selected, environment);
    return {
      ...environment,
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: selected.baseUrl,
      NEXORA_MODEL_NAME: selected.model,
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: String(selected.decisionOutputTokens),
      NEXORA_MODEL_TOOL_TRANSPORT: selected.transport,
      ...(selected.contextWindowTokens === null ? {} : { NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: String(selected.contextWindowTokens) }),
      ...(apiKey === undefined ? {} : { NEXORA_MODEL_API_KEY: apiKey }),
      NEXORA_MODEL_STREAM: "true"
    };
  }

  #providerConfigured(environment = this.#providerEnvironment()): boolean {
    return Boolean(environment.NEXORA_MODEL_BASE_URL?.trim() && environment.NEXORA_MODEL_API_KEY?.trim() && environment.NEXORA_MODEL_NAME?.trim() && environment.NEXORA_MODEL_DECISION_OUTPUT_TOKENS?.trim());
  }

  #profileApiKey(profile: StoredModelProfile, environment: ProviderEnvironment): string | undefined {
    return environment[profileApiKeyName(profile.id)]?.trim()
      || (profile.id === "environment" ? environment.NEXORA_MODEL_API_KEY?.trim() : undefined);
  }

  #preserveSelectedApiKey(project: StoredProject): void {
    const selected = project.modelProfiles.find((profile) => profile.id === project.selectedModelProfileId);
    if (selected === undefined) return;
    const environment = readEnv(join(this.#workspace, ".env"));
    const key = this.#profileApiKey(selected, environment);
    if (key !== undefined) this.#updateEnvFile({ [profileApiKeyName(selected.id)]: key });
  }

  #applySelectedModelProfile(project: StoredProject): void {
    const selected = project.modelProfiles.find((profile) => profile.id === project.selectedModelProfileId);
    if (selected === undefined) {
      this.#updateEnvFile({
        NEXORA_MODEL_BASE_URL: null,
        NEXORA_MODEL_API_KEY: null,
        NEXORA_MODEL_NAME: null,
        NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: null,
        NEXORA_MODEL_DECISION_OUTPUT_TOKENS: null,
        NEXORA_MODEL_TOOL_TRANSPORT: null
      });
      return;
    }
    const environment = readEnv(join(this.#workspace, ".env"));
    const key = this.#profileApiKey(selected, environment);
    this.#updateEnvFile({
      NEXORA_MODEL_BASE_URL: selected.baseUrl,
      NEXORA_MODEL_NAME: selected.model,
      NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: selected.contextWindowTokens === null ? null : String(selected.contextWindowTokens),
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: String(selected.decisionOutputTokens),
      NEXORA_MODEL_TOOL_TRANSPORT: selected.transport,
      NEXORA_MODEL_API_KEY: key ?? null
    });
  }

  #updateEnvFile(values: Record<string, string | null>): void {
    const path = join(this.#workspace, ".env");
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
      const value = JSON.parse(readFileSync(this.#hostConfigPath, "utf8")) as Partial<HostConfig>;
      if (value.version === 1 && Array.isArray(value.projects)) return value as HostConfig;
    } catch { /* First Desktop launch has no Host metadata. */ }
    return { version: 1, projects: [] };
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
  return {
    id: "environment",
    name: model,
    baseUrl,
    model,
    contextWindowTokens: Number.isInteger(contextWindowTokens) && contextWindowTokens > 0 ? contextWindowTokens : null,
    decisionOutputTokens,
    transport: environment.NEXORA_MODEL_TOOL_TRANSPORT === "structured_output" ? "structured_output" : "native_tools"
  };
}

function profileApiKeyName(profileId: string): string {
  const suffix = createHash("sha256").update(profileId).digest("hex").slice(0, 16).toUpperCase();
  return `NEXORA_DESKTOP_MODEL_${suffix}_API_KEY`;
}

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

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
