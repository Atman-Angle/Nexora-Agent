import {
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
import { RecoveryOrchestrator } from "./recovery/index.js";
import { AgentLoopRunFailure } from "./agent-loop/errors.js";
import { fingerprintToolCall } from "./agent-loop/fingerprint.js";
import { redactForEvidence } from "./agent-loop/redact.js";
import { maybeAbortAfterCheckpoint, maybeAbortAfterEvent } from "./agent-loop/test-abort.js";
import { failRun } from "./agent-loop/fail-run.js";
import { reGroundNow } from "./agent-loop/context-snapshot.js";
import { createInitialLoopState, serializeResumeState } from "./agent-loop/state.js";
import type { AgentLoopState } from "./agent-loop/state.js";
import type { AgentProfile } from "./profile/index.js";
import { ProfileStateInvalidError } from "./profile/profile-state-error.js";
import type { HandlerDeps } from "./agent-loop/outcome.js";
import type { DecisionDirective } from "./strategy/decision-directive.js";

export { AgentLoopRunFailure } from "./agent-loop/errors.js";
export { redactForEvidence } from "./agent-loop/redact.js";
export { fingerprintToolCall } from "./agent-loop/fingerprint.js";
import { applyLedgerPatch } from "./ledger-progress/index.js";

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
  profile: AgentProfile;
  runtimeContext?: unknown;
  resume?:
    | {
        ledger: ProgressLedger;
        resumeState: PendingActionResumeState;
        seedAction?: AgentAction | undefined;
        bypassApprovalForSeedAction?: boolean | undefined;
      }
    | undefined;
  eventListener?: ((event: Event) => void) | undefined;
}): Promise<AgentLoopResult> {
  if (input.task.input.agentRequest === undefined) {
    throw new AgentLoopRunFailure("AGENT_REQUEST_MISSING", "Agent loop requires an agent request.", false);
  }

  const explicitSuccessCriteria = input.task.input.successCriteria ?? [];
  const anchor = {
    goal: input.task.input.text,
    constraints: [
      "State Machine is the only writer of Run status.",
      "Tool runtime must stay inside the authorized workspace.",
      "Only one primary action is allowed per iteration.",
      "Final cannot bypass the completion gate."
    ],
    successCriteria:
      explicitSuccessCriteria.length > 0
        ? explicitSuccessCriteria
        : input.task.input.validationRequest === undefined
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
  let state: AgentLoopState;
  try {
    state = createInitialLoopState(input, anchor, ledger);
  } catch (error) {
    if (error instanceof ProfileStateInvalidError) {
      const failedAt = input.now();
      const failedRun = transitionRun(input.run, "failed", failedAt, "PROFILE_STATE_INVALID");
      input.runStore.updateRun(failedRun);
      const sequence = Math.max(1, input.eventStore.listEventsByRun(input.run.runId).length + 1);
      input.eventStore.appendEvent(
        createEvent({
          eventId: input.idGenerator(),
          runId: input.run.runId,
          sequence,
          type: "run.failed",
          timestamp: failedAt,
          payload: { code: "PROFILE_STATE_INVALID", message: error.message }
        })
      );
      throw new AgentLoopRunFailure("PROFILE_STATE_INVALID", error.message, false);
    }
    throw error;
  }
  // A crash can occur after an iteration row is committed but before the
  // following checkpoint snapshots its incremented index. SQLite is the
  // authority for that durable fact, so never reuse an existing index.
  const persistedNextIterationIndex = input.agentIterationStore
    .listByRun(input.run.runId)
    .reduce((next, iteration) => Math.max(next, iteration.index + 1), 0);
  state.latestIterationIndex = Math.max(state.latestIterationIndex, persistedNextIterationIndex);
  const recoveryOrchestrator = new RecoveryOrchestrator();
  const recoveryBudget = input.task.input.agentRequest?.recoveryBudget ?? {};
  const availableTools = input.toolRuntime.getAvailableTools();
  const MAX_ACTION_REPAIRS = 2;

  const appendEventWithSequence = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    Promise.resolve().then(() => {
      const sequence = state.nextSequence;
      const event = createEvent({
        eventId: input.idGenerator(),
        runId: state.activeRun.runId,
        sequence,
        type,
        timestamp,
        payload
      });
      input.eventStore.appendEvent(event);
      maybeAbortAfterEvent(type);
      state.nextSequence += 1;
      if (input.eventListener !== undefined) {
        try {
          input.eventListener(event);
        } catch (listenerError) {
          console.warn(
            `[runAgentLoop] eventListener threw: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`
          );
        }
      }
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
    const resumeState = serializeResumeState(state, input.profile);
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
      resumeState,
      ...(resumeState.profileName === undefined ? {} : { profileName: resumeState.profileName }),
      ...(resumeState.profileVersion === undefined ? {} : { profileVersion: resumeState.profileVersion }),
      ...(resumeState.profileState === undefined ? {} : { profileState: resumeState.profileState }),
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
    let decisionDirective: DecisionDirective | undefined;
    const currentSeededAction = state.seededAction;
    const usedSeededAction = currentSeededAction !== null;
    const bypassApproval = usedSeededAction && state.bypassApprovalForSeedAction;

    if (usedSeededAction) {
      action = currentSeededAction;
      state.seededAction = null;
      state.bypassApprovalForSeedAction = false;
    } else {
      const outcome = await input.profile.generateAction(state, deps);
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
      decisionDirective = outcome.decisionDirective;
    }

    const actionSignature =
      action.type === "tool_call" || action.type === "request_approval"
        ? fingerprintToolCall(action.toolCall)
        : JSON.stringify(action);
    deps.actionSignature = actionSignature;

    // --- Recovery bypass computation (Block C, stays in runner) ---
    const builderRecoveryAction =
      (state.recoveryState?.latestFailure?.source === "validation" || state.recoveryState?.latestFailure?.category === "patch_conflict") &&
      (action.type === "submit_execution_plan" ||
        ((action.type === "tool_call" || action.type === "request_approval") &&
          (action.toolCall.toolName === "filesystem.patch" || action.toolCall.toolName === "filesystem.write")));
    const strategyBypassedForRecovery =
      usedSeededAction || (state.recoveryState !== undefined && !builderRecoveryAction);

    // --- Generic policy evaluation loop ---
    let policyShortCircuited = false;
    let policyRejected = false;
    for (const policy of input.profile.actionPolicies) {
      const policyOutcome = await policy.evaluate({
        action,
        actionSignature,
        state,
        deps,
        strategyBypassedForRecovery,
        usedSeededAction,
        ...(decisionDirective === undefined ? {} : { decisionDirective })
      });

      if (policyOutcome.kind === "accept") {
        if (policyOutcome.stateDelta !== undefined) {
          Object.assign(state, policyOutcome.stateDelta);
        }
        if (policyOutcome.events !== undefined) {
          for (const event of policyOutcome.events) {
            await appendEvent(event.type, event.payload, input.now());
          }
        }
        continue; // next policy
      }

      if (policyOutcome.kind === "shortCircuit") {
        // Apply builder state/events from the evaluation
        if (policyOutcome.stateDelta !== undefined) {
          Object.assign(state, policyOutcome.stateDelta);
        }
        if (policyOutcome.events !== undefined) {
          for (const event of policyOutcome.events) {
            await appendEvent(event.type, event.payload, input.now());
          }
        }
        // Handle the delegated handler outcome
        const outcome = policyOutcome.handlerOutcome;
        if (outcome.kind === "fail") {
          return failRun({ input, run: state.activeRun, appendEvent, code: outcome.code, message: outcome.message, retryable: outcome.retryable });
        }
        if (outcome.kind === "return") {
          return outcome.result;
        }
        // continue → skip remaining policies, go to next iteration
        policyShortCircuited = true;
        break;
      }

      // policyOutcome.kind === "reject"
      // Apply state delta
      if (policyOutcome.stateDelta !== undefined) {
        Object.assign(state, policyOutcome.stateDelta);
      }
      // Emit pre-reject events (e.g., builder evaluation events that precede model.action.rejected)
      if (policyOutcome.preRejectEvents !== undefined) {
        for (const event of policyOutcome.preRejectEvents) {
          await appendEvent(event.type, event.payload, input.now());
        }
      }
      // Emit the standard model.action.rejected event
      const rejectedAt = input.now();
      await appendEvent(
        "model.action.rejected",
        {
          code: policyOutcome.code,
          message: policyOutcome.message,
          category: policyOutcome.category,
          reason: policyOutcome.reason,
          attempt: policyOutcome.attempt,
          remainingCorrectionAttempts: Math.max(0, policyOutcome.maxAttempts - policyOutcome.attempt)
        },
        rejectedAt
      );
      // Emit additional post-reject events
      if (policyOutcome.events !== undefined) {
        for (const event of policyOutcome.events) {
          await appendEvent(event.type, event.payload, input.now());
        }
      }
      // Apply ledger patch
      if (policyOutcome.ledgerPatch !== undefined) {
        state.ledger = applyLedgerPatch({
          ledger: state.ledger,
          patch: policyOutcome.ledgerPatch,
          now: rejectedAt
        });
        await persistLedger(state.ledger);
      }
      // Fail or continue
      if (policyOutcome.failSignal !== undefined) {
        return failRun({
          input,
          run: state.activeRun,
          appendEvent,
          code: policyOutcome.failSignal.code,
          message: policyOutcome.failSignal.message,
          retryable: policyOutcome.failSignal.retryable
        });
      }
      // Persist the policy's recovery snapshot before checkpointing so a
      // resumed Run observes the same correction boundary.
      if (policyOutcome.previousSnapshot !== undefined) {
        state.previousSnapshot = policyOutcome.previousSnapshot;
      }
      // Checkpoint
      if (policyOutcome.checkpoint === true) {
        await checkpoint("post_response", policyOutcome.checkpointNote !== undefined ? { note: policyOutcome.checkpointNote } : undefined);
      }
      // Skip remaining policies, continue loop
      policyRejected = true;
      break;
    }
    if (policyShortCircuited || policyRejected) {
      continue;
    }

    const handler = input.profile.actionHandlers[action.type];
    if (handler === undefined) {
      // Unknown action type — AgentActionSchema is a closed union so this
      // is unreachable for valid actions. Continue the loop to re-generate.
      continue;
    }
    const outcome = await handler(state, deps, action, {
      bypassApproval,
      strategyBypassedForRecovery
    });
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
    } catch (error) {
      if (error instanceof AgentLoopRunFailure) {
        if (error.code === "BUDGET_EXCEEDED" || error.code === "NO_PROGRESS") {
          const persistedRun = input.runStore.getRun(state.activeRun.runId);
          if (
            persistedRun !== null &&
            persistedRun.status !== "created" &&
            persistedRun.status !== "cancelled" &&
            persistedRun.status !== "succeeded" &&
            persistedRun.status !== "failed"
          ) {
            return failRun({
              input,
              run: persistedRun,
              appendEvent,
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              details: error.details
            });
          }
        }
        throw error;
      }
      if (error instanceof ProfileStateInvalidError) {
        return failRun({
          input,
          run: state.activeRun,
          appendEvent,
          code: "PROFILE_STATE_INVALID",
          message: error.message,
          retryable: false
        });
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
