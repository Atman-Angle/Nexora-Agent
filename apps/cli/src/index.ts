import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  createTask,
  RecoveryBudgetSchema,
  type ApprovalScope,
  type Event,
  type TaskAcceptanceCriterion,
  type TaskExecutionConstraints,
  type TaskType,
  type RecoveryBudget
} from "../../../packages/contracts/src/index.js";
import {
  AgentLoopRunFailure,
  AgentService,
  codingProfile,
  DirectRunFailure,
  ToolModeRunFailure,
  yixiangProfile
} from "../../../packages/core/src/index.js";
import { ModelConfigError, ModelHttpError, ModelJsonParseError, ModelTimeoutError } from "../../../packages/model-gateway/src/index.js";

type CliError = { code: string; message: string; retryable: boolean };
type ReadOnlyCommand =
  | { type: "list"; path?: string }
  | { type: "inspect"; path?: string }
  | { type: "commands" }
  | { type: "git_status" }
  | { type: "git_diff"; path?: string }
  | { type: "git_show"; revision: string; path?: string };
type Command =
  | { type: "ask"; text: string }
  | { type: "read"; path: string }
  | { type: "search"; query: string }
  | { type: "patch"; path: string; expectedHash: string; find: string; replace: string; idempotencyKey?: string }
  | { type: "verify"; command: string; args: string[] }
  | { type: "list" | "inspect"; path?: string }
  | { type: "commands" | "git_status" }
  | { type: "git_diff"; path?: string }
  | { type: "git_show"; revision: string; path?: string }
  | { type: "agent"; goal: string; command: string; args: string[] }
  | { type: "approvals_list" | "requests_list" | "run_status" | "run_cancel" | "run_resume"; runId: string }
  | { type: "approve"; approvalId: string; scope: ApprovalScope; reason?: string }
  | { type: "deny"; approvalId: string; reason?: string }
  | { type: "respond"; requestId: string; value: string };

export const NEXORA_CLI_VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) { printHelp(); return 0; }
    if (argv.length === 1 && ["--version", "-v"].includes(argv[0]!)) { process.stdout.write(`${NEXORA_CLI_VERSION}\n`); return 0; }
    const command = parseCommand(argv);
    const service = createService(requiresWorkspace(command) ? requireWorkspaceRoot() : undefined);
    service.open();
    const subscription = service.subscribeEvents(renderEvent);
    try { printSuccess(await dispatch(service, command)); return 0; }
    finally { subscription.unsubscribe(); service.close(); }
  } catch (error) {
    const cliError = toCliError(error); printError(cliError);
    return cliError.code === "INVALID_INPUT" ? 2 : 1;
  }
}

export function parseCommand(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command === "ask") {
    const text = rest.join(" ");
    if (!text.trim()) throw new InvalidInputError("Input text must not be empty.");
    return { type: "ask", text };
  }
  if (command === "read") {
    const path = rest.join(" ");
    if (!path.trim()) throw new InvalidInputError("File path must not be empty.");
    return { type: "read", path };
  }
  if (command === "search") {
    const query = rest.join(" ");
    if (!query.trim()) throw new InvalidInputError("Search query must not be empty.");
    return { type: "search", query };
  }
  if (command === "patch") {
    if (rest.length < 4) throw new Error('Usage: nexora patch "<path>" "<expectedHash>" "<find>" "<replace>" ["<idempotencyKey>"]');
    const [path, expectedHash, find, replace, idempotencyKey] = rest;
    if (path === undefined || expectedHash === undefined || find === undefined || replace === undefined) throw new Error('Usage: nexora patch "<path>" "<expectedHash>" "<find>" "<replace>" ["<idempotencyKey>"]');
    if (!path.trim() || !expectedHash.trim() || !find.length) throw new InvalidInputError("Patch path, expectedHash, and find text must not be empty.");
    return { type: "patch", path, expectedHash, find, replace, ...(idempotencyKey?.trim() ? { idempotencyKey } : {}) };
  }
  if (command === "verify") { if (rest[0] === undefined || !rest[0].trim()) throw new Error('Usage: nexora verify "<command>" ["<arg>" ...]'); return { type: "verify", command: rest[0], args: rest.slice(1) }; }
  if (command === "list") { if (rest.length > 1) throw new Error('Usage: nexora list ["<path>"]'); return { type: "list", ...(rest[0]?.trim() ? { path: rest[0] } : {}) }; }
  if (command === "inspect") { if (rest.length > 1) throw new Error('Usage: nexora inspect ["<path>"]'); return { type: "inspect", ...(rest[0]?.trim() ? { path: rest[0] } : {}) }; }
  if (command === "commands") { if (rest.length > 0) throw new Error("Usage: nexora commands"); return { type: "commands" }; }
  if (command === "git") {
    if (rest[0] === "status" && rest.length === 1) return { type: "git_status" };
    if (rest[0] === "diff" && rest.length <= 2) return { type: "git_diff", ...(rest[1]?.trim() ? { path: rest[1] } : {}) };
    if (rest[0] === "show" && rest[1]?.trim() && rest.length <= 3) return { type: "git_show", revision: rest[1], ...(rest[2]?.trim() ? { path: rest[2] } : {}) };
    throw new Error('Usage: nexora git status | nexora git diff ["<path>"] | nexora git show "<revision>" ["<path>"]');
  }
  if (command === "approvals") { if (rest[0] !== "list" || rest[1] === undefined || !rest[1].trim()) throw new Error('Usage: nexora approvals list "<runId>"'); return { type: "approvals_list", runId: rest[1] }; }
  if (command === "approve") { if (rest[0] === undefined || !rest[0].trim()) throw new Error('Usage: nexora approve "<approvalId>" ["once"|"current_run"] ["<reason>"]'); const scope = rest[1] === "current_run" ? "current_run" : "once"; const reason = rest.slice(rest[1] === "current_run" || rest[1] === "once" ? 2 : 1).join(" ").trim(); return { type: "approve", approvalId: rest[0], scope, ...(reason ? { reason } : {}) }; }
  if (command === "deny") { if (rest[0] === undefined || !rest[0].trim()) throw new Error('Usage: nexora deny "<approvalId>" ["<reason>"]'); const reason = rest.slice(1).join(" ").trim(); return { type: "deny", approvalId: rest[0], ...(reason ? { reason } : {}) }; }
  if (command === "requests") { if (rest[0] !== "list" || rest[1] === undefined || !rest[1].trim()) throw new Error('Usage: nexora requests list "<runId>"'); return { type: "requests_list", runId: rest[1] }; }
  if (command === "respond") { if (rest[0] === undefined || !rest[0].trim() || rest[1] === undefined) throw new Error('Usage: nexora respond "<requestId>" "<value>"'); return { type: "respond", requestId: rest[0], value: rest.slice(1).join(" ") }; }
  if (command === "run") {
    if (rest[0] === "status" && rest[1]?.trim()) return { type: "run_status", runId: rest[1] };
    if (rest[0] === "cancel" && rest[1]?.trim()) return { type: "run_cancel", runId: rest[1] };
    if (rest[0] === "resume" && rest[1]?.trim()) return { type: "run_resume", runId: rest[1] };
    throw new Error('Usage: nexora run status "<runId>" | nexora run cancel "<runId>" | nexora run resume "<runId>"');
  }
  if (command === "agent") { if (rest[0] === undefined || !rest[0].trim() || rest[1] === undefined || !rest[1].trim()) throw new Error('Usage: nexora agent "<goal>" "<command>" ["<arg>" ...]'); return { type: "agent", goal: rest[0], command: rest[1], args: rest.slice(2) }; }
  if (command !== "ask") throw new Error('Usage: nexora ask "<text>"');
  throw new Error('Usage: nexora ask "<text>" | nexora read "<path>" | nexora search "<query>" | nexora patch "<path>" "<expectedHash>" "<find>" "<replace>" ["<idempotencyKey>"] | nexora approvals list "<runId>" | nexora approve "<approvalId>" ["once"|"current_run"] ["<reason>"] | nexora deny "<approvalId>" ["<reason>"] | nexora requests list "<runId>" | nexora respond "<requestId>" "<value>" | nexora run status "<runId>" | nexora run cancel "<runId>" | nexora run resume "<runId>" | nexora verify "<command>" ["<arg>" ...] | nexora agent "<goal>" "<command>" ["<arg>" ...]');
}

async function dispatch(service: AgentService, command: Command): Promise<unknown> {
  if (command.type === "ask") return directResult(await service.runDirect(command.text));
  if (command.type === "approvals_list") return { runId: command.runId, approvals: service.listApprovals(command.runId) };
  if (command.type === "requests_list") return { runId: command.runId, requests: service.listRequests(command.runId) };
  if (command.type === "run_status") { const status = service.getRunStatus(command.runId); return { runId: command.runId, status: status.run.status, errorCode: status.run.errorCode, approvals: service.listApprovals(command.runId), requests: service.listRequests(command.runId), pendingAction: status.pendingAction }; }
  if (command.type === "run_cancel") { const run = service.cancelRun(command.runId); return { runId: run.runId, status: run.status, text: `Run ${run.runId} cancelled.` }; }
  if (command.type === "deny") return service.denyApproval(command.approvalId, command.reason);
  if (command.type === "approve") return renderLoop(await service.resumeApproval({ approvalId: command.approvalId, decision: "approved", scope: command.scope, ...(command.reason ? { reason: command.reason } : {}) }));
  if (command.type === "respond") return renderLoop(await service.resumeRespond({ requestId: command.requestId, value: command.value }));
  if (command.type === "run_resume") return renderResume(service, command.runId);
  if (command.type === "agent") return renderLoop(await service.startAgent(agentInput(command)));
  if (isReadOnlyCommand(command)) return readOnlyToolResult(await service.runReadOnlyTool(readOnlyToolInput(command)));
  return toolResult(await service.runToolMode(makeToolTask(command as Extract<Command, { type: "read" | "search" | "patch" | "verify" }>)));
}

async function renderResume(service: AgentService, runId: string): Promise<unknown> {
  const status = service.getRunStatus(runId).run.status;
  if (["running", "waiting_for_tool", "verifying"].includes(status)) service.setWorkspaceRoot(requireWorkspaceRoot());
  const result = await service.resumeRun(runId);
  if (result.kind === "terminal") throw new Error(`Run ${runId} is ${result.run.status} and cannot be resumed.`);
  if (result.kind === "executed") return { ...renderLoop(result.result), checkpointId: result.checkpointId, recoveryAction: result.recoveryAction };
  return { runId: result.run.runId, status: result.run.status, ...(result.kind === "waiting_for_approval" ? { approvalId: result.approvalId } : result.kind === "waiting_for_user" ? { requestId: result.requestId } : {}), checkpointId: result.checkpointId, recoveryAction: result.recoveryAction, text: result.text };
}

function createService(requiredWorkspaceRoot?: string): AgentService {
  const databasePath = requireDatabasePath(); const workspaceRoot = requiredWorkspaceRoot ?? process.cwd();
  return new AgentService({ databasePath, workspaceRoot, artifactRoot: process.env.NEXORA_ARTIFACT_ROOT?.trim() || join(dirname(databasePath), "artifacts"), profiles: [codingProfile, yixiangProfile], modelProviderOptions: providerOptions() });
}
function makeToolTask(command: Extract<Command, { type: "read" | "search" | "patch" | "verify" }>) {
  const now = new Date().toISOString(); const base = { taskId: randomUUID(), createdAt: now };
  if (command.type === "read") return createTask({ ...base, text: `Read file ${command.path}`, taskType: "read_only", filePath: command.path });
  if (command.type === "search") return createTask({ ...base, text: command.query, taskType: "read_only", searchQuery: command.query });
  if (command.type === "patch") return createTask({ ...base, text: `Patch file ${command.path}`, taskType: "workspace_mutation", patchRequest: { path: command.path, expectedHash: command.expectedHash, patch: { type: "replace_text", find: command.find, replace: command.replace }, encoding: "utf8", idempotencyKey: command.idempotencyKey ?? randomUUID() } });
  return createTask({ ...base, text: `Verify command ${command.command}`, taskType: parseTaskTypeEnv(process.env.NEXORA_VERIFY_TASK_TYPE, "analysis"), validationRequest: validationRequest(command.command, command.args, "VERIFY", true), acceptanceCriteria: parseAcceptanceCriteriaEnv(process.env.NEXORA_VERIFY_ACCEPTANCE_CRITERIA_JSON) });
}
function readOnlyToolInput(command: ReadOnlyCommand) {
  if (command.type === "list") return { kind: "filesystem_list" as const, ...(command.path === undefined ? {} : { relativePath: command.path }) };
  if (command.type === "inspect") return { kind: "project_inspect" as const, ...(command.path === undefined ? {} : { relativePath: command.path }) };
  if (command.type === "commands") return { kind: "project_commands" as const };
  if (command.type === "git_status") return { kind: "git_status" as const };
  if (command.type === "git_diff") return { kind: "git_diff" as const, ...(command.path === undefined ? {} : { path: command.path }) };
  if (command.type === "git_show") return { kind: "git_show" as const, revision: command.revision, ...(command.path === undefined ? {} : { path: command.path }) };
  throw new Error("Unsupported read-only command.");
}
function agentInput(command: Extract<Command, { type: "agent" }>) { const recoveryBudget = parseRecoveryBudgetEnv(); const executionConstraints = parseExecutionConstraintsEnv(process.env.NEXORA_AGENT_EXECUTION_CONSTRAINTS_JSON); return { profile: process.env.NEXORA_AGENT_PROFILE?.trim() || "coding", text: command.goal, taskType: parseTaskTypeEnv(process.env.NEXORA_AGENT_TASK_TYPE, "feature"), validationRequest: validationRequest(command.command, command.args, "AGENT", false), agentRequest: { budget: { maxLoopCount: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_LOOP_COUNT) ?? 50, maxModelCalls: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_MODEL_CALLS) ?? 80, maxToolCalls: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_TOOL_CALLS) ?? 50, maxRetries: parseNonNegativeInteger(process.env.NEXORA_AGENT_MAX_RETRIES) ?? 20, maxDurationMs: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_DURATION_MS) ?? 300000 }, ...(recoveryBudget === undefined ? {} : { recoveryBudget }) }, acceptanceCriteria: parseAcceptanceCriteriaEnv(process.env.NEXORA_AGENT_ACCEPTANCE_CRITERIA_JSON), ...(executionConstraints === undefined ? {} : { executionConstraints }) }; }
function validationRequest(command: string, args: string[], prefix: "VERIFY" | "AGENT", allowEmptyPlan: boolean) { const p = `NEXORA_${prefix}`; const planMode = allowEmptyPlan && process.env.NEXORA_VERIFY_PLAN_MODE === "empty" ? "empty" : "default"; return { command, args, cwd: process.env[`${p}_CWD`]?.trim() || ".", environment: {}, timeoutMs: parseOptionalDelay(process.env[`${p}_TIMEOUT_MS`]) ?? 5000, purpose: process.env[`${p}_PURPOSE`]?.trim() || "verification", idempotencyKey: process.env[`${p}_IDEMPOTENCY_KEY`]?.trim() || randomUUID(), validationPlan: { planId: randomUUID(), validators: planMode === "empty" ? [] : [{ validatorId: "command-exit-code", type: "command_exit_code" as const, required: true, expectedExitCode: parseOptionalExpectedExitCode(process.env[`${p}_EXPECTED_EXIT_CODE`]) ?? 0 }] } }; }
function renderLoop(result: any): any { if (result?.runId) return result; if (result.kind === "completed") return { runId: result.run.runId, status: result.run.status, text: result.artifact.content }; if (result.kind === "waiting_for_approval") return { runId: result.run.runId, status: result.run.status, approvalId: result.approval.approvalId, text: result.approval.actionSummary }; return { runId: result.run.runId, status: result.run.status, requestId: result.request.requestId, text: result.request.question }; }
function directResult(result: any) { return { runId: result.run.runId, status: "succeeded", text: result.artifact.content }; }
const toolResult = directResult;
function readOnlyToolResult(result: any) { return { runId: result.run.runId, status: result.run.status, toolName: result.toolResult.toolName, output: result.toolResult.output }; }
function renderEvent(event: Event): void { if (["run.completed", "run.failed", "approval.requested", "user_input.requested", "tool.started", "tool.completed"].includes(event.type)) process.stderr.write(`${JSON.stringify({ event: event.type, runId: event.runId, sequence: event.sequence })}\n`); }
class InvalidInputError extends Error {}
function requireDatabasePath() { const value = process.env.NEXORA_DB_PATH; if (!value?.trim()) throw new Error("NEXORA_DB_PATH is required."); return value; }
function requireWorkspaceRoot() { const value = process.env.NEXORA_WORKSPACE_ROOT; if (!value?.trim()) throw new Error("NEXORA_WORKSPACE_ROOT is required."); return value; }
function isReadOnlyCommand(command: Command): command is ReadOnlyCommand { return command.type === "list" || command.type === "inspect" || command.type === "commands" || command.type === "git_status" || command.type === "git_diff" || command.type === "git_show"; }
function requiresWorkspace(command: Command): boolean { return command.type === "read" || command.type === "search" || command.type === "patch" || command.type === "verify" || command.type === "agent" || command.type === "approve" || command.type === "respond" || command.type === "list" || command.type === "inspect" || command.type === "commands" || command.type === "git_status" || command.type === "git_diff" || command.type === "git_show"; }
function parseTaskTypeEnv(value: string | undefined, fallback: TaskType): TaskType { const normalized = value?.trim(); return normalized === "read_only" || normalized === "analysis" || normalized === "workspace_mutation" || normalized === "bug_fix" || normalized === "feature" ? normalized : fallback; }
function parseAcceptanceCriteriaEnv(value: string | undefined): TaskAcceptanceCriterion[] { const normalized = value?.trim(); return normalized === undefined || normalized.length === 0 ? [] : JSON.parse(normalized) as TaskAcceptanceCriterion[]; }
function parseExecutionConstraintsEnv(value: string | undefined): TaskExecutionConstraints | undefined { const normalized = value?.trim(); return normalized === undefined || normalized.length === 0 ? undefined : JSON.parse(normalized) as TaskExecutionConstraints; }
function parseOptionalDelay(value: string | undefined): number | undefined { const n = Number(value); return value === undefined || !Number.isFinite(n) || n < 0 ? undefined : n; }
function parseOptionalExpectedExitCode(value: string | undefined): number | undefined { const n = Number(value); return value === undefined || !Number.isInteger(n) ? undefined : n; }
function parsePositiveInteger(value: string | undefined): number | undefined { const n = Number(value); return value === undefined || !Number.isInteger(n) || n <= 0 ? undefined : n; }
function parseNonNegativeInteger(value: string | undefined): number | undefined { const n = Number(value); return value === undefined || !Number.isInteger(n) || n < 0 ? undefined : n; }
function parseRecoveryBudgetEnv(): RecoveryBudget | undefined { const entries: [string, number][] = []; for (const [env, key] of [["NEXORA_AGENT_MAX_RECOVERY_ATTEMPTS", "maxRecoveryAttempts"], ["NEXORA_AGENT_MAX_SAME_FAILURE_ATTEMPTS", "maxSameFailureAttempts"], ["NEXORA_AGENT_MAX_REGROUND_ATTEMPTS", "maxRegroundAttempts"], ["NEXORA_AGENT_MAX_REPLAN_ATTEMPTS", "maxReplanAttempts"], ["NEXORA_AGENT_MAX_UNKNOWN_FAILURE_ATTEMPTS", "maxUnknownFailureAttempts"], ["NEXORA_AGENT_MAX_RECOVERY_DURATION_MS", "maxRecoveryDurationMs"]] as const) { const value = parsePositiveInteger(process.env[env]); if (value !== undefined) entries.push([key, value]); } return entries.length === 0 ? undefined : RecoveryBudgetSchema.parse(Object.fromEntries(entries)); }
function providerOptions() { return { env: process.env, fakeModelText: process.env.NEXORA_FAKE_MODEL_TEXT ?? "ok", fakeModelMode: parseFakeModelMode(process.env.NEXORA_FAKE_MODEL_MODE), ...(process.env.NEXORA_FAKE_TOOL_PLAN_MODE === undefined ? {} : { fakeToolPlanMode: parseToolPlanMode(process.env.NEXORA_FAKE_TOOL_PLAN_MODE) }), ...(process.env.NEXORA_FAKE_TOOL_FINAL_MODE === undefined ? {} : { fakeToolFinalMode: parseToolFinalMode(process.env.NEXORA_FAKE_TOOL_FINAL_MODE) }), ...(process.env.NEXORA_FAKE_TOOL_TIMEOUT_MS === undefined ? {} : { fakeToolTimeoutMs: parseOptionalDelay(process.env.NEXORA_FAKE_TOOL_TIMEOUT_MS) }), ...(process.env.NEXORA_FAKE_MODEL_DELAY_MS === undefined ? {} : { fakeModelDelayMs: parseOptionalDelay(process.env.NEXORA_FAKE_MODEL_DELAY_MS) }) }; }
function parseFakeModelMode(value: string | undefined): "success" | "fail" | "empty" { return value === "fail" || value === "empty" ? value : "success"; }
function parseToolPlanMode(value: string | undefined): "success" | "invalid_action" | "fail_action" | undefined { return value === "success" || value === "invalid_action" || value === "fail_action" ? value : undefined; }
function parseToolFinalMode(value: string | undefined): "success" | "empty" | "fail_action" | undefined { return value === "success" || value === "empty" || value === "fail_action" ? value : undefined; }
function toCliError(error: unknown): CliError { if (error instanceof InvalidInputError) return { code: "INVALID_INPUT", message: error.message, retryable: false }; if (error instanceof ModelConfigError) return { code: "MODEL_CONFIG_ERROR", message: error.message, retryable: false }; if (error instanceof ModelHttpError || error instanceof ModelTimeoutError) return { code: "MODEL_HTTP_ERROR", message: error.message, retryable: true }; if (error instanceof ModelJsonParseError) return { code: "MODEL_JSON_PARSE_ERROR", message: error.message, retryable: true }; if (error instanceof AgentLoopRunFailure || error instanceof DirectRunFailure || error instanceof ToolModeRunFailure) return { code: error.code, message: error.message, retryable: error.retryable }; return { code: "CLI_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false }; }
export function printSuccess(result: unknown): void { process.stdout.write(`${JSON.stringify(result)}\n`); }
export function printError(error: CliError): void { process.stderr.write(`${JSON.stringify(error)}\n`); }
export function printHelp(): void { const lines = [`Nexora CLI v${NEXORA_CLI_VERSION}`, "", "Usage: nexora <command> [args]", "", "Commands:", '  ask "<text>"                                  Direct model response for the given text.', '  read "<path>"                                 Read a workspace file.', '  search "<query>"                              Search the workspace.', '  list ["<path>"]                              List workspace entries without a model.', '  inspect ["<path>"]                           Inspect repository structure without a model.', "  commands                                      Discover project commands without a model.", '  git status | git diff ["<path>"]', '  git show "<revision>" ["<path>"]              Read Git facts without a model.', '  patch "<path>" "<expectedHash>" "<find>" "<replace>" ["<idempotencyKey>"]', "                                                 Patch a workspace file.", '  verify "<command>" ["<arg>" ...]             Run a verification command.', '  agent "<goal>" "<command>" ["<arg>" ...]    Run the agent loop with verification.', '  approvals list "<runId>"                      List pending approvals for a run.', '  approve "<approvalId>" ["once"|"current_run"] ["<reason>"]', '  deny "<approvalId>" ["<reason>"]', '  requests list "<runId>"                       List pending user input requests.', '  respond "<requestId>" "<value>"', '  run status "<runId>"                          Show run status.', '  run cancel "<runId>"                          Cancel a waiting run.', '  run resume "<runId>"                          Resume an interrupted run.', "  --help, -h                                     Show this help.", "  --version, -v                                  Show the CLI version.", "", "Required environment variables:", "  NEXORA_DB_PATH                                 SQLite database path.", "  NEXORA_WORKSPACE_ROOT                          Workspace root for file/shell tools.", "  NEXORA_ARTIFACT_ROOT                           Artifact storage root.", "", "Model provider selection:", '  NEXORA_MODEL_PROVIDER                          "fake" (default) or "openai-compatible".', "  NEXORA_MODEL_BASE_URL                          OpenAI-compatible base URL (required for openai-compatible).", "  NEXORA_MODEL_API_KEY                           API key (required for openai-compatible).", "  NEXORA_MODEL_NAME                              Model name (required for openai-compatible).", "  NEXORA_MODEL_TIMEOUT_MS                        Request timeout in milliseconds (optional, default 60000).", "", "Fake provider tuning (tests):", "  NEXORA_FAKE_MODEL_TEXT, NEXORA_FAKE_MODEL_MODE, NEXORA_FAKE_AGENT_SCRIPT_JSON, ...", ""]; process.stdout.write(`${lines.join("\n")}\n`); }
if (process.argv[1]?.endsWith("index.ts")) void main().then((code) => { process.exitCode = code; });
