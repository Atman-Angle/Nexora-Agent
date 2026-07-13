import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createCheckpoint,
  createEvent,
  createRun,
  createTask,
  type ApprovalDecision,
  type Artifact,
  type CheckpointPhase,
  type Event,
  type PendingAction,
  type PendingActionResumeState,
  type ProgressLedger,
  type Run,
  type Task,
  type ToolResult,
  type ToolCall,
  ToolResultSchema,
  computeArtifactHash,
  type ValidationResult
} from "../../../contracts/src/index.js";
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
  ValidationResultStore,
  type DatabaseClient
} from "../../../storage/src/index.js";
import {
  createCodingToolRegistry,
  registerCodingTools,
  ToolRegistry,
  ToolRuntime,
  resolveWorkspaceFilePath
} from "../../../tool-runtime/src/index.js";
import {
  createModelProvider
} from "../../../model-gateway/src/index.js";
import {
  fingerprintToolCall
} from "../agent-loop/fingerprint.js";
import {
  transitionRun
} from "../state-machine.js";
import {
  runAgentLoop
} from "../agent-loop-runner.js";
import {
  runDirect
} from "../direct-runner.js";
import {
  runToolMode
} from "../tool-mode-runner.js";
import type { AgentLoopResult } from "../agent-loop/outcome.js";
import type { AgentProfile } from "../profile/types.js";
import {
  AgentServiceError,
  type AgentServiceConfig,
  type EventSubscriber,
  type EventSubscription,
  type ResumeApprovalInput,
  type ResumeRespondInput,
  type ReadOnlyToolInput,
  type ResumeRunResult,
  type RunStatusResult,
  type StartAgentInput
} from "./types.js";
import type { ToolModeModelProvider } from "../../../model-gateway/src/index.js";

/**
 * AgentService — application service layer for the Nexora runtime.
 *
 * Encapsulates store wiring, provider setup, tool runtime creation, profile
 * selection, and event bus management. Consumers (CLI, HTTP server, SDK) call
 * this service instead of wiring stores and runners directly.
 *
 * Lifecycle: construct → open() → use → close().
 * Methods throw AgentServiceError("NOT_OPEN") if called before open() or after close().
 * open() throws AgentServiceError("ALREADY_OPEN") if called twice.
 * close() is idempotent.
 */
export class AgentService {
  private readonly config: AgentServiceConfig;
  private workspaceRoot: string;
  private database: DatabaseClient | null = null;
  private taskStore: TaskStore | null = null;
  private runStore: RunStore | null = null;
  private eventStore: EventStore | null = null;
  private artifactStore: ArtifactStore | null = null;
  private executionRecordStore: ExecutionRecordStore | null = null;
  private validationResultStore: ValidationResultStore | null = null;
  private ledgerStore: LedgerStore | null = null;
  private agentIterationStore: AgentIterationStore | null = null;
  private approvalStore: ApprovalStore | null = null;
  private pendingActionStore: PendingActionStore | null = null;
  private userInputStore: UserInputStore | null = null;
  private checkpointStore: CheckpointStore | null = null;
  private toolRuntime: ToolRuntime | null = null;
  private profileMap = new Map<string, AgentProfile>();
  private subscribers = new Map<string, EventSubscriber>();
  private nextSubscriptionId = 0;
  private isOpen = false;

  constructor(config: AgentServiceConfig) {
    this.config = config;
    this.workspaceRoot = config.workspaceRoot;
  }

  /** Updates the caller-provided workspace boundary before an executable operation. */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.assertOpen();
    this.workspaceRoot = workspaceRoot;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  open(): void {
    if (this.isOpen) {
      throw new AgentServiceError("ALREADY_OPEN", "AgentService is already open.");
    }

    const database = openDatabase(this.config.databasePath);
    this.database = database;

    // Create all 12 stores
    this.taskStore = new TaskStore(database);
    this.runStore = new RunStore(database);
    this.eventStore = new EventStore(database);
    this.artifactStore = new ArtifactStore(database);
    this.executionRecordStore = new ExecutionRecordStore(database);
    this.validationResultStore = new ValidationResultStore(database);
    this.ledgerStore = new LedgerStore(database);
    this.agentIterationStore = new AgentIterationStore(database);
    this.approvalStore = new ApprovalStore(database);
    this.pendingActionStore = new PendingActionStore(database);
    this.userInputStore = new UserInputStore(database);
    this.checkpointStore = new CheckpointStore(database);

    // Create tool runtime with coding tools
    const registry = createCodingToolRegistry();
    this.toolRuntime = new ToolRuntime({
      registry,
      executionRecordStore: this.executionRecordStore,
      artifactStore: this.artifactStore
    });

    // Register cold-path deployments, retaining the legacy profile array for compatibility.
    const profiles = this.config.registry?.list().map((deployment) => deployment.profile) ?? this.config.profiles;
    if (profiles !== undefined) {
      for (const profile of profiles) {
        this.profileMap.set(profile.name, profile);
      }
    }

    this.isOpen = true;
  }

  close(): void {
    if (!this.isOpen) {
      return; // Idempotent
    }
    this.database?.close();
    this.database = null;
    this.taskStore = null;
    this.runStore = null;
    this.eventStore = null;
    this.artifactStore = null;
    this.executionRecordStore = null;
    this.validationResultStore = null;
    this.ledgerStore = null;
    this.agentIterationStore = null;
    this.approvalStore = null;
    this.pendingActionStore = null;
    this.userInputStore = null;
    this.checkpointStore = null;
    this.toolRuntime = null;
    this.subscribers.clear();
    this.isOpen = false;
  }

  // ── Agent Operations ───────────────────────────────────────────────

  async startAgent(input: StartAgentInput): Promise<AgentLoopResult> {
    this.assertOpen();

    const now = () => new Date().toISOString();
    const profile = this.resolveProfile(input.profile);
    const workspaceRoot = this.workspaceRoot;
    const artifactRoot = this.resolveArtifactRoot();

    const task = createTask({
      taskId: randomUUID(),
      text: input.text,
      taskType: input.taskType ?? "feature",
      ...(input.validationRequest !== undefined ? { validationRequest: input.validationRequest } : {}),
      ...(input.agentRequest !== undefined ? { agentRequest: input.agentRequest } : {}),
      acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
      ...(input.executionConstraints !== undefined ? { executionConstraints: input.executionConstraints } : {}),
      createdAt: now()
    });
    const run = this.createPersistedRun(task, "tool", now);

    return this.executeAgentLoop({
      task,
      run,
      profile,
      now,
      workspaceRoot,
      artifactRoot,
      ...(input.runtimeContext === undefined ? {} : { runtimeContext: input.runtimeContext })
    });
  }

  async resumeApproval(input: ResumeApprovalInput): Promise<AgentLoopResult | {
    runId: string;
    status: string;
    approvalId: string;
    text: string;
  }> {
    this.assertOpen();

    const now = () => new Date().toISOString();
    const workspaceRoot = this.workspaceRoot;
    const artifactRoot = this.resolveArtifactRoot();

    // Load and validate approval
    const approval = this.approvalStore!.getApproval(input.approvalId);
    if (approval === null) {
      throw new Error(`Approval ${input.approvalId} was not found.`);
    }

    const run = this.requireRun(approval.request.runId);
    if (run.status === "cancelled") {
      throw new Error(`Run ${run.runId} was cancelled and cannot be approved.`);
    }
    if (approval.request.status === "cancelled") {
      throw new Error(`Approval ${input.approvalId} was cancelled and cannot be approved.`);
    }

    const task = this.requireTask(run.taskId);
    const pendingAction = this.requirePendingAction(
      this.pendingActionStore!.getPendingActionByApprovalId(input.approvalId),
      input.approvalId
    );
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

    // Check expiry
    if (
      approval.request.status === "pending" &&
      new Date(approval.request.expiresAt).getTime() <= new Date(now()).getTime()
    ) {
      this.approvalStore!.updateApproval({
        request: { ...approval.request, status: "expired" },
        decision: approval.decision,
        updatedAt: now()
      });
      this.appendRunEvent(run.runId, "approval.expired", { approvalId: input.approvalId }, now());
      throw new Error(`Approval ${input.approvalId} has expired.`);
    }

    // Already approved?
    if (
      approval.request.status === "approved" &&
      approval.decision?.decision === "approved"
    ) {
      return {
        runId: run.runId,
        status: run.status,
        approvalId: approval.request.approvalId,
        text: "Approval already granted."
      };
    }

    // Record decision
    const decision: ApprovalDecision = {
      approvalId: approval.request.approvalId,
      runId: approval.request.runId,
      decision: "approved",
      scope: input.scope,
      decidedAt: now(),
      ...(input.reason !== undefined ? { optionalReason: input.reason } : {})
    };

    this.approvalStore!.updateApproval({
      request: { ...approval.request, status: "approved" },
      decision,
      updatedAt: now()
    });
    this.appendRunEvent(run.runId, "approval.approved", {
      approvalId: input.approvalId,
      scope: input.scope
    }, now());

    this.pendingActionStore!.updatePendingAction({
      ...pendingAction,
      status: "resolved",
      updatedAt: now()
    });

    this.persistCheckpoint({
      run,
      phase: "post_approval",
      pendingAction,
      now: now()
    });

    // Resume agent loop
    const ledger = this.requireLedger(run.runId);
    const profile = this.resolveProfileForResume(pendingAction, run);
    return this.executeAgentLoop({
      task,
      run,
      profile,
      now,
      workspaceRoot,
      artifactRoot,
      resume: {
        ledger,
        resumeState: pendingAction.resumeState,
        seedAction: pendingAction.action,
        bypassApprovalForSeedAction: true
      }
    });
  }

  async resumeRespond(input: ResumeRespondInput): Promise<AgentLoopResult | {
    runId: string;
    status: string;
    requestId: string;
    text: string;
  }> {
    this.assertOpen();

    const now = () => new Date().toISOString();
    const workspaceRoot = this.workspaceRoot;
    const artifactRoot = this.resolveArtifactRoot();

    // Load and validate request
    const requestEntry = this.userInputStore!.getRequest(input.requestId);
    if (requestEntry === null) {
      throw new Error(`Request ${input.requestId} was not found.`);
    }

    const run = this.requireRun(requestEntry.request.runId);
    if (run.status === "cancelled") {
      throw new Error(`Run ${run.runId} was cancelled and cannot accept responses.`);
    }
    if (requestEntry.request.status === "cancelled") {
      throw new Error(`Request ${input.requestId} was cancelled and cannot be answered.`);
    }

    const task = this.requireTask(run.taskId);
    const pendingAction = this.requirePendingAction(
      this.pendingActionStore!.getPendingActionByRequestId(input.requestId),
      input.requestId
    );
    const ledger = this.requireLedger(run.runId);

    if (
      pendingAction.runId !== requestEntry.request.runId ||
      pendingAction.requestId !== requestEntry.request.requestId
    ) {
      throw new Error("User input request does not match the pending action.");
    }

    // Already answered?
    if (
      requestEntry.request.status === "answered" &&
      requestEntry.response?.value === input.value
    ) {
      return {
        runId: run.runId,
        status: run.status,
        requestId: requestEntry.request.requestId,
        text: "Response already recorded."
      };
    }

    // Record response
    this.userInputStore!.updateRequest({
      request: { ...requestEntry.request, status: "answered" },
      response: {
        requestId: requestEntry.request.requestId,
        runId: requestEntry.request.runId,
        value: input.value,
        submittedAt: now()
      },
      updatedAt: now()
    });
    this.appendRunEvent(run.runId, "user_input.received", {
      requestId: input.requestId,
      value: input.value
    }, now());

    this.pendingActionStore!.updatePendingAction({
      ...pendingAction,
      status: "resolved",
      updatedAt: now()
    });

    this.persistCheckpoint({
      run,
      phase: "post_response",
      pendingAction,
      now: now()
    });

    // Update ledger with user input decision
    const resumedLedger: ProgressLedger = {
      ...ledger,
      decisions: [...new Set([...ledger.decisions, `User input: ${requestEntry.request.question} -> ${input.value}`])],
      version: ledger.version + 1,
      updatedAt: now()
    };
    this.ledgerStore!.upsertLedger(resumedLedger);

    // Resume agent loop
    const profile = this.resolveProfileForResume(pendingAction, run);
    return this.executeAgentLoop({
      task,
      run,
      profile,
      now,
      workspaceRoot,
      artifactRoot,
      resume: {
        ledger: resumedLedger,
        resumeState: pendingAction.resumeState
      }
    });
  }

  async resumeRun(runId: string): Promise<ResumeRunResult> {
    this.assertOpen();

    const now = () => new Date().toISOString();
    const run = this.requireRun(runId);

    // Terminal states
    if (run.status === "cancelled" || run.status === "succeeded" || run.status === "failed") {
      this.appendRunEvent(run.runId, "recovery.rejected", {
        runId, reason: "terminal_run", status: run.status
      }, now());
      return { kind: "terminal", run, text: `Run ${runId} is ${run.status}.` };
    }

    // Load checkpoint
    const latestCheckpoint = this.checkpointStore!.inspectLatestForRun(runId);
    if (latestCheckpoint.kind === "missing") {
      this.appendRunEvent(run.runId, "recovery.rejected", { runId, reason: "checkpoint_missing" }, now());
      throw new Error(`Run ${runId} has no checkpoint to resume from.`);
    }
    if (latestCheckpoint.kind === "corrupt") {
      this.appendRunEvent(run.runId, "recovery.rejected", { runId, reason: "checkpoint_corrupt" }, now());
      throw new Error(`Run ${runId} has a corrupt checkpoint.`);
    }
    if (latestCheckpoint.kind === "schema_version_mismatch") {
      this.appendRunEvent(run.runId, "recovery.rejected", {
        runId, reason: "checkpoint_schema_version_mismatch",
        schemaVersion: latestCheckpoint.schemaVersion ?? null
      }, now());
      throw new Error(`Run ${runId} checkpoint schema version ${latestCheckpoint.schemaVersion ?? "unknown"} is not supported for resume.`);
    }

    const checkpoint = latestCheckpoint.checkpoint;
    this.appendRunEvent(run.runId, "checkpoint.loaded", {
      checkpointId: checkpoint.checkpointId, phase: checkpoint.phase
    }, now());

    // Load pending action
    const pendingAction =
      checkpoint.pendingActionId === undefined
        ? this.pendingActionStore!.getActiveByRun(runId)
        : this.pendingActionStore!.getPendingAction(checkpoint.pendingActionId);

    if (
      checkpoint.pendingActionId !== undefined &&
      pendingAction?.pendingActionId !== checkpoint.pendingActionId
    ) {
      this.appendRunEvent(run.runId, "recovery.rejected", {
        runId, checkpointId: checkpoint.checkpointId, reason: "pending_action_mismatch"
      }, now());
      throw new Error(`Run ${runId} pending action no longer matches the latest checkpoint.`);
    }

    // Handle waiting states
    if (run.status === "waiting_for_approval") {
      const approvalId = pendingAction?.approvalId;
      const approval =
        approvalId !== undefined
          ? this.approvalStore!.listByRun(runId).find((e) => e.request.approvalId === approvalId)
          : undefined;
      if (approval === undefined || approval.request.status !== "pending") {
        this.appendRunEvent(run.runId, "recovery.rejected", {
          runId, checkpointId: checkpoint.checkpointId, reason: "approval_missing"
        }, now());
        throw new Error(`Run ${runId} has no pending approval to resume.`);
      }
      this.appendRunEvent(run.runId, "recovery.decision", {
        action: "wait", checkpointId: checkpoint.checkpointId, waitingFor: "approval"
      }, now());
      return {
        kind: "waiting_for_approval",
        run,
        approvalId: approval.request.approvalId,
        text: approval.request.actionSummary,
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "wait"
      };
    }

    if (run.status === "waiting_for_user") {
      const requestId = pendingAction?.requestId;
      const request =
        requestId !== undefined
          ? this.userInputStore!.listByRun(runId).find((e) => e.request.requestId === requestId)
          : undefined;
      if (request === undefined || request.request.status !== "pending") {
        this.appendRunEvent(run.runId, "recovery.rejected", {
          runId, checkpointId: checkpoint.checkpointId, reason: "request_missing"
        }, now());
        throw new Error(`Run ${runId} has no pending user-input request to resume.`);
      }
      this.appendRunEvent(run.runId, "recovery.decision", {
        action: "wait", checkpointId: checkpoint.checkpointId, waitingFor: "user_input"
      }, now());
      return {
        kind: "waiting_for_user",
        run,
        requestId: request.request.requestId,
        text: request.request.question,
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "wait"
      };
    }

    if (run.status === "blocked") {
      this.appendRunEvent(run.runId, "recovery.decision", {
        action: "blocked", checkpointId: checkpoint.checkpointId, waitingFor: "manual_intervention"
      }, now());
      return {
        kind: "blocked",
        run,
        text: run.errorCode ?? "Run is blocked and needs manual intervention.",
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "blocked"
      };
    }

    // waiting_for_tool — needs full tool recovery context
    if (run.status === "waiting_for_tool") {
      if (
        pendingAction === null ||
        pendingAction.waitingFor !== "tool_execution" ||
        pendingAction.action.type !== "tool_call"
      ) {
        const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
        this.runStore!.updateRun(blockedRun);
        this.appendRunEvent(run.runId, "recovery.decision", {
          action: "blocked",
          checkpointId: checkpoint.checkpointId,
          waitingFor: "manual_intervention",
          previousStatus: run.status,
          reason: "tool_pending_action_missing"
        }, now());
        return {
          kind: "blocked",
          run: blockedRun,
          text: `Run ${runId} lost its tool recovery context and needs manual review.`,
          checkpointId: checkpoint.checkpointId,
          recoveryAction: "blocked"
        };
      }

      // Verify fingerprint
      if (
        checkpoint.pendingActionFingerprint !== undefined &&
        fingerprintToolCall(pendingAction.action.toolCall) !== checkpoint.pendingActionFingerprint
      ) {
        this.appendRunEvent(run.runId, "recovery.rejected", {
          runId, checkpointId: checkpoint.checkpointId, reason: "pending_action_fingerprint_mismatch"
        }, now());
        throw new Error(`Run ${runId} tool action no longer matches the latest checkpoint.`);
      }

      const events = this.eventStore!.listEventsByRun(runId);
      const checkpointCreatedEvent = events.find(
        (event) =>
          event.type === "checkpoint.created" &&
          event.payload.checkpointId === checkpoint.checkpointId
      );
      const workspaceHashFromEvent = checkpointCreatedEvent?.payload.workspaceHash;
      const workspaceHashMatches =
        workspaceHashFromEvent !== undefined &&
        workspaceHashFromEvent === checkpoint.workspaceHash;

      if (
        !workspaceHashMatches &&
        checkpoint.workspaceHash !== undefined &&
        workspaceHashFromEvent !== undefined
      ) {
        const blockedRun = transitionRun(run, "blocked", now(), "WORKSPACE_INTEGRITY_VIOLATION");
        this.runStore!.updateRun(blockedRun);
        this.appendRunEvent(run.runId, "recovery.decision", {
          action: "blocked",
          checkpointId: checkpoint.checkpointId,
          waitingFor: "manual_intervention",
          previousStatus: run.status,
          reason: "workspace_integrity_violation"
        }, now());
        return {
          kind: "blocked",
          run: blockedRun,
          text: `Run ${runId} workspace was modified externally and needs review.`,
          checkpointId: checkpoint.checkpointId,
          recoveryAction: "blocked"
        };
      }

      const ledger = this.requireLedger(run.runId);
      const task = this.requireTask(run.taskId);
      const workspaceRoot = this.workspaceRoot;
      const artifactRoot = this.resolveArtifactRoot();

      const toolStartedSeenAfterCheckpoint = checkpointCreatedEvent !== undefined && events.some(
        (event) => event.sequence > checkpointCreatedEvent.sequence &&
          (event.type === "tool.started" || event.type === "command.started")
      );

      if (checkpoint.phase === "pre_tool") {
        const preToolRecovery = await this.preToolRecovery(pendingAction, workspaceRoot);
        if (preToolRecovery?.action === "blocked") {
          return this.blockRecovery(run, checkpoint.checkpointId, preToolRecovery.reason,
            `Run ${runId} target file is missing after checkpoint and patch resume needs manual review.`, now);
        }
        if (preToolRecovery?.action === "replan") {
          this.pendingActionStore!.updatePendingAction({ ...pendingAction, status: "cancelled", updatedAt: now() });
          this.appendRunEvent(run.runId, "recovery.decision", {
            action: "replan", checkpointId: checkpoint.checkpointId, waitingFor: "tool_execution",
            previousStatus: run.status, reason: preToolRecovery.reason
          }, now());
          const result = await this.resumeAgentLoop({ task, run, ledger, resumeState: {
            ...pendingAction.resumeState, regroundRequested: true, replanRequested: true
          }, now, workspaceRoot, artifactRoot });
          return { kind: "executed", result, checkpointId: checkpoint.checkpointId, recoveryAction: "replan" };
        }

        if (toolStartedSeenAfterCheckpoint && pendingAction.action.toolCall.toolName !== "filesystem.read") {
          return this.blockRecovery(run, checkpoint.checkpointId, "tool_started_state_unknown",
            `Run ${runId} was interrupted after ${pendingAction.action.toolCall.toolName} started and needs manual review.`, now);
        }

        this.appendRunEvent(run.runId, "recovery.decision", {
          action: "resume", checkpointId: checkpoint.checkpointId, waitingFor: "tool_execution"
        }, now());
        const result = await this.resumeAgentLoop({ task, run, ledger, resumeState: pendingAction.resumeState,
          seedAction: pendingAction.action, bypassApprovalForSeedAction: true, now, workspaceRoot, artifactRoot });
        return { kind: "executed", result, checkpointId: checkpoint.checkpointId, recoveryAction: "resume" };
      }

      if (checkpoint.phase === "post_tool" || checkpoint.phase === "post_patch" || checkpoint.phase === "post_write") {
        if (pendingAction.action.toolCall.toolName === "shell.execute") {
          return this.blockRecovery(run, checkpoint.checkpointId, "post_tool_shell_requires_review",
            `Run ${runId} was interrupted after shell.execute completed and needs manual review.`, now);
        }
        const executionRecord = this.executionRecordStore!.listByRun(runId).slice().reverse().find(
          (record) => record.toolCallId === pendingAction.actionId && record.status === "success"
        );
        if (executionRecord === undefined) {
          return this.blockRecovery(run, checkpoint.checkpointId, "post_tool_execution_missing",
            `Run ${runId} has no successful execution record for post-tool recovery.`, now);
        }
        const recoveredToolResult = ToolResultSchema.parse(JSON.parse(executionRecord.outputJson) as unknown);
        const reconciledLedger = reconcileLedgerAfterRecoveredTool({ ledger, toolName: recoveredToolResult.toolName,
          artifactRefs: collectArtifactRefs(recoveredToolResult), now: now() });
        if (reconciledLedger.version !== ledger.version) this.ledgerStore!.upsertLedger(reconciledLedger);
        const reconciledResumeState: PendingActionResumeState = {
          ...pendingAction.resumeState,
          usage: { ...pendingAction.resumeState.usage, toolCalls: pendingAction.resumeState.usage.toolCalls + 1 },
          changedFiles: recoveredToolResult.status === "success" &&
            (recoveredToolResult.toolName === "filesystem.patch" || recoveredToolResult.toolName === "filesystem.write")
            ? [...new Set([...pendingAction.resumeState.changedFiles, recoveredToolResult.output.result.path])]
            : pendingAction.resumeState.changedFiles,
          recentToolResult: recoveredToolResult,
          recentValidationResult: recoveredToolResult.status === "success" &&
            (recoveredToolResult.toolName === "filesystem.patch" || recoveredToolResult.toolName === "filesystem.write")
            ? null : pendingAction.resumeState.recentValidationResult,
          currentWorkingSet: recoveredToolResult.status === "success" && recoveredToolResult.toolName === "filesystem.search"
            ? recoveredToolResult.output.workingSet : pendingAction.resumeState.currentWorkingSet
        };
        if (recoveredToolResult.status === "success" && recoveredToolResult.toolName === "filesystem.patch") {
          this.appendRunEvent(run.runId, "patch.applied", { path: recoveredToolResult.output.result.path,
            status: recoveredToolResult.output.result.status, changed: recoveredToolResult.output.result.changed }, now());
        }
        if (recoveredToolResult.status === "success" && recoveredToolResult.toolName === "filesystem.write") {
          this.appendRunEvent(run.runId, "patch.applied", { path: recoveredToolResult.output.result.path,
            status: recoveredToolResult.output.result.mode, changed: true }, now());
        }
        this.appendRunEvent(run.runId, "recovery.reconciled", { checkpointId: checkpoint.checkpointId,
          toolCallId: executionRecord.toolCallId, toolName: executionRecord.toolName }, now());
        this.appendRunEvent(run.runId, "recovery.decision", {
          action: "resume", checkpointId: checkpoint.checkpointId, waitingFor: "tool_execution"
        }, now());
        const result = await this.resumeAgentLoop({ task, run, ledger: reconciledLedger,
          resumeState: reconciledResumeState, now, workspaceRoot, artifactRoot });
        return { kind: "executed", result, checkpointId: checkpoint.checkpointId, recoveryAction: "resume" };
      }

      return this.blockRecovery(run, checkpoint.checkpointId, "unsupported_tool_checkpoint_phase",
        `Run ${runId} was interrupted in ${checkpoint.phase} and needs manual review before continuing.`, now);
    }

    // A verification checkpoint has no idempotent continuation contract. The
    // pre-AgentService CLI blocked this state for manual review rather than
    // replaying validation or model work.
    if (checkpoint.phase === "pre_validation") {
      const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
      this.runStore!.updateRun(blockedRun);
      this.appendRunEvent(run.runId, "recovery.decision", {
        action: "blocked",
        checkpointId: checkpoint.checkpointId,
        waitingFor: "manual_intervention",
        previousStatus: run.status,
        reason: "pre_validation_requires_review"
      }, now());
      return {
        kind: "blocked",
        run: blockedRun,
        text: `Run ${runId} was interrupted before validation and needs manual review.`,
        checkpointId: checkpoint.checkpointId,
        recoveryAction: "blocked"
      };
    }

    // Default: try to resume directly
    const ledger = this.requireLedger(run.runId);
    const task = this.requireTask(run.taskId);
    const workspaceRoot = this.workspaceRoot;
    const artifactRoot = this.resolveArtifactRoot();
    const resumeState = pendingAction?.resumeState ?? checkpoint.resumeState ?? this.createDefaultResumeState();
    const profile = this.resolveProfileForRun(run);
    const result = await this.executeAgentLoop({
      task,
      run,
      profile,
      now,
      workspaceRoot,
      artifactRoot,
      resume: { ledger, resumeState }
    });

    return { kind: "executed", result, checkpointId: checkpoint.checkpointId, recoveryAction: "resume" };
  }

  // ── Queries ────────────────────────────────────────────────────────

  getRunStatus(runId: string): RunStatusResult {
    this.assertOpen();
    const run = this.requireRun(runId);
    const task = this.requireTask(run.taskId);
    const latestCheckpoint = this.checkpointStore!.inspectLatestForRun(runId);
    const checkpoint =
      latestCheckpoint.kind === "valid" ? latestCheckpoint.checkpoint : undefined;
    const pendingAction = this.pendingActionStore!.getActiveByRun(runId);
    return { run, task, checkpoint, pendingAction: pendingAction ?? undefined };
  }

  getRunEvents(runId: string): Event[] {
    this.assertOpen();
    return this.eventStore!.listEventsByRun(runId);
  }

  listApprovals(runId: string): ReturnType<ApprovalStore["listByRun"]> {
    this.assertOpen();
    return this.approvalStore!.listByRun(runId);
  }

  listRequests(runId: string): ReturnType<UserInputStore["listByRun"]> {
    this.assertOpen();
    return this.userInputStore!.listByRun(runId);
  }

  denyApproval(approvalId: string, reason?: string): {
    runId: string;
    status: Run["status"];
    approvalId: string;
    text: string;
  } {
    this.assertOpen();
    const now = () => new Date().toISOString();

    const approval = this.approvalStore!.getApproval(approvalId);
    if (approval === null) {
      throw new Error(`Approval ${approvalId} was not found.`);
    }

    const run = this.requireRun(approval.request.runId);
    if (run.status === "cancelled") {
      throw new Error(`Run ${run.runId} was cancelled and cannot be denied.`);
    }
    if (approval.request.status === "cancelled") {
      throw new Error(`Approval ${approvalId} was cancelled and cannot be denied.`);
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
      ...(reason !== undefined ? { optionalReason: reason } : {})
    };

    this.approvalStore!.updateApproval({
      request: { ...approval.request, status: "denied" },
      decision,
      updatedAt: now()
    });
    this.appendRunEvent(run.runId, "approval.denied", { approvalId }, now());

    const pendingAction = this.pendingActionStore!.getPendingActionByApprovalId(approvalId);
    if (pendingAction !== null && pendingAction.status === "pending") {
      this.pendingActionStore!.updatePendingAction({
        ...pendingAction,
        status: "cancelled",
        updatedAt: now()
      });
    }

    const failedRun = transitionRun(run, "failed", now(), "APPROVAL_DENIED");
    this.runStore!.updateRun(failedRun);
    this.appendRunEvent(run.runId, "run.failed", { code: "APPROVAL_DENIED", message: "Approval was denied." }, now());

    return {
      runId: failedRun.runId,
      status: failedRun.status,
      approvalId: approval.request.approvalId,
      text: "Approval denied."
    };
  }

  cancelRun(runId: string): Run {
    this.assertOpen();
    const now = () => new Date().toISOString();
    const run = this.requireRun(runId);

    if (run.status !== "waiting_for_approval" && run.status !== "waiting_for_user") {
      throw new Error(`Run ${runId} is not waiting and cannot be cancelled.`);
    }

    const cancelledRun = transitionRun(run, "cancelled", now());
    this.runStore!.updateRun(cancelledRun);

    this.persistCheckpoint({
      run: cancelledRun,
      phase: "runtime_shutdown",
      now: now()
    });

    const pendingAction = this.pendingActionStore!.getActiveByRun(runId);
    if (pendingAction !== null) {
      this.pendingActionStore!.updatePendingAction({
        ...pendingAction,
        status: "cancelled",
        updatedAt: now()
      });
    }

    if (run.status === "waiting_for_approval") {
      for (const approval of this.approvalStore!.listByRun(runId)) {
        if (approval.request.status !== "pending") {
          continue;
        }
        this.approvalStore!.updateApproval({
          request: { ...approval.request, status: "cancelled" },
          decision: approval.decision,
          updatedAt: now()
        });
      }
    }

    if (run.status === "waiting_for_user") {
      for (const request of this.userInputStore!.listByRun(runId)) {
        if (request.request.status !== "pending") {
          continue;
        }
        this.userInputStore!.updateRequest({
          request: { ...request.request, status: "cancelled" },
          response: request.response,
          updatedAt: now()
        });
      }
    }

    return cancelledRun;
  }

  // ── Event Streaming ────────────────────────────────────────────────

  subscribeEvents(callback: EventSubscriber): EventSubscription {
    const id = `sub_${this.nextSubscriptionId++}`;
    this.subscribers.set(id, callback);
    return {
      id,
      unsubscribe: () => {
        this.subscribers.delete(id);
      }
    };
  }

  unsubscribeEvents(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
  }

  // ── Direct/Tool Modes ──────────────────────────────────────────────

  async runDirect(text: string): Promise<{
    run: Run;
    artifact: Artifact;
    validation: ValidationResult;
  }> {
    this.assertOpen();

    const now = () => new Date().toISOString();
    const task = createTask({
      taskId: randomUUID(),
      text,
      taskType: "analysis",
      createdAt: now()
    });
    const run = this.createPersistedRun(task, "direct", now);

    const modelProvider = this.createModelProviderInstance();

    return runDirect({
      task,
      run,
      now,
      idGenerator: randomUUID,
      modelProvider,
      runStore: this.runStore!,
      eventStore: this.eventStore!,
      artifactStore: this.artifactStore!
    });
  }

  async runToolMode(task: Task): Promise<{
    run: Run;
    artifact: Artifact;
    validation: ValidationResult;
    toolResult: ToolResult;
  }> {
    this.assertOpen();

    return this.runToolTask(task, this.createModelProviderInstance());
  }

  async runReadOnlyTool(input: ReadOnlyToolInput): Promise<{
    run: Run;
    artifact: Artifact;
    validation: ValidationResult;
    toolResult: ToolResult;
  }> {
    this.assertOpen();
    const now = () => new Date().toISOString();
    const toolCall = this.createReadOnlyToolCall(input);
    const task = createTask({
      taskId: randomUUID(),
      text: `Read-only exploration: ${toolCall.toolName}`,
      taskType: "read_only",
      createdAt: now(),
      ...(input.kind === "filesystem_search" ? { searchQuery: input.query } : {})
    });
    return this.runToolTask(task, new DeterministicReadOnlyToolProvider(toolCall));
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private async runToolTask(task: Task, modelProvider: ToolModeModelProvider): Promise<{
    run: Run;
    artifact: Artifact;
    validation: ValidationResult;
    toolResult: ToolResult;
  }> {
    const now = () => new Date().toISOString();
    const run = this.createPersistedRun(task, "tool", now);
    return runToolMode({
      task,
      run,
      now,
      idGenerator: randomUUID,
      workspaceRoot: this.workspaceRoot,
      artifactRoot: this.resolveArtifactRoot(),
      modelProvider,
      toolRuntime: this.toolRuntime!,
      runStore: this.runStore!,
      eventStore: this.eventStore!,
      artifactStore: this.artifactStore!,
      validationResultStore: this.validationResultStore!,
      ...(this.hasSubscribers() ? { eventListener: this.createEventListener() } : {})
    });
  }

  private createReadOnlyToolCall(input: ReadOnlyToolInput): ToolCall {
    const toolCallId = randomUUID();
    const timeoutMs = input.kind === "filesystem_search" ? 60_000 : 5_000;
    if (input.kind === "filesystem_search") return { toolCallId, toolName: "filesystem.search", input: { query: input.query, limit: input.limit ?? 20 }, timeoutMs };
    if (input.kind === "filesystem_list") return { toolCallId, toolName: "filesystem.list", input: { relativePath: input.relativePath ?? "." }, timeoutMs };
    if (input.kind === "project_inspect") return { toolCallId, toolName: "project.inspect", input: { relativePath: input.relativePath ?? "." }, timeoutMs };
    if (input.kind === "project_commands") return { toolCallId, toolName: "project.commands", input: {}, timeoutMs };
    if (input.kind === "git_status") return { toolCallId, toolName: "git.status", input: {}, timeoutMs };
    if (input.kind === "git_diff") return { toolCallId, toolName: "git.diff", input: input.path === undefined ? {} : { path: input.path }, timeoutMs };
    if (input.kind === "git_show") return { toolCallId, toolName: "git.show", input: input.path === undefined ? { revision: input.revision } : { revision: input.revision, path: input.path }, timeoutMs };
    throw new AgentServiceError("READ_ONLY_TOOL_NOT_ALLOWED", "Read-only tool kind is not allowed.");
  }

  private async preToolRecovery(pendingAction: PendingAction, workspaceRoot: string): Promise<{ action: "blocked" | "replan"; reason: string } | undefined> {
    const toolCall = pendingAction.action.type === "tool_call" ? pendingAction.action.toolCall : undefined;
    if (toolCall?.toolName === "filesystem.patch") {
      const input = toolCall.input as { path: string; expectedHash: string };
      const currentHash = await readWorkspaceFileHash(workspaceRoot, input.path);
      if (currentHash === null) return { action: "blocked", reason: "workspace_target_missing_before_patch_resume" };
      if (currentHash !== input.expectedHash) return { action: "replan", reason: "workspace_changed_before_patch_resume" };
    }
    if (toolCall?.toolName === "filesystem.write") {
      const input = toolCall.input as { path: string; mode: string; expectedHash?: string };
      const currentHash = await readWorkspaceFileHash(workspaceRoot, input.path);
      const shouldReplan = input.mode === "create"
        ? currentHash !== null
        : currentHash === null || input.expectedHash === undefined || currentHash !== input.expectedHash;
      if (shouldReplan) return { action: "replan", reason: "workspace_changed_before_write_resume" };
    }
    return undefined;
  }

  private blockRecovery(run: Run, checkpointId: string, reason: string, text: string, now: () => string): Extract<ResumeRunResult, { kind: "blocked" }> {
    const blockedRun = transitionRun(run, "blocked", now(), "RECOVERY_REQUIRES_REVIEW");
    this.runStore!.updateRun(blockedRun);
    this.appendRunEvent(run.runId, "recovery.decision", {
      action: "blocked", checkpointId, waitingFor: "manual_intervention", previousStatus: run.status, reason
    }, now());
    return { kind: "blocked", run: blockedRun, text, checkpointId, recoveryAction: "blocked" };
  }

  private async resumeAgentLoop(input: {
    task: Task; run: Run; ledger: ProgressLedger; resumeState: PendingActionResumeState;
    seedAction?: PendingAction["action"]; bypassApprovalForSeedAction?: boolean;
    now: () => string; workspaceRoot: string; artifactRoot: string;
  }): Promise<AgentLoopResult> {
    const profile = this.resolveProfileForRun(input.run);
    return this.executeAgentLoop({
      task: input.task, run: input.run, profile, now: input.now,
      workspaceRoot: input.workspaceRoot, artifactRoot: input.artifactRoot,
      resume: { ledger: input.ledger, resumeState: input.resumeState,
        ...(input.seedAction !== undefined ? { seedAction: input.seedAction } : {}),
        ...(input.bypassApprovalForSeedAction === true ? { bypassApprovalForSeedAction: true } : {}) }
    });
  }

  /** Single AgentService boundary for agent-loop lifecycle assembly. */
  private executeAgentLoop(input: {
    task: Task;
    run: Run;
    profile: AgentProfile;
    now: () => string;
    workspaceRoot: string;
    artifactRoot: string;
    resume?: Parameters<typeof runAgentLoop>[0]["resume"];
    runtimeContext?: StartAgentInput["runtimeContext"];
  }): Promise<AgentLoopResult> {
    return runAgentLoop({
      task: input.task,
      run: input.run,
      now: input.now,
      idGenerator: randomUUID,
      workspaceRoot: input.workspaceRoot,
      artifactRoot: input.artifactRoot,
      modelProvider: this.createModelProviderInstance(input.resume?.resumeState.usage.modelCalls),
      toolRuntime: this.createToolRuntimeForProfile(input.profile),
      runStore: this.runStore!,
      eventStore: this.eventStore!,
      artifactStore: this.artifactStore!,
      validationResultStore: this.validationResultStore!,
      ledgerStore: this.ledgerStore!,
      agentIterationStore: this.agentIterationStore!,
      approvalStore: this.approvalStore!,
      pendingActionStore: this.pendingActionStore!,
      userInputStore: this.userInputStore!,
      checkpointStore: this.checkpointStore!,
      profile: input.profile,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.runtimeContext === undefined ? {} : { runtimeContext: input.runtimeContext }),
      ...(this.hasSubscribers() ? { eventListener: this.createEventListener() } : {})
    });
  }

  /** Persists the durable Task/Run pair for a new public execution mode. */
  private createPersistedRun(task: Task, mode: Run["mode"], now: () => string): Run {
    const run = createRun({ runId: randomUUID(), taskId: task.taskId, createdAt: now(), mode });
    this.taskStore!.insertTask(task);
    this.runStore!.insertRun(run);
    return run;
  }

  private assertOpen(): void {
    if (!this.isOpen) {
      throw new AgentServiceError("NOT_OPEN", "AgentService is not open. Call open() first.");
    }
  }

  private resolveArtifactRoot(): string {
    return this.config.artifactRoot ?? join(dirname(this.config.databasePath), "artifacts");
  }

  private resolveProfile(profileOrName: AgentProfile | string): AgentProfile {
    if (typeof profileOrName === "string") {
      const profile = this.profileMap.get(profileOrName);
      if (profile === undefined) {
        throw new AgentServiceError(
          "PROFILE_NOT_FOUND",
          `Profile "${profileOrName}" is not registered. Available: [${[...this.profileMap.keys()].join(", ")}].`
        );
      }
      return profile;
    }
    return profileOrName;
  }

  /**
   * Resolve the profile for an existing run. Reads the profileName from the
   * run's latest pending action resume state or checkpoint.
   */
  private resolveProfileForRun(run: Run): AgentProfile {
    // Try pending action first
    const pendingAction = this.pendingActionStore!.getActiveByRun(run.runId);
    if (pendingAction?.resumeState?.profileName !== undefined) {
      const profile = this.profileMap.get(pendingAction.resumeState.profileName);
      if (profile !== undefined) {
        return profile;
      }
    }

    // Try checkpoint
    const latestCheckpoint = this.checkpointStore!.inspectLatestForRun(run.runId);
    if (latestCheckpoint.kind === "valid" && latestCheckpoint.checkpoint.profileName !== undefined) {
      const profile = this.profileMap.get(latestCheckpoint.checkpoint.profileName);
      if (profile !== undefined) {
        return profile;
      }
    }

    // Fall back: if only one profile is registered, use it
    if (this.profileMap.size === 1) {
      return this.profileMap.values().next().value!;
    }

    // F033b compatibility: runs created before profileName was persisted by
    // the runtime are coding runs, because the pre-AgentService CLI hardcoded
    // codingProfile for every agent/resume path.
    const legacyCodingProfile = this.profileMap.get("coding");
    if (legacyCodingProfile !== undefined) {
      return legacyCodingProfile;
    }

    throw new AgentServiceError(
      "PROFILE_NOT_RESOLVABLE",
      `Cannot determine profile for run ${run.runId}. Register profiles and ensure profileName is persisted.`
    );
  }

  /**
   * F035a: resolve the profile for a resume path that holds the pending action
   * being resumed. `resumeApproval` / `resumeRespond` resolve the pending
   * action to "resolved" before calling runAgentLoop, which defeats
   * `resolveProfileForRun`'s `getActiveByRun` step. The pending action's
   * `resumeState.profileName` is the authoritative record of which profile
   * started the run, so consult it directly. Falls back to
   * `resolveProfileForRun` for pre-F029 rows without profileName.
   */
  private resolveProfileForResume(pendingAction: PendingAction | null, run: Run): AgentProfile {
    const profileName = pendingAction?.resumeState?.profileName;
    if (profileName !== undefined) {
      const profile = this.profileMap.get(profileName);
      if (profile !== undefined) {
        return profile;
      }
    }
    return this.resolveProfileForRun(run);
  }

  createModelProviderInstance(agentActionSliceFrom?: number): ReturnType<typeof createModelProvider> {
    return createModelProvider({
      ...(this.config.modelProviderOptions ?? {}),
      ...(agentActionSliceFrom !== undefined ? { agentActionSliceFrom } : {})
    });
  }

  /**
   * F035a: build a per-run ToolRuntime whose registry is populated by the
   * profile's `registerTools`. Agent-loop entry points (startAgent, resume*)
   * use this so each profile owns its own tool set. `runReadOnlyTool` /
   * `runToolMode` keep using the global coding `toolRuntime` from open().
   * undefined registerTools → coding fallback (compat); warn for non-coding.
   */
  private createToolRuntimeForProfile(profile: AgentProfile): ToolRuntime {
    const registry = new ToolRegistry();
    if (profile.registerTools === undefined && profile.name !== "coding") {
      console.warn(
        `[AgentService] Profile "${profile.name}" has no registerTools; ` +
        `falling back to coding tools. Non-coding profiles MUST declare ` +
        `registerTools to get tool isolation.`
      );
    }
    const register = profile.registerTools ?? registerCodingTools;
    register(registry);
    return new ToolRuntime({
      registry,
      executionRecordStore: this.executionRecordStore!,
      artifactStore: this.artifactStore!
    });
  }

  private requireRun(runId: string): Run {
    const run = this.runStore!.getRun(runId);
    if (run === null) {
      throw new Error(`Run ${runId} was not found.`);
    }
    return run;
  }

  private requireTask(taskId: string): Task {
    const task = this.taskStore!.getTask(taskId);
    if (task === null) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    return task;
  }

  private requirePendingAction(
    pendingAction: PendingAction | null,
    id: string
  ): PendingAction {
    if (pendingAction === null) {
      throw new Error(`Pending action for ${id} was not found.`);
    }
    return pendingAction;
  }

  private requireLedger(runId: string): ProgressLedger {
    const ledger = this.ledgerStore!.getByRun(runId);
    if (ledger === null) {
      throw new Error(`Ledger for run ${runId} was not found.`);
    }
    return ledger;
  }

  private appendRunEvent(
    runId: string,
    type: Event["type"],
    payload: Record<string, unknown>,
    timestamp: string
  ): void {
    const sequence = this.eventStore!.listEventsByRun(runId).length + 1;
    const event = createEvent({ eventId: randomUUID(), runId, sequence, type, timestamp, payload });
    this.eventStore!.appendEvent(event);
    if (this.hasSubscribers()) this.createEventListener()(event);
  }

  private persistCheckpoint(input: {
    run: { runId: string; stateVersion: number };
    phase: CheckpointPhase;
    pendingAction?: PendingAction;
    now: string;
  }): void {
    const ledgerVersion = this.ledgerStore!.getByRun(input.run.runId)?.version ?? 0;
    this.checkpointStore!.insertCheckpoint(
      createCheckpoint({
        checkpointId: randomUUID(),
        runId: input.run.runId,
        runStateVersion: input.run.stateVersion,
        ledgerVersion,
        phase: input.phase,
        ...(input.pendingAction !== undefined
          ? {
              pendingActionId: input.pendingAction.pendingActionId,
              resumeState: input.pendingAction.resumeState
            }
          : {}),
        createdAt: input.now
      })
    );
  }

  private hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  /**
   * Creates an event listener that fans out events to all subscribers.
   * Each subscriber is called inside a try/catch — exceptions are logged
   * to console.warn and do NOT propagate to the agent loop.
   */
  private createEventListener(): (event: Event) => void {
    return (event: Event) => {
      for (const subscriber of this.subscribers.values()) {
        try {
          subscriber(event);
        } catch (error) {
          console.warn(
            `[AgentService] Event subscriber threw: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };
  }

  /**
   * Legacy checkpoints without a pending action or F036 resume snapshot cannot
   * be resumed safely: reconstructing usage/iteration state would risk replay.
   */
  private createDefaultResumeState(): PendingActionResumeState {
    throw new Error(
      "Cannot resume run without a pending action resume state. " +
      "Use resumeApproval() or resumeRespond() for runs that are waiting for input."
    );
  }
}

class DeterministicReadOnlyToolProvider implements ToolModeModelProvider {
  constructor(private readonly toolCall: ToolCall) {}

  async plan(): Promise<{ type: "tool_call"; toolCall: ToolCall }> {
    return { type: "tool_call", toolCall: this.toolCall };
  }

  async finalize(input: { toolResult: ToolResult }): Promise<{ type: "final"; text: string }> {
    if (input.toolResult.status !== "success") {
      throw new Error("Read-only tool provider cannot finalize an error result.");
    }
    return {
      type: "final",
      text: JSON.stringify({ toolName: input.toolResult.toolName, output: input.toolResult.output })
    };
  }
}

function collectArtifactRefs(toolResult: ToolResult): string[] {
  if (toolResult.status !== "success") return [];
  if (toolResult.toolName === "filesystem.read") return toolResult.output.kind === "artifact_ref" ? [toolResult.output.artifactId] : [];
  if (toolResult.toolName === "filesystem.search") return toolResult.output.kind === "search_artifact_ref" ? [toolResult.output.artifactId] : [];
  if (toolResult.toolName === "filesystem.patch") return [toolResult.output.result.diffArtifactRef];
  if (toolResult.toolName === "shell.execute") return [toolResult.output.result.stdoutArtifactRef, toolResult.output.result.stderrArtifactRef].filter((value): value is string => value !== undefined);
  if (toolResult.toolName === "git.diff") return toolResult.output.kind === "diff_artifact_ref" ? [toolResult.output.artifactId] : [];
  if (toolResult.toolName === "git.show") return toolResult.output.kind === "show_artifact_ref" ? [toolResult.output.artifactId] : [];
  if (toolResult.toolName === "filesystem.list") return toolResult.output.kind === "list_artifact_ref" ? [toolResult.output.artifactId] : [];
  if (toolResult.toolName === "project.inspect") return toolResult.output.kind === "inspect_artifact_ref" ? [toolResult.output.artifactId] : [];
  return [];
}

function reconcileLedgerAfterRecoveredTool(input: { ledger: ProgressLedger; toolName: ToolResult["toolName"]; artifactRefs: string[]; now: string }): ProgressLedger {
  const matchingSteps = input.ledger.planSteps.filter((step) => step.status !== "completed" && stepMatchesRecoveredTool(step.description, input.toolName));
  if (matchingSteps.length === 0 && input.artifactRefs.length === 0) return input.ledger;
  const matchingStepIds = new Set(matchingSteps.map((step) => step.stepId));
  const planSteps = input.ledger.planSteps.map((step) => matchingStepIds.has(step.stepId)
    ? { ...step, status: "completed" as const, evidenceRefs: [...new Set([...step.evidenceRefs, ...input.artifactRefs])], updatedAt: input.now }
    : step);
  const completedSteps = [...new Set([...input.ledger.completedSteps, ...matchingSteps.map((step) => step.description)])];
  const currentStep = input.ledger.currentStep !== null && matchingSteps.some((step) => step.description === input.ledger.currentStep)
    ? planSteps.find((step) => step.status !== "completed")?.description ?? null : input.ledger.currentStep;
  return { ...input.ledger, currentStep, completedSteps, planSteps,
    artifactRefs: [...new Set([...input.ledger.artifactRefs, ...input.artifactRefs])], version: input.ledger.version + 1, updatedAt: input.now };
}

function stepMatchesRecoveredTool(descriptionText: string, toolName: ToolResult["toolName"]): boolean {
  const description = descriptionText.toLowerCase();
  if (toolName === "filesystem.search") return description.includes("search") || description.includes("find") || description.includes("locate");
  if (toolName === "filesystem.read") return description.includes("read") || description.includes("inspect");
  if (toolName === "filesystem.patch") return description.includes("patch") || description.includes("fix") || description.includes("modify");
  if (toolName === "filesystem.write") return description.includes("write") || description.includes("create") || description.includes("add file");
  if (toolName === "shell.execute") return ["verify", "verification", "validation", "build", "test", "run ", "acceptance", "reproduction"].some((term) => description.includes(term));
  if (toolName === "project.inspect") return description.includes("inspect") || description.includes("repository") || description.includes("understand");
  if (toolName === "project.commands") return description.includes("command");
  if (toolName === "git.status") return description.includes("git status") || description.includes("status");
  if (toolName === "git.diff") return description.includes("diff");
  if (toolName === "git.show") return description.includes("show");
  return false;
}

async function readWorkspaceFileHash(workspaceRoot: string, relativePath: string): Promise<string | null> {
  try { return computeArtifactHash(readFileSync(await resolveWorkspaceFilePath(workspaceRoot, relativePath), "utf8")); }
  catch { return null; }
}
