import {
  ALL_TOOL_NAMES,
  computeArtifactHash,
  createCheckpoint,
  createEvent,
  createProgressLedger,
  type AgentAction,
  type Checkpoint,
  type CheckpointPhase,
  type Event,
  type PendingActionResumeState,
  type ProgressLedger,
  type Run,
  type Task
} from "../../contracts/src/index.js";
import {
  collectRehydrationFilePaths,
  rehydrateWorkspaceFacts
} from "../../context/src/index.js";
import type { AgentLoopModelProvider } from "../../model-gateway/src/index.js";
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
import { failRun } from "./agent-loop/fail-run.js";
import { buildStrategyRejectionContext } from "./agent-loop/strategy-rejection.js";
import { reGroundNow } from "./agent-loop/context-snapshot.js";
import { createInitialLoopState } from "./agent-loop/state.js";
import { handleAskUser } from "./agent-loop/handlers/ask-user.js";
import { handleSubmitExecutionPlan } from "./agent-loop/handlers/submit-execution-plan.js";
import { handleUpdatePlan } from "./agent-loop/handlers/update-plan.js";
import { handleFinal } from "./agent-loop/handlers/final.js";
import { handleToolCall } from "./agent-loop/handlers/tool-call.js";
import { handleGenerateAction } from "./agent-loop/handlers/generate-action.js";
import type { HandlerDeps } from "./agent-loop/outcome.js";

export { AgentLoopRunFailure } from "./agent-loop/errors.js";
export { redactForEvidence } from "./agent-loop/redact.js";
export { fingerprintToolCall } from "./agent-loop/fingerprint.js";
import { applyLedgerPatch } from "./ledger-progress/index.js";
import {
  deriveExecutionPlanFromAction,
  evaluateExecutionPlanCompleteness,
  onStrategyRejection,
  validateActionWithStrategy
} from "./strategy/index.js";
import {
  evaluateBuilderAction
} from "./builder/index.js";

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
  const ledger =
    input.resume?.ledger ??
    input.ledgerStore.getByRun(input.run.runId) ??
    createProgressLedger({
      runId: input.run.runId,
      anchor,
      now: input.now()
    });
  const state = createInitialLoopState(input, anchor, ledger);
  const recoveryOrchestrator = new RecoveryOrchestrator();
  const recoveryBudget = input.task.input.agentRequest?.recoveryBudget ?? {};
  const availableTools = input.toolRuntime.getAvailableTools().filter((toolName) => ALL_TOOL_NAMES.includes(toolName));
  const MAX_ACTION_REPAIRS = 2;

  const appendEventWithSequence = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    Promise.resolve().then(() => {
      const sequence = state.nextSequence;
      input.eventStore.appendEvent(
        createEvent({
          eventId: input.idGenerator(),
          runId: state.activeRun.runId,
          sequence,
          type,
          timestamp,
          payload
        })
      );
      maybeAbortAfterEvent(type);
      state.nextSequence += 1;
      return sequence;
    });
  const appendEvent = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    appendEventWithSequence(type, payload, timestamp).then(() => undefined);

  const persistLedger = async (nextLedger: ProgressLedger) => {
    state.ledger = nextLedger;
    input.ledgerStore.upsertLedger(state.ledger);
    await appendEvent(
      state.ledger.version === 0 ? "ledger.initialized" : "ledger.updated",
      {
        version: state.ledger.version,
        currentStep: state.ledger.currentStep
      },
      state.ledger.updatedAt
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
      workingSetPaths: state.currentWorkingSet?.items.map((item) => item.path) ?? [],
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
      runId: state.activeRun.runId,
      runStateVersion: state.activeRun.stateVersion,
      ledgerVersion: state.ledger.version,
      phase,
      ...(options?.pendingActionId === undefined ? {} : { pendingActionId: options.pendingActionId }),
      ...(options?.pendingActionFingerprint === undefined ? {} : { pendingActionFingerprint: options.pendingActionFingerprint }),
      ...(workspaceHash === undefined ? {} : { workspaceHash }),
      ...(options?.note === undefined ? {} : { note: options.note }),
      ...(state.recoveryState === undefined ? {} : { recovery: state.recoveryState }),
      strategy: state.strategyState,
      builder: state.builderState,
      createdAt
    });
    input.checkpointStore.insertCheckpoint(checkpointRecord);
    await appendEvent("checkpoint.created", { checkpointId: checkpointRecord.checkpointId, phase }, createdAt);
    maybeAbortAfterCheckpoint(phase, options?.note);
    return checkpointRecord;
  };

  const deps: HandlerDeps = {
    input,
    anchor,
    appendEvent,
    appendEventWithSequence,
    checkpoint,
    persistLedger,
    recoveryOrchestrator,
    recoveryBudget,
    availableTools,
    maxActionRepairs: MAX_ACTION_REPAIRS,
    actionSignature: ""
  };

  if (input.resume === undefined) {
    await appendEvent("run.created", { status: state.activeRun.status }, state.activeRun.createdAt);
    const runningAt = input.now();
    state.activeRun = transitionRun(state.activeRun, "running", runningAt);
    input.runStore.updateRun(state.activeRun);
    await appendEvent("run.started", { status: state.activeRun.status }, runningAt);
    await persistLedger(state.ledger);
  } else {
    const resumedAt = input.now();
    if (state.activeRun.status !== "running") {
      state.activeRun = transitionRun(state.activeRun, "running", resumedAt);
      input.runStore.updateRun(state.activeRun);
    }
    await appendEvent("run.resumed", { status: state.activeRun.status }, resumedAt);
  }

  if (input.resume !== undefined) {
    state.regroundedAt = reGroundNow(input, state.currentWorkingSet, input.now());
    if (state.regroundedAt !== null) {
      await appendEvent("context.regrounded", { reason: "resume", at: state.regroundedAt }, state.regroundedAt);
    }
  }

  for (;;) {
    try {
    let action: AgentAction | undefined;
    const currentSeededAction = state.seededAction;
    const usedSeededAction = currentSeededAction !== null;
    const bypassApproval = usedSeededAction && state.bypassApprovalForSeedAction;

    if (usedSeededAction) {
      action = currentSeededAction;
      state.seededAction = null;
      state.bypassApprovalForSeedAction = false;
    } else {
      const outcome = await handleGenerateAction(state, deps);
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: state.activeRun,
          appendEvent,
          code: outcome.code,
          message: outcome.message,
          retryable: outcome.retryable
        });
      }
      action = outcome.action;
    }

    const actionSignature = JSON.stringify(action);
    deps.actionSignature = actionSignature;

    if (
      requiresValidationRepairAction(state.recentValidationResult) &&
      !isValidationRepairAction(action, state.builderState, state.recentValidationResult)
    ) {
      state.validationRepairActionRejectionCount += 1;
      const rejectedAt = input.now();
      const message =
        "The latest fresh validation failed after a mutation; broad filesystem.read, off-target filesystem.read, filesystem.search, filesystem.list, project inspection, git tools, update_plan, and shell.execute source mutation are not repair actions now. Submit a focused repair execution plan or a Builder-directed repair mutation within the same Task executionConstraints, then rerun validation. filesystem.read is only repair evidence when it targets a changed file named in the failure summary or the current Builder modify target; repeated reads do not count as repair progress and must lead to a concrete mutation. Use shell.execute only to rerun validation, tests, or builds.";
      state.pendingActionRejection = {
        category: "validation_repair",
        attempt: state.validationRepairActionRejectionCount,
        message
      };
      await appendEvent(
        "model.action.rejected",
        {
          code: "VALIDATION_REPAIR_ACTION_REQUIRED",
          message,
          category: "validation_repair",
          reason: "fresh_failed_validation_requires_repair_action",
          attempt: state.validationRepairActionRejectionCount,
          remainingCorrectionAttempts: Math.max(0, MAX_ACTION_REPAIRS + 1 - state.validationRepairActionRejectionCount)
        },
        rejectedAt
      );
      state.ledger = applyLedgerPatch({
        ledger: state.ledger,        patch: {
          appendDecisions: [message]
        },
        now: rejectedAt
      });
      await persistLedger(state.ledger);
      if (state.validationRepairActionRejectionCount > MAX_ACTION_REPAIRS) {
        return failRun({
          input,
          run: state.activeRun,
          appendEvent,
          code: "VALIDATION_REPAIR_ACTION_REQUIRED",
          message,
          retryable: false
        });
      }
      await checkpoint("post_response", { note: "validation_repair_action_required" });
      state.previousSnapshot = {
        actionSignature,
        errorCode: "VALIDATION_REPAIR_ACTION_REQUIRED",
        ledgerVersion: state.ledger.version,
        evidenceCount: state.ledger.evidenceRefs.length,
        validationStatus: state.recentValidationResult.status,
        artifactHash: null
      };
      continue;
    }

    if (action.type === "submit_execution_plan" && isFreshPassingValidation(state.recentValidationResult)) {
      state.finalizationPlanRejectionCount += 1;
      const rejectedAt = input.now();
      const message =
        "A fresh passing validation already exists after the latest mutation; submit a final action instead of a new execution plan.";
      state.pendingActionRejection = {
        category: "completion_guidance",
        attempt: state.finalizationPlanRejectionCount,
        message
      };
      await appendEvent(
        "model.action.rejected",
        {
          code: "EXECUTION_PLAN_AFTER_FRESH_VALIDATION",
          message,
          category: "completion_guidance",
          reason: "fresh_validation_requires_final",
          attempt: state.finalizationPlanRejectionCount,
          remainingCorrectionAttempts: Math.max(0, MAX_ACTION_REPAIRS + 1 - state.finalizationPlanRejectionCount)
        },
        rejectedAt
      );
      state.ledger = applyLedgerPatch({
        ledger: state.ledger,        patch: {
          appendDecisions: [message]
        },
        now: rejectedAt
      });
      await persistLedger(state.ledger);
      if (state.finalizationPlanRejectionCount > MAX_ACTION_REPAIRS) {
        return failRun({
          input,
          run: state.activeRun,
          appendEvent,
          code: "EXECUTION_PLAN_UNEXPECTED",
          message,
          retryable: false
        });
      }
      await checkpoint("post_response", { note: "fresh_validation_final_required" });
      state.previousSnapshot = {
        actionSignature,
        errorCode: "EXECUTION_PLAN_AFTER_FRESH_VALIDATION",
        ledgerVersion: state.ledger.version,
        evidenceCount: state.ledger.evidenceRefs.length,
        validationStatus: state.recentValidationResult.status,
        artifactHash: null
      };
      continue;
    }

    const builderRecoveryAction =
      (state.recoveryState?.latestFailure?.source === "validation" || state.recoveryState?.latestFailure?.category === "patch_conflict") &&
      (action.type === "submit_execution_plan" ||
        ((action.type === "tool_call" || action.type === "request_approval") &&
          (action.toolCall.toolName === "filesystem.patch" || action.toolCall.toolName === "filesystem.write")));
    const strategyBypassedForRecovery =
      usedSeededAction || (state.recoveryState !== undefined && !builderRecoveryAction);
    const builderActionEvaluation = evaluateBuilderAction({
      strategyBypassedForRecovery,
      strategyState: state.strategyState,      builderState: state.builderState,      action,
      workspaceRoot: input.workspaceRoot,
      now: input.now()
    });
    state.builderState = builderActionEvaluation.state;
    for (const event of builderActionEvaluation.events) {
      await appendEvent(event.type, event.payload, input.now());
    }
    if (!strategyBypassedForRecovery && action.type === "submit_execution_plan") {
      const outcome = await handleSubmitExecutionPlan(state, deps, action);
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: state.activeRun,
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
          state: state.strategyState,
          decision: state.strategyDecision
        });
    if (!strategyPolicy.allowed) {
      const rejectedAt = input.now();
      const previousStrategyRejection = state.strategyState.lastStrategyRejection;
      const strategyRejection = buildStrategyRejectionContext({
        action,
        policy: strategyPolicy,
        state: state.strategyState,
        decision: state.strategyDecision,
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
      if (strategyPolicy.reason === "plan_required_before_mutation" && state.strategyState.plan === undefined) {
        const proposedPlan = deriveExecutionPlanFromAction({
          action,
          validationCommand: input.task.input.validationRequest?.command,
          validationArgs: input.task.input.validationRequest?.args
        });
        if (proposedPlan !== undefined && evaluateExecutionPlanCompleteness(proposedPlan).complete) {
          state.strategyState = {
            ...state.strategyState,
            plan: proposedPlan,
            noProgressCount: 0,
            explorationUsage: {
              ...state.strategyState.explorationUsage,
              iterationsWithoutProgress: 0
            },
            lastProgressIteration: state.latestIterationIndex,
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
              iteration: state.latestIterationIndex,
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
        state.strategyState = {
          ...state.strategyState,
          lastStrategyRejection: strategyRejection
        };
        await appendEvent(
          "strategy.action_repair.requested",
          {
            reason: strategyPolicy.reason,
            iteration: state.latestIterationIndex,
            attempt: strategyRejection.attempt,
            remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
          },
          input.now()
        );
        await checkpoint("post_response", { note: "strategy_action_repair" });
        continue;
      }
      const rejection = onStrategyRejection({ task: input.task, state: state.strategyState, iteration: state.latestIterationIndex });
      state.strategyState = rejection.state;
      const repairBudgetExhausted = previousStrategyRejection.attempt >= MAX_ACTION_REPAIRS;
      if (rejection.terminal || repairBudgetExhausted) {
        await appendEvent(
          "strategy.no_progress.terminal",
          {
            reason: repairBudgetExhausted ? "strategy_repair_budget_exhausted" : strategyPolicy.reason,
            iteration: state.latestIterationIndex,
            consecutiveReadActions: state.strategyState.explorationUsage.consecutiveReadActions,
            iterationsWithoutProgress: state.strategyState.explorationUsage.iterationsWithoutProgress,
            attempt: strategyRejection.attempt,
            remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
          },
          input.now()
        );
        return failRun({
          input,
          run: state.activeRun,
          appendEvent,
          code: "AGENT_STRATEGY_NO_PROGRESS",
          message: "Agent strategy detected repeated rejected actions without progress.",
          retryable: false
        });
      }
      state.strategyState = {
        ...state.strategyState,
        lastStrategyRejection: strategyRejection
      };
      await appendEvent(
        "strategy.exploration.stalled",
        {
          reason: strategyPolicy.reason,
          iteration: state.latestIterationIndex,
          consecutiveReadActions: state.strategyState.explorationUsage.consecutiveReadActions,
          iterationsWithoutProgress: state.strategyState.explorationUsage.iterationsWithoutProgress,
          attempt: strategyRejection.attempt,
          remainingCorrectionAttempts: strategyRejection.remainingCorrectionAttempts
        },
        input.now()
      );
      await checkpoint("post_response", { note: "strategy_action_repair" });
      continue;
    }
    if (state.strategyState.lastStrategyRejection !== undefined) {
      state.strategyState = { ...state.strategyState, lastStrategyRejection: undefined };
    }

    if (action.type === "update_plan") {
      const outcome = await handleUpdatePlan(state, deps, action);
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: state.activeRun,
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
            run: state.activeRun,
            ledger: state.ledger,
            appendEvent,
            checkpoint,
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
        run: state.activeRun,
        appendEvent,
        code: action.code,
        message: action.message,
        retryable: action.retryable
      });
    }

    if (action.type === "final") {
      const outcome = await handleFinal(state, deps, action);
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: state.activeRun,
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
        run: state.activeRun,
        appendEvent,
        code: "EXECUTION_PLAN_UNEXPECTED",
        message: "Structured execution plans cannot be processed while recovery is bypassing normal strategy.",
        retryable: false
      });
    }

    if (action.type === "tool_call" || action.type === "request_approval") {
      const outcome = await handleToolCall(
        state, deps,
        action,
        bypassApproval,
        strategyBypassedForRecovery
      );
      if (outcome.kind === "fail") {
        return failRun({
          input,
          run: state.activeRun,
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
        const failedRun = transitionRun(state.activeRun, "failed", failedAt, "RUNTIME_ERROR");
        input.runStore.updateRun(failedRun);
        state.activeRun = failedRun;
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
