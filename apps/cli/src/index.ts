import {
  computeArtifactHash,
  createCheckpoint,
  createEvent,
  createRun,
  createTask,
  RecoveryBudgetSchema,
  ToolResultSchema,
  type TaskAcceptanceCriterion,
  type TaskExecutionConstraints,
  type TaskType,
  type ApprovalDecision,
  type ApprovalScope,
  type CheckpointPhase,
  type PendingAction,
  type ProgressLedger,
  type RecoveryBudget,
  type ToolResult
} from "../../../packages/contracts/src/index.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  AgentLoopRunFailure,
  DirectRunFailure,
  fingerprintToolCall,
  runAgentLoop,
  runDirect,
  runToolMode,
  ToolModeRunFailure,
  transitionRun
} from "../../../packages/core/src/index.js";
import {
  AgentIterationStore,
  ApprovalStore,
  ArtifactStore,
  CheckpointStore,
  EventStore,
  ExecutionRecordStore,
  LedgerStore,
  openDatabase,
  PendingActionStore,
  RunStore,
  TaskStore,
  UserInputStore,
  ValidationResultStore
} from "../../../packages/storage/src/index.js";
import { createDefaultToolRegistry, resolveWorkspaceFilePath, ToolRuntime } from "../../../packages/tool-runtime/src/index.js";
import { createModelProvider, resolveProviderKind, ModelConfigError, ModelHttpError, ModelTimeoutError, ModelJsonParseError } from "../../../packages/model-gateway/src/index.js";

type CliError = {
  code: string;
  message: string;
  retryable: boolean;
};

export const NEXORA_CLI_VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      printHelp();
      return 0;
    }
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
      process.stdout.write(`${NEXORA_CLI_VERSION}\n`);
      return 0;
    }
    const command = parseCommand(argv);
    const result =
      command.type === "ask"
        ? await runAskCommand(command.text)
        : command.type === "read"
          ? await runReadCommand(command.path)
          : command.type === "search"
            ? await runSearchCommand(command.query)
            : command.type === "patch"
              ? await runPatchCommand(command)
              : command.type === "approvals_list"
                ? await runApprovalListCommand(command.runId)
                : command.type === "approve"
                  ? await runApproveCommand(command)
                  : command.type === "deny"
                    ? await runDenyCommand(command)
                    : command.type === "requests_list"
                      ? await runRequestListCommand(command.runId)
                      : command.type === "respond"
                        ? await runRespondCommand(command)
                      : command.type === "run_status"
                          ? await runStatusCommand(command.runId)
                          : command.type === "run_cancel"
                            ? await runCancelCommand(command.runId)
                            : command.type === "run_resume"
                              ? await runResumeCommand(command.runId)
              : command.type === "verify"
                ? await runVerifyCommand(command)
                : await runAgentCommand(command);
    printSuccess(result);
    return 0;
  } catch (error) {
    const cliError = toCliError(error);
    printError(cliError);
    return cliError.code === "INVALID_INPUT" ? 2 : 1;
  }
}

export function parseCommand(argv: string[]):
  | { type: "ask"; text: string }
  | { type: "read"; path: string }
  | { type: "search"; query: string }
  | { type: "patch"; path: string; expectedHash: string; find: string; replace: string; idempotencyKey?: string }
  | { type: "approvals_list"; runId: string }
  | { type: "approve"; approvalId: string; scope: ApprovalScope; reason?: string }
  | { type: "deny"; approvalId: string; reason?: string }
  | { type: "requests_list"; runId: string }
  | { type: "respond"; requestId: string; value: string }
  | { type: "run_status"; runId: string }
  | { type: "run_cancel"; runId: string }
  | { type: "run_resume"; runId: string }
  | { type: "agent"; goal: string; command: string; args: string[] }
  | { type: "verify"; command: string; args: string[] } {
  const [command, ...rest] = argv;
  if (command === "ask") {
    const text = rest.join(" ");
    if (text.trim().length === 0) {
      throw new InvalidInputError("Input text must not be empty.");
    }

    return { type: "ask", text };
  }

  if (command === "read") {
    const path = rest.join(" ");
    if (path.trim().length === 0) {
      throw new InvalidInputError("File path must not be empty.");
    }

    return { type: "read", path };
  }

  if (command === "search") {
    const query = rest.join(" ");
    if (query.trim().length === 0) {
      throw new InvalidInputError("Search query must not be empty.");
    }

    return { type: "search", query };
  }

  if (command === "patch") {
    if (rest.length < 4) {
      throw new Error('Usage: nexora patch "<path>" "<expectedHash>" "<find>" "<replace>" ["<idempotencyKey>"]');
    }

    const path = rest[0];
    const expectedHash = rest[1];
    const find = rest[2];
    const replace = rest[3];
    const idempotencyKey = rest[4];
    if (path === undefined || expectedHash === undefined || find === undefined || replace === undefined) {
      throw new Error('Usage: nexora patch "<path>" "<expectedHash>" "<find>" "<replace>" ["<idempotencyKey>"]');
    }

    if (path.trim().length === 0 || expectedHash.trim().length === 0 || find.length === 0) {
      throw new InvalidInputError("Patch path, expectedHash, and find text must not be empty.");
    }

    return {
      type: "patch",
      path,
      expectedHash,
      find,
      replace,
      ...(idempotencyKey === undefined || idempotencyKey.trim().length === 0 ? {} : { idempotencyKey })
    };
  }

  if (command === "verify") {
    const executable = rest[0];
    if (executable === undefined || executable.trim().length === 0) {
      throw new Error('Usage: nexora verify "<command>" ["<arg>" ...]');
    }

    return {
      type: "verify",
      command: executable,
      args: rest.slice(1)
    };
  }

  if (command === "approvals") {
    if (rest[0] !== "list" || rest[1] === undefined || rest[1].trim().length === 0) {
      throw new Error('Usage: nexora approvals list "<runId>"');
    }

    return {
      type: "approvals_list",
      runId: rest[1]
    };
  }

  if (command === "approve") {
    const approvalId = rest[0];
    if (approvalId === undefined || approvalId.trim().length === 0) {
      throw new Error('Usage: nexora approve "<approvalId>" ["once"|"current_run"] ["<reason>"]');
    }

    const scope = rest[1] === "current_run" ? "current_run" : "once";
    const reasonIndex = rest[1] === "current_run" || rest[1] === "once" ? 2 : 1;
    const reason = rest.slice(reasonIndex).join(" ").trim();
    return {
      type: "approve",
      approvalId,
      scope,
      ...(reason.length === 0 ? {} : { reason })
    };
  }

  if (command === "deny") {
    const approvalId = rest[0];
    if (approvalId === undefined || approvalId.trim().length === 0) {
      throw new Error('Usage: nexora deny "<approvalId>" ["<reason>"]');
    }

    const reason = rest.slice(1).join(" ").trim();
    return {
      type: "deny",
      approvalId,
      ...(reason.length === 0 ? {} : { reason })
    };
  }

  if (command === "requests") {
    if (rest[0] !== "list" || rest[1] === undefined || rest[1].trim().length === 0) {
      throw new Error('Usage: nexora requests list "<runId>"');
    }

    return {
      type: "requests_list",
      runId: rest[1]
    };
  }

  if (command === "respond") {
    const requestId = rest[0];
    if (requestId === undefined || requestId.trim().length === 0 || rest[1] === undefined) {
      throw new Error('Usage: nexora respond "<requestId>" "<value>"');
    }

    return {
      type: "respond",
      requestId,
      value: rest.slice(1).join(" ")
    };
  }

  if (command === "run") {
    if (rest[0] === "status" && rest[1] !== undefined && rest[1].trim().length > 0) {
      return {
        type: "run_status",
        runId: rest[1]
      };
    }

    if (rest[0] === "cancel" && rest[1] !== undefined && rest[1].trim().length > 0) {
      return {
        type: "run_cancel",
        runId: rest[1]
      };
    }

    if (rest[0] === "resume" && rest[1] !== undefined && rest[1].trim().length > 0) {
      return {
        type: "run_resume",
        runId: rest[1]
      };
    }

    throw new Error('Usage: nexora run status "<runId>" | nexora run cancel "<runId>" | nexora run resume "<runId>"');
  }

  if (command === "agent") {
    const goal = rest[0];
    const executable = rest[1];
    if (goal === undefined || goal.trim().length === 0 || executable === undefined || executable.trim().length === 0) {
      throw new Error('Usage: nexora agent "<goal>" "<command>" ["<arg>" ...]');
    }

    return {
      type: "agent",
      goal,
      command: executable,
      args: rest.slice(2)
    };
  }

  if (command !== "ask") {
    throw new Error("Usage: nexora ask \"<text>\"");
  }

  throw new Error(
    'Usage: nexora ask "<text>" | nexora read "<path>" | nexora search "<query>" | nexora patch "<path>" "<expectedHash>" "<find>" "<replace>" ["<idempotencyKey>"] | nexora approvals list "<runId>" | nexora approve "<approvalId>" ["once"|"current_run"] ["<reason>"] | nexora deny "<approvalId>" ["<reason>"] | nexora requests list "<runId>" | nexora respond "<requestId>" "<value>" | nexora run status "<runId>" | nexora run cancel "<runId>" | nexora run resume "<runId>" | nexora verify "<command>" ["<arg>" ...] | nexora agent "<goal>" "<command>" ["<arg>" ...]'
  );
}

export async function runAskCommand(text: string): Promise<{
  runId: string;
  status: "succeeded";
  text: string;
}> {
  const databasePath = process.env.NEXORA_DB_PATH;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error("NEXORA_DB_PATH is required.");
  }

  const database = openDatabase(databasePath);
  const taskStore = new TaskStore(database);
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);

  try {
    const now = () => new Date().toISOString();
    const task = createTask({
      taskId: randomUUID(),
      text,
      taskType: "analysis",
      createdAt: now()
    });
    taskStore.insertTask(task);

    const run = createRun({
      runId: randomUUID(),
      taskId: task.taskId,
      createdAt: now(),
      mode: "direct"
    });
    runStore.insertRun(run);

    const modelProvider = createCliModelProvider();

    const result = await runDirect({
      task,
      run,
      now,
      idGenerator: randomUUID,
      modelProvider,
      runStore,
      eventStore,
      artifactStore
    });

    return {
      runId: result.run.runId,
      status: "succeeded",
      text: result.artifact.content
    };
  } finally {
    database.close();
  }
}

export async function runReadCommand(filePath: string): Promise<{
  runId: string;
  status: "succeeded";
  text: string;
}> {
  const databasePath = process.env.NEXORA_DB_PATH;
  const workspaceRoot = process.env.NEXORA_WORKSPACE_ROOT;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error("NEXORA_DB_PATH is required.");
  }

  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new Error("NEXORA_WORKSPACE_ROOT is required.");
  }

  const artifactRoot = process.env.NEXORA_ARTIFACT_ROOT?.trim().length
    ? process.env.NEXORA_ARTIFACT_ROOT
    : join(dirname(databasePath), "artifacts");

  const database = openDatabase(databasePath);
  const taskStore = new TaskStore(database);
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);

  try {
    const now = () => new Date().toISOString();
    const task = createTask({
      taskId: randomUUID(),
      text: `Read file ${filePath}`,
      taskType: "read_only",
      filePath,
      createdAt: now()
    });
    taskStore.insertTask(task);

    const run = createRun({
      runId: randomUUID(),
      taskId: task.taskId,
      createdAt: now(),
      mode: "tool"
    });
    runStore.insertRun(run);

    const modelProvider = createCliModelProvider();
    const toolRuntime = new ToolRuntime({
      registry: createDefaultToolRegistry(),
      executionRecordStore,
      artifactStore
    });

    const result = await runToolMode({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot,
      artifactRoot,
      modelProvider,
      toolRuntime,
      runStore,
      eventStore,
      artifactStore,
      validationResultStore
    });

    return {
      runId: result.run.runId,
      status: "succeeded",
      text: result.artifact.content
    };
  } finally {
    database.close();
  }
}

export async function runSearchCommand(searchQuery: string): Promise<{
  runId: string;
  status: "succeeded";
  text: string;
}> {
  const databasePath = process.env.NEXORA_DB_PATH;
  const workspaceRoot = process.env.NEXORA_WORKSPACE_ROOT;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error("NEXORA_DB_PATH is required.");
  }

  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new Error("NEXORA_WORKSPACE_ROOT is required.");
  }

  const artifactRoot = process.env.NEXORA_ARTIFACT_ROOT?.trim().length
    ? process.env.NEXORA_ARTIFACT_ROOT
    : join(dirname(databasePath), "artifacts");

  const database = openDatabase(databasePath);
  const taskStore = new TaskStore(database);
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);

  try {
    const now = () => new Date().toISOString();
    const task = createTask({
      taskId: randomUUID(),
      text: searchQuery,
      taskType: "read_only",
      searchQuery,
      createdAt: now()
    });
    taskStore.insertTask(task);

    const run = createRun({
      runId: randomUUID(),
      taskId: task.taskId,
      createdAt: now(),
      mode: "tool"
    });
    runStore.insertRun(run);

    const modelProvider = createCliModelProvider();
    const toolRuntime = new ToolRuntime({
      registry: createDefaultToolRegistry(),
      executionRecordStore,
      artifactStore
    });

    const result = await runToolMode({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot,
      artifactRoot,
      modelProvider,
      toolRuntime,
      runStore,
      eventStore,
      artifactStore,
      validationResultStore
    });

    return {
      runId: result.run.runId,
      status: "succeeded",
      text: result.artifact.content
    };
  } finally {
    database.close();
  }
}

export async function runPatchCommand(command: {
  path: string;
  expectedHash: string;
  find: string;
  replace: string;
  idempotencyKey?: string;
}): Promise<{
  runId: string;
  status: "succeeded";
  text: string;
}> {
  const databasePath = process.env.NEXORA_DB_PATH;
  const workspaceRoot = process.env.NEXORA_WORKSPACE_ROOT;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error("NEXORA_DB_PATH is required.");
  }

  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new Error("NEXORA_WORKSPACE_ROOT is required.");
  }

  const artifactRoot = process.env.NEXORA_ARTIFACT_ROOT?.trim().length
    ? process.env.NEXORA_ARTIFACT_ROOT
    : join(dirname(databasePath), "artifacts");

  const database = openDatabase(databasePath);
  const taskStore = new TaskStore(database);
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);

  try {
    const now = () => new Date().toISOString();
    const task = createTask({
      taskId: randomUUID(),
      text: `Patch file ${command.path}`,
      taskType: "workspace_mutation",
      patchRequest: {
        path: command.path,
        expectedHash: command.expectedHash,
        patch: {
          type: "replace_text",
          find: command.find,
          replace: command.replace
        },
        encoding: "utf8",
        idempotencyKey: command.idempotencyKey ?? randomUUID()
      },
      createdAt: now()
    });
    taskStore.insertTask(task);

    const run = createRun({
      runId: randomUUID(),
      taskId: task.taskId,
      createdAt: now(),
      mode: "tool"
    });
    runStore.insertRun(run);

    const modelProvider = createCliModelProvider();
    const toolRuntime = new ToolRuntime({
      registry: createDefaultToolRegistry(),
      executionRecordStore,
      artifactStore
    });

    const result = await runToolMode({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot,
      artifactRoot,
      modelProvider,
      toolRuntime,
      runStore,
      eventStore,
      artifactStore,
      validationResultStore
    });

    return {
      runId: result.run.runId,
      status: "succeeded",
      text: result.artifact.content
    };
  } finally {
    database.close();
  }
}

export async function runVerifyCommand(command: {
  command: string;
  args: string[];
}): Promise<{
  runId: string;
  status: "succeeded";
  text: string;
}> {
  const databasePath = process.env.NEXORA_DB_PATH;
  const workspaceRoot = process.env.NEXORA_WORKSPACE_ROOT;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error("NEXORA_DB_PATH is required.");
  }

  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new Error("NEXORA_WORKSPACE_ROOT is required.");
  }

  const artifactRoot = process.env.NEXORA_ARTIFACT_ROOT?.trim().length
    ? process.env.NEXORA_ARTIFACT_ROOT
    : join(dirname(databasePath), "artifacts");

  const database = openDatabase(databasePath);
  const taskStore = new TaskStore(database);
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);

  try {
    const now = () => new Date().toISOString();
    const timeoutMs = parseOptionalDelay(process.env.NEXORA_VERIFY_TIMEOUT_MS) ?? 5_000;
    const expectedExitCode = parseOptionalExpectedExitCode(process.env.NEXORA_VERIFY_EXPECTED_EXIT_CODE) ?? 0;
    const planMode = parseVerifyPlanMode(process.env.NEXORA_VERIFY_PLAN_MODE);
    const task = createTask({
      taskId: randomUUID(),
      text: `Verify command ${command.command}`,
      taskType: parseTaskTypeEnv(process.env.NEXORA_VERIFY_TASK_TYPE, "analysis"),
      validationRequest: {
        command: command.command,
        args: command.args,
        cwd: process.env.NEXORA_VERIFY_CWD?.trim().length ? process.env.NEXORA_VERIFY_CWD : ".",
        environment: {},
        timeoutMs,
        purpose: process.env.NEXORA_VERIFY_PURPOSE?.trim().length ? process.env.NEXORA_VERIFY_PURPOSE : "verification",
        idempotencyKey: process.env.NEXORA_VERIFY_IDEMPOTENCY_KEY?.trim().length
          ? process.env.NEXORA_VERIFY_IDEMPOTENCY_KEY
          : randomUUID(),
        validationPlan: {
          planId: randomUUID(),
          validators:
            planMode === "empty"
              ? []
              : [
                  {
                    validatorId: "command-exit-code",
                    type: "command_exit_code",
                    required: true,
                    expectedExitCode
                  }
                ]
        }
      },
      acceptanceCriteria: parseAcceptanceCriteriaEnv(process.env.NEXORA_VERIFY_ACCEPTANCE_CRITERIA_JSON),
      createdAt: now()
    });
    taskStore.insertTask(task);

    const run = createRun({
      runId: randomUUID(),
      taskId: task.taskId,
      createdAt: now(),
      mode: "tool"
    });
    runStore.insertRun(run);

    const modelProvider = createCliModelProvider();
    const toolRuntime = new ToolRuntime({
      registry: createDefaultToolRegistry(),
      executionRecordStore,
      artifactStore
    });

    const result = await runToolMode({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot,
      artifactRoot,
      modelProvider,
      toolRuntime,
      runStore,
      eventStore,
      artifactStore,
      validationResultStore
    });

    return {
      runId: result.run.runId,
      status: "succeeded",
      text: result.artifact.content
    };
  } finally {
    database.close();
  }
}

export async function runAgentCommand(command: {
  goal: string;
  command: string;
  args: string[];
}): Promise<{
  runId: string;
  status: string;
  text: string;
  approvalId?: string;
  requestId?: string;
}> {
  const databasePath = process.env.NEXORA_DB_PATH;
  const workspaceRoot = process.env.NEXORA_WORKSPACE_ROOT;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error("NEXORA_DB_PATH is required.");
  }

  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new Error("NEXORA_WORKSPACE_ROOT is required.");
  }

  const artifactRoot = process.env.NEXORA_ARTIFACT_ROOT?.trim().length
    ? process.env.NEXORA_ARTIFACT_ROOT
    : join(dirname(databasePath), "artifacts");

  const database = openDatabase(databasePath);
  const taskStore = new TaskStore(database);
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);
  const ledgerStore = new LedgerStore(database);
  const agentIterationStore = new AgentIterationStore(database);
  const approvalStore = new ApprovalStore(database);
  const pendingActionStore = new PendingActionStore(database);
  const userInputStore = new UserInputStore(database);
  const checkpointStore = new CheckpointStore(database);

  try {
    const now = () => new Date().toISOString();
    const timeoutMs = parseOptionalDelay(process.env.NEXORA_AGENT_VERIFY_TIMEOUT_MS) ?? 5_000;
    const expectedExitCode = parseOptionalExpectedExitCode(process.env.NEXORA_AGENT_EXPECTED_EXIT_CODE) ?? 0;
    const executionConstraints = parseExecutionConstraintsEnv(process.env.NEXORA_AGENT_EXECUTION_CONSTRAINTS_JSON);
    const task = createTask({
      taskId: randomUUID(),
      text: command.goal,
      taskType: parseTaskTypeEnv(process.env.NEXORA_AGENT_TASK_TYPE, "feature"),
      validationRequest: {
        command: command.command,
        args: command.args,
        cwd: process.env.NEXORA_AGENT_VERIFY_CWD?.trim().length ? process.env.NEXORA_AGENT_VERIFY_CWD : ".",
        environment: {},
        timeoutMs,
        purpose: process.env.NEXORA_AGENT_VERIFY_PURPOSE?.trim().length
          ? process.env.NEXORA_AGENT_VERIFY_PURPOSE
          : "verification",
        idempotencyKey: process.env.NEXORA_AGENT_VERIFY_IDEMPOTENCY_KEY?.trim().length
          ? process.env.NEXORA_AGENT_VERIFY_IDEMPOTENCY_KEY
          : randomUUID(),
        validationPlan: {
          planId: randomUUID(),
          validators: [
            {
              validatorId: "command-exit-code",
              type: "command_exit_code",
              required: true,
              expectedExitCode
            }
          ]
        }
      },
      agentRequest: {
        budget: {
          maxLoopCount: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_LOOP_COUNT) ?? 50,
          maxModelCalls: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_MODEL_CALLS) ?? 80,
          maxToolCalls: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_TOOL_CALLS) ?? 50,
          maxRetries: parseNonNegativeInteger(process.env.NEXORA_AGENT_MAX_RETRIES) ?? 20,
          maxDurationMs: parsePositiveInteger(process.env.NEXORA_AGENT_MAX_DURATION_MS) ?? 300_000
        },
        ...(() => {
          const recoveryBudget = parseRecoveryBudgetEnv();
          return recoveryBudget === undefined ? {} : { recoveryBudget };
        })()
      },
      acceptanceCriteria: parseAcceptanceCriteriaEnv(process.env.NEXORA_AGENT_ACCEPTANCE_CRITERIA_JSON),
      ...(executionConstraints === undefined ? {} : { executionConstraints }),
      createdAt: now()
    });
    taskStore.insertTask(task);

    const run = createRun({
      runId: randomUUID(),
      taskId: task.taskId,
      createdAt: now(),
      mode: "tool"
    });
    runStore.insertRun(run);

    const modelProvider = createCliModelProvider();
    const toolRuntime = new ToolRuntime({
      registry: createDefaultToolRegistry(),
      executionRecordStore,
      artifactStore
    });

    const result = await runAgentLoop({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot,
      artifactRoot,
      modelProvider,
      toolRuntime,
      runStore,
      eventStore,
      artifactStore,
      validationResultStore,
      ledgerStore,
      agentIterationStore,
      approvalStore,
      pendingActionStore,
      userInputStore,
      checkpointStore
    });

    return renderAgentLoopResult(result);
  } finally {
    database.close();
  }
}

export function printSuccess(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function printError(error: CliError): void {
  process.stderr.write(`${JSON.stringify(error)}\n`);
}

export function printHelp(): void {
  const lines = [
    `Nexora CLI v${NEXORA_CLI_VERSION}`,
    "",
    "Usage: nexora <command> [args]",
    "",
    "Commands:",
    "  ask \"<text>\"                                  Direct model response for the given text.",
    "  read \"<path>\"                                 Read a workspace file.",
    "  search \"<query>\"                              Search the workspace.",
    "  patch \"<path>\" \"<expectedHash>\" \"<find>\" \"<replace>\" [\"<idempotencyKey>\"]",
    "                                                 Patch a workspace file.",
    "  verify \"<command>\" [\"<arg>\" ...]             Run a verification command.",
    "  agent \"<goal>\" \"<command>\" [\"<arg>\" ...]    Run the agent loop with verification.",
    "  approvals list \"<runId>\"                      List pending approvals for a run.",
    "  approve \"<approvalId>\" [\"once\"|\"current_run\"] [\"<reason>\"]",
    "  deny \"<approvalId>\" [\"<reason>\"]",
    "  requests list \"<runId>\"                       List pending user input requests.",
    "  respond \"<requestId>\" \"<value>\"",
    "  run status \"<runId>\"                          Show run status.",
    "  run cancel \"<runId>\"                          Cancel a waiting run.",
    "  run resume \"<runId>\"                          Resume an interrupted run.",
    "  --help, -h                                     Show this help.",
    "  --version, -v                                  Show the CLI version.",
    "",
    "Required environment variables:",
    "  NEXORA_DB_PATH                                 SQLite database path.",
    "  NEXORA_WORKSPACE_ROOT                          Workspace root for file/shell tools.",
    "  NEXORA_ARTIFACT_ROOT                           Artifact storage root.",
    "",
    "Model provider selection:",
    "  NEXORA_MODEL_PROVIDER                          \"fake\" (default) or \"openai-compatible\".",
    "  NEXORA_MODEL_BASE_URL                          OpenAI-compatible base URL (required for openai-compatible).",
    "  NEXORA_MODEL_API_KEY                           API key (required for openai-compatible).",
    "  NEXORA_MODEL_NAME                              Model name (required for openai-compatible).",
    "  NEXORA_MODEL_TIMEOUT_MS                        Request timeout in milliseconds (optional, default 60000).",
    "",
    "Fake provider tuning (tests):",
    "  NEXORA_FAKE_MODEL_TEXT, NEXORA_FAKE_MODEL_MODE, NEXORA_FAKE_AGENT_SCRIPT_JSON, ...",
    ""
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function createCliModelProvider(options?: { agentActionSliceFrom?: number }): ReturnType<typeof createModelProvider> {
  const kind = resolveProviderKind(process.env);
  return createModelProvider({
    fakeModelText: process.env.NEXORA_FAKE_MODEL_TEXT ?? "ok",
    fakeModelMode: parseFakeModelMode(process.env.NEXORA_FAKE_MODEL_MODE),
    ...(process.env.NEXORA_FAKE_TOOL_PLAN_MODE === undefined ? {} : { fakeToolPlanMode: parseToolPlanMode(process.env.NEXORA_FAKE_TOOL_PLAN_MODE) }),
    ...(process.env.NEXORA_FAKE_TOOL_FINAL_MODE === undefined ? {} : { fakeToolFinalMode: parseToolFinalMode(process.env.NEXORA_FAKE_TOOL_FINAL_MODE) }),
    ...(process.env.NEXORA_FAKE_TOOL_TIMEOUT_MS === undefined ? {} : { fakeToolTimeoutMs: parseOptionalDelay(process.env.NEXORA_FAKE_TOOL_TIMEOUT_MS) }),
    ...(process.env.NEXORA_FAKE_MODEL_DELAY_MS === undefined ? {} : { fakeModelDelayMs: parseOptionalDelay(process.env.NEXORA_FAKE_MODEL_DELAY_MS) }),
    ...(options?.agentActionSliceFrom === undefined ? {} : { agentActionSliceFrom: options.agentActionSliceFrom }),
    ...(kind === "openai-compatible" ? { env: process.env } : {})
  });
}

class InvalidInputError extends Error {}

function toCliError(error: unknown): CliError {
  if (error instanceof InvalidInputError) {
    return {
      code: "INVALID_INPUT",
      message: error.message,
      retryable: false
    };
  }

  if (error instanceof DirectRunFailure) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
  }

  if (error instanceof ToolModeRunFailure) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
  }

  if (error instanceof AgentLoopRunFailure) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
  }

  if (error instanceof ModelConfigError) {
    return { code: "MODEL_CONFIG_ERROR", message: error.message, retryable: false };
  }
  if (error instanceof ModelHttpError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof ModelTimeoutError) {
    return { code: "MODEL_TIMEOUT", message: error.message, retryable: true };
  }
  if (error instanceof ModelJsonParseError) {
    return { code: "MODEL_JSON_PARSE_ERROR", message: error.message, retryable: false };
  }

  if (error instanceof Error && error.message.startsWith("Usage:")) {
    return {
      code: "INVALID_INPUT",
      message: error.message,
      retryable: false
    };
  }

  return {
    code: "RUNTIME_ERROR",
    message: error instanceof Error ? error.message : "Unknown runtime error",
    retryable: true
  };
}

function parseToolPlanMode(mode: string | undefined): "success" | "invalid_action" | "fail_action" | undefined {
  if (mode === "success" || mode === "invalid_action" || mode === "fail_action") {
    return mode;
  }

  return undefined;
}

function parseToolFinalMode(mode: string | undefined): "success" | "empty" | "fail_action" | undefined {
  if (mode === "success" || mode === "empty" || mode === "fail_action") {
    return mode;
  }

  return undefined;
}

function parseFakeModelMode(mode: string | undefined): "success" | "fail" | "empty" {
  if (mode === "fail" || mode === "empty" || mode === "success" || mode === undefined) {
    return mode ?? "success";
  }

  return "success";
}

function parseOptionalDelay(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return undefined;
  }

  return parsedValue;
}

function parseOptionalExpectedExitCode(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue)) {
    return undefined;
  }

  return parsedValue;
}

function parseVerifyPlanMode(rawValue: string | undefined): "default" | "empty" {
  if (rawValue === "empty") {
    return "empty";
  }

  return "default";
}

function parsePositiveInteger(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return undefined;
  }

  return parsedValue;
}

function parseRecoveryBudgetEnv(): RecoveryBudget | undefined {
  const entries: [string, number][] = [];
  const push = (env: string, key: string): void => {
    const value = parsePositiveInteger(process.env[env]);
    if (value !== undefined) {
      entries.push([key, value]);
    }
  };
  push("NEXORA_AGENT_MAX_RECOVERY_ATTEMPTS", "maxRecoveryAttempts");
  push("NEXORA_AGENT_MAX_SAME_FAILURE_ATTEMPTS", "maxSameFailureAttempts");
  push("NEXORA_AGENT_MAX_REGROUND_ATTEMPTS", "maxRegroundAttempts");
  push("NEXORA_AGENT_MAX_REPLAN_ATTEMPTS", "maxReplanAttempts");
  push("NEXORA_AGENT_MAX_UNKNOWN_FAILURE_ATTEMPTS", "maxUnknownFailureAttempts");
  push("NEXORA_AGENT_MAX_RECOVERY_DURATION_MS", "maxRecoveryDurationMs");
  if (entries.length === 0) {
    return undefined;
  }
  const partial = Object.fromEntries(entries) as Record<string, number>;
  return RecoveryBudgetSchema.parse(partial);
}

function parseNonNegativeInteger(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return undefined;
  }

  return parsedValue;
}

async function runApprovalListCommand(runId: string): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const approvalStore = new ApprovalStore(database);
    return {
      runId,
      approvals: approvalStore.listByRun(runId)
    };
  } finally {
    database.close();
  }
}

async function runRequestListCommand(runId: string): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const userInputStore = new UserInputStore(database);
    return {
      runId,
      requests: userInputStore.listByRun(runId)
    };
  } finally {
    database.close();
  }
}

async function runStatusCommand(runId: string): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const runStore = new RunStore(database);
    const approvalStore = new ApprovalStore(database);
    const userInputStore = new UserInputStore(database);
    const pendingActionStore = new PendingActionStore(database);
    const run = runStore.getRun(runId);
    if (run === null) {
      throw new Error(`Run ${runId} was not found.`);
    }

    return {
      runId,
      status: run.status,
      errorCode: run.errorCode,
      approvals: approvalStore.listByRun(runId),
      requests: userInputStore.listByRun(runId),
      pendingAction: pendingActionStore.getActiveByRun(runId)
    };
  } finally {
    database.close();
  }
}

async function runCancelCommand(runId: string): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const now = () => new Date().toISOString();
    const runStore = new RunStore(database);
    const approvalStore = new ApprovalStore(database);
    const userInputStore = new UserInputStore(database);
    const pendingActionStore = new PendingActionStore(database);
    const run = runStore.getRun(runId);
    if (run === null) {
      throw new Error(`Run ${runId} was not found.`);
    }

    if (run.status !== "waiting_for_approval" && run.status !== "waiting_for_user") {
      throw new Error(`Run ${runId} is not waiting and cannot be cancelled.`);
    }

    const cancelledRun = transitionRun(run, "cancelled", now());
    runStore.updateRun(cancelledRun);
    persistCheckpointForRun({
      checkpointStore: new CheckpointStore(database),
      ledgerStore: new LedgerStore(database),
      run: cancelledRun,
      phase: "runtime_shutdown",
      now: now()
    });

    const pendingAction = pendingActionStore.getActiveByRun(runId);
    if (pendingAction !== null) {
      pendingActionStore.updatePendingAction({
        ...pendingAction,
        status: "cancelled",
        updatedAt: now()
      });
    }

    if (run.status === "waiting_for_approval") {
      for (const approval of approvalStore.listByRun(runId)) {
        if (approval.request.status !== "pending") {
          continue;
        }
        approvalStore.updateApproval({
          request: {
            ...approval.request,
            status: "cancelled"
          },
          decision: approval.decision,
          updatedAt: now()
        });
      }
    }

    if (run.status === "waiting_for_user") {
      for (const request of userInputStore.listByRun(runId)) {
        if (request.request.status !== "pending") {
          continue;
        }
        userInputStore.updateRequest({
          request: {
            ...request.request,
            status: "cancelled"
          },
          response: request.response,
          updatedAt: now()
        });
      }
    }

    return {
      runId,
      status: cancelledRun.status,
      text: `Run ${runId} cancelled.`
    };
  } finally {
    database.close();
  }
}

async function runResumeCommand(runId: string): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const now = () => new Date().toISOString();
    const taskStore = new TaskStore(database);
    const runStore = new RunStore(database);
    const eventStore = new EventStore(database);
    const artifactStore = new ArtifactStore(database);
    const executionRecordStore = new ExecutionRecordStore(database);
    const validationResultStore = new ValidationResultStore(database);
    const ledgerStore = new LedgerStore(database);
    const agentIterationStore = new AgentIterationStore(database);
    const approvalStore = new ApprovalStore(database);
    const userInputStore = new UserInputStore(database);
    const pendingActionStore = new PendingActionStore(database);
    const checkpointStore = new CheckpointStore(database);

    const run = requireRun(runStore, runId);
    if (run.status === "cancelled" || run.status === "succeeded" || run.status === "failed") {
      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.rejected",
        { runId, reason: "terminal_run", status: run.status },
        now()
      );
      throw new Error(`Run ${runId} is ${run.status} and cannot be resumed.`);
    }

    const latestCheckpoint = checkpointStore.inspectLatestForRun(runId);
    if (latestCheckpoint.kind === "missing") {
      appendRunEvent(eventStore, run.runId, "recovery.rejected", { runId, reason: "checkpoint_missing" }, now());
      throw new Error(`Run ${runId} has no checkpoint to resume from.`);
    }
    if (latestCheckpoint.kind === "corrupt") {
      appendRunEvent(eventStore, run.runId, "recovery.rejected", { runId, reason: "checkpoint_corrupt" }, now());
      throw new Error(`Run ${runId} has a corrupt checkpoint and cannot be resumed.`);
    }
    if (latestCheckpoint.kind === "schema_version_mismatch") {
      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.rejected",
        { runId, reason: "checkpoint_schema_version_mismatch", schemaVersion: latestCheckpoint.schemaVersion ?? null },
        now()
      );
      throw new Error(
        `Run ${runId} checkpoint schema version ${latestCheckpoint.schemaVersion ?? "unknown"} is not supported for resume.`
      );
    }
    const checkpoint = latestCheckpoint.checkpoint;

    appendRunEvent(
      eventStore,
      run.runId,
      "checkpoint.loaded",
      { checkpointId: checkpoint.checkpointId, phase: checkpoint.phase },
      now()
    );

    const pendingAction =
      checkpoint.pendingActionId === undefined
        ? pendingActionStore.getActiveByRun(runId)
        : pendingActionStore.getPendingAction(checkpoint.pendingActionId);
    if (checkpoint.pendingActionId !== undefined && pendingAction?.pendingActionId !== checkpoint.pendingActionId) {
      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.rejected",
        { runId, checkpointId: checkpoint.checkpointId, reason: "pending_action_mismatch" },
        now()
      );
      throw new Error(`Run ${runId} pending action no longer matches the latest checkpoint.`);
    }

    if (run.status === "waiting_for_approval") {
      const approvalId = pendingAction?.approvalId;
      const approval =
        approvalId === undefined ? undefined : approvalStore.listByRun(runId).find((entry) => entry.request.approvalId === approvalId);
      if (approval === undefined || approval.request.status !== "pending") {
        appendRunEvent(
          eventStore,
          run.runId,
          "recovery.rejected",
          { runId, checkpointId: checkpoint.checkpointId, reason: "approval_missing" },
          now()
        );
        throw new Error(`Run ${runId} has no pending approval to resume.`);
      }

      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.decision",
        { action: "wait", checkpointId: checkpoint.checkpointId, waitingFor: "approval" },
        now()
      );
      return {
        runId: run.runId,
        status: run.status,
        approvalId: approval.request.approvalId,
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "wait",
        text: approval.request.actionSummary
      };
    }

    if (run.status === "waiting_for_user") {
      const requestId = pendingAction?.requestId;
      const request =
        requestId === undefined ? undefined : userInputStore.listByRun(runId).find((entry) => entry.request.requestId === requestId);
      if (request === undefined || request.request.status !== "pending") {
        appendRunEvent(
          eventStore,
          run.runId,
          "recovery.rejected",
          { runId, checkpointId: checkpoint.checkpointId, reason: "request_missing" },
          now()
        );
        throw new Error(`Run ${runId} has no pending user-input request to resume.`);
      }

      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.decision",
        { action: "wait", checkpointId: checkpoint.checkpointId, waitingFor: "user_input" },
        now()
      );
      return {
        runId: run.runId,
        status: run.status,
        requestId: request.request.requestId,
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "wait",
        text: request.request.question
      };
    }

    if (run.status === "blocked") {
      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.decision",
        { action: "blocked", checkpointId: checkpoint.checkpointId, waitingFor: "manual_intervention" },
        now()
      );
      return {
        runId: run.runId,
        status: run.status,
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "blocked",
        text: run.errorCode ?? "Run is blocked and needs manual intervention."
      };
    }

    if (run.status === "waiting_for_tool") {
      if (pendingAction === null || pendingAction.waitingFor !== "tool_execution" || pendingAction.action.type !== "tool_call") {
        const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
        runStore.updateRun(blockedRun);
        appendRunEvent(
          eventStore,
          run.runId,
          "recovery.decision",
          {
            action: "blocked",
            checkpointId: checkpoint.checkpointId,
            waitingFor: "manual_intervention",
            previousStatus: run.status,
            reason: "tool_pending_action_missing"
          },
          now()
        );
        return {
          runId: blockedRun.runId,
          status: blockedRun.status,
          checkpointId: checkpoint.checkpointId,
          recoveryAction: "blocked",
          text: `Run ${runId} lost its tool recovery context and needs manual review.`
        };
      }

      if (
        checkpoint.pendingActionFingerprint !== undefined &&
        fingerprintToolCall(pendingAction.action.toolCall) !== checkpoint.pendingActionFingerprint
      ) {
        appendRunEvent(
          eventStore,
          run.runId,
          "recovery.rejected",
          { runId, checkpointId: checkpoint.checkpointId, reason: "pending_action_fingerprint_mismatch" },
          now()
        );
        throw new Error(`Run ${runId} tool action no longer matches the latest checkpoint.`);
      }

      const events = eventStore.listEventsByRun(runId);
      const checkpointCreatedEvent = events.find(
        (event) => event.type === "checkpoint.created" && event.payload.checkpointId === checkpoint.checkpointId
      );
      const toolStartedSeenAfterCheckpoint =
        checkpointCreatedEvent !== undefined &&
        events.some(
          (event) =>
            event.sequence > checkpointCreatedEvent.sequence &&
            (event.type === "tool.started" || event.type === "command.started")
        );

      if (checkpoint.phase === "pre_tool") {
        if (pendingAction.action.toolCall.toolName === "filesystem.patch") {
          const workspaceRoot = requireWorkspaceRoot();
          const currentFileHash = await readWorkspaceFileHash(workspaceRoot, pendingAction.action.toolCall.input.path);
          if (currentFileHash === null) {
            const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
            runStore.updateRun(blockedRun);
            appendRunEvent(
              eventStore,
              run.runId,
              "recovery.decision",
                {
                  action: "blocked",
                  checkpointId: checkpoint.checkpointId,
                  waitingFor: "manual_intervention",
                  previousStatus: run.status,
                  reason: "workspace_target_missing_before_patch_resume"
                },
                now()
              );
            return {
              runId: blockedRun.runId,
              status: blockedRun.status,
              checkpointId: checkpoint.checkpointId,
              recoveryAction: "blocked",
              text: `Run ${runId} target file is missing after checkpoint and patch resume needs manual review.`
            };
          }
          if (currentFileHash !== pendingAction.action.toolCall.input.expectedHash) {
            pendingActionStore.updatePendingAction({
              ...pendingAction,
              status: "cancelled",
              updatedAt: now()
            });

            appendRunEvent(
              eventStore,
              run.runId,
              "recovery.decision",
              {
                action: "replan",
                checkpointId: checkpoint.checkpointId,
                waitingFor: "tool_execution",
                previousStatus: run.status,
                reason: "workspace_changed_before_patch_resume"
              },
              now()
            );

            const artifactRoot = resolveArtifactRoot(databasePath);
            const task = requireTask(taskStore, run.taskId);
            const ledger = requireLedger(ledgerStore.getByRun(run.runId), run.runId);
            const replanningResumeState = {
              ...pendingAction.resumeState,
              regroundRequested: true,
              replanRequested: true
            };
            const modelProvider = createCliModelProvider({ agentActionSliceFrom: replanningResumeState.usage.modelCalls });
            const toolRuntime = new ToolRuntime({
              registry: createDefaultToolRegistry(),
              executionRecordStore,
              artifactStore
            });

            const result = await runAgentLoop({
              task,
              run,
              now,
              idGenerator: randomUUID,
              workspaceRoot,
              artifactRoot,
              modelProvider,
              toolRuntime,
              runStore,
              eventStore,
              artifactStore,
              validationResultStore,
              ledgerStore,
              agentIterationStore,
              approvalStore,
              pendingActionStore,
              userInputStore,
              checkpointStore,
              resume: {
                ledger,
                resumeState: replanningResumeState
              }
            });

            return {
              ...renderAgentLoopResult(result),
              checkpointId: checkpoint.checkpointId,
              recoveryAction: "replan"
            };
          }
        }

        if (pendingAction.action.toolCall.toolName === "filesystem.write") {
          const workspaceRoot = requireWorkspaceRoot();
          const currentFileHash = await readWorkspaceFileHash(workspaceRoot, pendingAction.action.toolCall.input.path);
          const writeMode = pendingAction.action.toolCall.input.mode;
          const expectedHash = pendingAction.action.toolCall.input.expectedHash ?? null;
          const shouldReplan =
            writeMode === "create"
              ? currentFileHash !== null
              : currentFileHash === null || expectedHash === null || currentFileHash !== expectedHash;

          if (shouldReplan) {
            pendingActionStore.updatePendingAction({
              ...pendingAction,
              status: "cancelled",
              updatedAt: now()
            });

            appendRunEvent(
              eventStore,
              run.runId,
              "recovery.decision",
              {
                action: "replan",
                checkpointId: checkpoint.checkpointId,
                waitingFor: "tool_execution",
                previousStatus: run.status,
                reason: "workspace_changed_before_write_resume"
              },
              now()
            );

            const artifactRoot = resolveArtifactRoot(databasePath);
            const task = requireTask(taskStore, run.taskId);
            const ledger = requireLedger(ledgerStore.getByRun(run.runId), run.runId);
            const replanningResumeState = {
              ...pendingAction.resumeState,
              regroundRequested: true,
              replanRequested: true
            };
            const modelProvider = createCliModelProvider({ agentActionSliceFrom: replanningResumeState.usage.modelCalls });
            const toolRuntime = new ToolRuntime({
              registry: createDefaultToolRegistry(),
              executionRecordStore,
              artifactStore
            });

            const result = await runAgentLoop({
              task,
              run,
              now,
              idGenerator: randomUUID,
              workspaceRoot,
              artifactRoot,
              modelProvider,
              toolRuntime,
              runStore,
              eventStore,
              artifactStore,
              validationResultStore,
              ledgerStore,
              agentIterationStore,
              approvalStore,
              pendingActionStore,
              userInputStore,
              checkpointStore,
              resume: {
                ledger,
                resumeState: replanningResumeState
              }
            });

            return {
              ...renderAgentLoopResult(result),
              checkpointId: checkpoint.checkpointId,
              recoveryAction: "replan"
            };
          }
        }

        if (toolStartedSeenAfterCheckpoint && pendingAction.action.toolCall.toolName !== "filesystem.read") {
          const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
          runStore.updateRun(blockedRun);
          appendRunEvent(
            eventStore,
            run.runId,
            "recovery.decision",
            {
              action: "blocked",
              checkpointId: checkpoint.checkpointId,
              waitingFor: "manual_intervention",
              previousStatus: run.status,
              reason: "tool_started_state_unknown"
            },
            now()
          );
          return {
            runId: blockedRun.runId,
            status: blockedRun.status,
            checkpointId: checkpoint.checkpointId,
            recoveryAction: "blocked",
            text: `Run ${runId} was interrupted after ${pendingAction.action.toolCall.toolName} started and needs manual review.`
          };
        }

        appendRunEvent(
          eventStore,
          run.runId,
          "recovery.decision",
          { action: "resume", checkpointId: checkpoint.checkpointId, waitingFor: "tool_execution" },
          now()
        );

        const workspaceRoot = requireWorkspaceRoot();
        const artifactRoot = resolveArtifactRoot(databasePath);
        const task = requireTask(taskStore, run.taskId);
        const ledger = requireLedger(ledgerStore.getByRun(run.runId), run.runId);
        const modelProvider = createCliModelProvider({ agentActionSliceFrom: pendingAction.resumeState.usage.modelCalls });
        const toolRuntime = new ToolRuntime({
          registry: createDefaultToolRegistry(),
          executionRecordStore,
          artifactStore
        });

        const result = await runAgentLoop({
          task,
          run,
          now,
          idGenerator: randomUUID,
          workspaceRoot,
          artifactRoot,
          modelProvider,
          toolRuntime,
          runStore,
          eventStore,
          artifactStore,
          validationResultStore,
          ledgerStore,
          agentIterationStore,
          approvalStore,
          pendingActionStore,
          userInputStore,
          checkpointStore,
          resume: {
            ledger,
            resumeState: pendingAction.resumeState,
            seedAction: pendingAction.action
          }
        });

        return {
          ...renderAgentLoopResult(result),
          checkpointId: checkpoint.checkpointId,
          recoveryAction: "resume"
        };
      }

      if (checkpoint.phase === "post_tool" || checkpoint.phase === "post_patch" || checkpoint.phase === "post_write") {
        if (pendingAction.action.toolCall.toolName === "shell.execute") {
          const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
          runStore.updateRun(blockedRun);
          appendRunEvent(
            eventStore,
            run.runId,
            "recovery.decision",
            {
              action: "blocked",
              checkpointId: checkpoint.checkpointId,
              waitingFor: "manual_intervention",
              previousStatus: run.status,
              reason: "post_tool_shell_requires_review"
            },
            now()
          );
          return {
            runId: blockedRun.runId,
            status: blockedRun.status,
            checkpointId: checkpoint.checkpointId,
            recoveryAction: "blocked",
            text: `Run ${runId} was interrupted after shell.execute completed and needs manual review.`
          };
        }

        const executionRecord = executionRecordStore
          .listByRun(runId)
          .slice()
          .reverse()
          .find((record) => record.toolCallId === pendingAction.actionId && record.status === "success");
        if (executionRecord === undefined) {
          const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
          runStore.updateRun(blockedRun);
          appendRunEvent(
            eventStore,
            run.runId,
            "recovery.decision",
            {
              action: "blocked",
              checkpointId: checkpoint.checkpointId,
              waitingFor: "manual_intervention",
              previousStatus: run.status,
              reason: "post_tool_execution_missing"
            },
            now()
          );
          return {
            runId: blockedRun.runId,
            status: blockedRun.status,
            checkpointId: checkpoint.checkpointId,
            recoveryAction: "blocked",
            text: `Run ${runId} has no successful execution record for post-tool recovery.`
          };
        }

        const task = requireTask(taskStore, run.taskId);
        const ledger = requireLedger(ledgerStore.getByRun(run.runId), run.runId);
        const recoveredToolResult = ToolResultSchema.parse(JSON.parse(executionRecord.outputJson) as unknown);
        const artifactRefs = collectArtifactRefs(recoveredToolResult);
        const reconciledLedger = reconcileLedgerAfterRecoveredTool({
          ledger,
          toolName: recoveredToolResult.toolName,
          artifactRefs,
          now: now()
        });
        if (reconciledLedger.version !== ledger.version) {
          ledgerStore.upsertLedger(reconciledLedger);
        }
        const reconciledResumeState = {
          ...pendingAction.resumeState,
          usage: {
            ...pendingAction.resumeState.usage,
            toolCalls: pendingAction.resumeState.usage.toolCalls + 1
          },
          changedFiles:
            recoveredToolResult.status === "success" &&
            (recoveredToolResult.toolName === "filesystem.patch" || recoveredToolResult.toolName === "filesystem.write")
              ? [
                  ...new Set([
                    ...pendingAction.resumeState.changedFiles,
                    recoveredToolResult.output.result.path
                  ])
                ]
              : pendingAction.resumeState.changedFiles,
          recentToolResult: recoveredToolResult,
          recentValidationResult:
            recoveredToolResult.status === "success" &&
            (recoveredToolResult.toolName === "filesystem.patch" || recoveredToolResult.toolName === "filesystem.write")
              ? null
              : pendingAction.resumeState.recentValidationResult,
          currentWorkingSet:
            recoveredToolResult.toolName === "filesystem.search" && recoveredToolResult.status === "success"
              ? recoveredToolResult.output.workingSet
              : pendingAction.resumeState.currentWorkingSet
        };

        if (recoveredToolResult.status === "success" && recoveredToolResult.toolName === "filesystem.patch") {
          appendRunEvent(
            eventStore,
            run.runId,
            "patch.applied",
            {
              path: recoveredToolResult.output.result.path,
              status: recoveredToolResult.output.result.status,
              changed: recoveredToolResult.output.result.changed
            },
            now()
          );
        }
        if (recoveredToolResult.status === "success" && recoveredToolResult.toolName === "filesystem.write") {
          appendRunEvent(
            eventStore,
            run.runId,
            "patch.applied",
            {
              path: recoveredToolResult.output.result.path,
              status: recoveredToolResult.output.result.mode,
              changed: true
            },
            now()
          );
        }

        appendRunEvent(
          eventStore,
          run.runId,
          "recovery.reconciled",
          {
            checkpointId: checkpoint.checkpointId,
            toolCallId: executionRecord.toolCallId,
            toolName: executionRecord.toolName
          },
          now()
        );
        appendRunEvent(
          eventStore,
          run.runId,
          "recovery.decision",
          { action: "resume", checkpointId: checkpoint.checkpointId, waitingFor: "tool_execution" },
          now()
        );

        const workspaceRoot = requireWorkspaceRoot();
        const artifactRoot = resolveArtifactRoot(databasePath);
        const modelProvider = createCliModelProvider({ agentActionSliceFrom: reconciledResumeState.usage.modelCalls });
        const toolRuntime = new ToolRuntime({
          registry: createDefaultToolRegistry(),
          executionRecordStore,
          artifactStore
        });

        const result = await runAgentLoop({
          task,
          run,
          now,
          idGenerator: randomUUID,
          workspaceRoot,
          artifactRoot,
          modelProvider,
          toolRuntime,
          runStore,
          eventStore,
          artifactStore,
          validationResultStore,
          ledgerStore,
          agentIterationStore,
          approvalStore,
          pendingActionStore,
          userInputStore,
          checkpointStore,
          resume: {
            ledger: reconciledLedger,
            resumeState: reconciledResumeState
          }
        });

        return {
          ...renderAgentLoopResult(result),
          checkpointId: checkpoint.checkpointId,
          recoveryAction: "resume"
        };
      }
    }

    if (run.status === "running" && checkpoint.phase === "recovery_state" && checkpoint.recovery !== undefined) {
      const task = requireTask(taskStore, run.taskId);
      const ledger = requireLedger(ledgerStore.getByRun(run.runId), run.runId);
      const workspaceRoot = requireWorkspaceRoot();
      const artifactRoot = resolveArtifactRoot(databasePath);
      const baseResumeState = pendingAction?.resumeState ?? {
        usage: {
          loopCount: 0,
          modelCalls: 0,
          toolCalls: 0,
          retryCount: 0,
          actionRepairCount: 0,
          providerRetryCount: 0,
          startedAt: now()
        },
        nextSequence: eventStore.listEventsByRun(run.runId).length + 1,
        currentWorkingSet: null,
        changedFiles: [],
        recentToolResult: null,
        recentValidationResult: null,
        latestIterationIndex: 0,
        regroundRequested: false,
        replanRequested: false,
        noProgressCount: 0,
        pendingRetryIncrement: false,
        previousSnapshot: {
          actionSignature: null,
          errorCode: null,
          ledgerVersion: ledger.version,
          evidenceCount: ledger.evidenceRefs.length,
          validationStatus: null,
          artifactHash: null
        },
        finalizationPlanRejectionCount: 0,
        validationRepairActionRejectionCount: 0
      };
      const resumeState = {
        ...baseResumeState,
        nextSequence: Math.max(baseResumeState.nextSequence, eventStore.listEventsByRun(run.runId).length + 1),
        latestIterationIndex: Math.max(
          baseResumeState.latestIterationIndex,
          agentIterationStore.listByRun(run.runId).length
        ),
        regroundRequested: checkpoint.recovery.latestDecision?.disposition === "re_ground",
        replanRequested: checkpoint.recovery.latestDecision?.disposition === "replan",
        recoveryState: checkpoint.recovery
      };
      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.decision",
        {
          action: "resume",
          checkpointId: checkpoint.checkpointId,
          waitingFor: "recovery_state",
          disposition: checkpoint.recovery.latestDecision?.disposition ?? null
        },
        now()
      );
      const modelProvider = createCliModelProvider({ agentActionSliceFrom: resumeState.usage.modelCalls });
      const toolRuntime = new ToolRuntime({
        registry: createDefaultToolRegistry(),
        executionRecordStore,
        artifactStore
      });
      const result = await runAgentLoop({
        task,
        run,
        now,
        idGenerator: randomUUID,
        workspaceRoot,
        artifactRoot,
        modelProvider,
        toolRuntime,
        runStore,
        eventStore,
        artifactStore,
        validationResultStore,
        ledgerStore,
        agentIterationStore,
        approvalStore,
        pendingActionStore,
        userInputStore,
        checkpointStore,
        resume: {
          ledger,
          resumeState
        }
      });
      return {
        ...renderAgentLoopResult(result),
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "resume"
      };
    }

    if (run.status === "running" || run.status === "waiting_for_tool" || run.status === "verifying") {
      const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
      runStore.updateRun(blockedRun);
      appendRunEvent(
        eventStore,
        run.runId,
        "recovery.decision",
        {
          action: "blocked",
          checkpointId: checkpoint.checkpointId,
          waitingFor: "manual_intervention",
          previousStatus: run.status
        },
        now()
      );
      return {
        runId: blockedRun.runId,
        status: blockedRun.status,
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "blocked",
        text: `Run ${runId} was interrupted in ${run.status} and needs manual review before continuing.`
      };
    }

    appendRunEvent(
      eventStore,
      run.runId,
      "recovery.rejected",
      { runId, checkpointId: checkpoint.checkpointId, reason: "unsupported_state", status: run.status },
      now()
    );
    throw new Error(`Run ${runId} in status ${run.status} is not recoverable by explicit resume yet.`);
  } finally {
    database.close();
  }
}

async function runApproveCommand(command: {
  approvalId: string;
  scope: ApprovalScope;
  reason?: string;
}): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const workspaceRoot = requireWorkspaceRoot();
  const artifactRoot = resolveArtifactRoot(databasePath);
  const database = openDatabase(databasePath);
  const now = () => new Date().toISOString();
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);
  const ledgerStore = new LedgerStore(database);
  const agentIterationStore = new AgentIterationStore(database);
  const approvalStore = new ApprovalStore(database);
  const pendingActionStore = new PendingActionStore(database);
  const userInputStore = new UserInputStore(database);
  const checkpointStore = new CheckpointStore(database);
  const taskStore = new TaskStore(database);

  try {
    const approval = approvalStore.getApproval(command.approvalId);
    if (approval === null) {
      throw new Error(`Approval ${command.approvalId} was not found.`);
    }

    const run = requireRun(runStore, approval.request.runId);
    if (run.status === "cancelled") {
      throw new Error(`Run ${run.runId} was cancelled and cannot be approved.`);
    }
    if (approval.request.status === "cancelled") {
      throw new Error(`Approval ${command.approvalId} was cancelled and cannot be approved.`);
    }
    const task = requireTask(taskStore, run.taskId);
    const pendingAction = requirePendingAction(pendingActionStore.getPendingActionByApprovalId(command.approvalId), command.approvalId);
    if (pendingAction.runId !== approval.request.runId) {
      throw new Error("Approval does not match the pending action run.");
    }
    if (pendingAction.actionId !== approval.request.actionId) {
      throw new Error("Approval does not match the pending action.");
    }
    if (pendingAction.action.type !== "tool_call") {
      throw new Error("Approval can only resume a tool_call action.");
    }
    if (fingerprintToolCall(pendingAction.action.toolCall) !== approval.actionFingerprint) {
      throw new Error("Pending action no longer matches the approved tool call.");
    }

    if (approval.request.status === "pending" && new Date(approval.request.expiresAt).getTime() <= new Date(now()).getTime()) {
      approvalStore.updateApproval({
        request: {
          ...approval.request,
          status: "expired"
        },
        decision: approval.decision,
        updatedAt: now()
      });
      appendRunEvent(eventStore, run.runId, "approval.expired", { approvalId: command.approvalId }, now());
      throw new Error(`Approval ${command.approvalId} has expired.`);
    }

    if (approval.request.status === "approved" && approval.decision?.decision === "approved") {
      return {
        runId: run.runId,
        status: run.status,
        approvalId: approval.request.approvalId,
        text: "Approval already granted."
      };
    }

    const decision: ApprovalDecision = {
      approvalId: approval.request.approvalId,
      runId: approval.request.runId,
      decision: "approved",
      scope: command.scope,
      decidedAt: now(),
      ...(command.reason === undefined ? {} : { optionalReason: command.reason })
    };

    approvalStore.updateApproval({
      request: {
        ...approval.request,
        status: "approved"
      },
      decision,
      updatedAt: now()
    });
    appendRunEvent(eventStore, run.runId, "approval.approved", { approvalId: command.approvalId, scope: command.scope }, now());

    pendingActionStore.updatePendingAction({
      ...pendingAction,
      status: "resolved",
      updatedAt: now()
    });
    persistCheckpointForRun({
      checkpointStore,
      ledgerStore,
      run,
      phase: "post_approval",
      pendingAction,
      now: now()
    });

    const ledger = requireLedger(ledgerStore.getByRun(run.runId), run.runId);
    const modelProvider = createCliModelProvider({ agentActionSliceFrom: pendingAction.resumeState.usage.modelCalls });
    const toolRuntime = new ToolRuntime({
      registry: createDefaultToolRegistry(),
      executionRecordStore,
      artifactStore
    });

    const result = await runAgentLoop({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot,
      artifactRoot,
      modelProvider,
      toolRuntime,
      runStore,
      eventStore,
      artifactStore,
      validationResultStore,
      ledgerStore,
      agentIterationStore,
      approvalStore,
      pendingActionStore,
      userInputStore,
      checkpointStore,
      resume: {
        ledger,
        resumeState: pendingAction.resumeState,
        seedAction: pendingAction.action,
        bypassApprovalForSeedAction: true
      }
    });

    return renderAgentLoopResult(result);
  } finally {
    database.close();
  }
}

function collectArtifactRefs(toolResult: ToolResult): string[] {
  if (toolResult.status !== "success") {
    return [];
  }

  if (toolResult.toolName === "filesystem.read") {
    return toolResult.output.kind === "artifact_ref" ? [toolResult.output.artifactId] : [];
  }

  if (toolResult.toolName === "filesystem.search") {
    return toolResult.output.kind === "search_artifact_ref" ? [toolResult.output.artifactId] : [];
  }

  if (toolResult.toolName === "filesystem.patch") {
    return [toolResult.output.result.diffArtifactRef];
  }

  if (toolResult.toolName === "shell.execute") {
    return [toolResult.output.result.stdoutArtifactRef, toolResult.output.result.stderrArtifactRef].filter(
      (value): value is string => value !== undefined
    );
  }

  if (toolResult.toolName === "git.diff") {
    return toolResult.output.kind === "diff_artifact_ref" ? [toolResult.output.artifactId] : [];
  }

  if (toolResult.toolName === "git.show") {
    return toolResult.output.kind === "show_artifact_ref" ? [toolResult.output.artifactId] : [];
  }

  if (toolResult.toolName === "filesystem.list") {
    return toolResult.output.kind === "list_artifact_ref" ? [toolResult.output.artifactId] : [];
  }

  if (toolResult.toolName === "project.inspect") {
    return toolResult.output.kind === "inspect_artifact_ref" ? [toolResult.output.artifactId] : [];
  }

  return [];
}

function reconcileLedgerAfterRecoveredTool(input: {
  ledger: ProgressLedger;
  toolName: ToolResult["toolName"];
  artifactRefs: string[];
  now: string;
}): ProgressLedger {
  const matchingSteps = input.ledger.planSteps.filter(
    (step) => step.status !== "completed" && stepMatchesRecoveredTool(step.description, input.toolName)
  );
  if (matchingSteps.length === 0 && input.artifactRefs.length === 0) {
    return input.ledger;
  }

  const matchingStepIds = new Set(matchingSteps.map((step) => step.stepId));
  const planSteps = input.ledger.planSteps.map((step) =>
    matchingStepIds.has(step.stepId)
      ? {
          ...step,
          status: "completed" as const,
          evidenceRefs: [...new Set([...step.evidenceRefs, ...input.artifactRefs])],
          updatedAt: input.now
        }
      : step
  );
  const completedSteps = [...new Set([...input.ledger.completedSteps, ...matchingSteps.map((step) => step.description)])];
  const currentStep =
    input.ledger.currentStep !== null && matchingSteps.some((step) => step.description === input.ledger.currentStep)
      ? planSteps.find((step) => step.status !== "completed")?.description ?? null
      : input.ledger.currentStep;

  return {
    ...input.ledger,
    currentStep,
    completedSteps,
    planSteps,
    artifactRefs: [...new Set([...input.ledger.artifactRefs, ...input.artifactRefs])],
    version: input.ledger.version + 1,
    updatedAt: input.now
  };
}

function stepMatchesRecoveredTool(descriptionText: string, toolName: ToolResult["toolName"]): boolean {
  const description = descriptionText.toLowerCase();
  if (toolName === "filesystem.search") {
    return description.includes("search") || description.includes("find") || description.includes("locate");
  }
  if (toolName === "filesystem.read") {
    return description.includes("read") || description.includes("inspect");
  }
  if (toolName === "filesystem.patch") {
    return description.includes("patch") || description.includes("fix") || description.includes("modify");
  }
  if (toolName === "filesystem.write") {
    return description.includes("write") || description.includes("create") || description.includes("add file");
  }
  if (toolName === "shell.execute") {
    return (
      description.includes("verify") ||
      description.includes("verification") ||
      description.includes("validation") ||
      description.includes("build") ||
      description.includes("test") ||
      description.includes("run ") ||
      description.includes("acceptance") ||
      description.includes("reproduction")
    );
  }
  if (toolName === "project.inspect") {
    return description.includes("inspect") || description.includes("repository") || description.includes("understand");
  }
  if (toolName === "project.commands") {
    return description.includes("command");
  }
  if (toolName === "git.status") {
    return description.includes("git status") || description.includes("status");
  }
  if (toolName === "git.diff") {
    return description.includes("diff");
  }
  if (toolName === "git.show") {
    return description.includes("show");
  }
  return false;
}

async function readWorkspaceFileHash(workspaceRoot: string, relativePath: string): Promise<string | null> {
  try {
    const absolutePath = await resolveWorkspaceFilePath(workspaceRoot, relativePath);
    return computeArtifactHash(readFileSync(absolutePath, "utf8"));
  } catch {
    return null;
  }
}

function persistCheckpointForRun(input: {
  checkpointStore: CheckpointStore;
  ledgerStore: LedgerStore;
  run: { runId: string; stateVersion: number };
  phase: CheckpointPhase;
  pendingAction?: PendingAction;
  now: string;
}): void {
  const ledgerVersion = input.ledgerStore.getByRun(input.run.runId)?.version ?? 0;
  input.checkpointStore.insertCheckpoint(
    createCheckpoint({
      checkpointId: randomUUID(),
      runId: input.run.runId,
      runStateVersion: input.run.stateVersion,
      ledgerVersion,
      phase: input.phase,
      ...(input.pendingAction === undefined ? {} : { pendingActionId: input.pendingAction.pendingActionId }),
      createdAt: input.now
    })
  );
}

async function runDenyCommand(command: {
  approvalId: string;
  reason?: string;
}): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const database = openDatabase(databasePath);
  const now = () => new Date().toISOString();
  try {
    const runStore = new RunStore(database);
    const approvalStore = new ApprovalStore(database);
    const pendingActionStore = new PendingActionStore(database);
    const eventStore = new EventStore(database);

    const approval = approvalStore.getApproval(command.approvalId);
    if (approval === null) {
      throw new Error(`Approval ${command.approvalId} was not found.`);
    }

    const run = requireRun(runStore, approval.request.runId);
    if (run.status === "cancelled") {
      throw new Error(`Run ${run.runId} was cancelled and cannot be denied.`);
    }
    if (approval.request.status === "cancelled") {
      throw new Error(`Approval ${command.approvalId} was cancelled and cannot be denied.`);
    }
    if (approval.request.status === "denied" && approval.decision?.decision === "denied") {
      return {
        runId: run.runId,
        status: run.status,
        approvalId: approval.request.approvalId,
        text: "Approval already denied."
      };
    }

    const decision: ApprovalDecision = {
      approvalId: approval.request.approvalId,
      runId: approval.request.runId,
      decision: "denied",
      scope: "once",
      decidedAt: now(),
      ...(command.reason === undefined ? {} : { optionalReason: command.reason })
    };

    approvalStore.updateApproval({
      request: {
        ...approval.request,
        status: "denied"
      },
      decision,
      updatedAt: now()
    });
    appendRunEvent(eventStore, run.runId, "approval.denied", { approvalId: command.approvalId }, now());

    const pendingAction = pendingActionStore.getPendingActionByApprovalId(command.approvalId);
    if (pendingAction !== null && pendingAction.status === "pending") {
      pendingActionStore.updatePendingAction({
        ...pendingAction,
        status: "cancelled",
        updatedAt: now()
      });
    }

    const failedRun = transitionRun(run, "failed", now(), "APPROVAL_DENIED");
    runStore.updateRun(failedRun);
    appendRunEvent(eventStore, run.runId, "run.failed", { code: "APPROVAL_DENIED", message: "Approval was denied." }, now());

    return {
      runId: failedRun.runId,
      status: failedRun.status,
      approvalId: approval.request.approvalId,
      text: "Approval denied."
    };
  } finally {
    database.close();
  }
}

async function runRespondCommand(command: {
  requestId: string;
  value: string;
}): Promise<unknown> {
  const databasePath = requireDatabasePath();
  const workspaceRoot = requireWorkspaceRoot();
  const artifactRoot = resolveArtifactRoot(databasePath);
  const database = openDatabase(databasePath);
  const now = () => new Date().toISOString();
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);
  const ledgerStore = new LedgerStore(database);
  const agentIterationStore = new AgentIterationStore(database);
  const approvalStore = new ApprovalStore(database);
  const pendingActionStore = new PendingActionStore(database);
  const userInputStore = new UserInputStore(database);
  const checkpointStore = new CheckpointStore(database);
  const taskStore = new TaskStore(database);

  try {
    const requestEntry = userInputStore.getRequest(command.requestId);
    if (requestEntry === null) {
      throw new Error(`Request ${command.requestId} was not found.`);
    }

    const run = requireRun(runStore, requestEntry.request.runId);
    if (run.status === "cancelled") {
      throw new Error(`Run ${run.runId} was cancelled and cannot accept responses.`);
    }
    if (requestEntry.request.status === "cancelled") {
      throw new Error(`Request ${command.requestId} was cancelled and cannot be answered.`);
    }
    const task = requireTask(taskStore, run.taskId);
    const pendingAction = requirePendingAction(pendingActionStore.getPendingActionByRequestId(command.requestId), command.requestId);
    const ledger = requireLedger(ledgerStore.getByRun(run.runId), run.runId);
    if (pendingAction.runId !== requestEntry.request.runId || pendingAction.requestId !== requestEntry.request.requestId) {
      throw new Error("User input request does not match the pending action.");
    }

    if (requestEntry.request.status === "answered" && requestEntry.response?.value === command.value) {
      return {
        runId: run.runId,
        status: run.status,
        requestId: requestEntry.request.requestId,
        text: "Response already recorded."
      };
    }

    userInputStore.updateRequest({
      request: {
        ...requestEntry.request,
        status: "answered"
      },
      response: {
        requestId: requestEntry.request.requestId,
        runId: requestEntry.request.runId,
        value: command.value,
        submittedAt: now()
      },
      updatedAt: now()
    });
    appendRunEvent(eventStore, run.runId, "user_input.received", { requestId: command.requestId, value: command.value }, now());

    pendingActionStore.updatePendingAction({
      ...pendingAction,
      status: "resolved",
      updatedAt: now()
    });
    persistCheckpointForRun({
      checkpointStore,
      ledgerStore,
      run,
      phase: "post_response",
      pendingAction,
      now: now()
    });

    const resumedLedger: ProgressLedger = {
      ...ledger,
      decisions: [...new Set([...ledger.decisions, `User input: ${requestEntry.request.question} -> ${command.value}`])],
      version: ledger.version + 1,
      updatedAt: now()
    };
    ledgerStore.upsertLedger(resumedLedger);

    const modelProvider = createCliModelProvider({ agentActionSliceFrom: pendingAction.resumeState.usage.modelCalls });
    const toolRuntime = new ToolRuntime({
      registry: createDefaultToolRegistry(),
      executionRecordStore,
      artifactStore
    });

    const result = await runAgentLoop({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot,
      artifactRoot,
      modelProvider,
      toolRuntime,
      runStore,
      eventStore,
      artifactStore,
      validationResultStore,
      ledgerStore,
      agentIterationStore,
      approvalStore,
      pendingActionStore,
      userInputStore,
      checkpointStore,
      resume: {
        ledger: resumedLedger,
        resumeState: pendingAction.resumeState
      }
    });

    return renderAgentLoopResult(result);
  } finally {
    database.close();
  }
}

function renderAgentLoopResult(result: Awaited<ReturnType<typeof runAgentLoop>>): {
  runId: string;
  status: string;
  text: string;
  approvalId?: string;
  requestId?: string;
} {
  if (result.kind === "completed") {
    return {
      runId: result.run.runId,
      status: result.run.status,
      text: result.artifact.content
    };
  }

  if (result.kind === "waiting_for_approval") {
    return {
      runId: result.run.runId,
      status: result.run.status,
      approvalId: result.approval.approvalId,
      text: result.approval.actionSummary
    };
  }

  return {
    runId: result.run.runId,
    status: result.run.status,
    requestId: result.request.requestId,
    text: result.request.question
  };
}

function appendRunEvent(
  eventStore: EventStore,
  runId: string,
  type: ReturnType<typeof createEvent>["type"],
  payload: Record<string, unknown>,
  timestamp: string
): void {
  const sequence = eventStore.listEventsByRun(runId).length + 1;
  eventStore.appendEvent(
    createEvent({
      eventId: randomUUID(),
      runId,
      sequence,
      type,
      timestamp,
      payload
    })
  );
}

function requireDatabasePath(): string {
  const databasePath = process.env.NEXORA_DB_PATH;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error("NEXORA_DB_PATH is required.");
  }

  return databasePath;
}

function requireWorkspaceRoot(): string {
  const workspaceRoot = process.env.NEXORA_WORKSPACE_ROOT;
  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new Error("NEXORA_WORKSPACE_ROOT is required.");
  }

  return workspaceRoot;
}

function resolveArtifactRoot(databasePath: string): string {
  return process.env.NEXORA_ARTIFACT_ROOT?.trim().length ? process.env.NEXORA_ARTIFACT_ROOT : join(dirname(databasePath), "artifacts");
}

function parseTaskTypeEnv(value: string | undefined, fallback: TaskType): TaskType {
  const normalized = value?.trim();
  if (
    normalized === "read_only" ||
    normalized === "analysis" ||
    normalized === "workspace_mutation" ||
    normalized === "bug_fix" ||
    normalized === "feature"
  ) {
    return normalized;
  }

  return fallback;
}

function parseAcceptanceCriteriaEnv(value: string | undefined): TaskAcceptanceCriterion[] {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return [];
  }

  return JSON.parse(normalized) as TaskAcceptanceCriterion[];
}

function parseExecutionConstraintsEnv(value: string | undefined): TaskExecutionConstraints | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }

  return JSON.parse(normalized) as TaskExecutionConstraints;
}

function requireRun(runStore: RunStore, runId: string) {
  const run = runStore.getRun(runId);
  if (run === null) {
    throw new Error(`Run ${runId} was not found.`);
  }

  return run;
}

function requireTask(taskStore: TaskStore, taskId: string) {
  const task = taskStore.getTask(taskId);
  if (task === null) {
    throw new Error(`Task ${taskId} was not found.`);
  }

  return task;
}

function requirePendingAction(pendingAction: PendingAction | null, id: string): PendingAction {
  if (pendingAction === null) {
    throw new Error(`Pending action for ${id} was not found.`);
  }

  return pendingAction;
}

function requireLedger(ledger: ProgressLedger | null, runId: string): ProgressLedger {
  if (ledger === null) {
    throw new Error(`Ledger for run ${runId} was not found.`);
  }

  return ledger;
}

const exitCode = await main();
process.exitCode = exitCode;
