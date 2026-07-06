import {
  AgentActionSchema,
  AgentBudgetUsageSchema,
  ALL_TOOL_NAMES,
  computeArtifactHash,
  createCheckpoint,
  createEvent,
  createProgressLedger,
  type AgentAction,
  type BuilderState,
  type Checkpoint,
  type CheckpointPhase,
  type Event,
  type PendingActionResumeState,
  type ProgressLedger,
  type Run,
  type StrategyDecision,
  type StrategyState,
  type Task,
  type ToolResult,
  type ValidationResult,
  type WorkingSet
} from "../../contracts/src/index.js";
import {
  collectRehydrationFilePaths,
  rehydrateWorkspaceFacts,
  validateCompactionIntegrity
} from "../../context/src/index.js";
import type { AgentLoopModelProvider, ModelActionRejection } from "../../model-gateway/src/index.js";
import type { AgentIterationStore } from "../../storage/src/agent-iteration-store.js";
import type { ApprovalStore } from "../../storage/src/approval-store.js";
import type { ArtifactStore } from "../../storage/src/artifact-store.js";
import type { CheckpointStore } from "../../storage/src/checkpoint-store.js";
import type { EventStore } from "../../storage/src/event-store.js";
import type { LedgerStore } from "../../storage/src/ledger-store.js";
import type { PendingActionStore } from "../../storage/src/pending-action-store.js";
import type { RunStore } from "../../storage/src/run-store.js";
import type { UserInputStore } from "../../storage/src/user-input-store.js";
import type { ValidationResultStore } from "../../storage/src/validation-result-store.js";
import type { ToolRuntime } from "../../tool-runtime/src/index.js";
import { transitionRun } from "./state-machine.js";
import {
  isFreshPassingValidation,
  requiresValidationRepairAction,
  isValidationRepairAction
} from "./validation-repair/index.js";
import { RecoveryOrchestrator } from "./recovery/index.js";
import { AgentLoopRunFailure } from "./agent-loop/errors.js";
import { redactForEvidence } from "./agent-loop/redact.js";
import { maybeAbortAfterCheckpoint, maybeAbortAfterEvent } from "./agent-loop/test-abort.js";
import { ensureBudget } from "./agent-loop/budget.js";
import { failRun } from "./agent-loop/fail-run.js";
import {
  describeModelActionError,
  isActionRepairable
} from "./agent-loop/model-action-error.js";
import { buildStrategyRejectionContext } from "./agent-loop/strategy-rejection.js";
import { buildLoopContextSnapshot, reGroundNow } from "./agent-loop/context-snapshot.js";
import { handleAskUser } from "./agent-loop/handlers/ask-user.js";
import { handleSubmitExecutionPlan } from "./agent-loop/handlers/submit-execution-plan.js";
import { handleUpdatePlan } from "./agent-loop/handlers/update-plan.js";
import { handleFinal } from "./agent-loop/handlers/final.js";
import { handleToolCall } from "./agent-loop/handlers/tool-call.js";
import type { HandlerContext, StateDelta } from "./agent-loop/outcome.js";

export { AgentLoopRunFailure } from "./agent-loop/errors.js";
export { redactForEvidence } from "./agent-loop/redact.js";
export { fingerprintToolCall } from "./agent-loop/fingerprint.js";
import { applyLedgerPatch } from "./ledger-progress/index.js";
import {
  beforeModelStrategy,
  buildStrategyPromptContext,
  deriveExecutionPlanFromAction,
  evaluateExecutionPlanCompleteness,
  normalizeStrategyState,
  onStrategyRejection,
  validateActionWithStrategy
} from "./strategy/index.js";
import {
  buildPlanningPolicyContext,
  evaluateBuilderAction,
  normalizeBuilderState,
  prepareBuilderTurn
} from "./builder/index.js";

type NoProgressSnapshot = {
  actionSignature: string | null;
  errorCode: string | null;
  ledgerVersion: number;
  evidenceCount: number;
  validationStatus: "passed" | "failed" | null;
  artifactHash: string | null;
};

export { type AgentLoopResult } from "./agent-loop/outcome.js";
import type { AgentLoopResult } from "./agent-loop/outcome.js";

export async function runAgentLoop(input: {
  task: Task;
  run: Run;
  now: () => string;
  idGenerator: () => string;
  workspaceRoot: string;
  artifactRoot: string;
  modelProvider: AgentLoopModelProvider;
  toolRuntime: ToolRuntime;
  runStore: RunStore;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  validationResultStore: ValidationResultStore;
  ledgerStore: LedgerStore;
  agentIterationStore: AgentIterationStore;
  approvalStore: ApprovalStore;
  pendingActionStore: PendingActionStore;
  userInputStore: UserInputStore;
  checkpointStore: CheckpointStore;
  resume?:
    | {
        ledger: ProgressLedger;
        resumeState: PendingActionResumeState;
        seedAction?: AgentAction | undefined;
        bypassApprovalForSeedAction?: boolean | undefined;
      }
    | undefined;
}): Promise<AgentLoopResult> {
  if (input.task.input.agentRequest === undefined) {
    throw new AgentLoopRunFailure("AGENT_REQUEST_MISSING", "Agent loop requires an agent request.", false);
  }

  let activeRun = input.run;
  let nextSequence =
    input.resume === undefined
      ? Math.max(1, input.eventStore.listEventsByRun(input.run.runId).length + 1)
      : Math.max(input.resume.resumeState.nextSequence, input.eventStore.listEventsByRun(input.run.runId).length + 1);
  let currentWorkingSet = input.resume?.resumeState.currentWorkingSet ?? null;
  let changedFiles = input.resume?.resumeState.changedFiles ?? [];
  let recentToolResult = input.resume?.resumeState.recentToolResult ?? null;
  let recentValidationResult = input.resume?.resumeState.recentValidationResult ?? null;
  let latestIterationIndex = input.resume?.resumeState.latestIterationIndex ?? 0;
  let regroundRequested = input.resume?.resumeState.regroundRequested ?? false;
  let replanRequested = input.resume?.resumeState.replanRequested ?? false;
  let noProgressCount = input.resume?.resumeState.noProgressCount ?? 0;
  let recoveryState = input.resume?.resumeState.recoveryState;
  let strategyState = normalizeStrategyState(input.resume?.resumeState.strategyState);
  let builderState = normalizeBuilderState(input.resume?.resumeState.builderState);
  let strategyDecision: StrategyDecision = "continue_explore";
  const recoveryOrchestrator = new RecoveryOrchestrator();
  const recoveryBudget = input.task.input.agentRequest?.recoveryBudget ?? {};
  let pendingRetryIncrement = input.resume?.resumeState.pendingRetryIncrement ?? false;
  const usage =
    input.resume?.resumeState.usage ??
    AgentBudgetUsageSchema.parse({
      loopCount: 0,
      modelCalls: 0,
      toolCalls: 0,
      retryCount: 0,
      startedAt: input.now()
    });

  const anchor = {
    goal: input.task.input.text,
    constraints: [
      "State Machine is the only writer of Run status.",
      "Tool runtime must stay inside the authorized workspace.",
      "Only one primary action is allowed per iteration.",
      "Final cannot bypass the completion gate."
    ],
    successCriteria:
      input.task.input.validationRequest === undefined
        ? ["Produce a valid final artifact."]
        : [
            "Apply a fix that satisfies the verification command.",
            "Pass the validation plan.",
            "Produce a final artifact that passes the completion gate."
          ]
  };
  let ledger =
    input.resume?.ledger ??
    input.ledgerStore.getByRun(activeRun.runId) ??
    createProgressLedger({
      runId: activeRun.runId,
      anchor,
      now: input.now()
    });

  const appendEventWithSequence = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    Promise.resolve().then(() => {
      const sequence = nextSequence;
      input.eventStore.appendEvent(
        createEvent({
          eventId: input.idGenerator(),
          runId: activeRun.runId,
          sequence,
          type,
          timestamp,
          payload
        })
      );
      maybeAbortAfterEvent(type);
      nextSequence += 1;
      return sequence;
    });
  const appendEvent = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    appendEventWithSequence(type, payload, timestamp).then(() => undefined);

  const persistLedger = async (nextLedger: ProgressLedger) => {
    ledger = nextLedger;
    input.ledgerStore.upsertLedger(ledger);
    await appendEvent(
      ledger.version === 0 ? "ledger.initialized" : "ledger.updated",
      {
        version: ledger.version,
        currentStep: ledger.currentStep
      },
      ledger.updatedAt
    );
  };

  const checkpoint = async (phase: CheckpointPhase, options?: {
    pendingActionId?: string;
    pendingActionFingerprint?: string;
    note?: string;
  }): Promise<Checkpoint> => {
    const createdAt = input.now();
    const pendingPatchPath = input.task.input.patchRequest?.path;
    const filePaths = collectRehydrationFilePaths({
      workingSetPaths: currentWorkingSet?.items.map((item) => item.path) ?? [],
      pendingPatchPath
    });
    let workspaceHash: string | undefined;
    if (filePaths.length > 0) {
      const facts = rehydrateWorkspaceFacts({ workspaceRoot: input.workspaceRoot, filePaths, now: createdAt });
      const hashes = facts.fileHashes.map((entry) => `${entry.path}:${entry.hash ?? "missing"}`).join("|");
      workspaceHash = computeArtifactHash(hashes);
    }
    const checkpointRecord = createCheckpoint({
      checkpointId: input.idGenerator(),
      runId: activeRun.runId,
      runStateVersion: activeRun.stateVersion,
      ledgerVersion: ledger.version,
      phase,
      ...(options?.pendingActionId === undefined ? {} : { pendingActionId: options.pendingActionId }),
      ...(options?.pendingActionFingerprint === undefined ? {} : { pendingActionFingerprint: options.pendingActionFingerprint }),
      ...(workspaceHash === undefined ? {} : { workspaceHash }),
      ...(options?.note === undefined ? {} : { note: options.note }),
      ...(recoveryState === undefined ? {} : { recovery: recoveryState }),
      strategy: strategyState,
      builder: builderState,
      createdAt
    });
    input.checkpointStore.insertCheckpoint(checkpointRecord);
    await appendEvent("checkpoint.created", { checkpointId: checkpointRecord.checkpointId, phase }, createdAt);
    maybeAbortAfterCheckpoint(phase, options?.note);
    return checkpointRecord;
  };

  // F025-C: build a HandlerContext snapshot from the current locals for
  // extracted handlers, and apply a StateDelta back. These collapse into a
  // single mutable AgentLoopState reference once the body->state convergence
  // completes (final step of F025-C).
  const buildHandlerContext = (actionSignature: string): HandlerContext => ({
    input,
    anchor,
    appendEvent,
    appendEventWithSequence,
    checkpoint,
    persistLedger,
    mutate: applyStateDelta,
    recoveryOrchestrator,
    recoveryBudget,
    availableTools,
    maxActionRepairs: MAX_ACTION_REPAIRS,
    actionSignature,
    activeRun,
    nextSequence,
    latestIterationIndex,
    currentWorkingSet,
    changedFiles,
    recentToolResult,
    recentValidationResult,
    regroundedAt,
    ledger,
    noProgressCount,
    previousSnapshot,
    recoveryState,
    strategyState,
    builderState,
    strategyDecision,
    regroundRequested,
    replanRequested,
    pendingRetryIncrement,
    finalizationPlanRejectionCount,
    validationRepairActionRejectionCount,
    pendingActionRejection,
    usage
  });

  const applyStateDelta = (delta: StateDelta | undefined) => {
    if (delta === undefined) {
      return;
    }
    if ("activeRun" in delta) activeRun = delta.activeRun as Run;
    if ("currentWorkingSet" in delta) currentWorkingSet = (delta.currentWorkingSet as WorkingSet | null) ?? null;
    if ("changedFiles" in delta) changedFiles = delta.changedFiles as string[];
    if ("recentToolResult" in delta) recentToolResult = (delta.recentToolResult as ToolResult | null) ?? null;
    if ("recentValidationResult" in delta) recentValidationResult = (delta.recentValidationResult as ValidationResult | null) ?? null;
    if ("latestIterationIndex" in delta) latestIterationIndex = delta.latestIterationIndex as number;
    if ("regroundedAt" in delta) regroundedAt = (delta.regroundedAt as string | null) ?? null;
    if ("ledger" in delta) ledger = delta.ledger as ProgressLedger;
    if ("noProgressCount" in delta) noProgressCount = delta.noProgressCount as number;
    if ("previousSnapshot" in delta) previousSnapshot = delta.previousSnapshot as NoProgressSnapshot;
    if ("recoveryState" in delta) recoveryState = delta.recoveryState;
    if ("strategyState" in delta) strategyState = delta.strategyState as StrategyState;
    if ("builderState" in delta) builderState = delta.builderState as BuilderState;
    if ("strategyDecision" in delta) strategyDecision = delta.strategyDecision as StrategyDecision;
    if ("regroundRequested" in delta) regroundRequested = delta.regroundRequested as boolean;
    if ("replanRequested" in delta) replanRequested = delta.replanRequested as boolean;
    if ("pendingRetryIncrement" in delta) pendingRetryIncrement = delta.pendingRetryIncrement as boolean;
    if ("finalizationPlanRejectionCount" in delta) finalizationPlanRejectionCount = delta.finalizationPlanRejectionCount as number;
    if ("validationRepairActionRejectionCount" in delta) validationRepairActionRejectionCount = delta.validationRepairActionRejectionCount as number;
    if ("pendingActionRejection" in delta) pendingActionRejection = (delta.pendingActionRejection as ModelActionRejection | null) ?? null;
  };

  if (input.resume === undefined) {
    await appendEvent("run.created", { status: activeRun.status }, activeRun.createdAt);
    const runningAt = input.now();
    activeRun = transitionRun(activeRun, "running", runningAt);
    input.runStore.updateRun(activeRun);
    await appendEvent("run.started", { status: activeRun.status }, runningAt);
    await persistLedger(ledger);
  } else {
    const resumedAt = input.now();
    if (activeRun.status !== "running") {
      activeRun = transitionRun(activeRun, "running", resumedAt);
      input.runStore.updateRun(activeRun);
    }
    await appendEvent("run.resumed", { status: activeRun.status }, resumedAt);
  }

  let regroundedAt: string | null = null;
  if (input.resume !== undefined) {
    regroundedAt = reGroundNow(input, currentWorkingSet, input.now());
    if (regroundedAt !== null) {
      await appendEvent("context.regrounded", { reason: "resume", at: regroundedAt }, regroundedAt);
    }
  }

  let previousSnapshot: NoProgressSnapshot =
    input.resume?.resumeState.previousSnapshot ?? {
      actionSignature: null,
      errorCode: null,
      ledgerVersion: ledger.version,
      evidenceCount: ledger.evidenceRefs.length,
      validationStatus: null,
      artifactHash: null
    };
  let seededAction = input.resume?.seedAction ?? null;
  let bypassApprovalForSeedAction = input.resume?.bypassApprovalForSeedAction ?? false;
  const availableTools = input.toolRuntime.getAvailableTools().filter((toolName) => ALL_TOOL_NAMES.includes(toolName));
  const MAX_ACTION_REPAIRS = 2;
  let finalizationPlanRejectionCount = input.resume?.resumeState.finalizationPlanRejectionCount ?? 0;
  let validationRepairActionRejectionCount = input.resume?.resumeState.validationRepairActionRejectionCount ?? 0;
  let pendingActionRejection: ModelActionRejection | null = null;

  for (;;) {
    try {
    let action: AgentAction | undefined;
    const currentSeededAction = seededAction;
    const usedSeededAction = currentSeededAction !== null;
    const bypassApproval = usedSeededAction && bypassApprovalForSeedAction;

    if (usedSeededAction) {
      action = currentSeededAction;
      seededAction = null;
      bypassApprovalForSeedAction = false;
    } else {
      await ensureBudget({
        appendEvent,
        now: input.now(),
        phase: "model",
        budget: input.task.input.agentRequest.budget,
        usage,
        reserveVerification: input.task.input.validationRequest !== undefined
      });

      const iterationStartedAt = input.now();
      await appendEvent("iteration.started", { index: latestIterationIndex }, iterationStartedAt);
      usage.loopCount += 1;
      usage.modelCalls += 1;

      const contextSnapshot = buildLoopContextSnapshot({
        runId: activeRun.runId,
        anchor,
        ledger,
        workingSet: currentWorkingSet,
        recentToolResult,
        recentValidationResult,
        approvalStore: input.approvalStore,
        userInputStore: input.userInputStore,
        regroundedAt,
        now: iterationStartedAt
      });
      const integrity = validateCompactionIntegrity(
        {
          anchor,
          ledger,
          openApprovals: contextSnapshot.openApprovals,
          openUserInputs: contextSnapshot.openUserInputs
        },
        contextSnapshot
      );
      if (!integrity.valid) {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "CONTEXT_COMPACTION_FAILED",
          message: `Context compaction lost required fields: ${integrity.violations.map((violation) => violation.field).join(", ")}`,
          retryable: false
        });
      }
      await appendEvent(
        "context.compacted",
        {
          trims: contextSnapshot.trims.map((trim) => ({ field: trim.field, droppedCount: trim.droppedCount })),
          regroundedAt: contextSnapshot.regroundedAt,
          openApprovals: contextSnapshot.openApprovals,
          openUserInputs: contextSnapshot.openUserInputs
        },
        iterationStartedAt
      );

      let lastRejection: ModelActionRejection | null = null;
      const strategyBeforeModel = beforeModelStrategy({
        task: input.task,
        state: strategyState,
        changedFiles,
        recentValidationResult
      });
      if (strategyBeforeModel.phaseChanged) {
        await appendEvent(
          "strategy.phase.changed",
          {
            fromPhase: strategyBeforeModel.previousPhase,
            toPhase: strategyBeforeModel.state.phase,
            reason: strategyBeforeModel.decision,
            iteration: latestIterationIndex,
            consecutiveReadActions: strategyBeforeModel.state.explorationUsage.consecutiveReadActions,
            iterationsWithoutProgress: strategyBeforeModel.state.explorationUsage.iterationsWithoutProgress
          },
          input.now()
        );
      }
      strategyState = strategyBeforeModel.state;
      strategyDecision = strategyBeforeModel.decision;
      if (strategyDecision === "fail_no_progress") {
        await appendEvent(
          "strategy.no_progress.terminal",
          {
            reason: "no_progress_threshold_reached",
            iteration: latestIterationIndex,
            consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
            iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress
          },
          input.now()
        );
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "AGENT_STRATEGY_NO_PROGRESS",
          message: "Agent strategy detected repeated exploration without progress.",
          retryable: false
        });
      }
      if (strategyDecision !== "continue_explore") {
        await appendEvent(
          "strategy.transition.required",
          {
            reason: strategyDecision,
            iteration: latestIterationIndex,
            consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
            iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress
          },
          input.now()
        );
      }
      const builderPromptContext = prepareBuilderTurn({
        strategyState,
        builderState,
        workingSet: currentWorkingSet,
        workspaceRoot: input.workspaceRoot,
        now: input.now()
      });
      if (builderPromptContext !== null) {
        builderState = builderPromptContext.state;
        for (const event of builderPromptContext.events) {
          await appendEvent(event.type, event.payload, input.now());
        }
      }
      const planningPolicyContext = buildPlanningPolicyContext({
        task: input.task,
        workspaceRoot: input.workspaceRoot,
        knownExistingFiles: currentWorkingSet?.items.map((item) => item.path) ?? []
      });
      builderState = normalizeBuilderState({
        ...builderState,
        planningPolicy: null
      });
      const strategyContext = buildStrategyPromptContext({
        state: strategyState,
        decision: strategyDecision,
        workingSet: currentWorkingSet,
        changedFiles,
        recentValidationResult,
        currentStepId: builderState.currentStepId
      });
      for (let attempt = 0; attempt <= MAX_ACTION_REPAIRS; attempt += 1) {
        if (attempt > 0) {
          usage.actionRepairCount += 1;
          usage.modelCalls += 1;
          await ensureBudget({
            appendEvent,
            now: input.now(),
            phase: "model",
            budget: input.task.input.agentRequest.budget,
            usage,
            reserveVerification: input.task.input.validationRequest !== undefined
          });
        }
        try {
          action = AgentActionSchema.parse(
            await input.modelProvider.nextAction({
              runId: activeRun.runId,
              goal: anchor.goal,
              constraints: anchor.constraints,
              successCriteria: anchor.successCriteria,
              ledger,
              workingSet: currentWorkingSet,
              recentToolResult,
              recentValidationResult,
              ...(input.task.input.validationRequest === undefined
                ? {}
                : { validationRequest: input.task.input.validationRequest }),
              budget: input.task.input.agentRequest.budget,
              usage,
              availableTools,
              regroundRequested,
              replanRequested,
              contextSnapshot,
              strategyContext,
              ...(builderPromptContext === null ? {} : { builderContext: builderPromptContext.context }),
              planningPolicyContext,
              executionPlanRepairContext: builderState.executionPlanRepair,
              lastModelError: lastRejection ?? pendingActionRejection
            })
          );
          pendingActionRejection = null;
          break;
        } catch (error) {
          const failure = describeModelActionError(error);
          const category = failure.category ?? "schema_validation";
          lastRejection = {
            category,
            attempt: attempt + 1,
            message: failure.message,
            ...(failure.issues === null ? {} : { issues: failure.issues })
          };
          await appendEvent(
            "model.action.rejected",
            {
              code: failure.code,
              message: redactForEvidence(failure.message),
              category,
              attempt: attempt + 1,
              ...(failure.issues === null ? {} : { issues: failure.issues }),
              raw: failure.raw ?? null
            },
            input.now()
          );
          if (!isActionRepairable(error) || attempt === MAX_ACTION_REPAIRS) {
            return failRun({
              input,
              run: activeRun,
              appendEvent,
              code: failure.code,
              message: failure.message,
              retryable: failure.retryable
            });
          }
        }
      }
      if (action === undefined) {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "MODEL_ACTION_INVALID",
          message: "Agent model action repair did not produce a valid action.",
          retryable: false
        });
      }

      await appendEvent(
        "model.action.generated",
        {
          type: action.type,
          ...(action.type === "tool_call" || action.type === "request_approval"
            ? { toolCallId: action.toolCall.toolCallId, toolName: action.toolCall.toolName }
            : {})
        },
        input.now()
      );
    }

    const actionSignature = JSON.stringify(action);

    if (
      requiresValidationRepairAction(recentValidationResult) &&
      !isValidationRepairAction(action, builderState, recentValidationResult)
    ) {
      validationRepairActionRejectionCount += 1;
      const rejectedAt = input.now();
      const message =
        "The latest fresh validation failed after a mutation; broad filesystem.read, off-target filesystem.read, filesystem.search, filesystem.list, project inspection, git tools, update_plan, and shell.execute source mutation are not repair actions now. Submit a focused repair execution plan or a Builder-directed repair mutation within the same Task executionConstraints, then rerun validation. filesystem.read is only repair evidence when it targets a changed file named in the failure summary or the current Builder modify target; repeated reads do not count as repair progress and must lead to a concrete mutation. Use shell.execute only to rerun validation, tests, or builds.";
      pendingActionRejection = {
        category: "validation_repair",
        attempt: validationRepairActionRejectionCount,
        message
      };
      await appendEvent(
        "model.action.rejected",
        {
          code: "VALIDATION_REPAIR_ACTION_REQUIRED",
          message,
          category: "validation_repair",
          reason: "fresh_failed_validation_requires_repair_action",
          attempt: validationRepairActionRejectionCount,
          remainingCorrectionAttempts: Math.max(0, MAX_ACTION_REPAIRS + 1 - validationRepairActionRejectionCount)
        },
        rejectedAt
      );
      ledger = applyLedgerPatch({
        ledger,
        patch: {
          appendDecisions: [message]
        },
        now: rejectedAt
      });
      await persistLedger(ledger);
      if (validationRepairActionRejectionCount > MAX_ACTION_REPAIRS) {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "VALIDATION_REPAIR_ACTION_REQUIRED",
          message,
          retryable: false
        });
      }
      await checkpoint("post_response", { note: "validation_repair_action_required" });
      previousSnapshot = {
        actionSignature,
        errorCode: "VALIDATION_REPAIR_ACTION_REQUIRED",
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: recentValidationResult.status,
        artifactHash: null
      };
      continue;
    }

    if (action.type === "submit_execution_plan" && isFreshPassingValidation(recentValidationResult)) {
      finalizationPlanRejectionCount += 1;
      const rejectedAt = input.now();
      const message =
        "A fresh passing validation already exists after the latest mutation; submit a final action instead of a new execution plan.";
      pendingActionRejection = {
        category: "completion_guidance",
        attempt: finalizationPlanRejectionCount,
        message
      };
      await appendEvent(
        "model.action.rejected",
        {
          code: "EXECUTION_PLAN_AFTER_FRESH_VALIDATION",
          message,
          category: "completion_guidance",
          reason: "fresh_validation_requires_final",
          attempt: finalizationPlanRejectionCount,
          remainingCorrectionAttempts: Math.max(0, MAX_ACTION_REPAIRS + 1 - finalizationPlanRejectionCount)
        },
        rejectedAt
      );
      ledger = applyLedgerPatch({
        ledger,
        patch: {
          appendDecisions: [message]
        },
        now: rejectedAt
      });
      await persistLedger(ledger);
      if (finalizationPlanRejectionCount > MAX_ACTION_REPAIRS) {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "EXECUTION_PLAN_UNEXPECTED",
          message,
          retryable: false
        });
      }
      await checkpoint("post_response", { note: "fresh_validation_final_required" });
      previousSnapshot = {
        actionSignature,
        errorCode: "EXECUTION_PLAN_AFTER_FRESH_VALIDATION",
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: recentValidationResult.status,
        artifactHash: null
      };
      continue;
    }

    const builderRecoveryAction =
      (recoveryState?.latestFailure?.source === "validation" || recoveryState?.latestFailure?.category === "patch_conflict") &&
      (action.type === "submit_execution_plan" ||
        ((action.type === "tool_call" || action.type === "request_approval") &&
          (action.toolCall.toolName === "filesystem.patch" || action.toolCall.toolName === "filesystem.write")));
    const strategyBypassedForRecovery =
      usedSeededAction || (recoveryState !== undefined && !builderRecoveryAction);
    const builderActionEvaluation = evaluateBuilderAction({
      strategyBypassedForRecovery,
      strategyState,
      builderState,
      action,
      workspaceRoot: input.workspaceRoot,
      now: input.now()
    });
    builderState = builderActionEvaluation.state;
    for (const event of builderActionEvaluation.events) {
      await appendEvent(event.type, event.payload, input.now());
    }
    if (!strategyBypassedForRecovery && action.type === "submit_execution_plan") {
      const outcome = await handleSubmitExecutionPlan(buildHandlerContext(actionSignature), action);
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: outcome.code,
          message: outcome.message,
          retryable: outcome.retryable
        });
      }
      if (outcome.kind === "return") {
        return outcome.result;
      }
      continue;
    }

    const strategyPolicy = strategyBypassedForRecovery
      ? ({ allowed: true } as const)
      : builderActionEvaluation.rejection !== null
        ? ({
            allowed: false as const,
            code: builderActionEvaluation.rejection.code,
            message: builderActionEvaluation.rejection.message,
            reason: builderActionEvaluation.rejection.reason
          } as const)
        : validateActionWithStrategy({
          task: input.task,
          action,
          state: strategyState,
          decision: strategyDecision
        });
    if (!strategyPolicy.allowed) {
      const rejectedAt = input.now();
      const previousStrategyRejection = strategyState.lastStrategyRejection;
      const strategyRejection = buildStrategyRejectionContext({
        action,
        policy: strategyPolicy,
        state: strategyState,
        decision: strategyDecision,
        maxActionRepairs: MAX_ACTION_REPAIRS
      });
      await appendEvent(
        "model.action.rejected",
        {
          code: strategyPolicy.code,
          message: strategyPolicy.message,
          category: "strategy_policy",
          reason: strategyPolicy.reason,
          attempt: strategyRejection.attempt,
          remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
        },
        rejectedAt
      );
      if (strategyPolicy.reason === "plan_required_before_mutation" && strategyState.plan === undefined) {
        const proposedPlan = deriveExecutionPlanFromAction({
          action,
          validationCommand: input.task.input.validationRequest?.command,
          validationArgs: input.task.input.validationRequest?.args
        });
        if (proposedPlan !== undefined && evaluateExecutionPlanCompleteness(proposedPlan).complete) {
          strategyState = {
            ...strategyState,
            plan: proposedPlan,
            noProgressCount: 0,
            explorationUsage: {
              ...strategyState.explorationUsage,
              iterationsWithoutProgress: 0
            },
            lastProgressIteration: latestIterationIndex,
            lastStrategyRejection: {
              ...strategyRejection,
              activePlan: proposedPlan,
              allowedActionCategories: ["patch", "write", "read", "git_diff", "git_status"]
            }
          };
          await appendEvent(
            "plan.created",
            {
              reason: "minimum_execution_plan_from_proposed_action",
              targetFiles: proposedPlan.targetFiles,
              intendedChanges: proposedPlan.intendedChanges,
              validationCommands: proposedPlan.validationCommands
            },
            input.now()
          );
          await appendEvent(
            "strategy.action_repair.requested",
            {
              reason: strategyPolicy.reason,
              iteration: latestIterationIndex,
              attempt: strategyRejection.attempt,
              remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
            },
            input.now()
          );
          await checkpoint("post_response", { note: "strategy_action_repair" });
          continue;
        }
      }
      if (previousStrategyRejection === undefined) {
        strategyState = {
          ...strategyState,
          lastStrategyRejection: strategyRejection
        };
        await appendEvent(
          "strategy.action_repair.requested",
          {
            reason: strategyPolicy.reason,
            iteration: latestIterationIndex,
            attempt: strategyRejection.attempt,
            remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
          },
          input.now()
        );
        await checkpoint("post_response", { note: "strategy_action_repair" });
        continue;
      }
      const rejection = onStrategyRejection({ task: input.task, state: strategyState, iteration: latestIterationIndex });
      strategyState = rejection.state;
      const repairBudgetExhausted = previousStrategyRejection.attempt >= MAX_ACTION_REPAIRS;
      if (rejection.terminal || repairBudgetExhausted) {
        await appendEvent(
          "strategy.no_progress.terminal",
          {
            reason: repairBudgetExhausted ? "strategy_repair_budget_exhausted" : strategyPolicy.reason,
            iteration: latestIterationIndex,
            consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
            iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress,
            attempt: strategyRejection.attempt,
            remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
          },
          input.now()
        );
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "AGENT_STRATEGY_NO_PROGRESS",
          message: "Agent strategy detected repeated rejected actions without progress.",
          retryable: false
        });
      }
      strategyState = {
        ...strategyState,
        lastStrategyRejection: strategyRejection
      };
      await appendEvent(
        "strategy.exploration.stalled",
        {
          reason: strategyPolicy.reason,
          iteration: latestIterationIndex,
          consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
          iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress,
          attempt: strategyRejection.attempt,
          remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
        },
        input.now()
      );
      await checkpoint("post_response", { note: "strategy_action_repair" });
      continue;
    }
    if (strategyState.lastStrategyRejection !== undefined) {
      strategyState = { ...strategyState, lastStrategyRejection: undefined };
    }

    if (action.type === "update_plan") {
      const outcome = await handleUpdatePlan(buildHandlerContext(actionSignature), action);
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: outcome.code,
          message: outcome.message,
          retryable: outcome.retryable
        });
      }
      if (outcome.kind === "return") {
        return outcome.result;
      }
      continue;
    }

    if (action.type === "ask_user") {
      {
        const outcome = await handleAskUser(
          {
            input,
            run: activeRun,
            ledger,
            appendEvent,
            checkpoint,
            nextSequence,
            latestIterationIndex,
            currentWorkingSet,
            changedFiles,
            recentToolResult,
            recentValidationResult,
            regroundRequested,
            replanRequested,
            noProgressCount,
            usage,
            previousSnapshot,
            pendingRetryIncrement,
            recoveryState,
            strategyState,
            builderState,
            finalizationPlanRejectionCount,
            validationRepairActionRejectionCount
          },
          action
        );
        if (outcome.kind === "return") {
          return outcome.result;
        }
        continue;
      }
    }

    if (action.type === "fail") {
      return failRun({
        input,
        run: activeRun,
        appendEvent,
        code: action.code,
        message: action.message,
        retryable: action.retryable
      });
    }

    if (action.type === "final") {
      const outcome = await handleFinal(buildHandlerContext(actionSignature), action);
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: outcome.code,
          message: outcome.message,
          retryable: outcome.retryable
        });
      }
      if (outcome.kind === "return") {
        return outcome.result;
      }
      continue;
    }

    if (action.type === "submit_execution_plan") {
      return failRun({
        input,
        run: activeRun,
        appendEvent,
        code: "EXECUTION_PLAN_UNEXPECTED",
        message: "Structured execution plans cannot be processed while recovery is bypassing normal strategy.",
        retryable: false
      });
    }

    if (action.type === "tool_call" || action.type === "request_approval") {
      const outcome = await handleToolCall(
        buildHandlerContext(actionSignature),
        action,
        bypassApproval,
        strategyBypassedForRecovery
      );
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: outcome.code,
          message: outcome.message,
          retryable: outcome.retryable
        });
      }
      if (outcome.kind === "return") {
        return outcome.result;
      }
      continue;
    }
    } catch (error) {
      if (error instanceof AgentLoopRunFailure) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown runtime error";
      const redacted = redactForEvidence(message);
      try {
        const failedAt = input.now();
        const failedRun = transitionRun(activeRun, "failed", failedAt, "RUNTIME_ERROR");
        input.runStore.updateRun(failedRun);
        activeRun = failedRun;
        await appendEvent(
          "run.failed",
          {
            code: "RUNTIME_ERROR",
            message: redacted,
            handler: "global_safety_net"
          },
          failedAt
        );
      } catch {
        // Safety net itself failed (e.g. disk full). Best-effort; do not recurse.
      }
      throw new AgentLoopRunFailure("RUNTIME_ERROR", redacted, false);
    }
  }
}
