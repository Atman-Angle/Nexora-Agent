import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { AgentService } from "../../core/src/application/agent-service.js";
import { chatProfile } from "../../core/src/profile/chat-profile.js";
import { validateArtifactForRun } from "../../core/src/validation-gate.js";
import { registerFileTools, type FileToolName } from "../../tool-runtime/src/index.js";

export const fileTools = {
  read: "read",
  search: "search",
  list: "list",
  write: "write",
  patch: "patch"
} as const;

export type FileTool = (typeof fileTools)[keyof typeof fileTools];

export type CreateAgentOptions = {
  readonly workspace: string;
  readonly instructions: string;
  readonly tools: readonly FileTool[];
  /** Defaults to <workspace>/.nexora; contains runtime SQLite data and artifacts only. */
  readonly dataDir?: string | undefined;
};

export type AgentResult =
  | { readonly status: "completed"; readonly runId: string; readonly text: string }
  | { readonly status: "approval_required"; readonly runId: string; readonly approvalId: string; readonly summary: string }
  | { readonly status: "input_required"; readonly runId: string; readonly requestId: string; readonly question: string }
  | { readonly status: "blocked"; readonly runId: string; readonly text: string }
  | { readonly status: "terminal"; readonly runId: string; readonly text: string };

export type DeniedResult = { readonly status: "denied"; readonly runId: string; readonly approvalId: string; readonly text: string };

export type Agent = {
  run(text: string): Promise<AgentResult>;
  approve(approvalId: string): Promise<AgentResult>;
  deny(approvalId: string, reason?: string): DeniedResult;
  resume(runId: string): Promise<AgentResult>;
  close(): void;
};

/**
 * Creates a constrained, durable chat Agent. Provider configuration is read
 * only from the NEXORA_MODEL_* environment variables when a run begins.
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const workspace = requireWorkspace(options.workspace);
  const instructions = requireText("instructions", options.instructions);
  const tools = validateTools(options.tools);
  const dataDir = resolve(options.dataDir ?? join(workspace, ".nexora"));
  mkdirSync(dataDir, { recursive: true });
  const profile = {
    ...chatProfile,
    name: "runtime",
    registerTools: (registry: Parameters<NonNullable<typeof chatProfile.registerTools>>[0]) => registerFileTools(registry, tools),
    // ponytail: file-only facade has no validator; add a validated write mode only when an application needs it.
    completionGate: async (context: Parameters<NonNullable<typeof chatProfile.completionGate>>[0]) => ({
      validation: validateArtifactForRun(context.run, context.finalArtifact)
    })
  };
  const service = new AgentService({
    databasePath: join(dataDir, "runtime.db"),
    workspaceRoot: workspace,
    artifactRoot: join(dataDir, "artifacts"),
    profiles: [profile],
    taskSource: "application"
  });
  service.open();

  return {
    async run(text) {
      return toResult(await service.startAgent({
        profile: "runtime",
        text: requestText(instructions, text),
        taskType: "read_only",
        agentRequest: { budget: { maxLoopCount: 20, maxModelCalls: 30, maxToolCalls: 20, maxRetries: 10, maxDurationMs: 300_000 } }
      }));
    },
    async approve(approvalId) {
      return toResult(await service.resumeApproval({ approvalId, decision: "approved", scope: "once" }));
    },
    deny(approvalId, reason) {
      const result = service.denyApproval(approvalId, reason);
      return { status: "denied", runId: result.runId, approvalId: result.approvalId, text: result.text };
    },
    async resume(runId) {
      return toResult(await service.resumeRun(runId));
    },
    close() {
      service.close();
    }
  };
}

function requireWorkspace(value: string): string {
  const workspace = resolve(requireText("workspace", value));
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Nexora workspace does not exist or is not a directory: ${workspace}`);
  }
  return workspace;
}

function requireText(name: string, value: string): string {
  if (!value.trim()) throw new Error(`Nexora ${name} must be a non-empty string.`);
  return value;
}

function validateTools(tools: readonly FileTool[]): FileToolName[] {
  const allowed = new Set<FileToolName>(Object.values(fileTools));
  if (!Array.isArray(tools) || tools.some((tool) => !allowed.has(tool))) {
    throw new Error("Nexora tools must be selected from fileTools.");
  }
  return [...new Set(tools)];
}

function requestText(instructions: string, text: string): string {
  return `Application instructions:\n${instructions}\n\nUser request:\n${requireText("run text", text)}`;
}

function toResult(result: any): AgentResult {
  if (result.kind === "completed") return { status: "completed", runId: result.run.runId, text: result.artifact.content };
  if (result.kind === "waiting_for_approval") return { status: "approval_required", runId: result.run.runId, approvalId: result.approval?.approvalId ?? result.approvalId, summary: result.approval?.actionSummary ?? result.text };
  if (result.kind === "waiting_for_user") return { status: "input_required", runId: result.run.runId, requestId: result.request?.requestId ?? result.requestId, question: result.request?.question ?? result.text };
  if (result.kind === "blocked") return { status: "blocked", runId: result.run.runId, text: result.text };
  if (result.kind === "terminal") return { status: "terminal", runId: result.run.runId, text: result.text };
  if (typeof result.runId === "string") return { status: "terminal", runId: result.runId, text: result.text ?? "Run is awaiting the recorded decision." };
  throw new Error("Nexora returned an unsupported runtime result.");
}
