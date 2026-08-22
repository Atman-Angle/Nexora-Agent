import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { basename, join, resolve } from "node:path";

import {
  createAgent,
  createAgentProfileSnapshot,
  createBuiltInTools,
  openAICompatibleProviderFromEnv,
  type RunHandle,
  type RuntimeSubscription
} from "@nexora/harness";

import type {
  DesktopSnapshot,
  SessionControl,
  SessionView,
  WorkspaceView
} from "./shared.js";

const DESKTOP_PROFILE = createAgentProfileSnapshot({
  schemaVersion: 1,
  id: "nexora-desktop-workspace-agent",
  version: "1",
  role: {
    identity: "Workspace development agent",
    objective: "Complete the user's workspace task while preserving repository contracts."
  },
  strategy: {
    principles: [
      "Inspect workspace facts before changing files.",
      "Keep changes scoped to the requested outcome.",
      "Verify changed behavior proportionately."
    ]
  },
  communication: { audience: "Software project contributors", tone: "Direct and factual" }
}, { kind: "host", ref: "apps/desktop" });

type AgentRuntime = ReturnType<typeof createAgent>;

export class DesktopRuntimeService {
  readonly #onSnapshot: (snapshot: DesktopSnapshot) => void;
  readonly #onError: (message: string) => void;
  #workspace: string;
  #runtime: AgentRuntime | null = null;
  #activeRunId: string | null = null;
  #subscription: RuntimeSubscription | null = null;

  constructor(input: {
    readonly workspace: string;
    readonly onSnapshot: (snapshot: DesktopSnapshot) => void;
    readonly onError: (message: string) => void;
  }) {
    this.#workspace = resolve(input.workspace);
    this.#onSnapshot = input.onSnapshot;
    this.#onError = input.onError;
  }

  async snapshot(): Promise<DesktopSnapshot> {
    const runtime = this.#requireRuntime();
    const workspace = await this.#workspaceView(runtime);
    const session = this.#activeRunId === null
      ? null
      : await this.#sessionView(runtime.openRun(this.#activeRunId));
    return { workspace, session };
  }

  async setWorkspace(path: string): Promise<DesktopSnapshot> {
    const next = resolve(path);
    if (this.#runtime !== null) {
      const active = (await this.#runtime.listRuns()).find((run) => run.status === "running");
      if (active !== undefined) throw new Error("A Session is still running. Stop it before switching Workspace.");
    }
    await this.#closeRuntime();
    this.#workspace = next;
    this.#activeRunId = null;
    return await this.snapshot();
  }

  async startSession(goal: string): Promise<DesktopSnapshot> {
    if (!goal.trim()) throw new Error("Task goal must be non-empty.");
    const runtime = this.#requireRuntime();
    const handle = runtime.run(goal.trim());
    this.#activeRunId = handle.id;
    await this.#watch(handle);
    return await this.snapshot();
  }

  async openSession(runId: string): Promise<DesktopSnapshot> {
    const handle = this.#requireRuntime().openRun(runId);
    this.#activeRunId = handle.id;
    await this.#watch(handle);
    return await this.snapshot();
  }

  control(runId: string, control: SessionControl): void {
    const handle = this.#requireRuntime().openRun(runId);
    let operation: Promise<void>;
    if (control.type === "input") {
      operation = handle.input(control.text, { requestId: control.requestId });
    } else if (control.type === "approve") {
      operation = handle.approve({ requestId: control.requestId });
    } else if (control.type === "deny") {
      operation = handle.deny({
        requestId: control.requestId,
        ...(control.reason === undefined ? {} : { reason: control.reason })
      });
    } else if (control.type === "cancel") {
      operation = handle.cancel("Cancelled from Nexora Desktop.");
    } else if (control.type === "resume") {
      operation = handle.resume();
    } else if (control.type === "extend_budget") {
      operation = handle.resume({
        budgetExtension: { iterations: 20, modelCalls: 10, toolCalls: 20, retries: 2 }
      });
    } else {
      operation = handle.resume({ recovery: control.recovery });
    }
    void operation
      .then(() => this.#emit())
      .catch((error: unknown) => this.#onError(errorMessage(error)));
  }

  async readArtifact(digest: string) {
    return await this.#requireRuntime().readArtifactText(digest);
  }

  async close(): Promise<void> {
    await this.#closeRuntime();
  }

  #requireRuntime(): AgentRuntime {
    if (this.#runtime !== null) return this.#runtime;
    const envPath = join(this.#workspace, ".env");
    if (existsSync(envPath)) loadEnvFile(envPath);
    this.#runtime = createAgent({
      workspace: this.#workspace,
      provider: openAICompatibleProviderFromEnv(),
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
    try {
      this.#onSnapshot(await this.snapshot());
    } catch (error) {
      this.#onError(errorMessage(error));
    }
  }

  async #workspaceView(runtime: AgentRuntime): Promise<WorkspaceView> {
    return {
      path: this.#workspace,
      name: basename(this.#workspace),
      providerConfigured: Boolean(process.env.NEXORA_MODEL_API_KEY && process.env.NEXORA_MODEL_NAME),
      model: process.env.NEXORA_MODEL_NAME?.trim() || null,
      sessions: await runtime.listRuns()
    };
  }

  async #sessionView(handle: RunHandle): Promise<SessionView> {
    return {
      inspection: await handle.inspect(),
      history: await handle.history({ limit: 200 })
    };
  }

  async #closeRuntime(): Promise<void> {
    await this.#subscription?.close();
    this.#subscription = null;
    await this.#runtime?.close();
    this.#runtime = null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
