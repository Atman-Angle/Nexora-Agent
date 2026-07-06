import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  AgentActionSchema,
  AgentIterationSchema,
  AgentBudgetUsageSchema,
  ALL_TOOL_NAMES,
  type AgentBudgetUsage,
  ApprovalRequestSchema,
  ValidationResultSchema,
  ValidationPlanSchema,
  computeArtifactHash,
  createCheckpoint,
  createEvent,
  createProgressLedger,
  createTextArtifact,
  type AgentAction,
  type AgentIteration,
  type ApprovalRequest,
  type Artifact,
  type BuilderState,
  type Checkpoint,
  type CheckpointPhase,
  type ContextSnapshot,
  type Event,
  type PendingAction,
  type PendingActionResumeState,
  type ProgressLedger,
  type RecoveryCheckpointState,
  type Run,
  type StrategyDecision,
  type StrategyRejectionContext,
  type StrategyState,
  type Task,
  type TaskAnchor,
  type TestResult,
  type ToolCall,
  type ToolResult,
  type UserInputRequest,
  type ValidationResult,
  type WorkingSet
} from "../../contracts/src/index.js";
import {
  buildContextSnapshot,
  collectRehydrationFilePaths,
  rehydrateWorkspaceFacts,
  validateCompactionIntegrity
} from "../../context/src/index.js";
import type { AgentLoopModelProvider, ModelActionRejection, ModelActionRejectionCategory } from "../../model-gateway/src/index.js";
import {
  ModelConfigError,
  ModelHttpError,
  ModelJsonParseError,
  ModelTimeoutError
} from "../../model-gateway/src/index.js";
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
import { classifyRisk } from "../../tool-runtime/src/index.js";
import { transitionRun } from "./state-machine.js";
import { runCompletionGate } from "./validation-gate.js";
import {
  RecoveryOrchestrator,
  createProgressFingerprint,
  normalizeToolFailure,
  normalizeValidationFailure
} from "./recovery/index.js";
import {
  afterActionStrategy,
  allowedActionCategories,
  beforeModelStrategy,
  buildStrategyPromptContext,
  categorizeToolCall,
  clearPlanRepair,
  deriveExecutionPlan,
  deriveExecutionPlanFromAction,
  evaluateExecutionPlanCompleteness,
  handlePlanRepair,
  normalizeStrategyState,
  onStrategyRejection,
  validateActionWithStrategy
} from "./strategy/index.js";
import {
  applyBuilderToolEvidence,
  buildPlanningPolicyContext,
  createExecutionPlanRepairContext,
  evaluateBuilderAction,
  installAcceptedExecutionPlan,
  normalizeBuilderState,
  prepareBuilderTurn,
  validateSubmittedExecutionPlan
} from "./builder/index.js";

type NoProgressSnapshot = {
  actionSignature: string | null;
  errorCode: string | null;
  ledgerVersion: number;
  evidenceCount: number;
  validationStatus: "passed" | "failed" | null;
  artifactHash: string | null;
};

type AgentLoopCompletedResult = {
  kind: "completed";
  run: Run;
  artifact: Artifact;
  validation: ValidationResult;
  ledger: ProgressLedger;
};

type AgentLoopWaitingForApprovalResult = {
  kind: "waiting_for_approval";
  run: Run;
  ledger: ProgressLedger;
  approval: ApprovalRequest;
};

type AgentLoopWaitingForUserResult = {
  kind: "waiting_for_user";
  run: Run;
  ledger: ProgressLedger;
  request: UserInputRequest;
};

export type AgentLoopResult =
  | AgentLoopCompletedResult
  | AgentLoopWaitingForApprovalResult
  | AgentLoopWaitingForUserResult;

export class AgentLoopRunFailure extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

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
  let finalizationPlanRejectionCount = 0;
  let validationRepairActionRejectionCount = 0;
  let pendingActionRejection: ModelActionRejection | null = null;

  for (;;) {
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
      const proposedAt = input.now();
      await appendEvent(
        "builder.execution_plan.proposed",
        {
          iteration: latestIterationIndex,
          targetFiles: action.plan.targetFiles,
          stepIds: action.steps.map((step) => step.stepId)
        },
        proposedAt
      );
      const policy = buildPlanningPolicyContext({
        task: input.task,
        workspaceRoot: input.workspaceRoot,
        knownExistingFiles: currentWorkingSet?.items.map((item) => item.path) ?? []
      });
      const validation = validateSubmittedExecutionPlan({
        plan: action.plan,
        steps: action.steps,
        policy,
        satisfiedRequiredTargets: changedFiles
      });
      if (!validation.valid) {
        const repairDecision = createExecutionPlanRepairContext({
          previous: builderState.executionPlanRepair,
          issues: validation.issues,
          previousPlan: action.plan,
          previousSteps: action.steps
        });
        builderState = normalizeBuilderState({
          ...builderState,
          planningPolicy: null,
          executionPlanRepair: repairDecision.repair,
          planAccepted: false,
          version: builderState.version + 1
        });
        await appendEvent(
          "builder.execution_plan.rejected",
          {
            iteration: latestIterationIndex,
            issueCodes: validation.issues.map((issue) => issue.code),
            issues: validation.issues,
            attempt: repairDecision.repair.attempt,
            remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
          },
          input.now()
        );
        if (repairDecision.kind === "exhaust") {
          await appendEvent(
            "builder.execution_plan.repair_exhausted",
            {
              iteration: latestIterationIndex,
              issueCodes: validation.issues.map((issue) => issue.code),
              attempt: repairDecision.repair.attempt,
              remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
            },
            input.now()
          );
          return failRun({
            input,
            run: activeRun,
            appendEvent,
            code: "EXECUTION_PLAN_INVALID",
            message: "Builder exhausted execution-plan repair attempts without a valid structured plan.",
            retryable: false
          });
        }
        await appendEvent(
          "builder.execution_plan.repair_requested",
          {
            iteration: latestIterationIndex,
            issueCodes: validation.issues.map((issue) => issue.code),
            attempt: repairDecision.repair.attempt,
            remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
          },
          input.now()
        );
        await checkpoint("post_response", { note: "builder_execution_plan_repair" });
        continue;
      }

      strategyState = clearPlanRepair({
        ...strategyState,
        plan: validation.plan,
        noProgressCount: 0,
        explorationUsage: {
          ...strategyState.explorationUsage,
          iterationsWithoutProgress: 0
        },
        lastProgressIteration: latestIterationIndex
      });
      builderState = installAcceptedExecutionPlan({
        state: builderState,
        plan: validation.plan,
        steps: validation.steps,
        policy
      });
      await appendEvent(
        "builder.execution_plan.accepted",
        {
          iteration: latestIterationIndex,
          targetFiles: validation.plan.targetFiles,
          stepIds: validation.steps.map((step) => step.stepId)
        },
        input.now()
      );
      validationRepairActionRejectionCount = 0;
      if (recoveryState?.latestFailure?.source === "validation") {
        recoveryState = undefined;
        replanRequested = false;
        regroundRequested = false;
        noProgressCount = 0;
        previousSnapshot = {
          actionSignature: null,
          errorCode: null,
          ledgerVersion: ledger.version,
          evidenceCount: ledger.evidenceRefs.length,
          validationStatus: null,
          artifactHash: null
        };
      }
      await appendEvent(
        "plan.created",
        {
          reason: "structured_execution_plan_accepted",
          iteration: latestIterationIndex,
          targetFiles: validation.plan.targetFiles,
          intendedChanges: validation.plan.intendedChanges,
          validationCommands: validation.plan.validationCommands,
          builderPlanStepCount: builderState.planSteps.length
        },
        input.now()
      );
      await checkpoint("plan_formed", { note: "structured_execution_plan_accepted" });
      const iteration = createIteration({
        iterationId: input.idGenerator(),
        runId: activeRun.runId,
        index: latestIterationIndex,
        actionType: action.type,
        status: "completed",
        usage,
        summary: action.rationale,
        evidenceRefs: [],
        now: input.now()
      });
      input.agentIterationStore.insertIteration(iteration);
      await appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
      latestIterationIndex += 1;
      previousSnapshot = {
        actionSignature,
        errorCode: null,
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: recentValidationResult?.status ?? null,
        artifactHash: null
      };
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
      ledger = applyLedgerPatch({
        ledger,
        patch: action.patch,
        now: input.now()
      });
      await persistLedger(ledger);
      await checkpoint("plan_formed");
      const iteration = createIteration({
        iterationId: input.idGenerator(),
        runId: activeRun.runId,
        index: latestIterationIndex,
        actionType: action.type,
        status: "completed",
        usage,
        summary: action.reason,
        evidenceRefs: [],
        now: input.now()
      });
      input.agentIterationStore.insertIteration(iteration);
      await appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
      latestIterationIndex += 1;
      if (builderState.planAccepted) {
        const noProgressSignals = detectNoProgress({
          previous: previousSnapshot,
          current: {
            actionSignature,
            errorCode: null,
            ledgerVersion: ledger.version,
            evidenceCount: ledger.evidenceRefs.length,
            validationStatus: recentValidationResult?.status ?? null,
            artifactHash: null
          }
        });
        previousSnapshot = {
          actionSignature,
          errorCode: null,
          ledgerVersion: ledger.version,
          evidenceCount: ledger.evidenceRefs.length,
          validationStatus: recentValidationResult?.status ?? null,
          artifactHash: null
        };
        ({ ledger, noProgressCount, regroundRequested, replanRequested } = await handleNoProgress({
          input: {
            now: input.now,
            ledgerStore: input.ledgerStore
          },
          appendEvent,
          ledger,
          noProgressCount,
          signals: noProgressSignals
        }));
        continue;
      }
      const derivedPlan = deriveExecutionPlan({
        ledger,
        validationCommand: input.task.input.validationRequest?.command,
        validationArgs: input.task.input.validationRequest?.args
      });
      if (derivedPlan === undefined) {
        const strategyAfterPlan = afterActionStrategy({
          task: input.task,
          state: strategyState,
          iteration: latestIterationIndex,
          action,
          previousWorkingSet: currentWorkingSet,
          currentWorkingSet,
          previousChangedFiles: changedFiles,
          currentChangedFiles: changedFiles,
          previousValidationResult: recentValidationResult,
          currentValidationResult: recentValidationResult
        });
        strategyState = strategyAfterPlan.state;
      } else {
        const completeness = evaluateExecutionPlanCompleteness(derivedPlan);
        if (completeness.complete) {
          const strategyAfterPlan = afterActionStrategy({
            task: input.task,
            state: clearPlanRepair(strategyState),
            iteration: latestIterationIndex,
            action,
            previousWorkingSet: currentWorkingSet,
            currentWorkingSet,
            previousChangedFiles: changedFiles,
            currentChangedFiles: changedFiles,
            previousValidationResult: recentValidationResult,
            currentValidationResult: recentValidationResult,
            plan: derivedPlan
          });
          strategyState = strategyAfterPlan.state;
          await appendEvent(
            "plan.created",
            {
              reason: "minimum_execution_plan_derived",
              iteration: latestIterationIndex,
              targetFiles: derivedPlan.targetFiles,
              intendedChanges: derivedPlan.intendedChanges,
              validationCommands: derivedPlan.validationCommands
            },
            input.now()
          );
        } else {
          const repairDecision = handlePlanRepair({
            state: strategyState,
            completeness,
            derivedPlan,
            iteration: latestIterationIndex
          });
          strategyState = repairDecision.state;
          await appendEvent(
            "plan.partial",
            {
              reason: "execution_plan_incomplete",
              iteration: latestIterationIndex,
              targetFiles: derivedPlan.targetFiles,
              intendedChanges: derivedPlan.intendedChanges,
              validationCommands: derivedPlan.validationCommands,
              missingFields: completeness.missingFields,
              attempt: repairDecision.repair.attempt,
              remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
            },
            input.now()
          );
          if (repairDecision.kind === "exhaust") {
            await appendEvent(
              "strategy.plan_repair.exhausted",
              {
                reason: "plan_repair_budget_exhausted",
                iteration: latestIterationIndex,
                missingFields: completeness.missingFields,
                attempt: repairDecision.repair.attempt,
                remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
              },
              input.now()
            );
            return failRun({
              input,
              run: activeRun,
              appendEvent,
              code: "AGENT_STRATEGY_NO_PROGRESS",
              message: "Agent strategy exhausted plan repair attempts without producing a complete execution plan.",
              retryable: false
            });
          }
          await appendEvent(
            "strategy.plan_repair.requested",
            {
              reason: "execution_plan_incomplete",
              iteration: latestIterationIndex,
              missingFields: completeness.missingFields,
              attempt: repairDecision.repair.attempt,
              remainingCorrectionAttempts: repairDecision.repair.remainingCorrectionAttempts
            },
            input.now()
          );
          await checkpoint("post_response", { note: "strategy_plan_repair" });
          continue;
        }
      }

      const noProgressSignals = detectNoProgress({
        previous: previousSnapshot,
        current: {
          actionSignature,
          errorCode: null,
          ledgerVersion: ledger.version,
          evidenceCount: ledger.evidenceRefs.length,
          validationStatus: recentValidationResult?.status ?? null,
          artifactHash: null
        }
      });
      previousSnapshot = {
        actionSignature,
        errorCode: null,
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: recentValidationResult?.status ?? null,
        artifactHash: null
      };
      ({ ledger, noProgressCount, regroundRequested, replanRequested } = await handleNoProgress({
        input: {
          now: input.now,
          ledgerStore: input.ledgerStore
        },
        appendEvent,
        ledger,
        noProgressCount,
        signals: noProgressSignals
      }));
      continue;
    }

    if (action.type === "ask_user") {
      return waitForUser({
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
        action
      });
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
      const knownEvidenceRefs = new Set([
        ...ledger.evidenceRefs,
        ...(recentValidationResult?.evidenceRecords?.map((record) => record.evidenceId) ?? [])
      ]);
      const invalidFinalEvidenceRefs = (action.evidenceRefs ?? []).filter((evidenceRef) => !knownEvidenceRefs.has(evidenceRef));
      const finalProposedAt = input.now();
      await appendEvent(
        "model.final.proposed",
        {
          evidenceRefs: action.evidenceRefs ?? [],
          textLength: action.text.length
        },
        finalProposedAt
      );

      const artifact = createTextArtifact({
        artifactId: input.idGenerator(),
        runId: activeRun.runId,
        content: action.text,
        createdAt: finalProposedAt
      });

      const verifyingAt = input.now();
      activeRun = transitionRun(activeRun, "verifying", verifyingAt);
      input.runStore.updateRun(activeRun);
      await checkpoint("pre_validation");
      const validationStartSequence = await appendEventWithSequence("validation.started", { status: activeRun.status }, verifyingAt);

      let validation = (
        await runCompletionGate({
          run: activeRun,
          task: input.task,
          ledger,
          toolResult: recentToolResult,
          latestValidationResult: recentValidationResult,
          finalArtifact: artifact,
          artifacts: input.artifactStore.getArtifactsByRun(activeRun.runId),
          events: input.eventStore.listEventsByRun(activeRun.runId),
          workspaceRoot: input.workspaceRoot,
          now: input.now(),
          idGenerator: input.idGenerator
        })
      ).validation;
      if (invalidFinalEvidenceRefs.length > 0) {
        validation = ValidationResultSchema.parse({
          ...validation,
          status: "failed",
          evidence: [
            ...validation.evidence,
            ...invalidFinalEvidenceRefs.map((evidenceRef) => ({
              code: "FINAL_EVIDENCE_MISSING",
              message: `Final referenced unknown evidence ${evidenceRef}.`
            }))
          ]
        });
      }
      validation = ValidationResultSchema.parse({
        ...validation,
        validationSequence: validationStartSequence
      });

      input.validationResultStore.upsertValidationResult({
        runId: activeRun.runId,
        result: validation,
        createdAt: input.now()
      });
      await checkpoint("post_validation");
      await appendEvent(
        "validation.completed",
        {
          status: validation.status,
          evidence: validation.evidence,
          ...(validation.failureSummary === undefined ? {} : { failureSummary: validation.failureSummary })
        },
        input.now()
      );

      const iteration = createIteration({
        iterationId: input.idGenerator(),
        runId: activeRun.runId,
        index: latestIterationIndex,
        actionType: action.type,
        status: validation.status === "passed" ? "completed" : "failed",
        usage,
        summary: "Final artifact proposed.",
        latestValidationStatus: validation.status,
        evidenceRefs: validation.evidenceRecords.map((record) => record.evidenceId),
        now: input.now()
      });
      input.agentIterationStore.insertIteration(iteration);
      await appendEvent(
        validation.status === "passed" ? "iteration.completed" : "iteration.failed",
        { index: iteration.index, actionType: iteration.actionType },
        iteration.createdAt
      );
      latestIterationIndex += 1;

      if (validation.status === "failed") {
        const evidenceRefs = validation.evidenceRecords.map((record) => record.evidenceId);
        const rejectionMessages = [
          ...new Set(
            [
              ...(input.approvalStore.hasPendingByRun(activeRun.runId) || input.userInputStore.hasPendingByRun(activeRun.runId)
                ? ["Cannot finalize: unresolved approval or user input request is still pending."]
                : []),
              ...validation.evidence.map((entry) => entry.message),
              ...invalidFinalEvidenceRefs.map(
                (evidenceRef) => `Final referenced unknown evidence ${evidenceRef}.`
              )
            ].filter((message) => message.trim().length > 0)
          )
        ];
        await appendEvent(
          "model.final.rejected",
          {
            reasons: rejectionMessages,
            evidenceRefs
          },
          input.now()
        );
        ledger = appendFailedAttempt({
          ledger,
          now: input.now(),
          actionType: "final",
          summary: rejectionMessages.join(" "),
          errorCode: "MODEL_FINAL_REJECTED",
          retryable: false,
          evidenceRefs
        });
        ledger = applyLedgerPatch({
          ledger,
          patch: {
            appendEvidenceRefs: evidenceRefs,
            appendDecisions: rejectionMessages
          },
          now: input.now()
        });
        await persistLedger(ledger);
        recentValidationResult = validation;
        activeRun = transitionRun(activeRun, "running", input.now());
        input.runStore.updateRun(activeRun);

        const noProgressSignals = detectNoProgress({
          previous: previousSnapshot,
          current: {
            actionSignature,
            errorCode: "MODEL_FINAL_REJECTED",
            ledgerVersion: ledger.version,
            evidenceCount: ledger.evidenceRefs.length,
            validationStatus: validation.status,
            artifactHash: null
          }
        });
        previousSnapshot = {
          actionSignature,
          errorCode: "MODEL_FINAL_REJECTED",
          ledgerVersion: ledger.version,
          evidenceCount: ledger.evidenceRefs.length,
          validationStatus: validation.status,
          artifactHash: null
        };
        ({ ledger, noProgressCount, regroundRequested, replanRequested } = await handleNoProgress({
          input: {
            now: input.now,
            ledgerStore: input.ledgerStore
          },
          appendEvent,
          ledger,
          noProgressCount,
          signals: noProgressSignals
        }));
        continue;
      }

      await appendEvent("model.final.accepted", { evidenceRefs: validation.evidenceRecords.map((record) => record.evidenceId) }, input.now());
      input.artifactStore.insertArtifact(artifact);
      await appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);
      const succeededAt = input.now();
      activeRun = transitionRun(activeRun, "succeeded", succeededAt);
      input.runStore.updateRun(activeRun);
      await appendEvent("run.completed", { status: activeRun.status }, succeededAt);

      return {
        kind: "completed",
        run: activeRun,
        artifact,
        validation,
        ledger
      };
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

    const toolCall = action.type === "request_approval" ? action.toolCall : action.toolCall;
    if (isCriticalAction(toolCall)) {
      return failRun({
        input,
        run: activeRun,
        appendEvent,
        code: "COMMAND_REJECTED",
        message: "Critical actions are rejected and cannot be approved in F007.",
        retryable: false
      });
    }

    const risk = classifyRisk(toolCall.toolName);
    const actionFingerprint = fingerprintAction(toolCall);
    const resourceScope = describeResourceScope(toolCall);
    const requiresApproval = risk === "write" || risk === "execute";

    if (requiresApproval && !bypassApproval) {
      const reusableGrant = input.approvalStore.findReusableGrant({
        runId: activeRun.runId,
        actionFingerprint,
        resourceScope,
        now: input.now()
      });
      if (reusableGrant === null) {
        return waitForApproval({
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
          toolCall,
          actionReason: action.type === "request_approval" ? action.reason : describeApprovalReason(toolCall)
        });
      }
    }

    await ensureBudget({
      appendEvent,
      now: input.now(),
      phase: "tool",
      budget: input.task.input.agentRequest.budget,
      usage,
      reserveVerification: false
    });

    const waitingAt = input.now();
    activeRun = transitionRun(activeRun, "waiting_for_tool", waitingAt);
    input.runStore.updateRun(activeRun);
    const toolPendingAction = createPendingAction({
      pendingActionId: input.idGenerator(),
      runId: activeRun.runId,
      actionId: toolCall.toolCallId,
      waitingFor: "tool_execution",
      action: {
        type: "tool_call",
        toolCall
      },
      resumeState: buildResumeState({
        usage,
        nextSequence: nextSequence + 1,
        currentWorkingSet,
        changedFiles,
        recentToolResult,
        recentValidationResult,
        latestIterationIndex,
        regroundRequested,
        replanRequested,
        noProgressCount,
        previousSnapshot,
        pendingRetryIncrement,
        recoveryState,
        strategyState,
        builderState
      }),
      now: input.now()
    });
    input.pendingActionStore.insertPendingAction(toolPendingAction);
    await checkpoint("pre_tool", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });
    if (toolCall.toolName === "filesystem.patch") {
      await checkpoint("pre_patch", {
        pendingActionId: toolPendingAction.pendingActionId,
        pendingActionFingerprint: actionFingerprint
      });
    } else if (toolCall.toolName === "filesystem.write") {
      await checkpoint("pre_write", {
        pendingActionId: toolPendingAction.pendingActionId,
        pendingActionFingerprint: actionFingerprint
      });
    }
    await appendEvent(
      "tool.started",
      {
        toolName: toolCall.toolName,
        risk: classifyRisk(toolCall.toolName)
      },
      waitingAt
    );
    if (toolCall.toolName === "shell.execute") {
      await appendEvent(
        "command.started",
        {
          command: toolCall.input.command,
          args: toolCall.input.args,
          cwd: toolCall.input.cwd
        },
        waitingAt
      );
    }

    const strategyPreviousWorkingSet = currentWorkingSet;
    const strategyPreviousChangedFiles = changedFiles;
    const strategyPreviousValidationResult = recentValidationResult;
    const execution = await input.toolRuntime.execute({
      runId: activeRun.runId,
      toolCall,
      workspaceRoot: input.workspaceRoot,
      artifactRoot: input.artifactRoot,
      now: input.now,
      idGenerator: input.idGenerator
    });
    usage.toolCalls += 1;
    if (pendingRetryIncrement) {
      usage.retryCount += 1;
      pendingRetryIncrement = false;
    }
    input.pendingActionStore.updatePendingAction({
      ...toolPendingAction,
      status: "resolved",
      updatedAt: input.now()
    });
    if (toolCall.toolName === "filesystem.patch") {
      await checkpoint("post_patch", {
        pendingActionId: toolPendingAction.pendingActionId,
        pendingActionFingerprint: actionFingerprint
      });
    } else if (toolCall.toolName === "filesystem.write") {
      await checkpoint("post_write", {
        pendingActionId: toolPendingAction.pendingActionId,
        pendingActionFingerprint: actionFingerprint
      });
    }
    await checkpoint("post_tool", {
      pendingActionId: toolPendingAction.pendingActionId,
      pendingActionFingerprint: actionFingerprint
    });

    if (execution.toolResult.status === "error") {
      if (toolCall.toolName === "shell.execute") {
        await appendEvent(
          "command.failed",
          {
            command: toolCall.input.command,
            error: execution.toolResult.error
          },
          input.now()
        );
      }
      await appendEvent("tool.failed", { error: execution.toolResult.error }, input.now());
      const toolFailureRejection = buildToolFailureRejection({
        toolCall,
        code: execution.toolResult.error.code,
        message: execution.toolResult.error.message
      });
      if (toolFailureRejection !== null) {
        pendingActionRejection = toolFailureRejection;
      }

      ledger = appendFailedAttempt({
        ledger,
        now: input.now(),
        actionType: "tool_call",
        summary: execution.toolResult.error.message,
        errorCode: execution.toolResult.error.code,
        retryable: execution.toolResult.error.retryable,
        evidenceRefs: []
      });
      await persistLedger(ledger);

      const iteration = createIteration({
        iterationId: input.idGenerator(),
        runId: activeRun.runId,
        index: latestIterationIndex,
        actionType: action.type,
        status: "failed",
        usage,
        summary: execution.toolResult.error.message,
        latestToolCallId: toolCall.toolCallId,
        latestExecutionRecordId: execution.executionRecord.executionId,
        evidenceRefs: [],
        now: input.now()
      });
      input.agentIterationStore.insertIteration(iteration);
      await appendEvent("iteration.failed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
      latestIterationIndex += 1;

      const resumedAt = input.now();
      activeRun = transitionRun(activeRun, "running", resumedAt);
      input.runStore.updateRun(activeRun);

      if (toolFailureRejection !== null && toolCall.toolName === "shell.execute") {
        await checkpoint("post_tool", {
          pendingActionId: toolPendingAction.pendingActionId,
          pendingActionFingerprint: actionFingerprint,
          note: "tool_failure_action_repair"
        });
        previousSnapshot = {
          actionSignature,
          errorCode: execution.toolResult.error.code,
          ledgerVersion: ledger.version,
          evidenceCount: ledger.evidenceRefs.length,
          validationStatus: recentValidationResult?.status ?? null,
          artifactHash: null
        };
        continue;
      }

      const failure = normalizeToolFailure({
        failureId: input.idGenerator(),
        runId: activeRun.runId,
        taskId: input.task.taskId,
        iteration: latestIterationIndex,
        toolResult: execution.toolResult,
        executionRecordId: execution.executionRecord.executionId,
        occurredAt: input.now()
      });
      const progressFingerprint = createProgressFingerprint({
        ledgerVersion: ledger.version,
        evidenceRefs: ledger.evidenceRefs,
        changedFiles,
        validationStatus: recentValidationResult?.status ?? null,
        validationEvidenceCodes: recentValidationResult?.evidence.map((entry) => entry.code) ?? [],
        workingSetPaths: currentWorkingSet?.items.map((item) => item.path) ?? []
      });
      const recoveryOutcome = recoveryOrchestrator.decide({
        failure,
        previousFailure: recoveryState?.latestFailure,
        previousState: recoveryState,
        progressFingerprint,
        previousProgressFingerprint: recoveryState?.progressFingerprint,
        ledger,
        workingSet: currentWorkingSet,
        recoveryBudget,
        now: input.now,
        idGenerator: input.idGenerator
      });
      recoveryState = recoveryOutcome.state;
      await checkpoint("recovery_state", {
        pendingActionId: toolPendingAction.pendingActionId,
        pendingActionFingerprint: actionFingerprint,
        note: "tool_failure_recovery"
      });
      await appendEvent(
        "failure.detected",
        {
          failureId: failure.failureId,
          source: failure.source,
          code: failure.code ?? null,
          category: failure.category
        },
        failure.occurredAt
      );
      await appendEvent(
        "failure.classified",
        {
          failureId: failure.failureId,
          category: failure.category,
          retryable: failure.retryable
        },
        input.now()
      );
      await appendEvent(
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
        await appendEvent(
          "recovery.terminal",
          {
            failureId: failure.failureId,
            decisionId: recoveryOutcome.decision.decisionId,
            category: failure.category,
            reason: recoveryOutcome.decision.reason
          },
          input.now()
        );
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: execution.toolResult.error.code,
          message: execution.toolResult.error.message,
          retryable: false
        });
      }

      if (
        recoveryOutcome.decision.disposition === "re_ground" ||
        recoveryOutcome.decision.disposition === "replan"
      ) {
        await appendEvent(
          "recovery.started",
          {
            failureId: failure.failureId,
            decisionId: recoveryOutcome.decision.decisionId,
            disposition: recoveryOutcome.decision.disposition
          },
          input.now()
        );
        if (recoveryOutcome.regroundManifest !== undefined) {
          await appendEvent(
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
          await appendEvent(
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
          now: input.now()
        });
        await persistLedger(ledger);
        regroundRequested = recoveryOutcome.decision.disposition === "re_ground";
        replanRequested = recoveryOutcome.decision.disposition === "replan";
        noProgressCount = 0;
        await checkpoint("post_tool", {
          pendingActionId: toolPendingAction.pendingActionId,
          pendingActionFingerprint: actionFingerprint,
          note: "recovery_decision"
        });
        continue;
      }

      if (recoveryOutcome.decision.disposition === "retry_same_action") {
        pendingRetryIncrement = true;
      }
      const noProgressSignals = detectNoProgress({
        previous: previousSnapshot,
        current: {
          actionSignature,
          errorCode: execution.toolResult.error.code,
          ledgerVersion: ledger.version,
          evidenceCount: ledger.evidenceRefs.length,
          validationStatus: recentValidationResult?.status ?? null,
          artifactHash: null
        }
      });
      previousSnapshot = {
        actionSignature,
        errorCode: execution.toolResult.error.code,
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: recentValidationResult?.status ?? null,
        artifactHash: null
      };
      ({ ledger, noProgressCount, regroundRequested, replanRequested } = await handleNoProgress({
        input: {
          now: input.now,
          ledgerStore: input.ledgerStore
        },
        appendEvent,
        ledger,
        noProgressCount,
        signals: noProgressSignals
      }));
      continue;
    }

    if (execution.artifacts !== undefined) {
      for (const artifact of execution.artifacts) {
        await appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);
      }
      ledger = applyLedgerPatch({
        ledger,
        patch: {
          appendArtifactRefs: execution.artifacts.map((artifact) => artifact.artifactId)
        },
        now: input.now()
      });
      await persistLedger(ledger);
    }

    if (execution.toolResult.toolName === "filesystem.search") {
      currentWorkingSet = execution.toolResult.output.workingSet;
      await appendEvent(
        "search.completed",
        {
          returnedMatches: execution.toolResult.output.result.returnedMatches,
          truncated: execution.toolResult.output.result.truncated
        },
        input.now()
      );
      await appendEvent(
        "working-set.built",
        {
          itemCount: execution.toolResult.output.workingSet.itemCount
        },
        input.now()
      );
    }

    if (execution.toolResult.toolName === "filesystem.patch") {
      await appendEvent(
        "patch.applied",
        {
          path: execution.toolResult.output.result.path,
          status: execution.toolResult.output.result.status,
          changed: execution.toolResult.output.result.changed
        },
        input.now()
      );
      if (execution.toolResult.output.result.changed) {
        regroundedAt = reGroundNow(input, currentWorkingSet, input.now());
        if (regroundedAt !== null) {
          await appendEvent("context.regrounded", { reason: "workspace_change", at: regroundedAt }, regroundedAt);
        }
      }
    }

    if (execution.toolResult.toolName === "shell.execute") {
      await appendEvent(
        "command.completed",
        {
          exitCode: execution.toolResult.output.result.exitCode,
          timedOut: execution.toolResult.output.result.timedOut,
          cancelled: execution.toolResult.output.result.cancelled
        },
        input.now()
      );
    }

    if (execution.toolResult.toolName === "filesystem.write") {
      await appendEvent(
        "patch.applied",
        {
          path: execution.toolResult.output.result.path,
          status: execution.toolResult.output.result.mode,
          changed: true
        },
        input.now()
      );
    }
    await appendEvent("tool.completed", { toolName: execution.toolResult.toolName }, input.now());

    const resumedAt = input.now();
    activeRun = transitionRun(activeRun, "running", resumedAt);
    input.runStore.updateRun(activeRun);

    recentToolResult = execution.toolResult;
    let artifactHash: string | null = null;

    if (execution.toolResult.toolName === "filesystem.patch") {
      artifactHash = execution.toolResult.output.result.newHash;
      changedFiles = appendChangedFile(changedFiles, execution.toolResult.output.result.path);
      recentValidationResult = null;
      validationRepairActionRejectionCount = 0;
      builderState = applyBuilderToolEvidence({
        builderState,
        path: execution.toolResult.output.result.path,
        evidenceRefs: [`execution:${execution.executionRecord.executionId}`],
        now: input.now()
      });
    } else if (execution.toolResult.toolName === "filesystem.write") {
      artifactHash = execution.toolResult.output.result.hash;
      changedFiles = appendChangedFile(changedFiles, execution.toolResult.output.result.path);
      recentValidationResult = null;
      validationRepairActionRejectionCount = 0;
      builderState = applyBuilderToolEvidence({
        builderState,
        path: execution.toolResult.output.result.path,
        evidenceRefs: [`execution:${execution.executionRecord.executionId}`],
        now: input.now()
      });
    }
    if (
      execution.toolResult.toolName === "shell.execute" &&
      input.task.input.validationRequest !== undefined &&
      execution.toolResult.output.result.executionRecordId.length > 0
    ) {
      recentValidationResult = await runCommandValidation({
        run: activeRun,
        task: input.task,
        toolResult: execution.toolResult,
        artifacts: input.artifactStore.getArtifactsByRun(activeRun.runId),
        changedFiles,
        validationCwd: toolCall.toolName === "shell.execute" ? toolCall.input.cwd : ".",
        workspaceRoot: input.workspaceRoot,
        now: input.now(),
        idGenerator: input.idGenerator
      });
      input.validationResultStore.upsertValidationResult({
        runId: activeRun.runId,
        result: recentValidationResult,
        createdAt: input.now()
      });
      await appendEvent(
        "validation.completed",
        {
          status: recentValidationResult.status,
          evidence: recentValidationResult.evidence,
          ...(recentValidationResult.failureSummary === undefined ? {} : { failureSummary: recentValidationResult.failureSummary })
        },
        input.now()
      );
      ledger = applyLedgerPatch({
        ledger,
        patch: {
          appendEvidenceRefs: recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
        },
        now: input.now()
      });
      if (recentValidationResult.status === "failed") {
        ledger = appendFailedAttempt({
          ledger,
          now: input.now(),
          actionType: "tool_call",
          summary: recentValidationResult.testResult?.summary ?? "Verification failed.",
          errorCode: "VALIDATION_FAILED",
          retryable: false,
          evidenceRefs: recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
        });
        const failure = normalizeValidationFailure({
          failureId: input.idGenerator(),
          runId: activeRun.runId,
          taskId: input.task.taskId,
          iteration: latestIterationIndex,
          validation: recentValidationResult,
          occurredAt: input.now()
        });
        const progressFingerprint = createProgressFingerprint({
          ledgerVersion: ledger.version,
          evidenceRefs: ledger.evidenceRefs,
          changedFiles,
          validationStatus: recentValidationResult.status,
          validationEvidenceCodes: recentValidationResult.evidence.map((entry) => entry.code),
          workingSetPaths: currentWorkingSet?.items.map((item) => item.path) ?? []
        });
        const recoveryOutcome = recoveryOrchestrator.decide({
          failure,
          previousFailure: recoveryState?.latestFailure,
          previousState: recoveryState,
          progressFingerprint,
          previousProgressFingerprint: recoveryState?.progressFingerprint,
          ledger,
          workingSet: currentWorkingSet,
          recoveryBudget,
          now: input.now,
          idGenerator: input.idGenerator
        });
        recoveryState = recoveryOutcome.state;
        await checkpoint("recovery_state", {
          note: "validation_recovery"
        });
        await appendEvent(
          "failure.detected",
          {
            failureId: failure.failureId,
            source: failure.source,
            code: failure.code ?? null,
            category: failure.category
          },
          failure.occurredAt
        );
        await appendEvent(
          "failure.classified",
          {
            failureId: failure.failureId,
            category: failure.category,
            retryable: failure.retryable
          },
          input.now()
        );
        await appendEvent(
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
          await appendEvent(
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
          await appendEvent(
            "recovery.terminal",
            {
              failureId: failure.failureId,
              decisionId: recoveryOutcome.decision.decisionId,
              category: failure.category,
              reason: recoveryOutcome.decision.reason
            },
            input.now()
          );
          await persistLedger(ledger);
          return failRun({
            input,
            run: activeRun,
            appendEvent,
            code: "RECOVERY_TERMINAL",
            message: recoveryOutcome.decision.reason,
            retryable: false
          });
        }
        replanRequested = recoveryOutcome.decision.disposition === "replan";
        regroundRequested = recoveryOutcome.decision.disposition === "re_ground";
      }
      await persistLedger(ledger);
    }

    ledger = completePlanStepFromTool({
      ledger,
      toolResult: execution.toolResult,
      executionEvidenceRefs: [`execution:${execution.executionRecord.executionId}`],
      validationEvidenceRefs:
        execution.toolResult.toolName === "shell.execute" && recentValidationResult !== null
          ? recentValidationResult.evidenceRecords.map((record) => record.evidenceId)
          : [],
      now: input.now()
    });
    await persistLedger(ledger);

    const iteration = createIteration({
      iterationId: input.idGenerator(),
      runId: activeRun.runId,
      index: latestIterationIndex,
      actionType: action.type,
      status:
        recentValidationResult !== null && execution.toolResult.toolName === "shell.execute" && recentValidationResult.status === "failed"
          ? "failed"
          : "completed",
      usage,
      summary: describeToolSuccess(execution.toolResult),
      latestToolCallId: toolCall.toolCallId,
      latestExecutionRecordId: execution.executionRecord.executionId,
      latestValidationStatus:
        execution.toolResult.toolName === "shell.execute" ? recentValidationResult?.status : undefined,
      evidenceRefs: recentValidationResult?.evidenceRecords.map((record) => record.evidenceId) ?? [],
      now: input.now()
    });
    input.agentIterationStore.insertIteration(iteration);
    await appendEvent(
      iteration.status === "completed" ? "iteration.completed" : "iteration.failed",
      { index: iteration.index, actionType: iteration.actionType },
      iteration.createdAt
    );
    latestIterationIndex += 1;

    if (!strategyBypassedForRecovery && recoveryState === undefined) {
      const strategyAfterAction = afterActionStrategy({
        task: input.task,
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
        toolResult: execution.toolResult
      });
      strategyState = strategyAfterAction.state;
      if (strategyAfterAction.stalled) {
        await appendEvent(
          "strategy.exploration.stalled",
          {
            reason: strategyAfterAction.progressReasons.length === 0 ? "no_progress" : strategyAfterAction.progressReasons.join(","),
            iteration: latestIterationIndex,
            consecutiveReadActions: strategyState.explorationUsage.consecutiveReadActions,
            iterationsWithoutProgress: strategyState.explorationUsage.iterationsWithoutProgress
          },
          input.now()
        );
      }
      if (strategyAfterAction.terminal) {
        await appendEvent(
          "strategy.no_progress.terminal",
          {
            reason: "third_stall",
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
          message: "Agent strategy detected repeated action without progress.",
          retryable: false
        });
      }
    }

    const noProgressSignals = detectNoProgress({
      previous: previousSnapshot,
      current: {
        actionSignature,
        errorCode:
          execution.toolResult.toolName === "shell.execute" && recentValidationResult?.status === "failed"
            ? "VALIDATION_FAILED"
            : null,
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: recentValidationResult?.status ?? null,
        artifactHash
      }
    });
    previousSnapshot = {
      actionSignature,
      errorCode:
        execution.toolResult.toolName === "shell.execute" && recentValidationResult?.status === "failed"
          ? "VALIDATION_FAILED"
          : null,
      ledgerVersion: ledger.version,
      evidenceCount: ledger.evidenceRefs.length,
      validationStatus: recentValidationResult?.status ?? null,
      artifactHash
    };
    ({ ledger, noProgressCount, regroundRequested, replanRequested } = await handleNoProgress({
      input: {
        now: input.now,
        ledgerStore: input.ledgerStore
      },
      appendEvent,
      ledger,
      noProgressCount,
      signals: noProgressSignals
    }));
  }
}

async function waitForApproval(input: {
  input: Parameters<typeof runAgentLoop>[0];
  run: Run;
  ledger: ProgressLedger;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  checkpoint: (
    phase: CheckpointPhase,
    options?: {
      pendingActionId?: string;
      pendingActionFingerprint?: string;
      note?: string;
    }
  ) => Promise<Checkpoint>;
  nextSequence: number;
  latestIterationIndex: number;
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  regroundRequested: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  usage: {
    loopCount: number;
    modelCalls: number;
    toolCalls: number;
    retryCount: number;
    actionRepairCount?: number | undefined;
    providerRetryCount?: number | undefined;
    startedAt: string;
  };
  previousSnapshot: NoProgressSnapshot;
  pendingRetryIncrement: boolean;
  recoveryState?: RecoveryCheckpointState | undefined;
  strategyState: StrategyState;
  builderState: BuilderState;
  toolCall: ToolCall;
  actionReason: string;
}): Promise<AgentLoopWaitingForApprovalResult> {
  const approval = ApprovalRequestSchema.parse({
    approvalId: input.input.idGenerator(),
    runId: input.run.runId,
    actionId: input.toolCall.toolCallId,
    toolCallId: input.toolCall.toolCallId,
    riskLevel: classifyRisk(input.toolCall.toolName),
    reason: input.actionReason,
    requestedCapabilities: describeCapabilities(input.toolCall),
    resourceScope: describeResourceScope(input.toolCall),
    actionSummary: describeApprovalSummary(input.toolCall),
    expiresAt: new Date(new Date(input.input.now()).getTime() + 15 * 60_000).toISOString(),
    status: "pending",
    createdAt: input.input.now()
  });
  input.input.approvalStore.insertApproval(approval);
  input.input.approvalStore.setActionFingerprint(approval.approvalId, fingerprintAction(input.toolCall));

  const waitingAt = input.input.now();
  const waitingRun = transitionRun(input.run, "waiting_for_approval", waitingAt);
  input.input.runStore.updateRun(waitingRun);
  await input.appendEvent("approval.requested", { approvalId: approval.approvalId, toolCallId: approval.toolCallId }, waitingAt);
  await input.appendEvent("run.waiting", { status: waitingRun.status, waitingFor: "approval" }, waitingAt);

  const pendingAction = createPendingAction({
    pendingActionId: input.input.idGenerator(),
    runId: input.run.runId,
    actionId: input.toolCall.toolCallId,
    waitingFor: "approval",
    approvalId: approval.approvalId,
    action: {
      type: "tool_call",
      toolCall: input.toolCall
    },
    resumeState: buildResumeState({
      usage: input.usage,
      nextSequence: input.nextSequence + 2,
      currentWorkingSet: input.currentWorkingSet,
      changedFiles: input.changedFiles,
      recentToolResult: input.recentToolResult,
      recentValidationResult: input.recentValidationResult,
      latestIterationIndex: input.latestIterationIndex,
      regroundRequested: input.regroundRequested,
      replanRequested: input.replanRequested,
      noProgressCount: input.noProgressCount,
      previousSnapshot: input.previousSnapshot,
      pendingRetryIncrement: input.pendingRetryIncrement,
      ...(input.recoveryState === undefined ? {} : { recoveryState: input.recoveryState }),
      strategyState: input.strategyState,
      builderState: input.builderState
    }),
    now: input.input.now()
  });
  input.input.pendingActionStore.insertPendingAction(pendingAction);
  await input.checkpoint("waiting_for_approval", {
    pendingActionId: pendingAction.pendingActionId,
    pendingActionFingerprint: fingerprintAction(input.toolCall)
  });

  return {
    kind: "waiting_for_approval",
    run: waitingRun,
    ledger: input.ledger,
    approval
  };
}

async function waitForUser(input: {
  input: Parameters<typeof runAgentLoop>[0];
  run: Run;
  ledger: ProgressLedger;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  checkpoint: (
    phase: CheckpointPhase,
    options?: {
      pendingActionId?: string;
      pendingActionFingerprint?: string;
      note?: string;
    }
  ) => Promise<Checkpoint>;
  nextSequence: number;
  latestIterationIndex: number;
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  regroundRequested: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  usage: {
    loopCount: number;
    modelCalls: number;
    toolCalls: number;
    retryCount: number;
    startedAt: string;
  };
  previousSnapshot: NoProgressSnapshot;
  pendingRetryIncrement: boolean;
  recoveryState?: RecoveryCheckpointState | undefined;
  strategyState: StrategyState;
  builderState: BuilderState;
  action: Extract<AgentAction, { type: "ask_user" }>;
}): Promise<AgentLoopWaitingForUserResult> {
  const request = {
    requestId: input.input.idGenerator(),
    runId: input.run.runId,
    question: input.action.question,
    expectedInputType: input.action.expectedInputType,
    required: input.action.required,
    createdAt: input.input.now(),
    status: "pending" as const
  };
  input.input.userInputStore.insertRequest(request);

  const waitingLedger = applyLedgerPatch({
    ledger: input.ledger,
    patch: {
      appendOpenQuestions: [request.question]
    },
    now: input.input.now()
  });
  input.input.ledgerStore.upsertLedger(waitingLedger);

  const waitingAt = input.input.now();
  const waitingRun = transitionRun(input.run, "waiting_for_user", waitingAt);
  input.input.runStore.updateRun(waitingRun);
  await input.appendEvent("user_input.requested", { requestId: request.requestId }, waitingAt);
  await input.appendEvent("run.waiting", { status: waitingRun.status, waitingFor: "user_input" }, waitingAt);

  const pendingAction = createPendingAction({
    pendingActionId: input.input.idGenerator(),
    runId: input.run.runId,
    actionId: request.requestId,
    waitingFor: "user_input",
    requestId: request.requestId,
    action: input.action,
    resumeState: buildResumeState({
      usage: input.usage,
      nextSequence: input.nextSequence + 2,
      currentWorkingSet: input.currentWorkingSet,
      changedFiles: input.changedFiles,
      recentToolResult: input.recentToolResult,
      recentValidationResult: input.recentValidationResult,
      latestIterationIndex: input.latestIterationIndex,
      regroundRequested: input.regroundRequested,
      replanRequested: input.replanRequested,
      noProgressCount: input.noProgressCount,
      previousSnapshot: input.previousSnapshot,
      pendingRetryIncrement: input.pendingRetryIncrement,
      ...(input.recoveryState === undefined ? {} : { recoveryState: input.recoveryState }),
      strategyState: input.strategyState,
      builderState: input.builderState
    }),
    now: input.input.now()
  });
  input.input.pendingActionStore.insertPendingAction(pendingAction);
  await input.checkpoint("waiting_for_user", {
    pendingActionId: pendingAction.pendingActionId
  });

  return {
    kind: "waiting_for_user",
    run: waitingRun,
    ledger: waitingLedger,
    request
  };
}

function buildResumeState(input: {
  usage: {
    loopCount: number;
    modelCalls: number;
    toolCalls: number;
    retryCount: number;
    startedAt: string;
  };
  nextSequence: number;
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  latestIterationIndex: number;
  regroundRequested: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  previousSnapshot: NoProgressSnapshot;
  pendingRetryIncrement: boolean;
  recoveryState?: RecoveryCheckpointState | undefined;
  strategyState: StrategyState;
  builderState?: BuilderState | undefined;
}): PendingActionResumeState {
  return {
    usage: AgentBudgetUsageSchema.parse(input.usage),
    nextSequence: input.nextSequence,
    currentWorkingSet: input.currentWorkingSet,
    changedFiles: input.changedFiles,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.recentValidationResult,
    latestIterationIndex: input.latestIterationIndex,
    regroundRequested: input.regroundRequested,
    replanRequested: input.replanRequested,
    noProgressCount: input.noProgressCount,
    previousSnapshot: input.previousSnapshot,
    pendingRetryIncrement: input.pendingRetryIncrement,
    ...(input.recoveryState === undefined ? {} : { recoveryState: input.recoveryState }),
    strategyState: input.strategyState,
    ...(input.builderState === undefined ? {} : { builderState: input.builderState })
  };
}

function createPendingAction(input: {
  pendingActionId: string;
  runId: string;
  actionId: string;
  waitingFor: PendingAction["waitingFor"];
  approvalId?: string | undefined;
  requestId?: string | undefined;
  action: AgentAction;
  resumeState: PendingActionResumeState;
  now: string;
}): PendingAction {
  return {
    pendingActionId: input.pendingActionId,
    runId: input.runId,
    actionId: input.actionId,
    waitingFor: input.waitingFor,
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    action: input.action,
    resumeState: input.resumeState,
    status: "pending",
    createdAt: input.now,
    updatedAt: input.now
  };
}

async function ensureBudget(input: {
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  now: string;
  phase: "model" | "tool";
  budget: NonNullable<Task["input"]["agentRequest"]>["budget"];
  usage: AgentBudgetUsage;
  reserveVerification: boolean;
}): Promise<void> {
  await input.appendEvent(
    "budget.checked",
    {
      phase: input.phase,
      usage: {
        loopCount: input.usage.loopCount,
        modelCalls: input.usage.modelCalls,
        toolCalls: input.usage.toolCalls,
        retryCount: input.usage.retryCount,
        actionRepairCount: input.usage.actionRepairCount,
        providerRetryCount: input.usage.providerRetryCount
      }
    },
    input.now
  );

  const durationMs = new Date(input.now).getTime() - new Date(input.usage.startedAt).getTime();
  const wouldExceed =
    input.usage.loopCount >= input.budget.maxLoopCount ||
    input.usage.modelCalls >= input.budget.maxModelCalls ||
    input.usage.toolCalls >= input.budget.maxToolCalls ||
    input.usage.retryCount > input.budget.maxRetries ||
    input.usage.actionRepairCount + input.usage.providerRetryCount > input.budget.maxRetries ||
    durationMs >= input.budget.maxDurationMs ||
    (input.reserveVerification &&
      input.phase === "tool" &&
      input.usage.toolCalls + 1 >= input.budget.maxToolCalls &&
      input.usage.modelCalls + 1 >= input.budget.maxModelCalls);

  if (!wouldExceed) {
    return;
  }

  await input.appendEvent("budget.exceeded", { phase: input.phase }, input.now);
  throw new AgentLoopRunFailure("BUDGET_EXCEEDED", "Agent budget was exhausted.", false);
}

function applyLedgerPatch(input: {
  ledger: ProgressLedger;
  patch: {
    currentStep?: string | null | undefined;
    appendPlannedSteps?: string[] | undefined;
    appendCompletedSteps?: string[] | undefined;
    appendDecisions?: string[] | undefined;
    appendEvidenceRefs?: string[] | undefined;
    appendArtifactRefs?: string[] | undefined;
    appendOpenQuestions?: string[] | undefined;
  };
  now: string;
}): ProgressLedger {
  const unique = (values: string[]) => [...new Set(values)];
  const patched = {
    ...input.ledger,
    ...(input.patch.currentStep === undefined ? {} : { currentStep: input.patch.currentStep }),
    plannedSteps: unique([...input.ledger.plannedSteps, ...(input.patch.appendPlannedSteps ?? [])]),
    completedSteps: unique([...input.ledger.completedSteps, ...(input.patch.appendCompletedSteps ?? [])]),
    decisions: unique([...input.ledger.decisions, ...(input.patch.appendDecisions ?? [])]),
    evidenceRefs: unique([...input.ledger.evidenceRefs, ...(input.patch.appendEvidenceRefs ?? [])]),
    artifactRefs: unique([...input.ledger.artifactRefs, ...(input.patch.appendArtifactRefs ?? [])]),
    openQuestions: unique([...input.ledger.openQuestions, ...(input.patch.appendOpenQuestions ?? [])]),
    version: input.ledger.version + 1,
    updatedAt: input.now
  };
  return reconcilePlanSteps(patched, input.patch, input.now);
}

function reconcilePlanSteps(
  ledger: ProgressLedger,
  patch: {
    currentStep?: string | null | undefined;
    appendPlannedSteps?: string[] | undefined;
    appendCompletedSteps?: string[] | undefined;
  },
  now: string
): ProgressLedger {
  const planSteps = ledger.planSteps.map((step) => ({ ...step, evidenceRefs: [...step.evidenceRefs] }));
  const ensureStep = (description: string, status: "planned" | "in_progress" | "completed") => {
    const existing = planSteps.find((step) => step.description === description);
    const inferredEvidenceRefs =
      status === "completed"
        ? inferPlanStepEvidenceRefs(description, ledger.evidenceRefs).length > 0
          ? inferPlanStepEvidenceRefs(description, ledger.evidenceRefs)
          : [...ledger.evidenceRefs]
        : inferPlanStepEvidenceRefs(description, ledger.evidenceRefs);
    if (existing !== undefined) {
      if (existing.status !== "completed") {
        existing.status = status;
        existing.updatedAt = now;
        if (status === "completed" && existing.evidenceRefs.length === 0 && inferredEvidenceRefs.length > 0) {
          existing.evidenceRefs = inferredEvidenceRefs;
        }
      }
      return existing;
    }

    const created = {
      stepId: `plan-step-${planSteps.length + 1}`,
      description,
      required: true,
      status,
      evidenceRefs: status === "completed" ? inferredEvidenceRefs : [],
      createdAt: now,
      updatedAt: now
    };
    planSteps.push(created);
    return created;
  };

  for (const description of patch.appendPlannedSteps ?? []) {
    ensureStep(description, "planned");
  }
  if (patch.currentStep !== undefined && patch.currentStep !== null) {
    ensureStep(patch.currentStep, "in_progress");
  }
  for (const description of patch.appendCompletedSteps ?? []) {
    ensureStep(description, "completed");
  }

  return {
    ...ledger,
    planSteps
  };
}

function inferPlanStepEvidenceRefs(descriptionText: string, ledgerEvidenceRefs: string[]): string[] {
  const description = descriptionText.toLowerCase();
  if (description.includes("reproduction")) {
    return ledgerEvidenceRefs.filter((ref) => ref.startsWith("reproduction:"));
  }
  if (description.includes("inspect")) {
    return ledgerEvidenceRefs.filter((ref) => ref.startsWith("inspect:") || ref.startsWith("git-status:"));
  }
  return [];
}

function completePlanStepFromTool(input: {
  ledger: ProgressLedger;
  toolResult: Extract<ToolResult, { status: "success" }>;
  executionEvidenceRefs: string[];
  validationEvidenceRefs: string[];
  now: string;
}): ProgressLedger {
  if (input.ledger.planSteps.length === 0) {
    return input.ledger;
  }

  const matchingSteps = input.ledger.planSteps.filter(
    (step) => step.status !== "completed" && stepMatchesTool(step.description, input.toolResult.toolName)
  );

  if (matchingSteps.length === 0) {
    return input.ledger;
  }

  const matchingStepIds = new Set(matchingSteps.map((step) => step.stepId));
  const planSteps = input.ledger.planSteps.map((step) =>
    matchingStepIds.has(step.stepId)
      ? {
          ...step,
          status: "completed" as const,
          evidenceRefs: [...new Set([...step.evidenceRefs, ...input.executionEvidenceRefs, ...input.validationEvidenceRefs])],
          updatedAt: input.now
        }
      : step
  );
  const completedSteps = [...new Set([...input.ledger.completedSteps, ...matchingSteps.map((step) => step.description)])];
  const nextCurrentStep =
    input.ledger.currentStep !== null && matchingSteps.some((step) => step.description === input.ledger.currentStep)
      ? planSteps.find((step) => step.status !== "completed")?.description ?? null
      : input.ledger.currentStep;
  const appendedEvidenceRefs = [
    ...new Set([
      ...input.ledger.evidenceRefs,
      ...matchingSteps.flatMap((step) => step.evidenceRefs),
      ...input.executionEvidenceRefs,
      ...input.validationEvidenceRefs
    ])
  ];

  return {
    ...input.ledger,
    currentStep: nextCurrentStep,
    completedSteps,
    planSteps,
    evidenceRefs: appendedEvidenceRefs,
    version: input.ledger.version + 1,
    updatedAt: input.now
  };
}

function stepMatchesTool(descriptionText: string, toolName: ToolResult["toolName"]): boolean {
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
    return description.includes("diff") || description.includes("review");
  }
  if (toolName === "git.show") {
    return description.includes("show") || description.includes("history");
  }
  if (toolName === "filesystem.list") {
    return description.includes("list");
  }
  return false;
}

function appendFailedAttempt(input: {
  ledger: ProgressLedger;
  now: string;
  actionType: "tool_call" | "update_plan" | "final" | "fail";
  summary: string;
  errorCode?: string;
  retryable: boolean;
  evidenceRefs: string[];
}): ProgressLedger {
  return {
    ...input.ledger,
    failedAttempts: [
      ...input.ledger.failedAttempts,
      {
        actionType: input.actionType,
        summary: input.summary,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        retryable: input.retryable,
        evidenceRefs: [...new Set(input.evidenceRefs)],
        createdAt: input.now
      }
    ],
    version: input.ledger.version + 1,
    updatedAt: input.now
  };
}

function createIteration(input: {
  iterationId: string;
  runId: string;
  index: number;
  actionType: AgentIteration["actionType"];
  status: AgentIteration["status"];
  usage: {
    modelCalls: number;
    toolCalls: number;
  };
  summary: string;
  latestToolCallId?: string | undefined;
  latestExecutionRecordId?: string | undefined;
  latestValidationStatus?: "passed" | "failed" | undefined;
  evidenceRefs: string[];
  now: string;
}): AgentIteration {
  return AgentIterationSchema.parse({
    schemaVersion: "1",
    iterationId: input.iterationId,
    runId: input.runId,
    index: input.index,
    actionType: input.actionType,
    status: input.status,
    modelCallCount: input.usage.modelCalls,
    toolCallCount: input.usage.toolCalls,
    summary: input.summary,
    ...(input.latestToolCallId === undefined ? {} : { latestToolCallId: input.latestToolCallId }),
    ...(input.latestExecutionRecordId === undefined ? {} : { latestExecutionRecordId: input.latestExecutionRecordId }),
    ...(input.latestValidationStatus === undefined ? {} : { latestValidationStatus: input.latestValidationStatus }),
    evidenceRefs: [...new Set(input.evidenceRefs)],
    createdAt: input.now
  });
}

async function runCommandValidation(input: {
  run: Run;
  task: Task;
  toolResult: Extract<ToolResult, { toolName: "shell.execute"; status: "success" }>;
  artifacts: Artifact[];
  changedFiles: string[];
  validationCwd: string;
  workspaceRoot: string;
  now: string;
  idGenerator: () => string;
}): Promise<ValidationResult> {
  const evidence: ValidationResult["evidence"] = [];
  const validationRequest = input.task.input.validationRequest;
  const executedValidatorIds: string[] = [];

  if (validationRequest === undefined) {
    evidence.push({
      code: "VALIDATION_PLAN_MISSING",
      message: "Validation request and plan must exist."
    });
  } else {
    const parsedPlan = ValidationPlanSchema.parse(validationRequest.validationPlan);
    if (parsedPlan.validators.length === 0) {
      evidence.push({
        code: "VALIDATION_PLAN_EMPTY",
        message: "Validation plan must include at least one validator."
      });
    }
  }

  const artifactRefs = [input.toolResult.output.result.stdoutArtifactRef, input.toolResult.output.result.stderrArtifactRef].filter(
    (artifactRef): artifactRef is string => artifactRef !== undefined
  );
  for (const artifactRef of artifactRefs) {
    const artifact = input.artifacts.find((candidate) => candidate.artifactId === artifactRef);
    if (artifact === undefined) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_MISSING",
        message: `Artifact ${artifactRef} referenced by evidence was not found.`
      });
      continue;
    }

    if (artifact.runId !== input.run.runId) {
      evidence.push({
        code: "EVIDENCE_RUN_MISMATCH",
        message: `Artifact ${artifactRef} does not belong to the current run.`
      });
      continue;
    }

    if (artifact.filePath === undefined) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_INVALID",
        message: `Artifact ${artifactRef} must be file-backed for log evidence.`
      });
      continue;
    }
  }

  if (validationRequest !== undefined) {
    for (const validator of validationRequest.validationPlan.validators) {
      executedValidatorIds.push(validator.validatorId);
      if (validator.type === "command_exit_code" && input.toolResult.output.result.exitCode !== validator.expectedExitCode) {
        evidence.push({
          code: validator.required ? "VALIDATOR_REQUIRED_FAILED" : "VALIDATOR_FAILED",
          message: `Validator ${validator.validatorId} expected exit code ${validator.expectedExitCode} but received ${String(input.toolResult.output.result.exitCode)}.`
        });
      }
    }
  }

  const evidenceRecords = [
    {
      evidenceId: input.idGenerator(),
      runId: input.run.runId,
      type: "command_result" as const,
      source: "shell.execute" as const,
      status:
        input.toolResult.output.result.exitCode === 0 && evidence.length === 0 ? ("passed" as const) : ("failed" as const),
      summary:
        input.toolResult.output.result.exitCode === 0
          ? "Command completed successfully."
          : `Command exited with ${String(input.toolResult.output.result.exitCode)}.`,
      artifactRefs,
      createdAt: input.now
    }
  ];
  const failureSummary =
    evidence.length === 0 && input.toolResult.output.result.exitCode === 0
      ? undefined
      : await buildValidationFailureSummary({
          command: validationRequest?.command ?? input.toolResult.toolName,
          cwd: input.validationCwd,
          toolResult: input.toolResult,
          artifacts: input.artifacts,
          workspaceRoot: input.workspaceRoot,
          changedFiles: input.changedFiles,
          evidenceRefs: evidenceRecords.map((record) => record.evidenceId)
        });

  const testResult: TestResult = {
    status:
      evidence.length === 0 && input.toolResult.output.result.exitCode === 0 ? "passed" : "failed",
    command: validationRequest?.command ?? input.task.input.text,
    exitCode: input.toolResult.output.result.exitCode,
    summary:
      evidence.length === 0 && input.toolResult.output.result.exitCode === 0
        ? "Verification passed."
        : `Verification failed with exit code ${String(input.toolResult.output.result.exitCode)}.`,
    evidenceRefs: evidenceRecords.map((record) => record.evidenceId),
    startedAt: new Date(new Date(input.now).getTime() - input.toolResult.output.result.durationMs).toISOString(),
    completedAt: input.now
  };

  return {
    status: evidence.length === 0 ? "passed" : "failed",
    evidence,
    executedValidatorIds,
    ...(validationRequest === undefined ? {} : { plan: validationRequest.validationPlan }),
    testResult,
    evidenceRecords,
    taskType: input.task.input.taskType,
    validationCwd: input.validationCwd,
    changedFiles: input.changedFiles,
    acceptanceResults: [],
    artifactChecks: [],
    ...(failureSummary === undefined ? {} : { failureSummary }),
    ...(input.changedFiles.length === 0
      ? {}
      : { workspaceFingerprint: await computeChangedFilesFingerprint(input.workspaceRoot, input.changedFiles) })
  };
}

async function buildValidationFailureSummary(input: {
  command: string;
  cwd: string;
  toolResult: Extract<ToolResult, { toolName: "shell.execute"; status: "success" }>;
  artifacts: Artifact[];
  workspaceRoot: string;
  changedFiles: string[];
  evidenceRefs: string[];
}): Promise<NonNullable<ValidationResult["failureSummary"]>> {
  const commandResult = input.toolResult.output.result;
  const stdout = await readCommandStream({
    summary: commandResult.stdoutSummary,
    artifactRef: commandResult.stdoutArtifactRef,
    artifacts: input.artifacts
  });
  const stderr = await readCommandStream({
    summary: commandResult.stderrSummary,
    artifactRef: commandResult.stderrArtifactRef,
    artifacts: input.artifacts
  });
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);
  const combined = [cleanStdout, cleanStderr].filter((part) => part.trim().length > 0).join("\n");
  const moduleFacts = await summarizeReferencedModuleExports({
    workspaceRoot: input.workspaceRoot,
    diagnosticText: combined,
    changedFiles: input.changedFiles
  });
  const enrichedCombined = [combined, moduleFacts].filter((part) => part.trim().length > 0).join("\n");
  const stdoutExcerpt = summarizeDiagnosticExcerpt(cleanStdout, 1000);
  const stderrExcerpt = [summarizeDiagnosticExcerpt(cleanStderr, 1000), moduleFacts]
    .filter((part) => part.trim().length > 0)
    .join("\n");
  const detection = detectFailureLocation(enrichedCombined);
  const message = summarizeFailureMessage(enrichedCombined) || `Command exited with ${String(commandResult.exitCode)}.`;
  const suggestedRepair = summarizeSuggestedRepair(enrichedCombined);
  const afterLatestMutation = input.changedFiles.length > 0;

  return {
    schemaVersion: "1",
    status: "failed",
    command: redactForEvidence(input.command),
    cwd: input.cwd,
    exitCode: commandResult.exitCode,
    freshness: afterLatestMutation ? "fresh" : "unknown",
    changedFiles: [...new Set(input.changedFiles)].sort(),
    failingFile: detection.failingFile ?? null,
    failingTestName: detection.failingTestName ?? null,
    message: limitText(redactForEvidence(message), 500),
    ...(suggestedRepair.length === 0 ? {} : { suggestedRepair: limitText(redactForEvidence(suggestedRepair), 500) }),
    stdoutExcerpt: limitText(redactForEvidence(stdoutExcerpt), 1000),
    stderrExcerpt: limitText(redactForEvidence(stderrExcerpt), 1000),
    evidenceRefs: input.evidenceRefs,
    attempt: 1,
    afterLatestMutation
  };
}

async function readCommandStream(input: {
  summary: string;
  artifactRef: string | undefined;
  artifacts: Artifact[];
}): Promise<string> {
  if (input.artifactRef !== undefined) {
    const artifact = input.artifacts.find((candidate) => candidate.artifactId === input.artifactRef);
    if (artifact?.filePath !== undefined) {
      const content = await readFile(artifact.filePath, "utf8").catch(() => null);
      if (content !== null) {
        return content;
      }
    }
  }
  return input.summary;
}

function detectFailureLocation(text: string): {
  failingFile?: string;
  failingTestName?: string;
} {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const failLine = line.match(/(?:FAIL|FAILED)\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+>\s+(.+))?/i);
    if (failLine !== null) {
      return {
        failingFile: normalizeFailurePath(failLine[1] ?? ""),
        ...(failLine[2] === undefined ? {} : { failingTestName: limitText(failLine[2].trim(), 200) })
      };
    }
    const vitestFileLine = line.match(/[❯>]\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(/i);
    if (vitestFileLine !== null) {
      const testLine = lines.slice(index + 1, index + 5).find((candidate) => /[×x]\s+.+/i.test(candidate));
      return {
        failingFile: normalizeFailurePath(vitestFileLine[1] ?? ""),
        ...(testLine === undefined ? {} : { failingTestName: limitText(testLine.replace(/^[×x]\s+/, "").trim(), 200) })
      };
    }
  }

  const fileMatch = text.match(/([A-Za-z0-9_.\-\\/]+(?:test|spec)\.[cm]?[jt]sx?)/i);
  if (fileMatch !== null) {
    return { failingFile: normalizeFailurePath(fileMatch[1] ?? "") };
  }
  const buildFileMatch = text.match(/([A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?)\s*(?:\(\d+:\d+\)|:\d+:\d+)/i);
  if (buildFileMatch !== null) {
    return { failingFile: normalizeFailurePath(buildFileMatch[1] ?? "") };
  }
  return {};
}

function summarizeSuggestedRepair(text: string): string {
  const exportMismatch = text.match(
    /([A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?)\s*(?:\(\d+:\d+\)|:\d+:\d+):\s*"([^"]+)"\s+is not exported by\s+"([^"]+)",\s+imported by\s+"([^"]+)"/i
  );
  if (exportMismatch !== null) {
    const reportedFile = normalizeFailurePath(exportMismatch[1] ?? "");
    const importedName = exportMismatch[2] ?? "";
    const exporter = normalizeFailurePath(exportMismatch[3] ?? "");
    const importer = normalizeFailurePath(exportMismatch[4] ?? reportedFile);
    const exporterFacts = findModuleExportFact(text, exporter);
    if (importedName === "default" && exporterFacts?.namedExports.length === 1 && !exporterFacts.defaultExportPresent) {
      return `Module import/export mismatch: ${importer} imports default from ${exporter}, but ${exporter} exposes named export ${exporterFacts.namedExports[0]}. Prefer repairing the importing file to use a named import when it is editable/changed; scan the same importing file and align every local component import with its module exports before rerunning validation.`;
    }
    if (importedName !== "default" && exporterFacts?.defaultExportPresent === true && exporterFacts.namedExports.length === 0) {
      return `Module import/export mismatch: ${importer} imports named export ${importedName} from ${exporter}, but ${exporter} exposes only a default export. Prefer repairing the importing file to use a default import when it is editable/changed; scan the same importing file and align every local component import with its module exports before rerunning validation.`;
    }
    return `Module import/export mismatch: align the import of ${importedName} in ${importer} with the exports reported for ${exporter}; scan the same importing file and align every local component import with its module exports before rerunning validation.`;
  }
  if (/Found a label with the text of:|no form control was found associated to that label|htmlFor|aria-labelledby/i.test(text)) {
    return "Label/control association failed: ensure the label is associated with the intended form control by wrapping the control in the label or using htmlFor that exactly matches the input id; rerun validation.";
  }
  if (/Element type is invalid/i.test(text)) {
    return "Component import/export mismatch: inspect the changed file's local component imports and align every default import with a default export and every named import with a named export before rerunning validation.";
  }
  if (/toBeChecked\(\)|Received element is not checked/i.test(text)) {
    return "Checkbox assertion failed: make the target checkbox checked by default using a boolean checked/defaultChecked value or boolean state initialized to true; do not use a string checked attribute, and rerun validation.";
  }
  return "";
}

function findModuleExportFact(text: string, modulePath: string): { defaultExportPresent: boolean; namedExports: string[] } | null {
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const factMatch = text.match(new RegExp(`Module export facts for ${escapedPath}: default export: (present|absent); named exports: ([^\\n.]+|none)\\.`, "i"));
  if (factMatch === null) {
    return null;
  }
  const namedExportText = (factMatch[2] ?? "").trim();
  return {
    defaultExportPresent: (factMatch[1] ?? "").toLowerCase() === "present",
    namedExports:
      namedExportText.toLowerCase() === "none"
        ? []
        : namedExportText
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
  };
}

function isFreshPassingValidation(validation: ValidationResult | null): validation is ValidationResult {
  if (validation?.status !== "passed") {
    return false;
  }
  return validation.freshness?.valid !== false;
}

function requiresValidationRepairAction(validation: ValidationResult | null): validation is ValidationResult {
  if (validation?.status !== "failed") {
    return false;
  }
  return validation.failureSummary?.afterLatestMutation === true && validation.failureSummary.freshness === "fresh";
}

function isValidationRepairAction(
  action: AgentAction,
  builderState: BuilderState,
  validation: ValidationResult
): boolean {
  if (action.type === "final" || action.type === "fail" || action.type === "ask_user") {
    return true;
  }
  if (action.type === "submit_execution_plan") {
    return true;
  }
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (isChangedFileRepairReadAction(action, validation) || isBuilderTargetReadAction(action, builderState)) {
    return true;
  }
  return (
    action.toolCall.toolName === "filesystem.patch" ||
    action.toolCall.toolName === "filesystem.write" ||
    isValidationShellAction(action)
  );
}

function isChangedFileRepairReadAction(
  action: AgentAction,
  validation: ValidationResult
): boolean {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (action.toolCall.toolName !== "filesystem.read") {
    return false;
  }
  const path = (action.toolCall.input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  const summary = validation.failureSummary;
  if (summary === undefined || summary.afterLatestMutation !== true || summary.freshness !== "fresh") {
    return false;
  }
  const normalizedPath = normalizeWorkspaceRelativePath(path);
  return summary.changedFiles.map(normalizeWorkspaceRelativePath).includes(normalizedPath);
}

function isBuilderTargetReadAction(action: AgentAction, builderState: BuilderState): boolean {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (action.toolCall.toolName !== "filesystem.read") {
    return false;
  }
  if (builderState.currentStepId === null) {
    return false;
  }
  const path = (action.toolCall.input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  const currentStep = builderState.planSteps.find((step) => step.stepId === builderState.currentStepId);
  if (currentStep === undefined || currentStep.operation !== "modify") {
    return false;
  }
  const normalizedPath = normalizeWorkspaceRelativePath(path);
  return currentStep.targetFiles.map(normalizeWorkspaceRelativePath).includes(normalizedPath);
}

function isValidationShellAction(action: AgentAction): boolean {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (action.toolCall.toolName !== "shell.execute") {
    return false;
  }
  const input = action.toolCall.input as { purpose?: string; args?: string[] };
  const purpose = input.purpose ?? "";
  const args = input.args ?? [];
  return /(validat|verif|test|build)/i.test(purpose) && !args.includes("-e");
}

function summarizeFailureMessage(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const concrete = lines.find((line) => isConcreteDiagnosticLine(line));
  if (concrete !== undefined) {
    return concrete;
  }
  const preferred =
    lines.find((line) => /(Error|Assertion|Expected|Unable|Cannot|Received|expected)/i.test(line)) ??
    lines.find((line) => /(failed|FAIL)/i.test(line));
  return preferred ?? lines[0] ?? "";
}

function summarizeDiagnosticExcerpt(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  const diagnostic = collectDiagnosticWindow(normalized, limit);
  if (diagnostic.length > 0) {
    return diagnostic;
  }
  const headLength = Math.floor((limit - 5) / 2);
  const tailLength = limit - 5 - headLength;
  return `${normalized.slice(0, headLength)}\n...\n${normalized.slice(normalized.length - tailLength)}`;
}

function collectDiagnosticWindow(text: string, limit: number): string {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const selected: string[] = [];
  const concreteIndex = lines.findIndex((line) => isConcreteDiagnosticLine(line));
  const fallbackIndex = lines.findIndex((line) => isDiagnosticLine(line));
  const startIndex = concreteIndex >= 0 ? concreteIndex : fallbackIndex;
  if (startIndex < 0) {
    return "";
  }

  const contextStart = Math.max(0, startIndex - 3);
  const contextEnd = Math.min(lines.length, startIndex + 8);
  for (const line of lines.slice(contextStart, contextEnd)) {
    if (line.trim().length === 0 && selected.at(-1)?.trim().length === 0) {
      continue;
    }
    selected.push(line);
  }

  const withEarlierHeader = findNearbyDiagnosticHeader(lines, startIndex);
  if (withEarlierHeader !== undefined && !selected.includes(withEarlierHeader)) {
    selected.unshift(withEarlierHeader);
  }

  const summary = selected.join("\n").trim();
  if (summary.length <= limit) {
    return summary;
  }
  const concreteLine = lines[startIndex]?.trim() ?? "";
  if (concreteLine.length >= limit) {
    return `${concreteLine.slice(0, limit - 3)}...`;
  }
  return `${summary.slice(0, Math.max(0, limit - concreteLine.length - 8))}\n...\n${concreteLine}`;
}

function findNearbyDiagnosticHeader(lines: string[], diagnosticIndex: number): string | undefined {
  const searchStart = Math.max(0, diagnosticIndex - 20);
  for (let index = diagnosticIndex - 1; index >= searchStart; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (/error during build|build failed|test failed|failed tests|failures|\.(?:test|spec)\.[cm]?[jt]sx?/i.test(line)) {
      return line;
    }
  }
  return undefined;
}

function isConcreteDiagnosticLine(line: string): boolean {
  return (
    /[A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?\s*(?:\(\d+:\d+\)|:\d+:\d+)/i.test(line) ||
    /(TestingLibraryElementError|AssertionError|SyntaxError|TypeError|ReferenceError|RollupError|TransformPluginContext)/i.test(line) ||
    /(Expected|Unexpected|Cannot|Could not resolve|Unable to find|Found a label|Received)/i.test(line)
  );
}

function isDiagnosticLine(line: string): boolean {
  return isConcreteDiagnosticLine(line) || /(error during build|build failed|test failed|failed|FAIL)/i.test(line);
}

async function summarizeReferencedModuleExports(input: {
  workspaceRoot: string;
  diagnosticText: string;
  changedFiles: string[];
}): Promise<string> {
  const resolutionFacts = await summarizeModuleResolutionFacts(input);
  const referencedPaths = detectWorkspaceModulePaths(input.diagnosticText);
  const facts: string[] = [];
  for (const path of referencedPaths.slice(0, 4)) {
    const content = await readFile(join(input.workspaceRoot, path), "utf8").catch(() => null);
    if (content === null) {
      continue;
    }
    const exportFacts = summarizeExports(content);
    if (exportFacts === null) {
      continue;
    }
    facts.push(`Module export facts for ${path}: ${exportFacts}.`);
  }
  const localImportFacts = shouldSummarizeLocalImportFacts(input.diagnosticText)
      ? await summarizeChangedFileLocalImportFacts({
        workspaceRoot: input.workspaceRoot,
        changedFiles: input.changedFiles,
        diagnosticText: input.diagnosticText
      })
    : "";
  return [resolutionFacts, ...facts, localImportFacts].filter((part) => part.trim().length > 0).join("\n");
}

function shouldSummarizeLocalImportFacts(diagnosticText: string): boolean {
  return /Element type is invalid/i.test(diagnosticText);
}

async function summarizeChangedFileLocalImportFacts(input: {
  workspaceRoot: string;
  changedFiles: string[];
  diagnosticText: string;
}): Promise<string> {
  const facts: string[] = [];
  for (const changedFile of prioritizeChangedFilesForLocalImportFacts({
    changedFiles: input.changedFiles,
    diagnosticText: input.diagnosticText
  })) {
    const importer = normalizeDiagnosticWorkspacePath(changedFile);
    if (importer === null) {
      continue;
    }
    const content = await readFile(join(input.workspaceRoot, importer), "utf8").catch(() => null);
    if (content === null) {
      continue;
    }
    for (const importFact of await summarizeLocalImportsForFile({
      workspaceRoot: input.workspaceRoot,
      importer,
      content
    })) {
      facts.push(importFact);
      if (facts.length >= 8) {
        return facts.join("\n");
      }
    }
  }
  return facts.join("\n");
}

function prioritizeChangedFilesForLocalImportFacts(input: {
  changedFiles: string[];
  diagnosticText: string;
}): string[] {
  const changedFiles = [...new Set(input.changedFiles.map(normalizeWorkspaceRelativePath))].sort();
  const detected = detectFailureLocation(input.diagnosticText).failingFile;
  if (detected === undefined || !/(?:test|spec)\.[cm]?[jt]sx?$/i.test(detected)) {
    return changedFiles;
  }
  const sourceCandidate = detected.replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/i, "$1");
  if (changedFiles.includes(sourceCandidate)) {
    return [sourceCandidate];
  }
  return changedFiles;
}

async function summarizeLocalImportsForFile(input: {
  workspaceRoot: string;
  importer: string;
  content: string;
}): Promise<string[]> {
  const facts: string[] = [];
  const importPattern = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(input.content)) !== null) {
    const importClause = (match[1] ?? "").replace(/\s+/g, " ").trim();
    const specifier = match[2] ?? "";
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolved = await resolveLocalModuleFile({
      workspaceRoot: input.workspaceRoot,
      importer: input.importer,
      specifier
    });
    if (resolved === null) {
      continue;
    }
    const exportFacts = summarizeExports(resolved.content);
    if (exportFacts === null) {
      continue;
    }
    facts.push(
      `Local import/export facts: ${input.importer} imports ${summarizeImportClause(
        importClause
      )} from ${resolved.path}; Module export facts for ${resolved.path}: ${exportFacts}.`
    );
  }
  return facts;
}

async function resolveLocalModuleFile(input: {
  workspaceRoot: string;
  importer: string;
  specifier: string;
}): Promise<{ path: string; content: string } | null> {
  const importerDir = input.importer.split("/").slice(0, -1).join("/");
  const resolvedBase = normalizeWorkspaceRelativePath(join(importerDir, input.specifier));
  if (!resolvedBase.startsWith("src/") || resolvedBase.includes("..")) {
    return null;
  }
  const candidates = /\.[cm]?[jt]sx?$/.test(resolvedBase)
    ? [resolvedBase]
    : [
        `${resolvedBase}.tsx`,
        `${resolvedBase}.ts`,
        `${resolvedBase}.jsx`,
        `${resolvedBase}.js`,
        `${resolvedBase}/index.tsx`,
        `${resolvedBase}/index.ts`,
        `${resolvedBase}/index.jsx`,
        `${resolvedBase}/index.js`
      ];
  for (const candidate of candidates) {
    if (!/^src\/[A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?$/.test(candidate)) {
      continue;
    }
    const content = await readFile(join(input.workspaceRoot, candidate), "utf8").catch(() => null);
    if (content !== null) {
      return { path: candidate.replace(/\\/g, "/"), content };
    }
  }
  return null;
}

function summarizeImportClause(importClause: string): string {
  const namedMatch = importClause.match(/\{([^}]+)\}/);
  const namedImports =
    namedMatch === null
      ? []
      : (namedMatch[1] ?? "")
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/i)[0]?.trim() ?? "")
          .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
          .sort();
  const withoutNamed = importClause.replace(/\{[^}]+\}/g, "").replace(/,\s*$/, "").trim();
  const defaultImport = withoutNamed.length > 0 && !withoutNamed.startsWith("*") ? withoutNamed.split(",")[0]?.trim() : "";
  const parts = [];
  if (defaultImport !== undefined && defaultImport.length > 0) {
    parts.push(`default ${defaultImport}`);
  }
  if (namedImports.length > 0) {
    parts.push(`named ${namedImports.join(", ")}`);
  }
  return parts.length === 0 ? "side-effect only" : parts.join("; ");
}

async function summarizeModuleResolutionFacts(input: {
  workspaceRoot: string;
  diagnosticText: string;
}): Promise<string> {
  const facts: string[] = [];
  const pattern = /Could not resolve\s+"([^"]+)"\s+from\s+"([^"]+\.[cm]?[jt]sx?)"/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input.diagnosticText)) !== null) {
    const specifier = match[1] ?? "";
    const importer = normalizeDiagnosticWorkspacePath(match[2] ?? "");
    if (importer === null || !specifier.startsWith(".")) {
      continue;
    }
    const importerDir = importer.split("/").slice(0, -1).join("/");
    const resolvedBase = normalizeWorkspaceRelativePath(join(importerDir, specifier));
    const candidates = await findWorkspaceModuleCandidates({
      workspaceRoot: input.workspaceRoot,
      basename: specifier.replace(/\\/g, "/").split("/").pop() ?? ""
    });
    facts.push(
      `Relative import ${specifier} from ${importer} resolves to ${resolvedBase}; candidate files: ${
        candidates.length === 0 ? "none" : candidates.join(", ")
      }.`
    );
  }
  return facts.slice(0, 4).join("\n");
}

async function findWorkspaceModuleCandidates(input: {
  workspaceRoot: string;
  basename: string;
}): Promise<string[]> {
  if (!/^[A-Za-z0-9_.-]+$/.test(input.basename)) {
    return [];
  }
  const candidates: string[] = [];
  const srcRoot = join(input.workspaceRoot, "src");
  await collectWorkspaceModuleCandidates({
    root: srcRoot,
    relativeRoot: "src",
    basename: input.basename,
    candidates
  });
  return candidates.sort().slice(0, 8);
}

async function collectWorkspaceModuleCandidates(input: {
  root: string;
  relativeRoot: string;
  basename: string;
  candidates: string[];
}): Promise<void> {
  const entries = await readdir(input.root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relativePath = `${input.relativeRoot}/${entry.name}`;
    const absolutePath = join(input.root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      await collectWorkspaceModuleCandidates({
        root: absolutePath,
        relativeRoot: relativePath,
        basename: input.basename,
        candidates: input.candidates
      });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const extensionless = entry.name.replace(/\.[cm]?[jt]sx?$/, "");
    if (extensionless === input.basename && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      input.candidates.push(relativePath.replace(/\\/g, "/"));
    }
  }
}

function detectWorkspaceModulePaths(text: string): string[] {
  const paths = new Set<string>();
  const quotedSourcePattern = /(?:by|from|imported by|resolve)\s+"([^"]+\.[cm]?[jt]sx?)"/gi;
  let quoted: RegExpExecArray | null;
  while ((quoted = quotedSourcePattern.exec(text)) !== null) {
    const normalized = normalizeDiagnosticWorkspacePath(quoted[1] ?? "");
    if (normalized !== null) {
      paths.add(normalized);
    }
  }
  const filePattern = /((?:[A-Za-z]:)?[A-Za-z0-9_.:\-\\/]+\/src\/[A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?)/gi;
  let file: RegExpExecArray | null;
  while ((file = filePattern.exec(text)) !== null) {
    const normalized = normalizeDiagnosticWorkspacePath(file[1] ?? "");
    if (normalized !== null) {
      paths.add(normalized);
    }
  }
  return [...paths].sort();
}

function normalizeDiagnosticWorkspacePath(path: string): string | null {
  const withoutQuery = path.split("?")[0] ?? "";
  const normalized = withoutQuery.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const srcIndex = normalized.lastIndexOf("/src/");
  const workspaceRelative = srcIndex >= 0 ? normalized.slice(srcIndex + 1) : normalized;
  if (!/^src\/[A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?$/.test(workspaceRelative)) {
    return null;
  }
  if (workspaceRelative.includes("..")) {
    return null;
  }
  return workspaceRelative;
}

function normalizeWorkspaceRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function summarizeExports(content: string): string | null {
  const named = new Set<string>();
  const defaultExport = /\bexport\s+default\b/.test(content);
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      named.add(match[1] ?? "");
    }
  }
  const exportListPattern = /\bexport\s*\{([^}]+)\}/g;
  let listMatch: RegExpExecArray | null;
  while ((listMatch = exportListPattern.exec(content)) !== null) {
    for (const part of (listMatch[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/i).pop()?.trim();
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) {
        named.add(name);
      }
    }
  }
  const namedExports = [...named].filter((name) => name.length > 0).sort().slice(0, 12);
  if (namedExports.length === 0 && !defaultExport) {
    return null;
  }
  return `default export: ${defaultExport ? "present" : "absent"}; named exports: ${
    namedExports.length === 0 ? "none" : namedExports.join(", ")
  }`;
}

function normalizeFailurePath(path: string): string {
  return stripAnsi(path).replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function limitText(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ""
  );
}

function appendChangedFile(changedFiles: string[], nextPath: string): string[] {
  return [...new Set([...changedFiles, nextPath])];
}

async function computeChangedFilesFingerprint(workspaceRoot: string, changedFiles: string[]): Promise<string | undefined> {
  if (changedFiles.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const changedFile of [...new Set(changedFiles)].sort()) {
    const absolutePath = join(workspaceRoot, changedFile);
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    parts.push(`${changedFile}:${content === null ? "missing" : computeArtifactHash(content)}`);
  }

  return computeArtifactHash(parts.join("|"));
}

function detectNoProgress(input: {
  previous: NoProgressSnapshot;
  current: NoProgressSnapshot;
}): string[] {
  const signals: string[] = [];
  const sameAction =
    input.previous.actionSignature !== null && input.previous.actionSignature === input.current.actionSignature;
  const sameError = input.previous.errorCode !== null && input.previous.errorCode === input.current.errorCode;
  const sameFailedValidation =
    input.previous.validationStatus !== null &&
    input.previous.validationStatus === input.current.validationStatus &&
    input.current.validationStatus === "failed";
  const sameArtifactHash =
    input.previous.artifactHash !== null &&
    input.current.artifactHash !== null &&
    input.previous.artifactHash === input.current.artifactHash;

  if (sameAction) {
    signals.push("same_action");
  }
  if (sameError) {
    signals.push("same_error");
  }
  if (sameAction && input.previous.ledgerVersion === input.current.ledgerVersion) {
    signals.push("ledger_unchanged");
  }
  if ((sameAction || sameError || sameFailedValidation) && input.previous.evidenceCount === input.current.evidenceCount) {
    signals.push("no_new_evidence");
  }
  if (sameFailedValidation) {
    signals.push("validation_not_improved");
  }
  if (sameArtifactHash) {
    signals.push("file_hash_unchanged");
  }

  return [...new Set(signals)];
}

async function handleNoProgress(input: {
  input: {
    now: () => string;
    ledgerStore: LedgerStore;
  };
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  ledger: ProgressLedger;
  noProgressCount: number;
  signals: string[];
}): Promise<{
  ledger: ProgressLedger;
  noProgressCount: number;
  regroundRequested: boolean;
  replanRequested: boolean;
}> {
  if (input.signals.length === 0) {
    return {
      ledger: input.ledger,
      noProgressCount: 0,
      regroundRequested: false,
      replanRequested: false
    };
  }

  const now = input.input.now();
  await input.appendEvent("no_progress.detected", { signals: input.signals }, now);
  await input.appendEvent("recovery.no_progress.detected", { signals: input.signals }, now);
  const nextCount = input.noProgressCount + 1;

  if (nextCount === 1) {
    const ledger = applyLedgerPatch({
      ledger: input.ledger,
      patch: {
        appendDecisions: [`Re-ground requested due to: ${input.signals.join(", ")}`]
      },
      now
    });
    input.input.ledgerStore.upsertLedger(ledger);
    await input.appendEvent("reground.requested", { signals: input.signals }, now);
    return {
      ledger,
      noProgressCount: nextCount,
      regroundRequested: true,
      replanRequested: false
    };
  }

  if (nextCount === 2) {
    const ledger = applyLedgerPatch({
      ledger: input.ledger,
      patch: {
        appendDecisions: [`Re-plan requested due to: ${input.signals.join(", ")}`]
      },
      now
    });
    input.input.ledgerStore.upsertLedger(ledger);
    await input.appendEvent("replan.requested", { signals: input.signals }, now);
    return {
      ledger,
      noProgressCount: nextCount,
      regroundRequested: false,
      replanRequested: true
    };
  }

  throw new AgentLoopRunFailure("NO_PROGRESS", `Agent loop stalled: ${input.signals.join(", ")}.`, false);
}

async function failRun(input: {
  input: {
    now: () => string;
    runStore: RunStore;
  };
  run: Run;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  code: string;
  message: string;
  retryable: boolean;
}): Promise<never> {
  const failedAt = input.input.now();
  const failedRun = transitionRun(input.run, "failed", failedAt, input.code);
  input.input.runStore.updateRun(failedRun);
  await input.appendEvent("run.failed", { code: input.code, message: input.message }, failedAt);
  throw new AgentLoopRunFailure(input.code, input.message, input.retryable);
}

type ModelActionFailure = {
  code: string;
  message: string;
  retryable: boolean;
  raw: unknown;
  category: ModelActionRejectionCategory | null;
  issues: Array<{ path: string; message: string }> | null;
};

function summarizeZodIssues(issues: Array<{ path: PropertyKey[]; message: string }>): {
  summary: string;
  plain: Array<{ path: string; message: string }>;
} {
  const plain = issues.slice(0, 5).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message
  }));
  const summary = plain.map((i) => `${i.path}: ${i.message}`).join("; ");
  const suffix = issues.length > 5 ? `; (+${String(issues.length - 5)} more)` : "";
  return { summary: `${summary}${suffix}`, plain };
}

function describeModelActionError(error: unknown): ModelActionFailure {
  if (error instanceof ModelConfigError) {
    return { code: "MODEL_CONFIG_ERROR", message: error.message, retryable: false, raw: null, category: null, issues: null };
  }
  if (error instanceof ModelTimeoutError) {
    return { code: error.code, message: error.message, retryable: error.retryable, raw: null, category: null, issues: null };
  }
  if (error instanceof ModelHttpError) {
    return { code: error.code, message: error.message, retryable: error.retryable, raw: null, category: null, issues: null };
  }
  if (error instanceof ModelJsonParseError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      raw: null,
      category: "json_parse",
      issues: null
    };
  }
  if (error instanceof Error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    const issues = (error as unknown as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    const { summary, plain } = summarizeZodIssues(issues);
    return {
      code: "MODEL_ACTION_INVALID",
      message: `Agent model produced an action that failed schema validation. ${summary}`,
      retryable: false,
      raw: { issues: plain },
      category: "schema_validation",
      issues: plain
    };
  }
  if (error instanceof Error) {
    return {
      code: "MODEL_ACTION_INVALID",
      message: `Agent model produced an invalid action: ${error.message}`,
      retryable: false,
      raw: null,
      category: null,
      issues: null
    };
  }
  return {
    code: "MODEL_ACTION_INVALID",
    message: "Agent model produced an invalid action.",
    retryable: false,
    raw: null,
    category: null,
    issues: null
  };
}

function buildToolFailureRejection(input: {
  toolCall: ToolCall;
  code: string;
  message: string;
}): ModelActionRejection | null {
  if (!/(PATCH_|IDEMPOTENCY_CONFLICT)/i.test(input.code)) {
    return null;
  }
  if (input.toolCall.toolName === "shell.execute") {
    const toolInput = input.toolCall.input as { idempotencyKey?: string; purpose?: string };
    const idempotencyKey = toolInput.idempotencyKey ?? input.toolCall.toolCallId;
    return {
      category: "tool_failure_recovery",
      attempt: 1,
      message: [
        `Tool shell.execute failed with ${input.code}: ${input.message}`,
        `Do not repeat the same toolCallId or idempotencyKey (${idempotencyKey}).`,
        "If this was a validation, test, or build rerun, submit the same validation command again with a fresh toolCallId and fresh idempotencyKey.",
        "Do not mutate source through shell.execute; use it only for validation, tests, or builds after Builder-controlled mutations."
      ].join(" ")
    };
  }
  if (input.toolCall.toolName !== "filesystem.patch" && input.toolCall.toolName !== "filesystem.write") {
    return null;
  }
  const toolInput = input.toolCall.input as { path?: string; idempotencyKey?: string };
  const path = toolInput.path ?? "the Builder-bound target file";
  const idempotencyKey = toolInput.idempotencyKey ?? input.toolCall.toolCallId;
  return {
    category: "tool_failure_recovery",
    attempt: 1,
    message: [
      `Tool ${input.toolCall.toolName} failed with ${input.code}: ${input.message}`,
      `Target path: ${path}.`,
      `Do not repeat the same patch, toolCallId, or idempotencyKey (${idempotencyKey}).`,
      "Use a new idempotencyKey and either submit a focused repair execution plan, use filesystem.write for the same Builder-bound target, or create a new filesystem.patch from current file content.",
      "Stay within Task.input.executionConstraints and rerun validation after the mutation."
    ].join(" ")
  };
}

function buildStrategyRejectionContext(input: {
  action: AgentAction;
  policy: { code: string; reason: string; message: string };
  state: StrategyState;
  decision: StrategyDecision;
  maxActionRepairs: number;
}): StrategyRejectionContext {
  const previousAttempt = input.state.lastStrategyRejection?.attempt ?? 0;
  const attempt = previousAttempt + 1;
  return {
    rejectedActionType: input.action.type,
    rejectedActionCategory: describeActionCategory(input.action),
    rejectionCode: input.policy.code,
    rejectionReason: input.policy.reason,
    currentPhase: input.state.phase,
    requiredDecision: input.decision,
    allowedActionCategories: allowedActionCategories(input.state.phase, input.decision),
    activePlan: input.state.plan ?? null,
    attempt,
    remainingCorrectionAttempts: Math.max(0, input.maxActionRepairs + 1 - attempt)
  };
}

function describeActionCategory(action: AgentAction): string {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return action.type;
  }
  return categorizeToolCall(action.toolCall);
}

function isActionRepairable(error: unknown): boolean {
  if (error instanceof ModelConfigError) {
    return false;
  }
  if (error instanceof ModelJsonParseError) {
    return true;
  }
  if (error instanceof ModelTimeoutError || error instanceof ModelHttpError) {
    return false;
  }
  if (error instanceof Error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    return true;
  }
  return false;
}

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9._-]+/g, replacement: "Bearer ***" },
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replacement: "sk-***" },
  { re: /[Aa]uthorization[:\s]+[A-Za-z0-9._-]+/g, replacement: "authorization ***" }
];

export function redactForEvidence(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern.re, pattern.replacement);
  }
  return result;
}

function describeToolSuccess(toolResult: Extract<ToolResult, { status: "success" }>): string {
  if (toolResult.toolName === "filesystem.read") {
    return `Read ${toolResult.output.path}.`;
  }
  if (toolResult.toolName === "filesystem.search") {
    return `Search returned ${String(toolResult.output.result.returnedMatches)} matches.`;
  }
  if (toolResult.toolName === "filesystem.patch") {
    return `Patched ${toolResult.output.result.path}.`;
  }
  if (toolResult.toolName === "filesystem.write") {
    return `Wrote ${toolResult.output.result.path}.`;
  }
  if (toolResult.toolName === "shell.execute") {
    return `Executed ${toolResult.output.result.executionRecordId}.`;
  }
  if (toolResult.toolName === "filesystem.list") {
    if (toolResult.output.kind === "list_inline") {
      return `Listed ${String(toolResult.output.entries.length)} entries.`;
    }
    return `Listed ${String(toolResult.output.entryCount)} entries (artifact).`;
  }
  if (toolResult.toolName === "git.status") {
    return `Git status: dirty ${String(toolResult.output.result.isDirty)}.`;
  }
  if (toolResult.toolName === "git.diff") {
    return `Git diff: ${String(toolResult.output.changedFiles.length)} files.`;
  }
  if (toolResult.toolName === "git.show") {
    return `Git show ${toolResult.output.revision}.`;
  }
  if (toolResult.toolName === "project.commands") {
    return `Discovered ${String(toolResult.output.commands.length)} commands.`;
  }
  return `Inspected repository ${toolResult.output.profile.root}.`;
}

function describeCapabilities(toolCall: ToolCall): string[] {
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return ["filesystem.write"];
  }
  if (toolCall.toolName === "shell.execute") {
    return ["process.execute"];
  }

  return ["filesystem.read"];
}

function describeApprovalSummary(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch") {
    return `Patch ${toolCall.input.path}`;
  }

  if (toolCall.toolName === "filesystem.write") {
    return `Write ${toolCall.input.path} (${toolCall.input.mode})`;
  }

  if (toolCall.toolName === "shell.execute") {
    return `Execute ${toolCall.input.command}`;
  }

  return toolCall.toolName;
}

function describeApprovalReason(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return "Write access requires approval before mutating workspace files.";
  }

  return "Command execution requires approval before running a process.";
}

function buildLoopContextSnapshot(input: {
  runId: string;
  anchor: TaskAnchor;
  ledger: ProgressLedger;
  workingSet: WorkingSet | null;
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  approvalStore: ApprovalStore;
  userInputStore: UserInputStore;
  regroundedAt: string | null;
  now: string;
}): ContextSnapshot {
  const openApprovals = input.approvalStore.hasPendingByRun(input.runId) ? countPendingApprovals(input.approvalStore, input.runId) : 0;
  const openUserInputs = input.userInputStore.hasPendingByRun(input.runId) ? countPendingUserInputs(input.userInputStore, input.runId) : 0;
  return buildContextSnapshot({
    runId: input.runId,
    anchor: input.anchor,
    ledger: input.ledger,
    workingSet: input.workingSet,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.recentValidationResult,
    openApprovals,
    openUserInputs,
    regroundedAt: input.regroundedAt,
    now: input.now
  });
}

function countPendingApprovals(approvalStore: ApprovalStore, runId: string): number {
  return approvalStore.listByRun(runId).filter((entry) => entry.request.status === "pending").length;
}

function countPendingUserInputs(userInputStore: UserInputStore, runId: string): number {
  return userInputStore.listByRun(runId).filter((entry) => entry.request.status === "pending").length;
}

function reGroundNow(
  input: {
    workspaceRoot: string;
    task: Task;
  },
  workingSet: WorkingSet | null,
  now: string
): string | null {
  const workingSetPaths = workingSet?.items.map((item) => item.path) ?? [];
  const pendingPatchPath = input.task.input.patchRequest?.path;
  const facts = rehydrateWorkspaceFacts({
    workspaceRoot: input.workspaceRoot,
    filePaths: collectRehydrationFilePaths({ workingSetPaths, pendingPatchPath }),
    now
  });
  return facts.regroundedAt;
}

function maybeAbortAfterCheckpoint(phase: CheckpointPhase, note: string | undefined): void {
  const configuredPhase = process.env.NEXORA_TEST_EXIT_AFTER_CHECKPOINT_PHASE?.trim();
  if (configuredPhase === undefined || configuredPhase.length === 0) {
    return;
  }

  if (configuredPhase !== phase) {
    return;
  }

  const configuredNote = process.env.NEXORA_TEST_EXIT_AFTER_CHECKPOINT_NOTE?.trim();
  if (configuredNote !== undefined && configuredNote.length > 0 && configuredNote !== note) {
    return;
  }

  throw new Error(`Test abort after checkpoint phase ${phase}`);
}

function maybeAbortAfterEvent(type: Event["type"]): void {
  const configuredType = process.env.NEXORA_TEST_EXIT_AFTER_EVENT_TYPE?.trim();
  if (configuredType === undefined || configuredType.length === 0) {
    return;
  }

  if (configuredType !== type) {
    return;
  }

  throw new Error(`Test abort after event ${type}`);
}

function describeResourceScope(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return `workspace:${toolCall.input.path}`;
  }

  if (toolCall.toolName === "shell.execute") {
    return `workspace:${toolCall.input.cwd}`;
  }

  return "workspace";
}

export function fingerprintToolCall(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.read") {
    return JSON.stringify({ toolName: toolCall.toolName, path: toolCall.input.path });
  }
  if (toolCall.toolName === "filesystem.search") {
    return JSON.stringify({ toolName: toolCall.toolName, query: toolCall.input.query, limit: toolCall.input.limit });
  }
  if (toolCall.toolName === "filesystem.patch") {
    return JSON.stringify({
      toolName: toolCall.toolName,
      path: toolCall.input.path,
      patch: toolCall.input.patch,
      encoding: toolCall.input.encoding
    });
  }
  if (toolCall.toolName === "filesystem.write") {
    return JSON.stringify({
      toolName: toolCall.toolName,
      path: toolCall.input.path,
      content: toolCall.input.content,
      encoding: toolCall.input.encoding,
      mode: toolCall.input.mode,
      expectedHash: toolCall.input.expectedHash ?? null
    });
  }
  if (toolCall.toolName === "shell.execute") {
    return JSON.stringify({
      toolName: toolCall.toolName,
      command: toolCall.input.command,
      args: toolCall.input.args,
      cwd: toolCall.input.cwd,
      environment: toolCall.input.environment,
      purpose: toolCall.input.purpose
    });
  }
  return JSON.stringify({ toolName: toolCall.toolName, input: toolCall.input });
}

function fingerprintAction(toolCall: ToolCall): string {
  return fingerprintToolCall(toolCall);
}

function isCriticalAction(toolCall: ToolCall): boolean {
  if (toolCall.toolName !== "shell.execute") {
    return false;
  }

  const tokens = [toolCall.input.command, ...toolCall.input.args].join(" ").toLowerCase();
  return ["rm -rf", "del /f", "format ", "diskpart", "shutdown", "reboot", "mkfs"].some((pattern) => tokens.includes(pattern));
}
