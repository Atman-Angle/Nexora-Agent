import {
  AgentActionSchema,
  AgentIterationSchema,
  AgentBudgetUsageSchema,
  ApprovalRequestSchema,
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
  type Checkpoint,
  type CheckpointPhase,
  type ContextSnapshot,
  type Event,
  type PendingAction,
  type PendingActionResumeState,
  type ProgressLedger,
  type Run,
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
import { classifyRisk } from "../../tool-runtime/src/index.js";
import { transitionRun } from "./state-machine.js";
import { runCompletionGate } from "./validation-gate.js";

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
      ? 1
      : Math.max(input.resume.resumeState.nextSequence, input.eventStore.listEventsByRun(input.run.runId).length + 1);
  let currentWorkingSet = input.resume?.resumeState.currentWorkingSet ?? null;
  let recentToolResult = input.resume?.resumeState.recentToolResult ?? null;
  let recentValidationResult = input.resume?.resumeState.recentValidationResult ?? null;
  let latestIterationIndex = input.resume?.resumeState.latestIterationIndex ?? 0;
  let regroundRequested = input.resume?.resumeState.regroundRequested ?? false;
  let replanRequested = input.resume?.resumeState.replanRequested ?? false;
  let noProgressCount = input.resume?.resumeState.noProgressCount ?? 0;
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
    createProgressLedger({
      runId: activeRun.runId,
      anchor,
      now: input.now()
    });

  const appendEvent = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    Promise.resolve().then(() => {
      input.eventStore.appendEvent(
        createEvent({
          eventId: input.idGenerator(),
          runId: activeRun.runId,
          sequence: nextSequence,
          type,
          timestamp,
          payload
        })
      );
      maybeAbortAfterEvent(type);
      nextSequence += 1;
    });

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
      createdAt
    });
    input.checkpointStore.insertCheckpoint(checkpointRecord);
    await appendEvent("checkpoint.created", { checkpointId: checkpointRecord.checkpointId, phase }, createdAt);
    maybeAbortAfterCheckpoint(phase);
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
    activeRun = transitionRun(activeRun, "running", resumedAt);
    input.runStore.updateRun(activeRun);
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

  for (;;) {
    let action: AgentAction;
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
            budget: input.task.input.agentRequest.budget,
            usage,
            availableTools: ["filesystem.read", "filesystem.search", "filesystem.patch", "shell.execute"],
            regroundRequested,
            replanRequested,
            contextSnapshot
          })
        );
      } catch {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "MODEL_ACTION_INVALID",
          message: "Agent model produced an invalid action.",
          retryable: false
        });
      }

      await appendEvent("model.action.generated", { type: action.type }, input.now());
    }

    const actionSignature = JSON.stringify(action);

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
        recentToolResult,
        recentValidationResult,
        regroundRequested,
        replanRequested,
        noProgressCount,
        usage,
        previousSnapshot,
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
      if (input.approvalStore.hasPendingByRun(activeRun.runId) || input.userInputStore.hasPendingByRun(activeRun.runId)) {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "PENDING_REQUEST_UNRESOLVED",
          message: "Final cannot bypass unresolved approvals or user input requests.",
          retryable: false
        });
      }

      if (
        recentToolResult === null ||
        recentToolResult.toolName !== "shell.execute" ||
        recentToolResult.status !== "success" ||
        recentValidationResult?.status !== "passed"
      ) {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "MODEL_FINAL_REJECTED",
          message: "Final was proposed before a passing verification result was available.",
          retryable: false
        });
      }

      const knownEvidenceRefs = new Set([
        ...ledger.evidenceRefs,
        ...(recentValidationResult.evidenceRecords?.map((record) => record.evidenceId) ?? [])
      ]);
      for (const evidenceRef of action.evidenceRefs ?? []) {
        if (!knownEvidenceRefs.has(evidenceRef)) {
          return failRun({
            input,
            run: activeRun,
            appendEvent,
            code: "FINAL_EVIDENCE_MISSING",
            message: `Final referenced unknown evidence ${evidenceRef}.`,
            retryable: false
          });
        }
      }

      const artifact = createTextArtifact({
        artifactId: input.idGenerator(),
        runId: activeRun.runId,
        content: action.text,
        createdAt: input.now()
      });
      input.artifactStore.insertArtifact(artifact);
      await appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);

      const verifyingAt = input.now();
      activeRun = transitionRun(activeRun, "verifying", verifyingAt);
      input.runStore.updateRun(activeRun);
      await checkpoint("pre_validation");
      await appendEvent("validation.started", { status: activeRun.status }, verifyingAt);

      const validation = (
        await runCompletionGate({
          run: activeRun,
          task: input.task,
          toolResult: recentToolResult,
          finalArtifact: artifact,
          artifacts: input.artifactStore.getArtifactsByRun(activeRun.runId),
          now: input.now(),
          idGenerator: input.idGenerator
        })
      ).validation;

      input.validationResultStore.upsertValidationResult({
        runId: activeRun.runId,
        result: validation,
        createdAt: input.now()
      });
      await checkpoint("post_validation");
      await appendEvent("validation.completed", { status: validation.status, evidence: validation.evidence }, input.now());

      const iteration = createIteration({
        iterationId: input.idGenerator(),
        runId: activeRun.runId,
        index: latestIterationIndex,
        actionType: action.type,
        status: validation.status === "passed" ? "completed" : "failed",
        usage,
        summary: "Final artifact proposed.",
        evidenceRefs: action.evidenceRefs ?? [],
        now: input.now()
      });
      input.agentIterationStore.insertIteration(iteration);
      await appendEvent(
        validation.status === "passed" ? "iteration.completed" : "iteration.failed",
        { index: iteration.index, actionType: iteration.actionType },
        iteration.createdAt
      );

      if (validation.status === "failed") {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: "VALIDATION_FAILED",
          message: "Completion gate rejected the final artifact.",
          retryable: false
        });
      }

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
          recentToolResult,
          recentValidationResult,
          regroundRequested,
          replanRequested,
          noProgressCount,
          usage,
          previousSnapshot,
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
        recentToolResult,
        recentValidationResult,
        latestIterationIndex,
        regroundRequested,
        replanRequested,
        noProgressCount,
        previousSnapshot
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

    const execution = await input.toolRuntime.execute({
      runId: activeRun.runId,
      toolCall,
      workspaceRoot: input.workspaceRoot,
      artifactRoot: input.artifactRoot,
      now: input.now,
      idGenerator: input.idGenerator
    });
    usage.toolCalls += 1;
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

      if (!execution.toolResult.error.retryable) {
        return failRun({
          input,
          run: activeRun,
          appendEvent,
          code: execution.toolResult.error.code,
          message: execution.toolResult.error.message,
          retryable: false
        });
      }

      usage.retryCount += 1;
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
    await appendEvent("tool.completed", { toolName: execution.toolResult.toolName }, input.now());

    const resumedAt = input.now();
    activeRun = transitionRun(activeRun, "running", resumedAt);
    input.runStore.updateRun(activeRun);

    recentToolResult = execution.toolResult;
    let artifactHash: string | null = null;

    if (execution.toolResult.toolName === "filesystem.patch") {
      artifactHash = execution.toolResult.output.result.newHash;
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
          evidence: recentValidationResult.evidence
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
      }
      await persistLedger(ledger);
    }

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
      recentToolResult: input.recentToolResult,
      recentValidationResult: input.recentValidationResult,
      latestIterationIndex: input.latestIterationIndex,
      regroundRequested: input.regroundRequested,
      replanRequested: input.replanRequested,
      noProgressCount: input.noProgressCount,
      previousSnapshot: input.previousSnapshot
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
      recentToolResult: input.recentToolResult,
      recentValidationResult: input.recentValidationResult,
      latestIterationIndex: input.latestIterationIndex,
      regroundRequested: input.regroundRequested,
      replanRequested: input.replanRequested,
      noProgressCount: input.noProgressCount,
      previousSnapshot: input.previousSnapshot
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
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  latestIterationIndex: number;
  regroundRequested: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  previousSnapshot: NoProgressSnapshot;
}): PendingActionResumeState {
  return {
    usage: AgentBudgetUsageSchema.parse(input.usage),
    nextSequence: input.nextSequence,
    currentWorkingSet: input.currentWorkingSet,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.recentValidationResult,
    latestIterationIndex: input.latestIterationIndex,
    regroundRequested: input.regroundRequested,
    replanRequested: input.replanRequested,
    noProgressCount: input.noProgressCount,
    previousSnapshot: input.previousSnapshot
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
  usage: {
    loopCount: number;
    modelCalls: number;
    toolCalls: number;
    retryCount: number;
    startedAt: string;
  };
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
        retryCount: input.usage.retryCount
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
  return {
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
    evidenceRecords
  };
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
  return `Executed ${toolResult.output.result.executionRecordId}.`;
}

function describeCapabilities(toolCall: ToolCall): string[] {
  if (toolCall.toolName === "filesystem.patch") {
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

  if (toolCall.toolName === "shell.execute") {
    return `Execute ${toolCall.input.command}`;
  }

  return toolCall.toolName;
}

function describeApprovalReason(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch") {
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

function maybeAbortAfterCheckpoint(phase: CheckpointPhase): void {
  const configuredPhase = process.env.NEXORA_TEST_EXIT_AFTER_CHECKPOINT_PHASE?.trim();
  if (configuredPhase === undefined || configuredPhase.length === 0) {
    return;
  }

  if (configuredPhase !== phase) {
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
  if (toolCall.toolName === "filesystem.patch") {
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
  return JSON.stringify({
    toolName: toolCall.toolName,
    command: toolCall.input.command,
    args: toolCall.input.args,
    cwd: toolCall.input.cwd,
    environment: toolCall.input.environment,
    purpose: toolCall.input.purpose
  });
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
