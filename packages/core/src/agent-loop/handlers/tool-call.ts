import type {
  AgentAction,
  Artifact,
  ProgressLedger,
  Run,
  ToolCall,
  ToolResult,
  ValidationResult
} from "../../../../contracts/src/index.js";
import type { NoProgressSnapshot } from "../../recovery/resume-boundary.js";
import { applyLedgerPatch, completePlanStepFromTool } from "../../ledger-progress/index.js";
import { appendChangedFile, appendFailedAttempt, createIteration } from "../iteration.js";
import { applyBuilderToolEvidence } from "../../builder/index.js";
import { afterActionStrategy } from "../../strategy/index.js";
import {
  createProgressFingerprint,
  normalizeToolFailure,
  normalizeValidationFailure
} from "../../recovery/index.js";
import { runCommandValidation } from "../../validation-repair/index.js";
import { transitionRun } from "../../state-machine.js";
import { ensureBudget } from "../budget.js";
import { detectNoProgress, handleNoProgress } from "../no-progress.js";
import { describeToolSuccess } from "../tool-description.js";
import {
  describeResourceScope,
  fingerprintAction,
  isCriticalAction
} from "../fingerprint.js";
import { buildToolFailureRejection } from "../model-action-error.js";
import { reGroundNow } from "../context-snapshot.js";
import { createPendingAction } from "../../recovery/resume-boundary.js";
import { serializeResumeState } from "../state.js";
import { classifyRisk } from "../../../../tool-runtime/src/index.js";
import { handleApproval } from "./approval.js";
import type { HandlerDeps, HandlerOutcome } from "../outcome.js";
import type { AgentLoopState } from "../state.js";

type ExecutionResult = {
  toolResult: ToolResult;
  executionRecord: { executionId: string };
  artifacts?: Artifact[] | undefined;
};

type ToolExecState = {
  toolCall: ToolCall;
  actionFingerprint: string;
  toolPendingActionId: string;
  execution: ExecutionResult;
  activeRun: Run;
  pendingRetryIncrement: boolean;
  strategyPreviousWorkingSet: AgentLoopState["currentWorkingSet"];
  strategyPreviousChangedFiles: string[];
  strategyPreviousValidationResult: ValidationResult | null;
  latestIterationIndex: number;
};

function buildSnapshot(
  actionSignature: string,
  ledger: ProgressLedger,
  recentValidationResult: ValidationResult | null,
  errorCode: string | null,
  artifactHash: string | null
): NoProgressSnapshot {
  return {
    actionSignature,
    errorCode,
    ledgerVersion: ledger.version,
    evidenceCount: ledger.evidenceRefs.length,
    validationStatus: recentValidationResult?.status ?? null,
    artifactHash
  };
}

/**
 * handleToolCall — the tool_call / request_approval branch: critical-action
 * gate, approval gate (delegates to handleApproval), budget check, pending
 * action + checkpoints, tool execution, then either error recovery or
 * success processing (validation, strategy after-action, no-progress).
 */
export async function handleToolCall(
  state: AgentLoopState, deps: HandlerDeps,
  action: Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
  bypassApproval: boolean,
  strategyBypassedForRecovery: boolean
): Promise<HandlerOutcome> {
  const toolCall = action.toolCall;
  if (isCriticalAction(toolCall)) {
    return {
      kind: "fail",
      code: "COMMAND_REJECTED",
      message: "Critical actions are rejected and cannot be approved in F007.",
      retryable: false
    };
  }

  const risk = classifyRisk(toolCall.toolName);
  const actionFingerprint = fingerprintAction(toolCall);
  const resourceScope = describeResourceScope(toolCall);
  const requiresApproval = risk === "write" || risk === "execute";

  if (requiresApproval && !bypassApproval) {
    const reusableGrant = deps.input.approvalStore.findReusableGrant({
      runId: state.activeRun.runId,
      actionFingerprint,
      resourceScope,
      now: deps.input.now()
    });
    if (reusableGrant === null) {
      const outcome = await handleApproval(
        {
          input: deps.input,
          run: state.activeRun,
          ledger: state.ledger,
          appendEvent: deps.appendEvent,
          checkpoint: deps.checkpoint,
          nextSequence: state.nextSequence,
          latestIterationIndex: state.latestIterationIndex,
          currentWorkingSet: state.currentWorkingSet,
          changedFiles: state.changedFiles,
          recentToolResult: state.recentToolResult,
          recentValidationResult: state.recentValidationResult,
          regroundRequested: state.regroundRequested,
          replanRequested: state.replanRequested,
          noProgressCount: state.noProgressCount,
          usage: state.usage,
          previousSnapshot: state.previousSnapshot,
          pendingRetryIncrement: state.pendingRetryIncrement,
          recoveryState: state.recoveryState,
          strategyState: state.strategyState,
          builderState: state.builderState,
          finalizationPlanRejectionCount: state.finalizationPlanRejectionCount,
          validationRepairActionRejectionCount: state.validationRepairActionRejectionCount
        },
        toolCall,
        action.type === "request_approval" ? action.reason : describeApprovalReasonFor(toolCall)
      );
      if (outcome.kind === "return") {
        return outcome;
      }
      return { kind: "continue" };
    }
  }

  await ensureBudget({
    appendEvent: deps.appendEvent,
    now: deps.input.now(),
    phase: "tool",
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    reserveVerification: false
  });

  let activeRun: Run = transitionRun(state.activeRun, "waiting_for_tool", deps.input.now());
  deps.input.runStore.updateRun(activeRun);
  Object.assign(state, { activeRun });
  const toolPendingAction = createPendingAction({
    pendingActionId: deps.input.idGenerator(),
    runId: activeRun.runId,
    actionId: toolCall.toolCallId,
    waitingFor: "tool_execution",
    action: {
      type: "tool_call",
      toolCall
    },
    resumeState: serializeResumeState({
      usage: state.usage,
      nextSequence: state.nextSequence + 1,
      currentWorkingSet: state.currentWorkingSet,
      changedFiles: state.changedFiles,
      recentToolResult: state.recentToolResult,
      recentValidationResult: state.recentValidationResult,
      latestIterationIndex: state.latestIterationIndex,
      regroundRequested: state.regroundRequested,
      replanRequested: state.replanRequested,
      noProgressCount: state.noProgressCount,
      previousSnapshot: state.previousSnapshot,
      pendingRetryIncrement: state.pendingRetryIncrement,
      recoveryState: state.recoveryState,
      strategyState: state.strategyState,
      builderState: state.builderState,
      finalizationPlanRejectionCount: state.finalizationPlanRejectionCount,
      validationRepairActionRejectionCount: state.validationRepairActionRejectionCount
    }),
    now: deps.input.now()
  });
  deps.input.pendingActionStore.insertPendingAction(toolPendingAction);
  await deps.checkpoint("pre_tool", {
    pendingActionId: toolPendingAction.pendingActionId,
    pendingActionFingerprint: actionFingerprint
  });
  if (toolCall.toolName === "filesystem.patch") {
    await deps.checkpoint("pre_patch", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  } else if (toolCall.toolName === "filesystem.write") {
    await deps.checkpoint("pre_write", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  }
  await deps.appendEvent(
    "tool.started",
    {
      toolName: toolCall.toolName,
      risk: classifyRisk(toolCall.toolName)
    },
    activeRun.updatedAt
  );
  if (toolCall.toolName === "shell.execute") {
    await deps.appendEvent(
      "command.started",
      {
        command: toolCall.input.command,
        args: toolCall.input.args,
        cwd: toolCall.input.cwd
      },
      activeRun.updatedAt
    );
  }

  const strategyPreviousWorkingSet = state.currentWorkingSet;
  const strategyPreviousChangedFiles = state.changedFiles;
  const strategyPreviousValidationResult = state.recentValidationResult;
  const execution = await deps.input.toolRuntime.execute({
    runId: activeRun.runId,
    toolCall,
    workspaceRoot: deps.input.workspaceRoot,
    artifactRoot: deps.input.artifactRoot,
    now: deps.input.now,
    idGenerator: deps.input.idGenerator
  });
  state.usage.toolCalls += 1;
  let pendingRetryIncrement = state.pendingRetryIncrement;
  if (pendingRetryIncrement) {
    state.usage.retryCount += 1;
    pendingRetryIncrement = false;
    Object.assign(state, { pendingRetryIncrement });
  }
  deps.input.pendingActionStore.updatePendingAction({
    ...toolPendingAction,
    status: "resolved",
    updatedAt: deps.input.now()
  });
  if (toolCall.toolName === "filesystem.patch") {
    await deps.checkpoint("post_patch", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  } else if (toolCall.toolName === "filesystem.write") {
    await deps.checkpoint("post_write", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  }
  await deps.checkpoint("post_tool", {
    pendingActionId: toolPendingAction.pendingActionId,
    pendingActionFingerprint: actionFingerprint
  });

  const execState: ToolExecState = {
    toolCall,
    actionFingerprint,
    toolPendingActionId: toolPendingAction.pendingActionId,
    execution: execution as ExecutionResult,
    activeRun,
    pendingRetryIncrement,
    strategyPreviousWorkingSet,
    strategyPreviousChangedFiles,
    strategyPreviousValidationResult,
    latestIterationIndex: state.latestIterationIndex
  };

  const toolResult = execution.toolResult;
  if (toolResult.status === "error") {
    return handleToolError(state, deps, action, execState, strategyBypassedForRecovery);
  }
  return processToolSuccess(state, deps, action, execState, strategyBypassedForRecovery);
}

function describeApprovalReasonFor(toolCall: ToolCall): string {
  // Local alias to avoid importing describeApprovalReason (kept in runner for the inline gate).
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return "Write access requires approval before mutating workspace files.";
  }
  return "Command execution requires approval before running a process.";
}

async function handleToolError(
  state: AgentLoopState, deps: HandlerDeps,
  action: Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
  execState: ToolExecState,
  _strategyBypassedForRecovery: boolean
): Promise<HandlerOutcome> {
  const { toolCall, actionFingerprint, toolPendingActionId, execution, pendingRetryIncrement } = execState;
  const toolResult = execution.toolResult as Extract<ToolResult, { status: "error" }>;
  let activeRun = execState.activeRun;
  let ledger = state.ledger;
  let previousSnapshot = state.previousSnapshot;
  let latestIterationIndex = execState.latestIterationIndex;
  let recoveryState = state.recoveryState;
  let noProgressCount = state.noProgressCount;
  let regroundRequested = state.regroundRequested;
  let replanRequested = state.replanRequested;
  let pendingActionRejection = state.pendingActionRejection;
  let currentPendingRetryIncrement = pendingRetryIncrement;

  if (toolCall.toolName === "shell.execute") {
    await deps.appendEvent(
      "command.failed",
      {
        command: toolCall.input.command,
        error: toolResult.error
      },
      deps.input.now()
    );
  }
  await deps.appendEvent("tool.failed", { error: toolResult.error }, deps.input.now());
  const toolFailureRejection = buildToolFailureRejection({
    toolCall,
    code: toolResult.error.code,
    message: toolResult.error.message
  });
  if (toolFailureRejection !== null) {
    pendingActionRejection = toolFailureRejection;
  }

  ledger = appendFailedAttempt({
    ledger,
    now: deps.input.now(),
    actionType: "tool_call",
    summary: toolResult.error.message,
    errorCode: toolResult.error.code,
    retryable: toolResult.error.retryable,
    evidenceRefs: []
  });
  await deps.persistLedger(ledger);

  const iteration = createIteration({
    iterationId: deps.input.idGenerator(),
    runId: activeRun.runId,
    index: latestIterationIndex,
    actionType: action.type,
    status: "failed",
    usage: state.usage,
    summary: toolResult.error.message,
    latestToolCallId: toolCall.toolCallId,
    latestExecutionRecordId: execution.executionRecord.executionId,
    evidenceRefs: [],
    now: deps.input.now()
  });
  deps.input.agentIterationStore.insertIteration(iteration);
  await deps.appendEvent("iteration.failed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  latestIterationIndex += 1;

  const resumedAt = deps.input.now();
  activeRun = transitionRun(activeRun, "running", resumedAt);
  deps.input.runStore.updateRun(activeRun);
  Object.assign(state, { activeRun });

  if (toolFailureRejection !== null && toolCall.toolName === "shell.execute") {
    await deps.checkpoint("post_tool", {
      pendingActionId: toolPendingActionId,
      pendingActionFingerprint: actionFingerprint,
      note: "tool_failure_action_repair"
    });
    previousSnapshot = buildSnapshot(deps.actionSignature, ledger, state.recentValidationResult, toolResult.error.code, null);
    Object.assign(state, {
      pendingActionRejection,
      latestIterationIndex,
      previousSnapshot,
      noProgressCount,
      regroundRequested,
      replanRequested,
      recoveryState
    });
    return { kind: "continue" };
  }

  const failure = normalizeToolFailure({
    failureId: deps.input.idGenerator(),
    runId: activeRun.runId,
    taskId: deps.input.task.taskId,
    iteration: latestIterationIndex,
    toolResult: toolResult,
    executionRecordId: execution.executionRecord.executionId,
    occurredAt: deps.input.now()
  });
  const progressFingerprint = createProgressFingerprint({
    ledgerVersion: ledger.version,
    evidenceRefs: ledger.evidenceRefs,
    changedFiles: state.changedFiles,
    validationStatus: state.recentValidationResult?.status ?? null,
    validationEvidenceCodes: state.recentValidationResult?.evidence.map((entry) => entry.code) ?? [],
    workingSetPaths: state.currentWorkingSet?.items.map((item) => item.path) ?? []
  });
  const recoveryOutcome = deps.recoveryOrchestrator.decide({
    failure,
    previousFailure: recoveryState?.latestFailure,
    previousState: recoveryState,
    progressFingerprint,
    previousProgressFingerprint: recoveryState?.progressFingerprint,
    ledger,
    workingSet: state.currentWorkingSet,
    recoveryBudget: deps.recoveryBudget,
    now: deps.input.now,
    idGenerator: deps.input.idGenerator
  });
  recoveryState = recoveryOutcome.state;
  Object.assign(state, { recoveryState });
  await deps.checkpoint("recovery_state", {
    pendingActionId: toolPendingActionId,
    pendingActionFingerprint: actionFingerprint,
    note: "tool_failure_recovery"
  });
  await deps.appendEvent(
    "failure.detected",
    {
      failureId: failure.failureId,
      source: failure.source,
      code: failure.code ?? null,
      category: failure.category
    },
    failure.occurredAt
  );
  await deps.appendEvent(
    "failure.classified",
    {
      failureId: failure.failureId,
      category: failure.category,
      retryable: failure.retryable
    },
    deps.input.now()
  );
  await deps.appendEvent(
    "recovery.decision.created",
    {
      failureId: failure.failureId,
      decisionId: recoveryOutcome.decision.decisionId,
      category: failure.category,
      disposition: recoveryOutcome.decision.disposition,
      attempt: recoveryOutcome.decision.attempt,
      maxAttempts: recoveryOutcome.decision.maxAttempts,
      usage: recoveryOutcome.state.usage
    },
    recoveryOutcome.decision.decidedAt
  );

  if (recoveryOutcome.terminal) {
    await deps.appendEvent(
      "recovery.terminal",
      {
        failureId: failure.failureId,
        decisionId: recoveryOutcome.decision.decisionId,
        category: failure.category,
        reason: recoveryOutcome.decision.reason
      },
      deps.input.now()
    );
    return {
      kind: "fail",
      code: toolResult.error.code,
      message: toolResult.error.message,
      retryable: false
    };
  }

  if (
    recoveryOutcome.decision.disposition === "re_ground" ||
    recoveryOutcome.decision.disposition === "replan"
  ) {
    await deps.appendEvent(
      "recovery.started",
      {
        failureId: failure.failureId,
        decisionId: recoveryOutcome.decision.decisionId,
        disposition: recoveryOutcome.decision.disposition
      },
      deps.input.now()
    );
    if (recoveryOutcome.regroundManifest !== undefined) {
      await deps.appendEvent(
        "recovery.reground.completed",
        {
          failureId: failure.failureId,
          manifestId: recoveryOutcome.regroundManifest.manifestId,
          inspectedPaths: recoveryOutcome.regroundManifest.inspectedPaths
        },
        recoveryOutcome.regroundManifest.createdAt
      );
    }
    if (recoveryOutcome.recoveryPlan !== undefined) {
      await deps.appendEvent(
        "recovery.replan.created",
        {
          failureId: failure.failureId,
          recoveryPlanId: recoveryOutcome.recoveryPlan.recoveryPlanId,
          preservedStepIds: recoveryOutcome.recoveryPlan.preservedStepIds,
          invalidatedStepIds: recoveryOutcome.recoveryPlan.invalidatedStepIds
        },
        recoveryOutcome.recoveryPlan.createdAt
      );
    }
    ledger = applyLedgerPatch({
      ledger,
      patch: {
        appendDecisions: [
          `Recovery ${recoveryOutcome.decision.disposition}: ${recoveryOutcome.decision.reason}`
        ]
      },
      now: deps.input.now()
    });
    await deps.persistLedger(ledger);
    regroundRequested = recoveryOutcome.decision.disposition === "re_ground";
    replanRequested = recoveryOutcome.decision.disposition === "replan";
    noProgressCount = 0;
    await deps.checkpoint("post_tool", {
      pendingActionId: toolPendingActionId,
      pendingActionFingerprint: actionFingerprint,
      note: "recovery_decision"
    });
    Object.assign(state, {
      pendingActionRejection,
      latestIterationIndex,
      noProgressCount,
      regroundRequested,
      replanRequested
    });
    return { kind: "continue" };
  }

  if (recoveryOutcome.decision.disposition === "retry_same_action") {
    currentPendingRetryIncrement = true;
  }
  const noProgressSignals = detectNoProgress({
    previous: previousSnapshot,
    current: buildSnapshot(deps.actionSignature, ledger, state.recentValidationResult, toolResult.error.code, null)
  });
  previousSnapshot = buildSnapshot(deps.actionSignature, ledger, state.recentValidationResult, toolResult.error.code, null);
  const noProgress = await handleNoProgress({
    input: { now: deps.input.now, ledgerStore: deps.input.ledgerStore },
    appendEvent: deps.appendEvent,
    ledger,
    noProgressCount,
    signals: noProgressSignals
  });
  Object.assign(state, {
    pendingActionRejection,
    pendingRetryIncrement: currentPendingRetryIncrement,
    latestIterationIndex,
    previousSnapshot,
    ledger: noProgress.ledger,
    noProgressCount: noProgress.noProgressCount,
    regroundRequested: noProgress.regroundRequested,
    replanRequested: noProgress.replanRequested
  });
  return { kind: "continue" };
}

async function processToolSuccess(
  state: AgentLoopState, deps: HandlerDeps,
  action: Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
  execState: ToolExecState,
  strategyBypassedForRecovery: boolean
): Promise<HandlerOutcome> {
  const { toolCall, actionFingerprint: _actionFingerprint, execution, strategyPreviousWorkingSet, strategyPreviousChangedFiles, strategyPreviousValidationResult } = execState;
  const toolResult = execution.toolResult as Extract<ToolResult, { status: "success" }>;
  void _actionFingerprint;
  let ledger = state.ledger;
  let activeRun = execState.activeRun;
  let currentWorkingSet = state.currentWorkingSet;
  let changedFiles = state.changedFiles;
  let recentToolResult = state.recentToolResult;
  let recentValidationResult = state.recentValidationResult;
  let regroundedAt = state.regroundedAt;
  let builderState = state.builderState;
  let strategyState = state.strategyState;
  let recoveryState = state.recoveryState;
  let previousSnapshot = state.previousSnapshot;
  let noProgressCount = state.noProgressCount;
  let regroundRequested = state.regroundRequested;
  let replanRequested = state.replanRequested;
  let latestIterationIndex = state.latestIterationIndex;
  let validationRepairActionRejectionCount = state.validationRepairActionRejectionCount;

  if (execution.artifacts !== undefined) {
    for (const artifact of execution.artifacts) {
      await deps.appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);
    }
    ledger = applyLedgerPatch({
      ledger,
      patch: {
        appendArtifactRefs: execution.artifacts.map((artifact) => artifact.artifactId)
      },
      now: deps.input.now()
    });
    await deps.persistLedger(ledger);
  }

  if (toolResult.toolName === "filesystem.search") {
    currentWorkingSet = toolResult.output.workingSet;
    await deps.appendEvent(
      "search.completed",
      {
        returnedMatches: toolResult.output.result.returnedMatches,
        truncated: toolResult.output.result.truncated
      },
      deps.input.now()
    );
    await deps.appendEvent(
      "working-set.built",
      {
        itemCount: toolResult.output.workingSet.itemCount
      },
      deps.input.now()
    );
  }

  if (toolResult.toolName === "filesystem.patch") {
    await deps.appendEvent(
      "patch.applied",
      {
        path: toolResult.output.result.path,
        status: toolResult.output.result.status,
        changed: toolResult.output.result.changed
      },
      deps.input.now()
    );
    if (toolResult.output.result.changed) {
      regroundedAt = reGroundNow(deps.input, currentWorkingSet, deps.input.now());
      if (regroundedAt !== null) {
        await deps.appendEvent("context.regrounded", { reason: "workspace_change", at: regroundedAt }, regroundedAt);
      }
    }
  }

  if (toolResult.toolName === "shell.execute") {
    await deps.appendEvent(
      "command.completed",
      {
        exitCode: toolResult.output.result.exitCode,
        timedOut: toolResult.output.result.timedOut,
        cancelled: toolResult.output.result.cancelled
      },
      deps.input.now()
    );
  }

  if (toolResult.toolName === "filesystem.write") {
    await deps.appendEvent(
      "patch.applied",
      {
        path: toolResult.output.result.path,
        status: toolResult.output.result.mode,
        changed: true
      },
      deps.input.now()
    );
  }
  await deps.appendEvent("tool.completed", { toolName: toolResult.toolName }, deps.input.now());

  const resumedAt = deps.input.now();
  activeRun = transitionRun(activeRun, "running", resumedAt);
  deps.input.runStore.updateRun(activeRun);

  recentToolResult = toolResult;
  let artifactHash: string | null = null;

  if (toolResult.toolName === "filesystem.patch") {
    artifactHash = toolResult.output.result.newHash;
    changedFiles = appendChangedFile(changedFiles, toolResult.output.result.path);
    recentValidationResult = null;
    validationRepairActionRejectionCount = 0;
    builderState = applyBuilderToolEvidence({
      builderState,
      path: toolResult.output.result.path,
      evidenceRefs: [`execution:${execution.executionRecord.executionId}`],
      now: deps.input.now()
    });
  } else if (toolResult.toolName === "filesystem.write") {
    artifactHash = toolResult.output.result.hash;
    changedFiles = appendChangedFile(changedFiles, toolResult.output.result.path);
    recentValidationResult = null;
    validationRepairActionRejectionCount = 0;
    builderState = applyBuilderToolEvidence({
      builderState,
      path: toolResult.output.result.path,
      evidenceRefs: [`execution:${execution.executionRecord.executionId}`],
      now: deps.input.now()
    });
  }
  if (
    toolResult.toolName === "shell.execute" &&
    deps.input.task.input.validationRequest !== undefined &&
    toolResult.output.result.executionRecordId.length > 0
  ) {
    recentValidationResult = await runCommandValidation({
      run: activeRun,
      task: deps.input.task,
      toolResult: toolResult,
      artifacts: deps.input.artifactStore.getArtifactsByRun(activeRun.runId),
      changedFiles,
      validationCwd: toolCall.toolName === "shell.execute" ? toolCall.input.cwd : ".",
      workspaceRoot: deps.input.workspaceRoot,
      now: deps.input.now(),
      idGenerator: deps.input.idGenerator
    });
    deps.input.validationResultStore.upsertValidationResult({
      runId: activeRun.runId,
      result: recentValidationResult,
      createdAt: deps.input.now()
    });
    await deps.appendEvent(
      "validation.completed",
      {
        status: recentValidationResult.status,
        evidence: recentValidationResult.evidence,
        ...(recentValidationResult.failureSummary === undefined ? {} : { failureSummary: recentValidationResult.failureSummary })
      },
      deps.input.now()
    );
    ledger = applyLedgerPatch({
      ledger,
      patch: {
        appendEvidenceRefs: recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
      },
      now: deps.input.now()
    });
    if (recentValidationResult.status === "failed") {
      ledger = appendFailedAttempt({
        ledger,
        now: deps.input.now(),
        actionType: "tool_call",
        summary: recentValidationResult.testResult?.summary ?? "Verification failed.",
        errorCode: "VALIDATION_FAILED",
        retryable: false,
        evidenceRefs: recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
      });
      const failure = normalizeValidationFailure({
        failureId: deps.input.idGenerator(),
        runId: activeRun.runId,
        taskId: deps.input.task.taskId,
        iteration: latestIterationIndex,
        validation: recentValidationResult,
        occurredAt: deps.input.now()
      });
      const progressFingerprint = createProgressFingerprint({
        ledgerVersion: ledger.version,
        evidenceRefs: ledger.evidenceRefs,
        changedFiles,
        validationStatus: recentValidationResult.status,
        validationEvidenceCodes: recentValidationResult.evidence.map((entry) => entry.code),
        workingSetPaths: currentWorkingSet?.items.map((item) => item.path) ?? []
      });
      const recoveryOutcome = deps.recoveryOrchestrator.decide({
        failure,
        previousFailure: recoveryState?.latestFailure,
        previousState: recoveryState,
        progressFingerprint,
        previousProgressFingerprint: recoveryState?.progressFingerprint,
        ledger,
        workingSet: currentWorkingSet,
        recoveryBudget: deps.recoveryBudget,
        now: deps.input.now,
        idGenerator: deps.input.idGenerator
      });
      recoveryState = recoveryOutcome.state;
      Object.assign(state, { recoveryState });
      await deps.checkpoint("recovery_state", {
        note: "validation_recovery"
      });
      await deps.appendEvent(
        "failure.detected",
        {
          failureId: failure.failureId,
          source: failure.source,
          code: failure.code ?? null,
          category: failure.category
        },
        failure.occurredAt
      );
      await deps.appendEvent(
        "failure.classified",
        {
          failureId: failure.failureId,
          category: failure.category,
          retryable: failure.retryable
        },
        deps.input.now()
      );
      await deps.appendEvent(
        "recovery.decision.created",
        {
          failureId: failure.failureId,
          decisionId: recoveryOutcome.decision.decisionId,
          category: failure.category,
          disposition: recoveryOutcome.decision.disposition,
          attempt: recoveryOutcome.decision.attempt,
          maxAttempts: recoveryOutcome.decision.maxAttempts,
          usage: recoveryOutcome.state.usage
        },
        recoveryOutcome.decision.decidedAt
      );
      if (recoveryOutcome.recoveryPlan !== undefined) {
        await deps.appendEvent(
          "recovery.replan.created",
          {
            failureId: failure.failureId,
            recoveryPlanId: recoveryOutcome.recoveryPlan.recoveryPlanId,
            preservedStepIds: recoveryOutcome.recoveryPlan.preservedStepIds,
            invalidatedStepIds: recoveryOutcome.recoveryPlan.invalidatedStepIds
          },
          recoveryOutcome.recoveryPlan.createdAt
        );
      }
      if (recoveryOutcome.terminal) {
        await deps.appendEvent(
          "recovery.terminal",
          {
            failureId: failure.failureId,
            decisionId: recoveryOutcome.decision.decisionId,
            category: failure.category,
            reason: recoveryOutcome.decision.reason
          },
          deps.input.now()
        );
        await deps.persistLedger(ledger);
        return {
          kind: "fail",
          code: "RECOVERY_TERMINAL",
          message: recoveryOutcome.decision.reason,
          retryable: false
        };
      }
      replanRequested = recoveryOutcome.decision.disposition === "replan";
      regroundRequested = recoveryOutcome.decision.disposition === "re_ground";
    }
    await deps.persistLedger(ledger);
  }

  ledger = completePlanStepFromTool({
    ledger,
    toolResult: toolResult,
    executionEvidenceRefs: [`execution:${execution.executionRecord.executionId}`],
    validationEvidenceRefs:
      toolResult.toolName === "shell.execute" && recentValidationResult !== null
        ? recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
        : [],
    now: deps.input.now()
  });
  await deps.persistLedger(ledger);

  const iteration = createIteration({
    iterationId: deps.input.idGenerator(),
    runId: activeRun.runId,
    index: latestIterationIndex,
    actionType: action.type,
    status:
      recentValidationResult !== null && toolResult.toolName === "shell.execute" && recentValidationResult.status === "failed"
        ? "failed"
        : "completed",
    usage: state.usage,
    summary: describeToolSuccess(toolResult),
    latestToolCallId: toolCall.toolCallId,
    latestExecutionRecordId: execution.executionRecord.executionId,
    latestValidationStatus:
      toolResult.toolName === "shell.execute" ? recentValidationResult?.status : undefined,
    evidenceRefs: recentValidationResult?.evidenceRecords.map((record) => record.evidenceId) ?? [],
    now: deps.input.now()
  });
  deps.input.agentIterationStore.insertIteration(iteration);
  await deps.appendEvent(
    iteration.status === "completed" ? "iteration.completed" : "iteration.failed",
    { index: iteration.index, actionType: iteration.actionType },
    iteration.createdAt
  );
  latestIterationIndex += 1;

  if (!strategyBypassedForRecovery && recoveryState === undefined) {
    const strategyAfterAction = afterActionStrategy({
      task: deps.input.task,
      state: strategyState,
      iteration: latestIterationIndex,
      action,
      previousWorkingSet: strategyPreviousWorkingSet,
      currentWorkingSet,
      previousChangedFiles: strategyPreviousChangedFiles,
      currentChangedFiles: changedFiles,
      previousValidationResult: strategyPreviousValidationResult,
      currentValidationResult: recentValidationResult,
      toolCall,
      toolResult: toolResult
    });
    strategyState = strategyAfterAction.state;
    if (strategyAfterAction.stalled) {
      await deps.appendEvent(
        "strategy.exploration.stalled",
        {
          reason: strategyAfterAction.progressReasons.length === 0 ? "no_progress" : strategyAfterAction.progressReasons.join(","),
          iteration: latestIterationIndex,
          consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
          iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress
        },
        deps.input.now()
      );
    }
    if (strategyAfterAction.terminal) {
      await deps.appendEvent(
        "strategy.no_progress.terminal",
        {
          reason: "third_stall",
          iteration: latestIterationIndex,
          consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
          iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress
        },
        deps.input.now()
      );
      Object.assign(state, {
        activeRun,
        currentWorkingSet,
        changedFiles,
        recentToolResult,
        recentValidationResult,
        regroundedAt,
        builderState,
        strategyState,
        validationRepairActionRejectionCount
      });
      return {
        kind: "fail",
        code: "AGENT_STRATEGY_NO_PROGRESS",
        message: "Agent strategy detected repeated action without progress.",
        retryable: false
      };
    }
  }

  const noProgressSignals = detectNoProgress({
    previous: previousSnapshot,
    current: buildSnapshot(
      deps.actionSignature,
      ledger,
      recentValidationResult,
      toolResult.toolName === "shell.execute" && recentValidationResult?.status === "failed"
        ? "VALIDATION_FAILED"
        : null,
      artifactHash
    )
  });
  previousSnapshot = buildSnapshot(
    deps.actionSignature,
    ledger,
    recentValidationResult,
    toolResult.toolName === "shell.execute" && recentValidationResult?.status === "failed"
      ? "VALIDATION_FAILED"
      : null,
    artifactHash
  );
  const noProgress = await handleNoProgress({
    input: { now: deps.input.now, ledgerStore: deps.input.ledgerStore },
    appendEvent: deps.appendEvent,
    ledger,
    noProgressCount,
    signals: noProgressSignals
  });
  regroundRequested = noProgress.regroundRequested;
  replanRequested = noProgress.replanRequested;
  Object.assign(state, {
    activeRun,
    currentWorkingSet,
    changedFiles,
    recentToolResult,
    recentValidationResult,
    regroundedAt,
    builderState,
    strategyState,
    validationRepairActionRejectionCount,
    latestIterationIndex,
    previousSnapshot,
    ledger: noProgress.ledger,
    noProgressCount: noProgress.noProgressCount,
    regroundRequested,
    replanRequested
  });
  return { kind: "continue" };
}
