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
import type { HandlerContext, HandlerOutcome } from "../outcome.js";

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
  strategyPreviousWorkingSet: ReturnType<HandlerContext["currentWorkingSet"] extends infer T ? () => T : never>;
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
  ctx: HandlerContext,
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
    const reusableGrant = ctx.input.approvalStore.findReusableGrant({
      runId: ctx.activeRun.runId,
      actionFingerprint,
      resourceScope,
      now: ctx.input.now()
    });
    if (reusableGrant === null) {
      const outcome = await handleApproval(
        {
          input: ctx.input,
          run: ctx.activeRun,
          ledger: ctx.ledger,
          appendEvent: ctx.appendEvent,
          checkpoint: ctx.checkpoint,
          nextSequence: ctx.nextSequence,
          latestIterationIndex: ctx.latestIterationIndex,
          currentWorkingSet: ctx.currentWorkingSet,
          changedFiles: ctx.changedFiles,
          recentToolResult: ctx.recentToolResult,
          recentValidationResult: ctx.recentValidationResult,
          regroundRequested: ctx.regroundRequested,
          replanRequested: ctx.replanRequested,
          noProgressCount: ctx.noProgressCount,
          usage: ctx.usage,
          previousSnapshot: ctx.previousSnapshot,
          pendingRetryIncrement: ctx.pendingRetryIncrement,
          recoveryState: ctx.recoveryState,
          strategyState: ctx.strategyState,
          builderState: ctx.builderState,
          finalizationPlanRejectionCount: ctx.finalizationPlanRejectionCount,
          validationRepairActionRejectionCount: ctx.validationRepairActionRejectionCount
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
    appendEvent: ctx.appendEvent,
    now: ctx.input.now(),
    phase: "tool",
    budget: ctx.input.task.input.agentRequest!.budget,
    usage: ctx.usage,
    reserveVerification: false
  });

  let activeRun: Run = transitionRun(ctx.activeRun, "waiting_for_tool", ctx.input.now());
  ctx.input.runStore.updateRun(activeRun);
  ctx.mutate({ activeRun });
  const toolPendingAction = createPendingAction({
    pendingActionId: ctx.input.idGenerator(),
    runId: activeRun.runId,
    actionId: toolCall.toolCallId,
    waitingFor: "tool_execution",
    action: {
      type: "tool_call",
      toolCall
    },
    resumeState: serializeResumeState({
      usage: ctx.usage,
      nextSequence: ctx.nextSequence + 1,
      currentWorkingSet: ctx.currentWorkingSet,
      changedFiles: ctx.changedFiles,
      recentToolResult: ctx.recentToolResult,
      recentValidationResult: ctx.recentValidationResult,
      latestIterationIndex: ctx.latestIterationIndex,
      regroundRequested: ctx.regroundRequested,
      replanRequested: ctx.replanRequested,
      noProgressCount: ctx.noProgressCount,
      previousSnapshot: ctx.previousSnapshot,
      pendingRetryIncrement: ctx.pendingRetryIncrement,
      recoveryState: ctx.recoveryState,
      strategyState: ctx.strategyState,
      builderState: ctx.builderState,
      finalizationPlanRejectionCount: ctx.finalizationPlanRejectionCount,
      validationRepairActionRejectionCount: ctx.validationRepairActionRejectionCount
    }),
    now: ctx.input.now()
  });
  ctx.input.pendingActionStore.insertPendingAction(toolPendingAction);
  await ctx.checkpoint("pre_tool", {
    pendingActionId: toolPendingAction.pendingActionId,
    pendingActionFingerprint: actionFingerprint
  });
  if (toolCall.toolName === "filesystem.patch") {
    await ctx.checkpoint("pre_patch", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  } else if (toolCall.toolName === "filesystem.write") {
    await ctx.checkpoint("pre_write", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  }
  await ctx.appendEvent(
    "tool.started",
    {
      toolName: toolCall.toolName,
      risk: classifyRisk(toolCall.toolName)
    },
    activeRun.updatedAt
  );
  if (toolCall.toolName === "shell.execute") {
    await ctx.appendEvent(
      "command.started",
      {
        command: toolCall.input.command,
        args: toolCall.input.args,
        cwd: toolCall.input.cwd
      },
      activeRun.updatedAt
    );
  }

  const strategyPreviousWorkingSet = ctx.currentWorkingSet;
  const strategyPreviousChangedFiles = ctx.changedFiles;
  const strategyPreviousValidationResult = ctx.recentValidationResult;
  const execution = await ctx.input.toolRuntime.execute({
    runId: activeRun.runId,
    toolCall,
    workspaceRoot: ctx.input.workspaceRoot,
    artifactRoot: ctx.input.artifactRoot,
    now: ctx.input.now,
    idGenerator: ctx.input.idGenerator
  });
  ctx.usage.toolCalls += 1;
  let pendingRetryIncrement = ctx.pendingRetryIncrement;
  if (pendingRetryIncrement) {
    ctx.usage.retryCount += 1;
    pendingRetryIncrement = false;
    ctx.mutate({ pendingRetryIncrement });
  }
  ctx.input.pendingActionStore.updatePendingAction({
    ...toolPendingAction,
    status: "resolved",
    updatedAt: ctx.input.now()
  });
  if (toolCall.toolName === "filesystem.patch") {
    await ctx.checkpoint("post_patch", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  } else if (toolCall.toolName === "filesystem.write") {
    await ctx.checkpoint("post_write", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
  }
  await ctx.checkpoint("post_tool", {
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
    latestIterationIndex: ctx.latestIterationIndex
  };

  const toolResult = execution.toolResult;
  if (toolResult.status === "error") {
    return handleToolError(ctx, action, execState, strategyBypassedForRecovery);
  }
  return processToolSuccess(ctx, action, execState, strategyBypassedForRecovery);
}

function describeApprovalReasonFor(toolCall: ToolCall): string {
  // Local alias to avoid importing describeApprovalReason (kept in runner for the inline gate).
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return "Write access requires approval before mutating workspace files.";
  }
  return "Command execution requires approval before running a process.";
}

async function handleToolError(
  ctx: HandlerContext,
  action: Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
  execState: ToolExecState,
  _strategyBypassedForRecovery: boolean
): Promise<HandlerOutcome> {
  const { toolCall, actionFingerprint, toolPendingActionId, execution, pendingRetryIncrement } = execState;
  const toolResult = execution.toolResult as Extract<ToolResult, { status: "error" }>;
  let activeRun = execState.activeRun;
  let ledger = ctx.ledger;
  let previousSnapshot = ctx.previousSnapshot;
  let latestIterationIndex = execState.latestIterationIndex;
  let recoveryState = ctx.recoveryState;
  let noProgressCount = ctx.noProgressCount;
  let regroundRequested = ctx.regroundRequested;
  let replanRequested = ctx.replanRequested;
  let pendingActionRejection = ctx.pendingActionRejection;
  let currentPendingRetryIncrement = pendingRetryIncrement;

  if (toolCall.toolName === "shell.execute") {
    await ctx.appendEvent(
      "command.failed",
      {
        command: toolCall.input.command,
        error: toolResult.error
      },
      ctx.input.now()
    );
  }
  await ctx.appendEvent("tool.failed", { error: toolResult.error }, ctx.input.now());
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
    now: ctx.input.now(),
    actionType: "tool_call",
    summary: toolResult.error.message,
    errorCode: toolResult.error.code,
    retryable: toolResult.error.retryable,
    evidenceRefs: []
  });
  await ctx.persistLedger(ledger);

  const iteration = createIteration({
    iterationId: ctx.input.idGenerator(),
    runId: activeRun.runId,
    index: latestIterationIndex,
    actionType: action.type,
    status: "failed",
    usage: ctx.usage,
    summary: toolResult.error.message,
    latestToolCallId: toolCall.toolCallId,
    latestExecutionRecordId: execution.executionRecord.executionId,
    evidenceRefs: [],
    now: ctx.input.now()
  });
  ctx.input.agentIterationStore.insertIteration(iteration);
  await ctx.appendEvent("iteration.failed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  latestIterationIndex += 1;

  const resumedAt = ctx.input.now();
  activeRun = transitionRun(activeRun, "running", resumedAt);
  ctx.input.runStore.updateRun(activeRun);
  ctx.mutate({ activeRun });

  if (toolFailureRejection !== null && toolCall.toolName === "shell.execute") {
    await ctx.checkpoint("post_tool", {
      pendingActionId: toolPendingActionId,
      pendingActionFingerprint: actionFingerprint,
      note: "tool_failure_action_repair"
    });
    previousSnapshot = buildSnapshot(ctx.actionSignature, ledger, ctx.recentValidationResult, toolResult.error.code, null);
    ctx.mutate({
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
    failureId: ctx.input.idGenerator(),
    runId: activeRun.runId,
    taskId: ctx.input.task.taskId,
    iteration: latestIterationIndex,
    toolResult: toolResult,
    executionRecordId: execution.executionRecord.executionId,
    occurredAt: ctx.input.now()
  });
  const progressFingerprint = createProgressFingerprint({
    ledgerVersion: ledger.version,
    evidenceRefs: ledger.evidenceRefs,
    changedFiles: ctx.changedFiles,
    validationStatus: ctx.recentValidationResult?.status ?? null,
    validationEvidenceCodes: ctx.recentValidationResult?.evidence.map((entry) => entry.code) ?? [],
    workingSetPaths: ctx.currentWorkingSet?.items.map((item) => item.path) ?? []
  });
  const recoveryOutcome = ctx.recoveryOrchestrator.decide({
    failure,
    previousFailure: recoveryState?.latestFailure,
    previousState: recoveryState,
    progressFingerprint,
    previousProgressFingerprint: recoveryState?.progressFingerprint,
    ledger,
    workingSet: ctx.currentWorkingSet,
    recoveryBudget: ctx.recoveryBudget,
    now: ctx.input.now,
    idGenerator: ctx.input.idGenerator
  });
  recoveryState = recoveryOutcome.state;
  ctx.mutate({ recoveryState });
  await ctx.checkpoint("recovery_state", {
    pendingActionId: toolPendingActionId,
    pendingActionFingerprint: actionFingerprint,
    note: "tool_failure_recovery"
  });
  await ctx.appendEvent(
    "failure.detected",
    {
      failureId: failure.failureId,
      source: failure.source,
      code: failure.code ?? null,
      category: failure.category
    },
    failure.occurredAt
  );
  await ctx.appendEvent(
    "failure.classified",
    {
      failureId: failure.failureId,
      category: failure.category,
      retryable: failure.retryable
    },
    ctx.input.now()
  );
  await ctx.appendEvent(
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
    await ctx.appendEvent(
      "recovery.terminal",
      {
        failureId: failure.failureId,
        decisionId: recoveryOutcome.decision.decisionId,
        category: failure.category,
        reason: recoveryOutcome.decision.reason
      },
      ctx.input.now()
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
    await ctx.appendEvent(
      "recovery.started",
      {
        failureId: failure.failureId,
        decisionId: recoveryOutcome.decision.decisionId,
        disposition: recoveryOutcome.decision.disposition
      },
      ctx.input.now()
    );
    if (recoveryOutcome.regroundManifest !== undefined) {
      await ctx.appendEvent(
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
      await ctx.appendEvent(
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
      now: ctx.input.now()
    });
    await ctx.persistLedger(ledger);
    regroundRequested = recoveryOutcome.decision.disposition === "re_ground";
    replanRequested = recoveryOutcome.decision.disposition === "replan";
    noProgressCount = 0;
    await ctx.checkpoint("post_tool", {
      pendingActionId: toolPendingActionId,
      pendingActionFingerprint: actionFingerprint,
      note: "recovery_decision"
    });
    ctx.mutate({
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
    current: buildSnapshot(ctx.actionSignature, ledger, ctx.recentValidationResult, toolResult.error.code, null)
  });
  previousSnapshot = buildSnapshot(ctx.actionSignature, ledger, ctx.recentValidationResult, toolResult.error.code, null);
  const noProgress = await handleNoProgress({
    input: { now: ctx.input.now, ledgerStore: ctx.input.ledgerStore },
    appendEvent: ctx.appendEvent,
    ledger,
    noProgressCount,
    signals: noProgressSignals
  });
  ctx.mutate({
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
  ctx: HandlerContext,
  action: Extract<AgentAction, { type: "tool_call" | "request_approval" }>,
  execState: ToolExecState,
  strategyBypassedForRecovery: boolean
): Promise<HandlerOutcome> {
  const { toolCall, actionFingerprint: _actionFingerprint, execution, strategyPreviousWorkingSet, strategyPreviousChangedFiles, strategyPreviousValidationResult } = execState;
  const toolResult = execution.toolResult as Extract<ToolResult, { status: "success" }>;
  void _actionFingerprint;
  let ledger = ctx.ledger;
  let activeRun = execState.activeRun;
  let currentWorkingSet = ctx.currentWorkingSet;
  let changedFiles = ctx.changedFiles;
  let recentToolResult = ctx.recentToolResult;
  let recentValidationResult = ctx.recentValidationResult;
  let regroundedAt = ctx.regroundedAt;
  let builderState = ctx.builderState;
  let strategyState = ctx.strategyState;
  let recoveryState = ctx.recoveryState;
  let previousSnapshot = ctx.previousSnapshot;
  let noProgressCount = ctx.noProgressCount;
  let regroundRequested = ctx.regroundRequested;
  let replanRequested = ctx.replanRequested;
  let latestIterationIndex = ctx.latestIterationIndex;
  let validationRepairActionRejectionCount = ctx.validationRepairActionRejectionCount;

  if (execution.artifacts !== undefined) {
    for (const artifact of execution.artifacts) {
      await ctx.appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);
    }
    ledger = applyLedgerPatch({
      ledger,
      patch: {
        appendArtifactRefs: execution.artifacts.map((artifact) => artifact.artifactId)
      },
      now: ctx.input.now()
    });
    await ctx.persistLedger(ledger);
  }

  if (toolResult.toolName === "filesystem.search") {
    currentWorkingSet = toolResult.output.workingSet;
    await ctx.appendEvent(
      "search.completed",
      {
        returnedMatches: toolResult.output.result.returnedMatches,
        truncated: toolResult.output.result.truncated
      },
      ctx.input.now()
    );
    await ctx.appendEvent(
      "working-set.built",
      {
        itemCount: toolResult.output.workingSet.itemCount
      },
      ctx.input.now()
    );
  }

  if (toolResult.toolName === "filesystem.patch") {
    await ctx.appendEvent(
      "patch.applied",
      {
        path: toolResult.output.result.path,
        status: toolResult.output.result.status,
        changed: toolResult.output.result.changed
      },
      ctx.input.now()
    );
    if (toolResult.output.result.changed) {
      regroundedAt = reGroundNow(ctx.input, currentWorkingSet, ctx.input.now());
      if (regroundedAt !== null) {
        await ctx.appendEvent("context.regrounded", { reason: "workspace_change", at: regroundedAt }, regroundedAt);
      }
    }
  }

  if (toolResult.toolName === "shell.execute") {
    await ctx.appendEvent(
      "command.completed",
      {
        exitCode: toolResult.output.result.exitCode,
        timedOut: toolResult.output.result.timedOut,
        cancelled: toolResult.output.result.cancelled
      },
      ctx.input.now()
    );
  }

  if (toolResult.toolName === "filesystem.write") {
    await ctx.appendEvent(
      "patch.applied",
      {
        path: toolResult.output.result.path,
        status: toolResult.output.result.mode,
        changed: true
      },
      ctx.input.now()
    );
  }
  await ctx.appendEvent("tool.completed", { toolName: toolResult.toolName }, ctx.input.now());

  const resumedAt = ctx.input.now();
  activeRun = transitionRun(activeRun, "running", resumedAt);
  ctx.input.runStore.updateRun(activeRun);

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
      now: ctx.input.now()
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
      now: ctx.input.now()
    });
  }
  if (
    toolResult.toolName === "shell.execute" &&
    ctx.input.task.input.validationRequest !== undefined &&
    toolResult.output.result.executionRecordId.length > 0
  ) {
    recentValidationResult = await runCommandValidation({
      run: activeRun,
      task: ctx.input.task,
      toolResult: toolResult,
      artifacts: ctx.input.artifactStore.getArtifactsByRun(activeRun.runId),
      changedFiles,
      validationCwd: toolCall.toolName === "shell.execute" ? toolCall.input.cwd : ".",
      workspaceRoot: ctx.input.workspaceRoot,
      now: ctx.input.now(),
      idGenerator: ctx.input.idGenerator
    });
    ctx.input.validationResultStore.upsertValidationResult({
      runId: activeRun.runId,
      result: recentValidationResult,
      createdAt: ctx.input.now()
    });
    await ctx.appendEvent(
      "validation.completed",
      {
        status: recentValidationResult.status,
        evidence: recentValidationResult.evidence,
        ...(recentValidationResult.failureSummary === undefined ? {} : { failureSummary: recentValidationResult.failureSummary })
      },
      ctx.input.now()
    );
    ledger = applyLedgerPatch({
      ledger,
      patch: {
        appendEvidenceRefs: recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
      },
      now: ctx.input.now()
    });
    if (recentValidationResult.status === "failed") {
      ledger = appendFailedAttempt({
        ledger,
        now: ctx.input.now(),
        actionType: "tool_call",
        summary: recentValidationResult.testResult?.summary ?? "Verification failed.",
        errorCode: "VALIDATION_FAILED",
        retryable: false,
        evidenceRefs: recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
      });
      const failure = normalizeValidationFailure({
        failureId: ctx.input.idGenerator(),
        runId: activeRun.runId,
        taskId: ctx.input.task.taskId,
        iteration: latestIterationIndex,
        validation: recentValidationResult,
        occurredAt: ctx.input.now()
      });
      const progressFingerprint = createProgressFingerprint({
        ledgerVersion: ledger.version,
        evidenceRefs: ledger.evidenceRefs,
        changedFiles,
        validationStatus: recentValidationResult.status,
        validationEvidenceCodes: recentValidationResult.evidence.map((entry) => entry.code),
        workingSetPaths: currentWorkingSet?.items.map((item) => item.path) ?? []
      });
      const recoveryOutcome = ctx.recoveryOrchestrator.decide({
        failure,
        previousFailure: recoveryState?.latestFailure,
        previousState: recoveryState,
        progressFingerprint,
        previousProgressFingerprint: recoveryState?.progressFingerprint,
        ledger,
        workingSet: currentWorkingSet,
        recoveryBudget: ctx.recoveryBudget,
        now: ctx.input.now,
        idGenerator: ctx.input.idGenerator
      });
      recoveryState = recoveryOutcome.state;
      ctx.mutate({ recoveryState });
      await ctx.checkpoint("recovery_state", {
        note: "validation_recovery"
      });
      await ctx.appendEvent(
        "failure.detected",
        {
          failureId: failure.failureId,
          source: failure.source,
          code: failure.code ?? null,
          category: failure.category
        },
        failure.occurredAt
      );
      await ctx.appendEvent(
        "failure.classified",
        {
          failureId: failure.failureId,
          category: failure.category,
          retryable: failure.retryable
        },
        ctx.input.now()
      );
      await ctx.appendEvent(
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
        await ctx.appendEvent(
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
        await ctx.appendEvent(
          "recovery.terminal",
          {
            failureId: failure.failureId,
            decisionId: recoveryOutcome.decision.decisionId,
            category: failure.category,
            reason: recoveryOutcome.decision.reason
          },
          ctx.input.now()
        );
        await ctx.persistLedger(ledger);
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
    await ctx.persistLedger(ledger);
  }

  ledger = completePlanStepFromTool({
    ledger,
    toolResult: toolResult,
    executionEvidenceRefs: [`execution:${execution.executionRecord.executionId}`],
    validationEvidenceRefs:
      toolResult.toolName === "shell.execute" && recentValidationResult !== null
        ? recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
        : [],
    now: ctx.input.now()
  });
  await ctx.persistLedger(ledger);

  const iteration = createIteration({
    iterationId: ctx.input.idGenerator(),
    runId: activeRun.runId,
    index: latestIterationIndex,
    actionType: action.type,
    status:
      recentValidationResult !== null && toolResult.toolName === "shell.execute" && recentValidationResult.status === "failed"
        ? "failed"
        : "completed",
    usage: ctx.usage,
    summary: describeToolSuccess(toolResult),
    latestToolCallId: toolCall.toolCallId,
    latestExecutionRecordId: execution.executionRecord.executionId,
    latestValidationStatus:
      toolResult.toolName === "shell.execute" ? recentValidationResult?.status : undefined,
    evidenceRefs: recentValidationResult?.evidenceRecords.map((record) => record.evidenceId) ?? [],
    now: ctx.input.now()
  });
  ctx.input.agentIterationStore.insertIteration(iteration);
  await ctx.appendEvent(
    iteration.status === "completed" ? "iteration.completed" : "iteration.failed",
    { index: iteration.index, actionType: iteration.actionType },
    iteration.createdAt
  );
  latestIterationIndex += 1;

  if (!strategyBypassedForRecovery && recoveryState === undefined) {
    const strategyAfterAction = afterActionStrategy({
      task: ctx.input.task,
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
      await ctx.appendEvent(
        "strategy.exploration.stalled",
        {
          reason: strategyAfterAction.progressReasons.length === 0 ? "no_progress" : strategyAfterAction.progressReasons.join(","),
          iteration: latestIterationIndex,
          consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
          iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress
        },
        ctx.input.now()
      );
    }
    if (strategyAfterAction.terminal) {
      await ctx.appendEvent(
        "strategy.no_progress.terminal",
        {
          reason: "third_stall",
          iteration: latestIterationIndex,
          consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
          iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress
        },
        ctx.input.now()
      );
      ctx.mutate({
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
      ctx.actionSignature,
      ledger,
      recentValidationResult,
      toolResult.toolName === "shell.execute" && recentValidationResult?.status === "failed"
        ? "VALIDATION_FAILED"
        : null,
      artifactHash
    )
  });
  previousSnapshot = buildSnapshot(
    ctx.actionSignature,
    ledger,
    recentValidationResult,
    toolResult.toolName === "shell.execute" && recentValidationResult?.status === "failed"
      ? "VALIDATION_FAILED"
      : null,
    artifactHash
  );
  const noProgress = await handleNoProgress({
    input: { now: ctx.input.now, ledgerStore: ctx.input.ledgerStore },
    appendEvent: ctx.appendEvent,
    ledger,
    noProgressCount,
    signals: noProgressSignals
  });
  regroundRequested = noProgress.regroundRequested;
  replanRequested = noProgress.replanRequested;
  ctx.mutate({
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
