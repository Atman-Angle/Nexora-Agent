import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  RunSnapshotSchema,
  CompletionRequirementsSchema,
  RuntimeActionSchema,
  RuntimeBudgetExtensionSchema,
  RuntimeBudgetsSchema,
  StructuredPlanSchema,
  TaskContractSchema,
  UNPLANNED_STEP_ID,
  JsonValueSchema,
  createInitialRunSnapshot,
  type BranchRecord,
  type CompletionRequirements,
  type Evidence,
  type PlanTaskContract,
  type RunEvent,
  type RunSnapshot,
  type RuntimeAction,
  type RuntimeBudgetExtension,
  type RuntimeBudgets,
  type TaskContract,
  type ToolInvocation
} from "./contracts.js";
import { ArtifactStore } from "./store/artifacts.js";
import {
  branchWorkspaceExists,
  cleanupStagingWorkspaces,
  removeDirectoryTree,
  snapshotWorkspace
} from "./store/branch-workspace.js";
import type { ForkContext } from "./contracts.js";
import {
  buildForkBaseInheritedFacts,
  buildForkBaseInheritedRefs
} from "./fork-inheritance.js";
import type {
  AgentAuditEvent,
  AgentDriver,
  AgentRuntimePort,
  AgentStateView,
  ContextEvidenceFact,
  ModelCallCompletion,
  ModelCallStart,
  ProviderAttemptCompletion,
  ProviderAttemptStart,
  RuntimeCommand
} from "./agent-runtime-port.js";
import { openRunStore, type RunStore } from "./store/run-store.js";
import { transitionRunStatus } from "./state-machine.js";
import { digestTaskContract, validateCompletion } from "./completion-gate.js";
import { deriveRunDelivery } from "./delivery.js";
import {
  ActionRejectedError,
  assertCompletedStepsUnchanged,
  completeSatisfiedSteps,
  deepFreeze,
  digestJson,
  digestCanonicalJson,
  errorMessage,
  responseRejectionDiagnostic,
  requireWorkspace,
  serializeRejectedResponse,
  toRunResult,
  validateToolContract
} from "./runtime-helpers.js";
import {
  callTool,
  executeReadToolBatch,
  type PreparedReadBatchCall,
  recoverToolInvocation
} from "./execution/runtime-execution.js";
import type {
  BranchHandle,
  BranchView,
  CreateRuntimeOptions,
  RuntimeDelegationPolicy,
  DenialOptions,
  ForkOptions,
  MergeDecisions,
  MergeOutcome,
  RecoveryDecision,
  RequestOptions,
  ResumeInput,
  RunFinalResult,
  RunHandle,
  RunHandleResumeOptions,
  RunInspection,
  RunLineage,
  RunOptions,
  RunContinuationInput,
  RunResult,
  RunSummary,
  RunView,
  RuntimeEventListener,
  RuntimeObserver,
  RuntimeServices,
  RuntimeSubscription,
  RuntimeWatch,
  RuntimeTool,
  StartInput,
  TextArtifactView,
  WorkerObservation,
  WorkerRecoveryRequest,
  SubscribeOptions
} from "./runtime-types.js";

import {
  projectRunFinalResult,
  projectRunInspection,
  projectRunSummary
} from "./runtime-public.js";
import {
  createRuntimeSubscription,
  type ManagedRuntimeSubscription
} from "./runtime-events.js";
import { RunControlError } from "./runtime-control-error.js";
import {
  RuntimeError,
  cancellationReason
} from "./runtime-error.js";
import { LeaseManager } from "./runtime-lease.js";

type NoProgressDiagnostic = {
  readonly fingerprint: string;
  readonly kind: string;
  readonly repeatCount: number;
  readonly strategyFingerprints?: readonly string[];
  readonly observationFingerprints?: readonly string[];
  readonly resources?: readonly string[];
  readonly reads?: number;
  readonly mutations?: number;
  readonly failures?: number;
};

const MAX_PROVIDER_FAILURES_PER_PROGRESS_WINDOW = 2;

export type {
  ApprovalDecision,
  BranchHandle,
  BranchView,
  CreateRuntimeOptions,
  ForkOptions,
  MergeDecisions,
  MergeOutcome,
  PublicEvidence,
  PublicInputEntry,
  PublicPendingRequest,
  PublicPlan,
  PublicRunError,
  PublicRunStatus,
  PublicStepProgress,
  PublicToolInvocation,
  PublicRecoveryRequest,
  RequestOptions,
  DenialOptions,
  RecoveryDecision,
  ResumeInput,
  RunFinalResult,
  RunHandle,
  RunInspection,
  RunHandleResumeOptions,
  RunOptions,
  RunContinuationInput,
  RunResult,
  RunSummary,
  TextArtifactView,
  RunView,
  RuntimeObserver,
  RuntimeDelegationPolicy,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeSubscription,
  RuntimeWatch,
  SubscribeOptions,
  RuntimeTool,
  RuntimeToolResult,
  WorkerObservation,
  StartInput
} from "./runtime-types.js";
export type { FailureHandoff } from "./runtime-types.js";
export {
  RunControlError,
  type RunControlErrorCode
} from "./runtime-control-error.js";
export {
  RuntimeError,
  type RuntimeErrorCode
} from "./runtime-error.js";

export class RuntimeEngine {
  readonly #workspace: string;
  readonly #dataDir: string;
  readonly #driver: AgentDriver;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #workerToolPolicies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly #delegationPolicy: RuntimeDelegationPolicy;
  readonly #allowedWorkerProfiles: ReadonlySet<string> | null;
  readonly #store: RunStore;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #artifactDir: string;
  readonly #leases: LeaseManager;
  readonly #activeExecutions = new Map<string, Promise<RunResult>>();
  readonly #executionControllers = new Map<string, AbortController>();
  readonly #subscriptions = new Map<
    string,
    Set<ManagedRuntimeSubscription>
  >();
  readonly #verifiedJournalHeads = new Map<string, string>();
  /** Branch child runId → isolated workspace root (directory snapshot). */
  readonly #branchWorkspaces = new Map<string, string>();
  readonly #branchWorkspaceCleanups = new Map<string, () => void>();
  /** Run IDs created by this Runtime instance; used only to recognize a real cross-instance continuation. */
  readonly #localRunIds = new Set<string>();
  /** Existing Runs opened by this instance and not yet continued. */
  readonly #reopenedRunIds = new Set<string>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: CreateRuntimeOptions) {
    try {
      const workspace = requireWorkspace(options.workspace);
      if (
        options.driver === null
        || typeof options.driver !== "object"
        || typeof options.driver.run !== "function"
      ) {
        throw new Error("Runtime driver must implement run().");
      }
      const tools = new Map<string, RuntimeTool>();
      for (const tool of options.tools) {
        const name = tool.contract.identity.name;
        validateToolContract(tool.contract);
        if (tools.has(name)) throw new Error(`Duplicate Runtime Tool: ${name}`);
        try {
          tool.contract.execution.inputSchema.parse(
            JsonValueSchema.parse(tool.contract.execution.inputExample)
          );
        } catch (error) {
          throw new Error(
            `Invalid inputExample for Runtime Tool ${name}: ${errorMessage(error)}`
          );
        }
        tools.set(name, tool);
      }
      const now = options.now ?? (() => new Date().toISOString());
      const createId = options.createId ?? randomUUID;
      const leaseTtlMs = options.leaseTtlMs ?? 60_000;
      if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
        throw new Error("leaseTtlMs must be a positive integer.");
      }
      const dataDir = resolve(options.dataDir ?? join(workspace, ".nexora"));
      this.#workspace = workspace;
      this.#dataDir = dataDir;
      this.#driver = options.driver;
      this.#now = now;
      this.#createId = createId;
      this.#tools = tools;
      const delegationPolicy = options.delegationPolicy ?? { mode: "allowed" as const, maxConcurrentWorkers: 8 };
      if (!Number.isInteger(delegationPolicy.maxConcurrentWorkers)
        || delegationPolicy.maxConcurrentWorkers < 2
        || delegationPolicy.maxConcurrentWorkers > 8) {
        throw new Error("delegationPolicy.maxConcurrentWorkers must be an integer from 2 through 8.");
      }
      this.#delegationPolicy = structuredClone(delegationPolicy);
      this.#allowedWorkerProfiles = delegationPolicy.allowedProfiles === undefined
        ? null
        : new Set(delegationPolicy.allowedProfiles);
      this.#workerToolPolicies = new Map(Object.entries(delegationPolicy.workerToolPolicies ?? {}).map(([profile, names]) => [
        profile,
        new Set(names)
      ]));
      this.#artifactDir = join(dataDir, "artifacts");
      this.#store = openRunStore({
        databasePath: join(dataDir, "runtime-v1.1.db")
      });
      this.#leases = new LeaseManager({
        store: this.#store,
        ownerId: createId(),
        leaseTtlMs,
        now
      });
      this.#recoverBranchWorkspaces(dataDir);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError({
        code: "INVALID_CONFIGURATION",
        message: errorMessage(error),
        cause: error
      });
    }
  }

  run(input: string, options: RunOptions = {}): RunHandle {
    this.#assertOpen();
    return this.#beginRun({ input, ...options }).handle;
  }

  openRun(runId: string): RunHandle {
    this.#assertOpen();
    this.#requireRun(runId);
    if (!this.#localRunIds.has(runId)) this.#reopenedRunIds.add(runId);
    return this.#createHandle(runId);
  }

  async listRuns(limit = 100): Promise<readonly RunSummary[]> {
    this.#assertOpen();
    return deepFreeze(this.#store.listRuns(limit).map((run) => projectRunSummary(run, this.#lineageForRun(run.runId))));
  }

  async readArtifactText(digest: string, maxBytes = 256_000): Promise<TextArtifactView> {
    this.#assertOpen();
    if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1_000_000) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Artifact text limit must be an integer from 1 through 1000000."
      });
    }
    try {
      const text = new ArtifactStore(this.#artifactDir).getText(digest);
      const bytes = Buffer.from(text, "utf8");
      const byteLength = bytes.byteLength;
      if (byteLength <= maxBytes) {
        return deepFreeze({ digest, byteLength, text, truncated: false });
      }
      const preview = bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
      return deepFreeze({ digest, byteLength, text: preview, truncated: true });
    } catch (error) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: errorMessage(error),
        cause: error
      });
    }
  }

  async start(input: StartInput, observer?: RuntimeObserver): Promise<RunResult> {
    return await this.#beginRun(input, observer).execution;
  }

  #beginRun(
    input: StartInput,
    observer?: RuntimeObserver
  ): { readonly handle: RunHandle; readonly execution: Promise<RunResult> } {
    this.#assertOpen();
    let budgets;
    let completionRequirements: CompletionRequirements;
    try {
      budgets = input.budgets === undefined
        ? undefined
        : RuntimeBudgetsSchema.parse(input.budgets);
      completionRequirements = CompletionRequirementsSchema.parse(
        input.completion ?? {
          evidence: "auto",
          requiredToolNames: []
        }
      );
      for (const toolName of completionRequirements.requiredToolNames) {
        if (!this.#tools.has(toolName)) {
          throw new Error(`Completion requires an unregistered Tool: ${toolName}`);
        }
      }
    } catch (error) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: errorMessage(error),
        cause: error
      });
    }
    const now = this.#now();
    const continuation = input.continuation === undefined
      ? undefined
      : this.#resolveContinuation(input.continuation);
    let snapshot: RunSnapshot;
    try {
      snapshot = createInitialRunSnapshot({
        runId: this.#createId(),
        input: input.input,
        workspace: this.#workspace,
        now,
        completionRequirements,
        ...(continuation === undefined ? {} : { continuation }),
        ...(budgets === undefined ? {} : { budgets })
      });
      if (continuation !== undefined) {
        const parent = this.#requireRun(continuation.parentRunId);
        const unfinishedSteps = parent.currentPlan?.orderedSteps.filter((step) => (
          parent.stepProgress.find((progress) => progress.stepId === step.id)?.status !== "completed"
        )) ?? [];
        if (
          this.#isRecoverableContinuationParent(parent)
          && parent.taskContract !== null
          && parent.currentPlan !== null
          && unfinishedSteps.length > 0
        ) {
          const carriedContract = TaskContractSchema.parse({
            ...parent.taskContract,
            version: 1,
            inputVersion: 1,
            workspace: this.#workspace
          });
          snapshot = RunSnapshotSchema.parse({
            ...snapshot,
            taskContract: carriedContract,
            currentPlan: {
              version: 1,
              basedOnVersion: null,
              goalDigest: digestTaskContract(carriedContract),
              orderedSteps: unfinishedSteps
            },
            stepProgress: unfinishedSteps.map((step, index) => ({
              stepId: step.id,
              status: index === 0 ? "active" as const : "pending" as const,
              evidenceIds: []
            }))
          });
        }
      }
    } catch (error) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: errorMessage(error),
        cause: error
      });
    }
    const created = this.#store.createRun(snapshot, {
      type: "run.created",
      occurredAt: now,
      actorType: "host",
      causationRef: `input:${snapshot.inputHistory[0]!.id}`,
      correlationRef: `run:${snapshot.runId}`,
      payload: {
        inputSequence: 1,
        inputId: snapshot.inputHistory[0]!.id,
        inputDigest: digestCanonicalJson(snapshot.inputHistory[0]!.text),
        ...(snapshot.continuation === undefined ? {} : { continuation: snapshot.continuation })
      }
    });
    this.#localRunIds.add(created.runId);
    this.#notify(created.runId, observer);
    const controller = new AbortController();
    const execution = this.#executeCreatedRun(created, controller, observer);
    this.#trackExecution(created.runId, execution, controller);
    return { handle: this.#createHandle(created.runId), execution };
  }

  async resume(input: ResumeInput, observer?: RuntimeObserver): Promise<RunResult> {
    this.#assertOpen();
    const run = this.#requireRun(input.runId);
    if (
      run.status === "cancelled"
      || run.status === "failed"
      || run.status === "succeeded"
    ) {
      return toRunResult(run);
    }
    if (this.#activeExecutions.has(run.runId)) {
      throw new RunControlError({
        code: "RUN_BUSY",
        runId: run.runId,
        message: "Run already has an active execution segment."
      });
    }
    const controller = new AbortController();
    const execution = this.#resumeRun(run, input, controller, observer);
    this.#trackExecution(run.runId, execution, controller);
    try {
      return await execution;
    } catch (error) {
      throw this.#mapExecutionBoundaryError(error, run.runId);
    }
  }

  async #resumeRun(
    initial: RunSnapshot,
    input: ResumeInput,
    controller: AbortController,
    observer?: RuntimeObserver
  ): Promise<RunResult> {
    let run = initial;
    const durationDeadline = this.#armDurationDeadline(run, controller);
    this.#leases.acquire(run.runId);
    this.#assertAuditIntegrity(run.runId);
    try {
      if (this.#reopenedRunIds.delete(run.runId)) {
        this.#store.recordRunEvent({
          runId: run.runId,
          event: {
            type: "run.reopened",
            occurredAt: this.#now(),
            payload: {
              status: run.status,
              ...(run.pendingRequest === null
                ? {}
                : {
                    pendingRequestKind: run.pendingRequest.kind,
                    pendingRequestId: run.pendingRequest.id
                  })
            }
          },
          fencingToken: this.#leases.requireFencingToken(run.runId)
        });
        this.#notify(run.runId, observer);
      }
      if (run.status === "blocked" && run.resumePredicate !== null) {
        this.#assertResumePredicate(run, input);
      }
      if (input.budgetExtension !== undefined) {
        if (run.status !== "blocked" || run.resumePredicate?.kind !== "budget_extension") {
          throw new Error("A Budget Extension requires a budget-blocked Run.");
        }
        const extension = RuntimeBudgetExtensionSchema.parse(input.budgetExtension);
        const previousBudgets = run.budgets;
        const next = RunSnapshotSchema.parse({
          ...run,
          budgets: {
            maxIterations: addQuota(previousBudgets.maxIterations, extension.iterations),
            maxModelCalls: addQuota(previousBudgets.maxModelCalls, extension.modelCalls),
            maxToolCalls: addQuota(previousBudgets.maxToolCalls, extension.toolCalls),
            maxRetries: addQuota(previousBudgets.maxRetries, extension.retries),
            maxDurationMs: previousBudgets.maxDurationMs
          },
          updatedAt: this.#now()
        });
        run = this.#commit(run, next, "run.budget_extended", {
          extension,
          previousBudgets,
          budgets: next.budgets
        }, observer);
      }
      run = await recoverToolInvocation(
        this.#services(controller.signal, run.runId),
        run,
        input.recoveryDecision,
        observer
      );
      const cancellation = this.#store.getCancellationRequest(run.runId);
      if (
        cancellation?.status === "requested"
        && !this.#hasUnknownInvocation(run.runId)
        && run.status !== "cancelled"
        && run.status !== "failed"
        && run.status !== "succeeded"
      ) {
        run = this.#cancelPersistedRun(run, cancellation.reason, observer);
      }
      if (
        run.status === "cancelled"
        || run.status === "failed"
      ) {
        return toRunResult(run);
      }
      if (controller.signal.aborted && run.status === "running") {
        run = this.#cancelPersistedRun(
          run,
          cancellationReason(controller.signal),
          observer
        );
        return toRunResult(run);
      }
      if (run.status === "blocked" && isBudgetStopReason(run.stopReason)) {
        if (run.resumePredicate?.kind !== "budget_extension") return toRunResult(run);
        if (this.#budgetFailure(run, Date.parse(this.#now())) !== null) {
          return toRunResult(run);
        }
        const now = this.#now();
        const resumed = transitionRunStatus(run, "running", { now });
        run = this.#commit(run, resumed, "run.resumed", {
          reason: "budget_extended"
        }, observer);
      } else if (
        run.status === "blocked"
        && run.resumePredicate?.kind === "provider_reconnect"
        && input.recoveryDecision === undefined
      ) {
        if (!this.#providerRecoveryAllowed(run.runId)) return toRunResult(run);
        const now = this.#now();
        const resumed = transitionRunStatus(run, "running", { now });
        run = this.#commit(run, resumed, "run.resumed", {
          reason: "provider_retry"
        }, observer);
      } else if (run.status === "blocked" && run.stopReason === "WORKER_RECOVERY_REQUIRED") {
        if (run.resumePredicate?.kind !== "worker_recovery_decision") return toRunResult(run);
        this.#reconcileDelegatedBranches(run.runId);
        run = this.#requireRun(run.runId);
        if (this.#workerRecoveryRequests(run.runId).length > 0) return toRunResult(run);
        const now = this.#now();
        const resumed = transitionRunStatus(run, "running", { now });
        run = this.#commit(run, resumed, "run.resumed", { reason: "worker_recovery_resolved" }, observer);
      } else if (run.status === "blocked" && run.stopReason === "NO_PROGRESS_DETECTED") {
        const text = input.input?.trim();
        if (text === undefined || text.length === 0) {
          return toRunResult(run);
        }
        const now = this.#now();
        const resumed = transitionRunStatus({
          ...run,
          inputHistory: [...run.inputHistory, {
            id: this.#createId(),
            sequence: run.inputHistory.length + 1,
            text,
            receivedAt: now
          }]
        }, "running", { now });
        run = this.#commit(run, resumed, "run.resumed", {
          reason: "no_progress_corrective_input",
          inputSequence: resumed.inputHistory.length
        }, observer);
      } else if (run.status === "blocked") {
        return toRunResult(run);
      }
      if (run.status === "waiting") {
        if (run.pendingRequest?.kind === "input") {
          if (input.input === undefined) return toRunResult(run);
          const requestId = run.pendingRequest.id;
          const text = input.input.trim();
          if (!text) throw new Error("Resume input must be non-empty.");
          const now = this.#now();
          const resumed = transitionRunStatus({
            ...run,
            inputHistory: [...run.inputHistory, {
              id: this.#createId(),
              sequence: run.inputHistory.length + 1,
              text,
              receivedAt: now
            }]
          }, "running", { now });
          run = this.#commit(run, resumed, "run.resumed", {
            requestId,
            inputSequence: resumed.inputHistory.length
          }, observer);
        } else if (run.pendingRequest?.kind === "approval") {
          const decision = input.approvalDecision;
          if (decision === undefined || decision.requestId !== run.pendingRequest.id) {
            throw new Error("Approval decision does not match the pending Approval Request.");
          }
          const reason = decision.reason?.trim();
          if (decision.approved && reason) throw new Error("Approval feedback is only valid for a denied request.");
          const pendingAction = RuntimeActionSchema.parse(run.pendingRequest.action);
          if (pendingAction.type !== "call_tool") throw new Error("Pending Approval does not contain a Tool action.");
          const now = this.#now();
          const denialInput = !decision.approved && reason
            ? {
                ...run,
                inputHistory: [...run.inputHistory, {
                  id: this.#createId(),
                  sequence: run.inputHistory.length + 1,
                  text: reason,
                  receivedAt: now
                }],
                lastError: { code: "APPROVAL_DENIED", message: reason, retryable: true, detailsArtifact: null }
              }
            : !decision.approved
              ? {
                  ...run,
                  lastError: {
                    code: "APPROVAL_DENIED",
                    message: "The user denied the protected Tool action.",
                    retryable: true,
                    detailsArtifact: null
                  }
                }
              : run;
          const resumed = transitionRunStatus(RunSnapshotSchema.parse(denialInput), "running", { now });
          run = this.#commit(run, resumed, decision.approved ? "approval.granted" : "approval.denied", {
            requestId: decision.requestId,
            ...(reason === undefined ? {} : { reason })
          }, observer);
          if (decision.approved) {
            run = await callTool(
              this.#services(controller.signal, run.runId),
              run,
              pendingAction,
              observer,
              true
            );
          } else {
            const waiting = transitionRunStatus(run, "waiting", {
              now,
              pendingRequest: {
                id: this.#createId(),
                kind: "input",
                prompt: "The protected Tool action was denied. Provide new instructions to continue.",
                createdAt: now
              },
              stopReason: "INPUT_REQUIRED"
            });
            run = this.#commit(run, waiting, "run.waiting", {
              reason: "APPROVAL_DENIED",
              requestId: waiting.pendingRequest?.id ?? null
            }, observer);
          }
        }
      }
      if (run.status !== "running") return toRunResult(run);
      this.#reconcileDelegatedBranches(run.runId);
      run = await this.#recoverAcceptedDelegations(run, controller.signal, observer);
      if (run.status !== "running") return toRunResult(run);
      try {
        return await this.#driveRun(run, controller.signal, observer);
      } catch (error) {
        const current = this.#requireRun(run.runId);
        if (
          current.status === "succeeded"
          || current.status === "failed"
          || current.status === "cancelled"
        ) return toRunResult(current);
        const failed = this.#fail(
          current,
          "INTERNAL_ERROR",
          "INTERNAL",
          observer,
          "The Run stopped because of an internal execution error. The persisted failure details are available for recovery."
        );
        this.#store.recordRunEvent({
          runId: failed.runId,
          event: {
            type: "runtime.event",
            occurredAt: this.#now(),
            payload: { name: "execution.error_contained", message: errorMessage(error) }
          },
          fencingToken: this.#leases.requireFencingToken(failed.runId)
        });
        this.#notify(failed.runId, observer);
        return toRunResult(failed);
      }
    } finally {
      clearTimeout(durationDeadline);
      this.#leases.release(run.runId);
    }
  }

  async inspect(runId: string): Promise<RunView> {
    this.#assertOpen();
    return {
      snapshot: this.#requireRun(runId),
      events: this.#store.listEvents(runId),
      toolInvocations: this.#store.listToolInvocations(runId),
      toolAttempts: this.#store.listToolAttempts(runId),
      modelCalls: this.#store.listModelCalls(runId)
    };
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#closeResources();
    void this.#closePromise.catch(() => undefined);
    return this.#closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #closeResources(): Promise<void> {
    const errors: unknown[] = [];
    for (const controller of this.#executionControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort("Runtime closed.");
      }
    }
    const subscriptionClosures: Promise<void>[] = [];
    for (const subscriptions of this.#subscriptions.values()) {
      for (const subscription of subscriptions) {
        subscriptionClosures.push(subscription.close());
      }
    }
    this.#subscriptions.clear();
    const subscriptionResults = await Promise.allSettled(subscriptionClosures);
    errors.push(...subscriptionResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason));

    const executionResults = await Promise.allSettled([
      ...this.#activeExecutions.values()
    ]);
    errors.push(...executionResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason));

    for (const tool of this.#tools.values()) {
      try {
        await tool.dispose?.();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.#driver.dispose?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#store.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new RuntimeError({
        code: "INTERNAL",
        message: `Runtime resource release failed: ${errorMessage(errors[0])}`,
        cause: errors[0]
      });
    }
  }

  async #executeCreatedRun(
    created: RunSnapshot,
    controller: AbortController,
    observer?: RuntimeObserver
  ): Promise<RunResult> {
    const durationDeadline = this.#armDurationDeadline(created, controller);
    this.#leases.acquire(created.runId);
    this.#assertAuditIntegrity(created.runId);
    try {
      try {
        return await this.#driveRun(created, controller.signal, observer);
      } catch (error) {
        const current = this.#requireRun(created.runId);
        if (
          current.status === "succeeded"
          || current.status === "failed"
          || current.status === "cancelled"
        ) return toRunResult(current);
        const failed = this.#fail(
          current,
          "INTERNAL_ERROR",
          "INTERNAL",
          observer,
          "The Run stopped because of an internal execution error. The persisted failure details are available for recovery."
        );
        this.#store.recordRunEvent({
          runId: failed.runId,
          event: {
            type: "runtime.event",
            occurredAt: this.#now(),
            payload: { name: "execution.error_contained", message: errorMessage(error) }
          },
          fencingToken: this.#leases.requireFencingToken(failed.runId)
        });
        this.#notify(failed.runId, observer);
        return toRunResult(failed);
      }
    } finally {
      clearTimeout(durationDeadline);
      this.#leases.release(created.runId);
    }
  }

  #armDurationDeadline(run: RunSnapshot, controller: AbortController): ReturnType<typeof setTimeout> {
    const deadline = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("DURATION_BUDGET_EXCEEDED");
    }, run.budgets.maxDurationMs);
    deadline.unref?.();
    return deadline;
  }

  #createHandle(runId: string): RunHandle {
    return Object.freeze({
      id: runId,
      inspect: async () => await this.#inspectHandle(runId),
      history: async (query = {}) => deepFreeze(this.#store.readAuditHistory(runId, query)),
      historyRecord: async (sequence) => deepFreeze(this.#store.readAuditRecord(runId, sequence)),
      modelCallTrace: async (callId) => deepFreeze(this.#store.readModelCallTrace(runId, callId)),
      verifyHistory: async () => deepFreeze(this.#verifyAuditIntegrity(runId)),
      wait: async () => await this.#waitForHandle(runId),
      result: async () => await this.#resultForHandle(runId),
      subscribe: (
        listener: RuntimeEventListener,
        options?: SubscribeOptions
      ) => this.#subscribeHandle(runId, listener, options),
      watch: async (listener: RuntimeEventListener) => this.#watchHandle(runId, listener),
      input: async (text: string, options?: RequestOptions) => {
        await this.#inputHandle(runId, text, options);
      },
      approve: async (options?: RequestOptions) => {
        await this.#approvalHandle(runId, true, options);
      },
      deny: async (options?: DenialOptions) => {
        await this.#approvalHandle(runId, false, options);
      },
      resume: async (options?: RunHandleResumeOptions) => {
        await this.#resumeHandle(runId, options);
      },
      cancel: async (reason?: string) => {
        await this.#cancelHandle(runId, reason);
      },
      compactContext: async () => {
        await this.#compactContextHandle(runId);
      }
    });
  }

  #subscribeHandle(
    runId: string,
    listener: RuntimeEventListener,
    options: SubscribeOptions = {}
  ): RuntimeSubscription {
    this.#assertOpen();
    this.#requireRun(runId);
    if (typeof listener !== "function") {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Runtime Event listener must be a function.",
        runId
      });
    }
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "afterSequence must be a non-negative integer.",
        runId
      });
    }
    let subscriptions = this.#subscriptions.get(runId);
    if (subscriptions === undefined) {
      subscriptions = new Set();
      this.#subscriptions.set(runId, subscriptions);
    }
    const subscription = createRuntimeSubscription({
      runId,
      afterSequence,
      listener,
      readEvents: (cursor) => this.#store.listEventsAfter(runId, cursor),
      readStatus: () => this.#requireRun(runId).status,
      onClose: (closed) => {
        const current = this.#subscriptions.get(runId);
        current?.delete(closed);
        if (current?.size === 0) this.#subscriptions.delete(runId);
      }
    });
    subscriptions.add(subscription);
    return subscription;
  }

  async #watchHandle(
    runId: string,
    listener: RuntimeEventListener
  ): Promise<RuntimeWatch> {
    this.#assertOpen();
    const slice = this.#store.readExecutionSlice(runId);
    const snapshot = projectRunInspection(
      slice.run,
      slice.invocations,
      slice.lastEventSequence,
      this.#store.listModelCalls(runId),
      this.#lineageForRun(runId),
      this.#workerRecoveryRequests(runId),
      this.#store.listEvents(runId).filter((event) => event.type === "plan.set").length,
      this.#physicalToolExecutions(runId)
    );
    const subscription = this.#subscribeHandle(runId, listener, {
      afterSequence: slice.lastEventSequence
    });
    return { snapshot, subscription };
  }

  async #inputHandle(
    runId: string,
    text: string,
    options: RequestOptions = {}
  ): Promise<void> {
    if (!text.trim()) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Run input must be non-empty.",
        runId
      });
    }
    this.#assertControlIdle(runId);
    await this.#withControlLease(runId, async () => {
      const run = this.#requirePendingRequest(runId, "input", options.requestId);
      await this.#performControl(runId, async () => {
        await this.resume({ runId: run.runId, input: text });
      });
    });
  }

  async #approvalHandle(
    runId: string,
    approved: boolean,
    options: DenialOptions = {}
  ): Promise<void> {
    this.#assertControlIdle(runId);
    await this.#withControlLease(runId, async () => {
      const run = this.#requirePendingRequest(
        runId,
        "approval",
        options.requestId
      );
      await this.#performControl(runId, async () => {
        await this.resume({
          runId: run.runId,
          approvalDecision: {
            requestId: run.pendingRequest!.id,
            approved,
            ...(!approved && options.reason !== undefined
              ? { reason: options.reason }
              : {})
          }
        });
      });
    });
  }

  async #resumeHandle(
    runId: string,
    options: RunHandleResumeOptions = {}
  ): Promise<void> {
    this.#assertControlIdle(runId);
    await this.#withControlLease(runId, async () => {
    const run = this.#requireRun(runId);
    if (run.status !== "blocked" && run.status !== "running") {
      throw this.#controlConflict(
        runId,
        `Run is ${run.status}; resume requires a blocked or interrupted running Run.`
      );
    }
    if (run.status === "blocked" && run.stopReason === "NO_PROGRESS_DETECTED") {
      if (options.input?.trim() === undefined || options.input.trim().length === 0) {
        throw this.#controlConflict(
          runId,
          "NO_PROGRESS_DETECTED requires corrective input or a new continuation Run; generic Resume is not allowed."
        );
      }
    } else if (options.input !== undefined) {
      throw this.#controlConflict(
        runId,
        "Corrective input is only valid for a NO_PROGRESS_DETECTED Run."
      );
    }
    if (
      run.status === "blocked"
      && (run.stopReason === "PROVIDER_UNAVAILABLE" || run.stopReason === "CONTEXT_CAPACITY_EXCEEDED")
      && !this.#providerRecoveryAllowed(runId)
    ) {
      this.#fail(
        run,
        run.stopReason,
        run.stopReason,
        undefined,
        "Provider recovery is exhausted for the current progress window."
      );
      return;
    }
    if (run.status === "blocked" && run.resumePredicate !== null) {
      this.#assertResumePredicate(run, options);
    }
    const unresolved = this.#store.listToolInvocations(runId)
      .filter(
        (invocation) => invocation.status === "prepared"
          || invocation.status === "started"
          || invocation.status === "unknown"
      );
    const unknown = unresolved.filter(
      (invocation) => invocation.status === "unknown"
    );
    const recovery = options.recovery;
    if (unknown.length > 0) {
      if (recovery === undefined && !this.#canAutomaticallyReconcile(unknown.map(({ id }) => id))) {
        throw this.#controlConflict(
          runId,
          "The unknown Tool Invocation requires a Recovery Decision."
        );
      }
      if (recovery !== undefined && !unknown.some(({ id }) => id === recovery.invocationId)) {
        throw this.#controlConflict(
          runId,
          "Recovery Decision does not match the current unknown Tool Invocation."
        );
      }
    } else if (recovery !== undefined) {
      throw this.#controlConflict(
        runId,
        "Run has no unknown Tool Invocation to recover."
      );
    }
    if (
      run.status === "running"
      && unresolved.length === 0
      && !this.#reopenedRunIds.has(runId)
    ) {
      throw this.#controlConflict(
        runId,
        "Running Run has no interrupted Tool Invocation to recover."
      );
    }
    if (options.budgetExtension !== undefined && run.resumePredicate?.kind !== "budget_extension") {
      throw this.#controlConflict(
        runId,
        "Budget Extension requires a budget-blocked Run."
      );
    }
    if (run.resumePredicate?.kind === "budget_extension" && options.budgetExtension === undefined) {
      throw this.#controlConflict(
        runId,
        "This Run requires a Budget Extension before it can resume."
      );
    }
    await this.#performControl(runId, async () => {
      await this.resume({
        runId,
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.budgetExtension === undefined
          ? {}
          : { budgetExtension: options.budgetExtension }),
        ...(options.recovery === undefined
          ? {}
          : { recoveryDecision: options.recovery })
      });
    });
    });
  }

  async #cancelHandle(runId: string, reason?: string): Promise<void> {
    this.#assertOpen();
    const message = this.#cancelMessage(reason);
    let run = this.#requireRun(runId);
    if (
      run.status === "cancelled"
      || run.status === "failed"
      || run.status === "succeeded"
    ) {
      throw this.#controlConflict(
        runId,
        `Run is already terminal: ${run.status}.`
      );
    }

    const active = this.#activeExecutions.get(runId);
    const controller = this.#executionControllers.get(runId);
    if (active !== undefined && controller !== undefined) {
      this.#requestCancellation(runId, message);
      if (!controller.signal.aborted) controller.abort(message);
      try {
        await active;
      } catch (error) {
        throw this.#mapExecutionBoundaryError(error, runId);
      }
      this.#assertCancellationOutcome(runId);
      return;
    }

    if (run.status === "running") {
      const interruptedController = new AbortController();
      const execution = this.#resumeRun(
        run,
        { runId },
        interruptedController
      );
      this.#trackExecution(runId, execution, interruptedController);
      try {
        // #resumeRun acquires the Lease synchronously before its first await.
        this.#requestCancellation(runId, message);
        interruptedController.abort(message);
        await execution;
      } catch (error) {
        throw this.#mapExecutionBoundaryError(error, runId);
      }
      this.#assertCancellationOutcome(runId);
      return;
    }

    try {
      this.#leases.acquire(runId);
      this.#assertAuditIntegrity(runId);
      run = this.#requireRun(runId);
      if (this.#hasUnknownInvocation(runId)) {
        throw this.#toolResultUnknown(runId);
      }
      if (
        run.status === "cancelled"
        || run.status === "failed"
        || run.status === "succeeded"
      ) {
        throw this.#controlConflict(
          runId,
          `Run became terminal before cancellation: ${run.status}.`
        );
      }
      this.#requestCancellation(runId, message);
      this.#cancelPersistedRun(run, message);
    } catch (error) {
      throw this.#mapControlBoundaryError(error, runId);
    } finally {
      this.#leases.release(runId);
    }
  }

  #cancelMessage(reason?: string): string {
    if (reason === undefined) return "The Run was cancelled by its host.";
    const message = reason.trim();
    if (!message || message.length > 500) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Cancellation reason must be non-empty and at most 500 characters."
      });
    }
    return message;
  }

  #requestCancellation(runId: string, reason: string): void {
    const existing = this.#store.getCancellationRequest(runId);
    if (existing !== null) return;
    this.#store.requestCancellation({
      requestId: this.#createId(),
      runId,
      reason,
      requestedAt: this.#now()
    });
    this.#notify(runId);
  }

  #assertCancellationOutcome(runId: string): void {
    const run = this.#requireRun(runId);
    if (run.status === "cancelled") return;
    if (run.status === "blocked" && this.#hasUnknownInvocation(runId)) {
      throw this.#toolResultUnknown(runId);
    }
    throw this.#controlConflict(
      runId,
      `Run reached ${run.status} before cancellation could complete.`
    );
  }

  #hasUnknownInvocation(runId: string): boolean {
    return this.#store.listToolInvocations(runId)
      .some((invocation) => invocation.status === "unknown");
  }

  #toolResultUnknown(runId: string): RuntimeError {
    return new RuntimeError({
      code: "TOOL_RESULT_UNKNOWN",
      message: "Cancellation cannot complete while a Tool result is unknown.",
      retryable: false,
      runId
    });
  }

  async #performControl(
    runId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (error instanceof RunControlError) throw error;
      const message = errorMessage(error);
      if (message.startsWith("RUN_BUSY:") || message.includes("RUN_LEASE_")) {
        throw new RunControlError({
          code: "RUN_BUSY",
          runId,
          message: "Run is controlled by another Runtime."
        });
      }
      if (message.includes("Run revision conflict")) {
        throw this.#controlConflict(
          runId,
          "Run changed while the control operation was being applied."
        );
      }
      throw error;
    }
  }

  async #withControlLease(
    runId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      this.#leases.acquire(runId);
      this.#assertAuditIntegrity(runId);
    } catch (error) {
      throw this.#mapControlBoundaryError(error, runId);
    }
    try {
      await operation();
    } finally {
      this.#leases.release(runId);
    }
  }

  /**
   * Synchronous variant of #withControlLease for control-plane operations that
   * write the parent Run (fork / merge / discard): acquires the parent's lease,
   * runs the fenced write, and releases it in a finally block.
   */
  #withControlLeaseSync<T>(runId: string, operation: () => T): T {
    try {
      this.#leases.acquire(runId);
      this.#assertAuditIntegrity(runId);
    } catch (error) {
      throw this.#mapControlBoundaryError(error, runId);
    }
    try {
      return operation();
    } finally {
      this.#leases.release(runId);
    }
  }

  #mapControlBoundaryError(error: unknown, runId: string): Error {
    if (error instanceof RuntimeError) return error;
    const message = errorMessage(error);
    if (message.startsWith("RUN_BUSY:") || message.includes("RUN_LEASE_")) {
      return new RunControlError({
        code: "RUN_BUSY",
        runId,
        message: "Run is controlled by another Runtime."
      });
    }
    if (message.includes("Run revision conflict")) {
      return this.#controlConflict(
        runId,
        "Run changed while cancellation was being applied."
      );
    }
    return new RuntimeError({
      code: "INTERNAL",
      message,
      runId,
      cause: error
    });
  }

  #assertControlIdle(runId: string): void {
    this.#assertOpen();
    if (this.#activeExecutions.has(runId)) {
      throw new RunControlError({
        code: "RUN_BUSY",
        runId,
        message: "Run already has an active execution segment."
      });
    }
  }

  #requirePendingRequest(
    runId: string,
    kind: "input" | "approval",
    requestId?: string
  ): RunSnapshot {
    const run = this.#requireRun(runId);
    const pending = run.pendingRequest;
    if (run.status !== "waiting" || pending === null || pending.kind !== kind) {
      throw this.#controlConflict(
        runId,
        `Run has no current ${kind} request.`,
        requestId
      );
    }
    if (requestId !== undefined && requestId !== pending.id) {
      throw this.#controlConflict(
        runId,
        `Request ${requestId} is stale or does not match the current request.`,
        requestId
      );
    }
    return run;
  }

  #controlConflict(
    runId: string,
    message: string,
    requestId?: string
  ): RunControlError {
    return new RunControlError({
      code: "RUN_STATE_CONFLICT",
      runId,
      message,
      ...(requestId === undefined ? {} : { requestId })
    });
  }

  async #inspectHandle(runId: string): Promise<RunInspection> {
    this.#assertOpen();
    const slice = this.#store.readExecutionSlice(runId);
    return projectRunInspection(
      slice.run,
      slice.invocations,
      slice.lastEventSequence,
      this.#store.listModelCalls(runId),
      this.#lineageForRun(runId),
      this.#workerRecoveryRequests(runId),
      this.#store.listEvents(runId).filter((event) => event.type === "plan.set").length,
      this.#physicalToolExecutions(runId)
    );
  }

  async #compactContextHandle(runId: string): Promise<void> {
    this.#assertOpen();
    this.#assertControlIdle(runId);
    const run = this.#requireRun(runId);
    if (!isTerminalRun(run)) {
      throw this.#controlConflict(runId, "Context compaction requires a terminal Run.");
    }
    const invocations = this.#store.listToolInvocations(runId);
    if (invocations.some((invocation) => invocation.status === "started" || invocation.status === "unknown")) {
      throw this.#controlConflict(runId, "Resolve every pending Tool effect before compacting Context.");
    }
    this.#assertAuditIntegrity(runId);
    if (this.#store.listEvents(runId).some((event) => event.type === "context.compaction.requested")) return;
    const now = this.#now();
    this.#store.recordRunEvent({
      runId,
      event: {
        type: "context.compaction.requested",
        occurredAt: now,
        actorType: "host",
        causationRef: `run:${runId}`,
        correlationRef: `run:${runId}`,
        payload: { mode: "deterministic", requestedAt: now }
      }
    });
    this.#notify(runId);
  }

  async #waitForHandle(runId: string): Promise<RunInspection> {
    this.#assertOpen();
    this.#requireRun(runId);
    const execution = this.#activeExecutions.get(runId);
    if (execution !== undefined) await execution;
    return await this.#inspectHandle(runId);
  }

  async #resultForHandle(runId: string): Promise<RunFinalResult> {
    await this.#waitForHandle(runId);
    const snapshot = this.#requireRun(runId);
    const result = projectRunFinalResult(snapshot);
    if (result === null) {
      if (
        snapshot.status === "blocked"
        && snapshot.lastError?.code === "TOOL_RESULT_UNKNOWN"
      ) {
        throw this.#toolResultUnknown(runId);
      }
      if (
        snapshot.status === "blocked"
        && snapshot.lastError?.code === "PROVIDER_UNAVAILABLE"
      ) {
        throw new RuntimeError({
          code: "PROVIDER_UNAVAILABLE",
          message: snapshot.lastError.message,
          retryable: snapshot.lastError.retryable,
          runId
        });
      }
      throw new RunControlError({
        code: "RUN_STATE_CONFLICT",
        runId,
        message: `Run is not terminal: ${snapshot.status}. Use wait() or inspect().`
      });
    }
    return result;
  }

  #deleteActiveExecution(
    runId: string,
    execution: Promise<RunResult>
  ): void {
    if (this.#activeExecutions.get(runId) === execution) {
      this.#activeExecutions.delete(runId);
      this.#executionControllers.delete(runId);
    }
  }

  #trackExecution(
    runId: string,
    execution: Promise<RunResult>,
    controller: AbortController
  ): void {
    this.#activeExecutions.set(runId, execution);
    this.#executionControllers.set(runId, controller);
    void execution.then(
      () => this.#deleteActiveExecution(runId, execution),
      () => this.#deleteActiveExecution(runId, execution)
    );
    void execution.catch(() => undefined);
  }

  #mapExecutionBoundaryError(error: unknown, runId: string): Error {
    if (error instanceof RuntimeError) return error;
    return this.#mapControlBoundaryError(error, runId);
  }

  #cancelPersistedRun(
    run: RunSnapshot,
    message: string,
    observer?: RuntimeObserver
  ): RunSnapshot {
    if (
      run.status !== "running"
      && run.status !== "waiting"
      && run.status !== "blocked"
    ) {
      throw this.#controlConflict(
        run.runId,
        `Run cannot be cancelled from ${run.status}.`
      );
    }
    const input = RunSnapshotSchema.parse({
      ...run,
      lastError: {
        code: "CANCELLED",
        message,
        retryable: false,
        detailsArtifact: null
      }
    });
    const cancelled = transitionRunStatus(input, "cancelled", {
      now: this.#now(),
      stopReason: "CANCELLED",
      delivery: deriveRunDelivery({
        run: input,
        outcome: "cancelled",
        now: this.#now(),
        stopReason: "CANCELLED"
      })
    });
    const request = this.#store.getCancellationRequest(run.runId);
    if (request !== null && request.status === "requested") {
      const committed = this.#store.reconcileCancellationAndCommitRun({
        requestId: request.id,
        previous: run,
        next: cancelled,
        fencingToken: this.#leases.requireFencingToken(run.runId),
        event: {
          type: "run.cancelled",
          occurredAt: cancelled.updatedAt,
          payload: { reason: message, requestId: request.id }
        }
      });
      this.#notify(run.runId, observer);
      return committed;
    }
    return this.#commit(run, cancelled, "run.cancelled", { reason: message }, observer);
  }

  async #driveRun(
    initial: RunSnapshot,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunResult> {
    return await this.#driver.run(
      this.#agentRuntimePort(),
      initial,
      signal,
      observer
    );
  }

  #agentRuntimePort(): AgentRuntimePort {
    return {
      now: () => this.#now(),
      createId: () => this.#createId(),
      readState: (runId) => this.#readAgentState(runId),
      readArtifactText: (digest) => new ArtifactStore(this.#artifactDir).getText(digest),
      artifactExists: (digest) => new ArtifactStore(this.#artifactDir).has(digest),
      commitPlan: (run, proposal, observer) => this.#setPlan(run, proposal, observer),
      dispatch: async (run, command, signal, observer) => (
        await this.#handleAction(run, command, signal, observer)
      ),
      recordContextEvidence: (run, facts, observer) => (
        this.#recordContextRefEvidence(run, facts, observer)
      ),
      rejectModelResponse: (run, error, rawResponse, observer) => {
        if (!(error instanceof z.ZodError) && !(error instanceof ActionRejectedError)) throw error;
        return this.#rejectResponse(run, error, rawResponse, observer);
      },
      cancel: (run, message, observer) => this.#cancelPersistedRun(run, message, observer),
      enforceBudget: (run, activeStartedAt, observer) => {
        const failure = this.#budgetFailure(run, activeStartedAt);
        return failure === null ? null : this.#blockForBudget(run, failure, observer);
      },
      enforceConvergence: (run, observer) => this.#enforceConvergence(run, observer),
      finalizeBudget: (run, activeStartedAt, summary, observer) => {
        const failure = this.#budgetFailure(run, activeStartedAt);
        if (failure === null) throw new Error("Budget finalization requires an exhausted Runtime budget.");
        return this.#blockForBudget(run, failure, observer, summary);
      },
      blockForProvider: (run, error, observer) => (
        this.#blockForProvider(run, error, observer)
      ),
      beginModelCall: (run, input, observer) => this.#beginModelCall(run, input, observer),
      completeModelCall: (runId, input) => this.#completeModelCall(runId, input),
      beginProviderAttempt: (runId, input) => this.#beginProviderAttempt(runId, input),
      completeProviderAttempt: (runId, input) => this.#completeProviderAttempt(runId, input),
      recordAgentEvent: (runId, event, observer) => (
        this.#recordAgentEvent(runId, event, observer)
      ),
      withHeartbeat: (runId, operation) => this.#leases.withHeartbeat(runId, operation),
      completeRun: (run, input, observer) => this.#completeAgentRun(run, input, observer)
    };
  }

  #readAgentState(runId: string): AgentStateView {
    const run = this.#requireRun(runId);
    const latestModelCall = this.#store.listModelCalls(runId).at(-1);
    const forkContext = this.#forkContextFor(runId);
    const parentRun = forkContext === null ? null : this.#store.getRun(forkContext.parentRunId);
    return Object.freeze({
      run,
      workspace: this.#workspaceFor(runId),
      tools: Object.freeze(
        [...this.#toolsForRun(runId).values()].map((tool) => Object.freeze({ contract: tool.contract }))
      ),
      invocations: Object.freeze(this.#store.listToolInvocations(runId)),
      attempts: Object.freeze(this.#store.listToolAttempts(runId)),
      events: Object.freeze(this.#store.listEvents(runId)),
      continuationAncestors: Object.freeze(this.#continuationAncestors(run)),
      forkContext,
      parentRun,
      parentInvocations: Object.freeze(
        parentRun === null ? [] : this.#store.listToolInvocations(parentRun.runId)
      ),
      workerObservations: Object.freeze(this.#workerObservationsForDecision(runId)),
      latestModelCallAudit: latestModelCall === undefined
        ? null
        : this.#store.getModelCallAudit(latestModelCall.id)
    });
  }

  #resolveContinuation(input: RunContinuationInput): NonNullable<RunSnapshot["continuation"]> {
    const parentRunId = typeof input.parentRunId === "string" ? input.parentRunId.trim() : "";
    if (parentRunId === "") {
      throw new RuntimeError({
        code: "INVALID_CONTINUATION",
        message: "Continuation parentRunId must be a non-empty Run ID."
      });
    }
    const parent = this.#store.getRun(parentRunId);
    if (parent === null) {
      throw new RuntimeError({
        code: "INVALID_CONTINUATION",
        message: "Continuation parent is unavailable in this Runtime Store."
      });
    }
    const recoverableBlockedParent = this.#isRecoverableContinuationParent(parent);
    if (!isTerminalRun(parent) && !recoverableBlockedParent) {
      throw new RuntimeError({
        code: "INVALID_CONTINUATION",
        runId: parentRunId,
        message: "Continuation parent must be terminal or at an exhausted bounded-recovery boundary."
      });
    }
    if (this.#store.listToolInvocations(parentRunId).some((invocation) => (
      invocation.status === "started" || invocation.status === "unknown"
    ))) {
      throw new RuntimeError({
        code: "INVALID_CONTINUATION",
        runId: parentRunId,
        message: "Continuation parent has an unresolved Tool effect."
      });
    }
    // Reading the verified chain also rejects legacy corruption and cycles
    // before a new immutable edge is persisted.
    this.#continuationAncestors(parent);
    const lastEventSequence = this.#store.listEvents(parentRunId).at(-1)?.sequence;
    if (lastEventSequence === undefined) {
      throw new RuntimeError({
        code: "INVALID_CONTINUATION",
        runId: parentRunId,
        message: "Continuation parent has no persisted event boundary."
      });
    }
    return {
      parentRunId,
      parentRevision: parent.revision,
      parentLastEventSequence: lastEventSequence
    };
  }

  #continuationAncestors(run: RunSnapshot): AgentStateView["continuationAncestors"] {
    const newestFirst: Array<AgentStateView["continuationAncestors"][number]> = [];
    const visited = new Set<string>([run.runId]);
    let child = run;
    while (child.continuation !== undefined) {
      const edge = child.continuation;
      if (visited.has(edge.parentRunId)) {
        throw new RuntimeError({
          code: "INVALID_CONTINUATION",
          runId: run.runId,
          message: "Continuation lineage contains a cycle."
        });
      }
      visited.add(edge.parentRunId);
      const parent = this.#store.getRun(edge.parentRunId);
      const allEvents = parent === null ? [] : this.#store.listEvents(parent.runId);
      const boundaryExists = allEvents.some((event) => event.sequence === edge.parentLastEventSequence);
      const recoverableBlockedParent = parent !== null
        && this.#isRecoverableContinuationParent(parent);
      if (
        parent === null
        || parent.revision !== edge.parentRevision
        || !boundaryExists
        || (!isTerminalRun(parent) && !recoverableBlockedParent)
      ) {
        throw new RuntimeError({
          code: "INVALID_CONTINUATION",
          runId: run.runId,
          message: "Continuation lineage no longer matches its persisted authority boundary."
        });
      }
      const events = allEvents.filter((event) => event.sequence <= edge.parentLastEventSequence);
      const invocations = this.#store.listToolInvocations(parent.runId);
      if (invocations.some((invocation) => invocation.status === "started" || invocation.status === "unknown")) {
        throw new RuntimeError({
          code: "INVALID_CONTINUATION",
          runId: run.runId,
          message: "Continuation lineage contains an unresolved Tool effect."
        });
      }
      newestFirst.push(Object.freeze({
        run: parent,
        invocations: Object.freeze(invocations),
        attempts: Object.freeze(this.#store.listToolAttempts(parent.runId)),
        events: Object.freeze(events)
      }));
      child = parent;
    }
    return newestFirst.reverse();
  }

  #beginModelCall(
    run: RunSnapshot,
    input: ModelCallStart,
    observer?: RuntimeObserver
  ): RunSnapshot {
    this.#assertAuditIntegrity(run.runId);
    const requestCapture = input.capturePolicy === "metadata"
      ? { digest: input.manifest.projectionDigest }
      : this.#captureAuditPayload(input.requestPayload, input.capturePolicy);
    const next = RunSnapshotSchema.parse({
      ...run,
      budgetsUsed: {
        ...run.budgetsUsed,
        iterations: run.budgetsUsed.iterations + (input.countIteration ? 1 : 0),
        modelCalls: run.budgetsUsed.modelCalls + 1
      },
      updatedAt: this.#now()
    });
    const persisted = this.#store.beginModelCallAndCommitRun({
      intent: input.intent,
      manifest: input.manifest,
      capturePolicy: input.capturePolicy,
      requestDigest: requestCapture.digest,
      ...(requestCapture.artifactRef === undefined ? {} : { requestArtifactRef: requestCapture.artifactRef }),
      previous: run,
      next,
      fencingToken: this.#leases.requireFencingToken(run.runId),
      event: {
        type: input.eventType,
        occurredAt: this.#now(),
        payload: { callId: input.intent.id, ...input.eventPayload }
      }
    });
    this.#notify(run.runId, observer);
    return persisted.run;
  }

  #completeModelCall(runId: string, input: ModelCallCompletion): void {
    const audit = this.#store.getModelCallAudit(input.callId);
    if (audit === null) throw new Error(`Model call audit is missing: ${input.callId}`);
    const outputCapture = input.outputPayload === undefined
      ? undefined
      : this.#captureAuditPayload(input.outputPayload, audit.capturePolicy);
    const errorCapture = input.errorPayload === undefined
      ? undefined
      : this.#captureAuditPayload(input.errorPayload, audit.capturePolicy);
    this.#store.completeModelCall({
      ...input,
      ...(outputCapture === undefined ? {} : {
        outputDigest: outputCapture.digest,
        ...(outputCapture.artifactRef === undefined ? {} : { outputArtifactRef: outputCapture.artifactRef })
      }),
      ...(errorCapture === undefined ? {} : {
        errorDigest: errorCapture.digest,
        ...(errorCapture.artifactRef === undefined ? {} : { errorArtifactRef: errorCapture.artifactRef })
      }),
      completedAt: this.#now(),
      fencingToken: this.#leases.requireFencingToken(runId)
    });
    this.#trustCurrentJournalHead(runId);
  }

  #beginProviderAttempt(runId: string, input: ProviderAttemptStart) {
    this.#assertAuditIntegrity(runId);
    const attempt = this.#store.beginProviderAttempt({
      ...input,
      runId,
      startedAt: this.#now(),
      fencingToken: this.#leases.requireFencingToken(runId)
    });
    this.#trustCurrentJournalHead(runId);
    return attempt;
  }

  #completeProviderAttempt(runId: string, input: ProviderAttemptCompletion) {
    const audit = this.#store.getModelCallAudit(
      input.callId
    );
    const responseCapture = input.responsePayload === undefined
      ? undefined
      : this.#captureAuditPayload(
          input.responsePayload,
          input.captureResponsePayload === true ? "redacted" : audit?.capturePolicy ?? "metadata"
        );
    const { captureResponsePayload: _captureResponsePayload, ...completion } = input;
    const attempt = this.#store.completeProviderAttempt({
      ...completion,
      ...(responseCapture === undefined ? {} : {
        responseDigest: responseCapture.digest,
        ...(responseCapture.artifactRef === undefined ? {} : { responseArtifactRef: responseCapture.artifactRef })
      }),
      completedAt: this.#now(),
      fencingToken: this.#leases.requireFencingToken(runId)
    });
    this.#trustCurrentJournalHead(runId);
    return attempt;
  }

  #captureAuditPayload(value: unknown, policy: "metadata" | "redacted"): {
    readonly digest: string;
    readonly artifactRef?: string;
  } {
    const digest = digestCanonicalJson(value);
    if (policy === "metadata") return { digest };
    const artifact = new ArtifactStore(this.#artifactDir).putText(
      JSON.stringify(value),
      "application/json"
    );
    return { digest, artifactRef: artifact.digest };
  }

  #verifyAuditIntegrity(runId: string) {
    const artifacts = new ArtifactStore(this.#artifactDir);
    return this.#store.verifyAuditIntegrity(runId, (digest) => artifacts.verify(digest));
  }

  #assertAuditIntegrity(runId: string): void {
    const currentHead = this.#store.getLastEvent(runId)?.recordDigest;
    if (currentHead !== undefined && this.#verifiedJournalHeads.get(runId) === currentHead) return;
    const integrity = this.#verifyAuditIntegrity(runId);
    if (!integrity.valid) {
      throw new RuntimeError({
        code: "INTERNAL",
        message: `Run Journal integrity verification failed: ${integrity.error ?? "unknown error"}`,
        runId
      });
    }
    this.#trustCurrentJournalHead(runId);
  }

  #trustCurrentJournalHead(runId: string): void {
    const digest = this.#store.getLastEvent(runId)?.recordDigest;
    if (digest !== undefined) this.#verifiedJournalHeads.set(runId, digest);
  }

  #recordAgentEvent(
    runId: string,
    event: AgentAuditEvent,
    observer?: RuntimeObserver
  ): void {
    this.#store.recordRunEvent({
      runId,
      event: {
        type: event.type,
        occurredAt: this.#now(),
        payload: { ...event.payload }
      },
      fencingToken: this.#leases.requireFencingToken(runId)
    });
    this.#notify(runId, observer);
  }

  #completeAgentRun(
    run: RunSnapshot,
    input: { readonly summary: string; readonly completionMode: "task_result" | "direct_response" },
    observer?: RuntimeObserver
  ): RunSnapshot {
    const activeWorkers = this.#store.listBranches(run.runId).filter((branch) => {
      if (branch.status !== "active" && branch.status !== "creating") return false;
      const child = this.#store.getRun(branch.childRunId);
      return child !== null && child.status !== "succeeded" && child.status !== "failed" && child.status !== "cancelled";
    });
    if (activeWorkers.length > 0) {
      throw new ActionRejectedError(`Completion is not valid: ${activeWorkers.length} delegated Worker Run(s) are still active.`);
    }
    const validation = validateCompletion(
      run,
      this.#store.listToolInvocations(run.runId),
      (digest) => new ArtifactStore(this.#artifactDir).verify(digest),
      input.completionMode,
      (toolName) => this.#tools.get(toolName)?.contract.execution.effect.kind
    );
    if (!validation.passed) {
      throw new ActionRejectedError(`Completion is not valid: ${validation.issues.join(", ")}`);
    }
    const evidenceIds = validation.evidenceIds;
    const completedNavigation = RunSnapshotSchema.parse({
      ...run,
      lastError: null,
      updatedAt: this.#now()
    });
    const resultArtifact = Buffer.byteLength(input.summary, "utf8") > 4_096
      ? new ArtifactStore(this.#artifactDir).putText(input.summary, "text/plain").digest
      : null;
    const boundedSummary = resultArtifact === null ? input.summary : `${input.summary.slice(0, 4_096)}\n[Full result: artifact ${resultArtifact}]`;
    const succeeded = transitionRunStatus(completedNavigation, "succeeded", {
      now: this.#now(),
      stopReason: "COMPLETED",
      result: { summary: boundedSummary, resultArtifact, evidenceIds: [...evidenceIds] },
      delivery: deriveRunDelivery({
        run: completedNavigation,
        outcome: "succeeded",
        now: this.#now(),
        stopReason: "COMPLETED",
        summary: boundedSummary,
        generatedBy: "model"
      })
    });
    return this.#commit(
      run,
      succeeded,
      "run.succeeded",
      { evidenceIds, completionGate: "deterministic", completionMode: input.completionMode },
      observer
    );
  }

  #recordContextRefEvidence(
    run: RunSnapshot,
    facts: readonly ContextEvidenceFact[],
    observer?: RuntimeObserver
  ): RunSnapshot {
    const plan = run.currentPlan;
    if (plan === null) return run;
    const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
    const activeStep = plan.orderedSteps.find((item) => item.id === activeStepId);
    if (activeStep === undefined) return run;
    const available = new Map(facts.filter((fact) => fact.error === null).map((fact) => [fact.ref, fact]));
    const existingChecks = new Set(run.evidence.filter((item) => (
      item.planVersion <= plan.version && item.stepId === activeStep.id
    )).map((item) => item.checkId));
    const newEvidence: Evidence[] = activeStep.acceptanceChecks.flatMap((check) => {
      if (check.kind !== "context_ref" || existingChecks.has(check.id)) return [];
      const fact = available.get(check.ref);
      if (fact === undefined) return [];
      return [{
        id: this.#createId(),
        kind: "context_ref" as const,
        source: "context" as const,
        producedAt: this.#now(),
        planVersion: plan.version,
        stepId: activeStep.id,
        checkId: check.id,
        subjectRef: fact.ref,
        invocationId: null,
        artifactRef: null,
        digest: fact.digest
      }];
    });
    if (newEvidence.length === 0) return run;
    const evidence = [...run.evidence, ...newEvidence];
    const next = RunSnapshotSchema.parse({
      ...run,
      evidence,
      stepProgress: completeSatisfiedSteps(plan, run.stepProgress, evidence),
      updatedAt: this.#now()
    });
    return this.#commit(run, next, "context.evidence_recorded", {
      evidenceIds: newEvidence.map((item) => item.id),
      refs: newEvidence.map((item) => item.subjectRef)
    }, observer);
  }

  async #handleAction(
    run: RunSnapshot,
    action: RuntimeCommand,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    if (action.type === "delegate_workers") {
      return this.#delegateWorkers(run, action, signal, observer);
    }
    if (action.type === "execute_step") return this.#handleExecuteStep(run, action, signal, observer);
    if (action.type === "request_input") {
      const now = this.#now();
      const waiting = transitionRunStatus(run, "waiting", {
        now,
        pendingRequest: { id: this.#createId(), kind: "input", prompt: action.question, createdAt: now },
        stopReason: "INPUT_REQUIRED"
      });
      return this.#commit(run, waiting, "run.waiting", {
        reason: action.reason,
        requestId: waiting.pendingRequest?.id ?? null,
        kind: "input",
        prompt: action.question
      }, observer);
    }
    if (action.type === "call_tool") {
      this.#assertMutationActionsAdmissible(run, [action]);
      return callTool(this.#services(signal, run.runId), run, action, observer);
    }
    throw new ActionRejectedError("Unsupported Runtime command.");
  }

  async #delegateWorkers(
    run: RunSnapshot,
    action: Extract<RuntimeAction, { type: "delegate_workers" }>,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    signal.throwIfAborted();
    if (this.#store.getBranchByChild(run.runId) !== null) {
      throw new ActionRejectedError(
        "WORKER_DELEGATION_FORBIDDEN: A Child Worker Run cannot delegate additional Workers."
      );
    }
    if (this.#delegationPolicy.mode === "forbidden") {
      throw new ActionRejectedError("WORKER_DELEGATION_FORBIDDEN: Host policy forbids Worker delegation.");
    }
    const fingerprints = action.assignments.map((assignment) => ({
      objectiveDigest: digestJson(assignment.objective),
      profileRef: assignment.profileRef ?? null
    }));
    if (new Set(fingerprints.map((item) => item.objectiveDigest)).size !== fingerprints.length) {
      throw new ActionRejectedError("DELEGATION_REQUIRES_INDEPENDENT_GOALS: Worker objectives must be distinct.");
    }
    for (const assignment of action.assignments) {
      if (assignment.profileRef === undefined) continue;
      if (this.#allowedWorkerProfiles === null
        || !this.#allowedWorkerProfiles.has(assignment.profileRef)
        || !this.#workerToolPolicies.has(assignment.profileRef)) {
        throw new ActionRejectedError(`WORKER_PROFILE_FORBIDDEN: ${assignment.profileRef}`);
      }
    }
    const priorDelegation = [...this.#store.listEvents(run.runId)].reverse().find((event) => {
      if (event.type !== "runtime.event" || event.payload.name !== "workers.delegation.accepted") return false;
      if (action.commandRef === undefined || event.payload.commandRef !== action.commandRef) return false;
      const assignments = event.payload.assignments;
      if (!Array.isArray(assignments) || assignments.length !== fingerprints.length) return false;
      return assignments.every((item, index) => {
        if (typeof item !== "object" || item === null) return false;
        const candidate = item as Record<string, unknown>;
        return candidate.objectiveDigest === fingerprints[index]!.objectiveDigest
          && (candidate.profileRef ?? null) === fingerprints[index]!.profileRef;
      });
    });
    const priorPayload = priorDelegation?.payload;
    if (priorPayload?.policyEnvelope !== undefined
      && !isDelegationEnvelopeNoWider(this.#delegationPolicy, priorPayload.policyEnvelope)) {
      throw new ActionRejectedError("DELEGATION_POLICY_WIDENED: Reopened execution cannot widen its persisted Worker envelope.");
    }
    const delegationId = priorPayload !== undefined && typeof priorPayload.delegationId === "string"
      ? priorPayload.delegationId
      : this.#createId();
    const priorAssignments = priorPayload !== undefined && Array.isArray(priorPayload.assignments)
      ? priorPayload.assignments
      : [];
    const existingAssignmentIds = new Set(this.#store.listBranches(run.runId).flatMap((branch) => (
      branch.lineage.flatMap((lineage) => lineage.assignmentId === undefined ? [] : [lineage.assignmentId])
    )));
    const newWorkerCount = action.assignments.reduce((count, _assignment, index) => {
      const persisted = priorAssignments[index];
      const assignmentId = typeof persisted === "object" && persisted !== null
        ? (persisted as Record<string, unknown>).assignmentId
        : undefined;
      return count + (typeof assignmentId === "string" && existingAssignmentIds.has(assignmentId) ? 0 : 1);
    }, 0);
    const activeWorkerCount = this.#store.listBranches(run.runId)
      .filter((branch) => branch.status === "active" || branch.status === "creating").length;
    if (activeWorkerCount + newWorkerCount > this.#delegationPolicy.maxConcurrentWorkers) {
      throw new ActionRejectedError(
        `WORKER_CONCURRENCY_EXCEEDED: ${activeWorkerCount} active plus ${newWorkerCount} new Workers exceeds ${this.#delegationPolicy.maxConcurrentWorkers}.`
      );
    }
    if (compileChildBudgets(run, this.#delegationPolicy.childBudgets) === null) {
      throw new ActionRejectedError("DELEGATION_BUDGET_INSUFFICIENT: Parent must retain synthesis capacity and each new Child requires an independent decision and Tool allowance.");
    }
    let current = run;
    if (priorDelegation === undefined) {
      const acceptedAssignments = action.assignments.map((assignment, index) => ({
        assignmentId: this.#createId(),
        ordinal: index,
        objectiveDigest: fingerprints[index]!.objectiveDigest,
        profileRef: assignment.profileRef ?? null,
        objective: assignment.objective
      }));
      current = this.#store.commitRun({
        previous: current,
        next: RunSnapshotSchema.parse({ ...current, updatedAt: this.#now() }),
        fencingToken: this.#leases.requireFencingToken(current.runId),
        event: {
          type: "runtime.event",
          occurredAt: this.#now(),
          payload: {
            name: "workers.delegation.accepted",
            delegationId,
            policyDigest: digestJson(this.#delegationPolicy),
            policyEnvelope: this.#delegationPolicy,
            ...(action.commandRef === undefined ? {} : { commandRef: action.commandRef }),
            assignments: acceptedAssignments
          }
        }
      });
      this.#notify(current.runId, observer);
      priorAssignments.splice(0, priorAssignments.length, ...acceptedAssignments);
    }
    const created: Array<Record<string, unknown>> = [];
    const handles: BranchHandle[] = [];
    for (let index = 0; index < action.assignments.length; index += 1) {
      signal.throwIfAborted();
      const assignment = action.assignments[index]!;
      const objectiveDigest = digestJson(assignment.objective);
      const priorAssignment = priorAssignments[index];
      const assignmentId = typeof priorAssignment === "object" && priorAssignment !== null
        && typeof (priorAssignment as Record<string, unknown>).assignmentId === "string"
        ? (priorAssignment as Record<string, unknown>).assignmentId as string
        : this.#createId();
      const existing = typeof priorAssignment === "object" && priorAssignment !== null
        ? this.#store.listBranches(run.runId).find((branch) => branch.lineage.some((lineage) => (
            lineage.assignmentId === (priorAssignment as Record<string, unknown>).assignmentId
          )))
        : undefined;
      if (existing !== undefined) {
        if (existing.status === "active") handles.push(this.#createBranchHandle(existing));
        created.push({ assignmentId, branchId: existing.branchId, childRunId: existing.childRunId, objectiveDigest, profileRef: assignment.profileRef ?? null, reused: true });
        continue;
      }
      const branch = await this.#leases.withHeartbeat(run.runId, async () => this.#forkParentRun(current, {
        initialInput: assignment.objective
      }, observer, {
        delegationId,
        assignmentId,
        ...(assignment.profileRef === undefined ? {} : { profileRef: assignment.profileRef }),
        objectiveDigest
      }));
      if (branch === null) {
        const failed = this.#fail(
          current,
          "DELEGATION_SPAWN_FAILED",
          "DELEGATION_SPAWN_FAILED",
          observer,
          "Supervisor delegation could not create an isolated Worker Run."
        );
        return failed;
      }
      current = this.#requireRun(run.runId);
      handles.push(branch);
      const branchView = await branch.inspect();
      created.push({ assignmentId, branchId: branch.id, childRunId: branchView.branch.childRunId, objectiveDigest, profileRef: assignment.profileRef ?? null });
    }
    // Child Runs are real Runtime executions. Run them concurrently while the
    // Parent remains at this delegation turn; their terminal facts are later
    // projected back through listWorkerObservations().
    await this.#leases.withHeartbeat(run.runId, async () => {
      await Promise.all(handles.map(async (branch) => {
        const cancelChild = () => {
          void branch.cancel(cancellationReason(signal)).catch(() => undefined);
        };
        signal.addEventListener("abort", cancelChild, { once: true });
        try {
          const result = await branch.run();
          if (result.status === "succeeded") {
            this.#closeDelegatedBranch(branch.id, "merged", "Worker completed successfully.");
          } else if (result.status === "failed" || result.status === "cancelled") {
            this.#closeDelegatedBranch(branch.id, "discarded", `Worker ended with ${result.status}.`);
          }
        } catch {
          // Child Run authority records the failure; Parent must observe it.
          // Preserve an active Branch/workspace when execution outcome is not
          // durably terminal; Recovery resumes the same Child identity.
        } finally {
          signal.removeEventListener("abort", cancelChild);
        }
      }));
    });
    const next = this.#store.commitRun({
      previous: current,
      next: RunSnapshotSchema.parse({ ...current, updatedAt: this.#now() }),
      fencingToken: this.#leases.requireFencingToken(current.runId),
      event: {
        type: "runtime.event",
        occurredAt: this.#now(),
          payload: {
            name: "workers.delegated",
            delegationId,
            ...(action.commandRef === undefined ? {} : { commandRef: action.commandRef }),
            assignments: created
          }
      }
    });
    this.#notify(next.runId, observer);
    const blockedWorkers = this.#workerRecoveryRequests(next.runId);
    return blockedWorkers.length === 0
      ? next
      : this.#blockForWorkerRecovery(next, blockedWorkers, observer);
  }

  /** Resume an accepted-but-not-joined batch without another Provider decision. */
  async #recoverAcceptedDelegations(
    run: RunSnapshot,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    const events = this.#store.listEvents(run.runId);
    const joined = new Set(events.flatMap((event) => (
      event.type === "runtime.event"
        && event.payload.name === "workers.delegated"
        && typeof event.payload.delegationId === "string"
        ? [event.payload.delegationId]
        : []
    )));
    let current = run;
    for (const event of events) {
      if (event.type !== "runtime.event" || event.payload.name !== "workers.delegation.accepted") continue;
      const delegationId = event.payload.delegationId;
      if (typeof delegationId !== "string" || joined.has(delegationId)) continue;
      const persisted = event.payload.assignments;
      if (!Array.isArray(persisted) || persisted.length < 2 || persisted.length > 8) {
        return this.#fail(current, "DELEGATION_RECOVERY_MATERIAL_INVALID", "INTERNAL", observer,
          "Accepted Worker delegation is missing its durable assignment material.");
      }
      const assignments: Array<{ objective: string; profileRef?: string }> = [];
      for (const item of persisted) {
        if (typeof item !== "object" || item === null) {
          return this.#fail(current, "DELEGATION_RECOVERY_MATERIAL_INVALID", "INTERNAL", observer,
            "Accepted Worker assignment metadata is invalid.");
        }
        const record = item as Record<string, unknown>;
        if (typeof record.objective !== "string" || digestJson(record.objective) !== record.objectiveDigest) {
          return this.#fail(current, "DELEGATION_RECOVERY_MATERIAL_INVALID", "INTERNAL", observer,
            "Accepted Worker objective is missing or does not match its digest.");
        }
        assignments.push({
          objective: record.objective,
          ...(typeof record.profileRef === "string" ? { profileRef: record.profileRef } : {})
        });
      }
      current = await this.#delegateWorkers(current, {
        type: "delegate_workers",
        ...(typeof event.payload.commandRef === "string" ? { commandRef: event.payload.commandRef } : {}),
        assignments
      }, signal, observer);
      joined.add(delegationId);
    }
    return current;
  }

  /** Close a delegated Branch while its Parent execution still owns the lease. */
  #closeDelegatedBranch(branchId: string, status: "merged" | "discarded", reason: string): void {
    const branch = this.#store.getBranch(branchId);
    if (branch === null || (branch.status !== "active" && branch.status !== "creating")) return;
    const now = this.#now();
    this.#store.updateBranchStatus({
      branchId,
      status,
      parentRunId: branch.parentRunId,
      event: {
        type: status === "merged" ? "branch.merged" : "branch.discarded",
        occurredAt: now,
        payload: { branchId, childRunId: branch.childRunId, reason }
      },
      fencingToken: this.#leases.requireFencingToken(branch.parentRunId)
    });
    this.#branchWorkspaceCleanups.get(branch.childRunId)?.();
    this.#branchWorkspaces.delete(branch.childRunId);
    this.#branchWorkspaceCleanups.delete(branch.childRunId);
    this.#notify(branch.parentRunId, undefined);
  }

  #reconcileDelegatedBranches(parentRunId: string): void {
    for (const branch of this.#store.listBranches(parentRunId)) {
      if (branch.status !== "active" && branch.status !== "creating") continue;
      if (branch.lineage.at(-1)?.delegationId === undefined) continue;
      const child = this.#store.getRun(branch.childRunId);
      if (child?.status === "succeeded") {
        this.#closeDelegatedBranch(branch.branchId, "merged", "Recovered Worker completed successfully.");
      } else if (child?.status === "failed" || child?.status === "cancelled") {
        this.#closeDelegatedBranch(branch.branchId, "discarded", `Recovered Worker ended with ${child.status}.`);
      }
    }
  }

  /** A pre-validated Tool batch. Plan provenance may create Evidence but never authorizes execution. */
  async #handleExecuteStep(
    run: RunSnapshot,
    action: Extract<RuntimeAction, { type: "execute_step" }>,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    signal.throwIfAborted();
    this.#assertMutationActionsAdmissible(run, action.actions);
    const services = this.#services(signal, run.runId);
    const plan = run.currentPlan;
    const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
    const step = plan?.orderedSteps.find((item) => (
      item.id === activeStepId && item.id === action.stepId
    ));
    const planVersion = plan?.version ?? 1;

    // Pre-flight: validate every sub-action so a malformed batch is rejected as
    // a whole (repair budget) before any sub-action executes.
    const seenIdempotency = new Set<string>();
    const preparedCalls: PreparedReadBatchCall[] = [];
    let cachedReadCount = 0;
    for (const sub of action.actions) {
      if (sub.stepId !== action.stepId) {
        throw new ActionRejectedError("execute_step sub-action does not target the active Step.");
      }
      const checkIds = step === undefined
        ? []
        : sub.checkIds.filter((id) => step.acceptanceChecks.some((check) => check.id === id));
      const tool = this.#tools.get(sub.toolName);
      if (tool === undefined) throw new ActionRejectedError(`Tool is not registered: ${sub.toolName}`);
      const parsedInput = JsonValueSchema.parse(tool.contract.execution.inputSchema.parse(sub.input));
      const parsedInputDigest = digestJson(parsedInput);
      const baseKey = `${run.runId}:${planVersion}:${action.stepId}:${tool.contract.identity.name}:${parsedInputDigest}`;
      if (seenIdempotency.has(baseKey)) {
        if (tool.contract.execution.effect.kind === "read" && tool.contract.execution.idempotent) {
          cachedReadCount += 1;
          continue;
        }
        throw new ActionRejectedError("execute_step contains duplicate Tool Invocations.");
      }
      seenIdempotency.add(baseKey);
      const persistedInvocations = this.#store.listToolInvocations(run.runId);
      const matching = persistedInvocations.filter(
        (item) => item.idempotencyKey === baseKey || item.idempotencyKey.startsWith(`${baseKey}:`)
      );
      const repeatableRead = tool.contract.execution.effect.kind === "read"
        && tool.contract.execution.idempotent;
      const duplicate = repeatableRead
        ? undefined
        : persistedInvocations.find((item) => (
            item.toolName === tool.contract.identity.name
            && item.inputDigest === parsedInputDigest
            && item.status !== "failed"
          ));
      const duplicateIndex = duplicate === undefined
        ? -1
        : persistedInvocations.findIndex((item) => item.id === duplicate.id);
      const invalidatedByWrite = duplicateIndex >= 0
        && tool.contract.execution.effect.kind === "execute"
        && persistedInvocations.slice(duplicateIndex + 1).some((item) => (
          item.status === "succeeded"
          && this.#tools.get(item.toolName)?.contract.execution.effect.kind === "write"
        ));
      if (duplicate !== undefined && !invalidatedByWrite) {
        throw new ActionRejectedError(
          `execute_step duplicates an existing persisted Invocation with status ${duplicate.status}; do not repeat it.`
        );
      }
      const key = matching.length === 0
        ? baseKey
        : repeatableRead
          ? `${baseKey}:observation:${matching.length}`
          : `${baseKey}:retry:${matching.length}`;
      preparedCalls.push({
        action: { ...sub, checkIds, input: parsedInput },
        tool,
        parsedInput,
        inputDigest: parsedInputDigest,
        idempotencyKey: key
      });
    }
    if (run.budgetsUsed.toolCalls + preparedCalls.length > run.budgets.maxToolCalls) {
      const remaining = Math.max(0, run.budgets.maxToolCalls - run.budgetsUsed.toolCalls);
      throw new ActionRejectedError(
        `execute_step requested ${preparedCalls.length} new Tool call(s), but only ${remaining} remain; submit at most ${remaining}.`
      );
    }

    const protectedMutations = preparedCalls.filter(({ tool }) => (
      tool.contract.execution.effect.kind !== "read"
    ));
    if (protectedMutations.length > 1) {
      throw new ActionRejectedError(
        "PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME: submit one protected mutation per Provider turn, or combine edits into one complete write. No mutation was admitted."
      );
    }

    if (preparedCalls.every(({ tool }) => tool.contract.execution.effect.kind === "read")) {
      const current = await executeReadToolBatch(services, run, preparedCalls, observer);
      this.#store.recordRunEvent({
        runId: run.runId,
        event: {
          type: "execute_step.completed",
          occurredAt: this.#now(),
          payload: {
            stepId: action.stepId,
            executedActionCount: preparedCalls.length,
            cachedActionCount: cachedReadCount,
            totalActions: action.actions.length,
            stoppedReason: current.lastError === null ? "completed" : "tool_failed"
          }
        },
        fencingToken: this.#leases.requireFencingToken(run.runId)
      });
      this.#notify(run.runId, observer);
      return current;
    }

    // Write, execute and mixed batches preserve the existing serial Approval
    // boundary. Only all-read batches enter the concurrent Effect path above.
    let current = run;
    let executed = 0;
    let stoppedReason: "completed" | "step_completed" | "approval_required" | "tool_failed" | "run_status_changed" = "completed";
    for (const sub of action.actions) {
      if (current.status !== "running") {
        stoppedReason = current.status === "waiting" ? "approval_required" : "run_status_changed";
        break;
      }
      if (executed > 0 && current.lastError !== null) {
        stoppedReason = "tool_failed";
        break;
      }
      const executedBefore = current.budgetsUsed.toolCalls;
      current = await callTool(services, current, sub, observer);
      if (current.budgetsUsed.toolCalls > executedBefore) {
        executed += 1;
      }
    }

    // Re-derive the stop reason from the final Run state: the last sub-action
    // may itself have required approval, failed, or completed the Step, with no
    // further iteration to surface it. A step_completed stop is only reported
    // when it actually dropped remaining actions; a batch that consumed every
    // action is "completed" even if the Step finished as a side effect.
    if (current.status !== "running") {
      stoppedReason = current.status === "waiting" ? "approval_required" : "run_status_changed";
    } else if (current.lastError !== null) {
      stoppedReason = "tool_failed";
    }

    this.#store.recordRunEvent({
      runId: run.runId,
      event: {
        type: "execute_step.completed",
        occurredAt: this.#now(),
        payload: {
          stepId: action.stepId,
          executedActionCount: executed,
          totalActions: action.actions.length,
          stoppedReason
        }
      },
      fencingToken: this.#leases.requireFencingToken(run.runId)
    });
    this.#notify(run.runId, observer);
    return current;
  }

  #setPlan(run: RunSnapshot, action: Extract<RuntimeAction, { type: "set_plan" }>, observer?: RuntimeObserver): RunSnapshot {
    const current = run.currentPlan;
    if (current === null && this.#closedMutationForSlots(run, this.#unplannedMutationSlots(run)) !== null) {
      throw new ActionRejectedError(
        "PLAN_AFTER_UNPLANNED_MUTATION: a successful unplanned mutation cannot be retroactively expanded into a Plan without a later authoritative verification failure. Verify or finish the current result."
      );
    }
    let contract = run.taskContract;
    if (current === null) {
      if (action.basedOnVersion !== null) throw new ActionRejectedError("The first Plan must be based on null.");
      if (action.taskContract === undefined) throw new ActionRejectedError("The first Plan requires a Task Contract.");
      contract = this.#deriveTaskContract(run, action.taskContract);
    } else {
      if (action.basedOnVersion !== current.version) throw new ActionRejectedError("Plan revision conflict.");
      const hasNewInput = contract !== null && contract.inputVersion < run.inputHistory.length;
      if (hasNewInput && action.taskContract === undefined) throw new ActionRejectedError("New user input requires an updated Task Contract.");
      if (!hasNewInput && action.taskContract !== undefined) throw new ActionRejectedError("Task Contract cannot change without new user input.");
      if (action.taskContract !== undefined) {
        this.#assertScopeRevisionPreservesRequiredOutcomes(contract?.scope, action.taskContract.scope);
        contract = this.#deriveTaskContract(run, action.taskContract);
      }
      assertCompletedStepsUnchanged(run, action.orderedSteps);
    }
    if (contract === null) throw new ActionRejectedError("Task Contract is missing.");
    if (contract.scope !== undefined) {
      const scopeOutcomeIds = new Set(contract.scope.requiredOutcomes.map((outcome) => outcome.id));
      for (const step of action.orderedSteps) {
        if (step.kind === undefined || step.scopeRefs === undefined) {
          throw new ActionRejectedError(`PLAN_SCOPE_RELATION_REQUIRED: Plan Step ${step.id} is not bound to Task Scope.`);
        }
        if (step.scopeRefs.length === 0) {
          throw new ActionRejectedError(
            `PLAN_SCOPE_RELATION_INVALID: Plan Step ${step.id} must bind at least one Task Scope required outcome.`
          );
        }
        if (step.kind === "required_outcome" && step.scopeRefs.length !== 1) {
          throw new ActionRejectedError(
            `PLAN_SCOPE_RELATION_INVALID: required_outcome Plan Step ${step.id} must bind exactly one Task Scope required outcome.`
          );
        }
        const invalidRefs = step.scopeRefs.filter((scopeRef) => !scopeOutcomeIds.has(scopeRef));
        if (invalidRefs.length > 0) {
          throw new ActionRejectedError(
            `PLAN_SCOPE_REF_INVALID: Plan Step ${step.id} references unknown Task Scope outcomes: ${invalidRefs.join(", ")}`
          );
        }
      }
      const coveredScopeOutcomes = new Set(action.orderedSteps
        .filter((step) => step.kind === "required_outcome")
        .flatMap((step) => step.scopeRefs ?? []));
      const missingScopeOutcomes = contract.scope.requiredOutcomes
        .map((outcome) => outcome.id)
        .filter((outcomeId) => !coveredScopeOutcomes.has(outcomeId));
      if (missingScopeOutcomes.length > 0) {
        throw new ActionRejectedError(
          `PLAN_SCOPE_REQUIRED_OUTCOME_UNCOVERED: ${missingScopeOutcomes.join(", ")}`
        );
      }
      const scopeBindingCounts = new Map<string, number>();
      for (const step of action.orderedSteps) {
        if (step.kind !== "required_outcome") continue;
        for (const scopeRef of step.scopeRefs ?? []) {
          scopeBindingCounts.set(scopeRef, (scopeBindingCounts.get(scopeRef) ?? 0) + 1);
        }
      }
      const duplicatedScopeOutcomes = contract.scope.requiredOutcomes
        .map((outcome) => outcome.id)
        .filter((outcomeId) => (scopeBindingCounts.get(outcomeId) ?? 0) > 1);
      if (duplicatedScopeOutcomes.length > 0) {
        throw new ActionRejectedError(
          `PLAN_SCOPE_REQUIRED_OUTCOME_DUPLICATED: ${duplicatedScopeOutcomes.join(", ")}`
        );
      }
    }

    const planSemantics = (steps: typeof action.orderedSteps): unknown => steps.map((step) => ({
      objective: normalizePlanText(step.objective),
      kind: step.kind ?? null,
      scopeRefs: step.scopeRefs ?? [],
      acceptanceChecks: step.acceptanceChecks.map((check) => normalizePlanValue(check))
    }));
    if (
      current !== null
      && action.taskContract === undefined
      && digestCanonicalJson(planSemantics(action.orderedSteps))
        === digestCanonicalJson(planSemantics(current.orderedSteps))
    ) {
      throw new ActionRejectedError(
        "PLAN_UNCHANGED: the proposed Plan has no semantic difference. Execute or verify the current active Step instead of submitting the same Plan again."
      );
    }

    const version = current === null ? 1 : current.version + 1;
    const plan = StructuredPlanSchema.parse({
      version,
      basedOnVersion: action.basedOnVersion,
      goalDigest: digestTaskContract(contract),
      orderedSteps: action.orderedSteps
    });
    const completed = new Map(run.stepProgress.filter((item) => item.status === "completed").map((item) => [item.stepId, item]));
    // Evidence remains immutable Run authority across Plan creation and
    // revision. Applicability to a new Plan is decided by the Completion Gate;
    // deleting earlier Tool evidence here loses verified exploration history.
    const evidence = run.evidence;
    let activeAssigned = false;
    const stepProgress = plan.orderedSteps.map((step) => {
      const preserved = completed.get(step.id);
      if (preserved !== undefined) return preserved;
      if (!activeAssigned) {
        activeAssigned = true;
        return { stepId: step.id, status: "active" as const, evidenceIds: [] };
      }
      return { stepId: step.id, status: "pending" as const, evidenceIds: [] };
    });
    const next = RunSnapshotSchema.parse({
      ...run,
      taskContract: contract,
      currentPlan: plan,
      stepProgress,
      evidence,
      lastError: null,
      updatedAt: this.#now()
    });
    return this.#commit(run, next, "plan.set", {
      version,
      basedOnVersion: action.basedOnVersion,
      inputVersion: contract.inputVersion,
      goalDigest: plan.goalDigest,
      taskContract: contract,
      plan
    }, observer);
  }

  /**
   * Derives the complete persisted Task Contract from the model's semantic
   * proposal by injecting the deterministic mechanical fields. Model decides
   * intent; Runtime derives runtime facts. Never invents missing intent.
   */
  #deriveTaskContract(run: RunSnapshot, proposal: PlanTaskContract): TaskContract {
    const inputVersion = run.inputHistory.length;
    return TaskContractSchema.parse({
      ...proposal,
      workspace: this.#workspaceFor(run.runId),
      version: inputVersion,
      inputVersion
    });
  }

  #assertScopeRevisionPreservesRequiredOutcomes(
    previous: PlanTaskContract["scope"] | undefined,
    proposed: PlanTaskContract["scope"] | undefined
  ): void {
    if (previous === undefined) return;
    if (proposed === undefined) {
      throw new ActionRejectedError("TASK_SCOPE_REQUIRED_OUTCOME_REMOVED_OR_CHANGED: resolved Task Scope cannot be removed.");
    }
    const proposedById = new Map(proposed.requiredOutcomes.map((outcome) => [outcome.id, outcome]));
    const changed = previous.requiredOutcomes.filter((outcome) => {
      const next = proposedById.get(outcome.id);
      return next === undefined
        || next.description !== outcome.description
        || next.source !== outcome.source;
    });
    if (changed.length > 0) {
      throw new ActionRejectedError(
        `TASK_SCOPE_REQUIRED_OUTCOME_REMOVED_OR_CHANGED: ${changed.map((outcome) => outcome.id).join(", ")}`
      );
    }
  }

  #assertMutationActionsAdmissible(
    run: RunSnapshot,
    actions: readonly Extract<RuntimeAction, { type: "call_tool" }>[]
  ): void {
    for (const action of actions) {
      const tool = this.#tools.get(action.toolName);
      if (tool?.contract.execution.effect.kind !== "write") continue;
      const slots = this.#mutationSlots(run, action.stepId, action.checkIds, action.toolName);
      const prior = this.#closedMutationForSlots(run, slots);
      if (prior === null) continue;
      throw new ActionRejectedError(
        `MUTATION_VERIFICATION_REQUIRED: successful mutation ${prior.id} already satisfied the active mutation outcome. Verify or finish it; another write requires a later authoritative verification failure or new user input. No Tool side effect was admitted.`
      );
    }
  }

  #closedMutationForSlots(run: RunSnapshot, slots: readonly string[]): ToolInvocation | null {
    const events = this.#store.listEvents(run.runId);
    const inputBoundary = [...events].reverse().find((event) => (
      event.type === "run.resumed" && typeof event.payload.inputSequence === "number"
    ));
    const invocations = this.#store.listToolInvocations(run.runId)
      .filter((invocation) => inputBoundary === undefined || invocation.startedAt > inputBoundary.occurredAt);
    let latest: { invocation: ToolInvocation; index: number } | null = null;
    for (const [index, invocation] of invocations.entries()) {
      if (
        invocation.status !== "succeeded"
        || this.#tools.get(invocation.toolName)?.contract.execution.effect.kind !== "write"
        || !overlaps(slots, this.#mutationSlots(run, invocation.stepId, invocation.checkIds, invocation.toolName))
      ) continue;
      latest = { invocation, index };
    }
    if (latest === null) return null;
    const verificationCheckIds = this.#verificationCheckIds(run, latest.invocation.stepId);
    const mutationSubjects = new Set(run.evidence
      .filter((evidence) => evidence.invocationId === latest.invocation.id)
      .map((evidence) => evidence.subjectRef));
    const failedVerification = invocations.slice(latest.index + 1).some((invocation) => {
      if (invocation.status !== "failed") return false;
      const effect = this.#tools.get(invocation.toolName)?.contract.execution.effect.kind;
      if (effect === undefined || effect === "write") return false;
      if (verificationCheckIds.length > 0) return overlaps(verificationCheckIds, invocation.checkIds);
      if (effect === "execute") return true;
      return this.#store.listToolAttempts(run.runId).some((attempt) => (
        attempt.invocationId === invocation.id
        && attempt.subjectRef !== null
        && mutationSubjects.has(attempt.subjectRef)
      ));
    });
    return failedVerification ? null : latest.invocation;
  }

  #mutationSlots(
    run: RunSnapshot,
    stepId: string,
    checkIds: readonly string[],
    toolName: string
  ): readonly string[] {
    if (stepId === UNPLANNED_STEP_ID) return [`${UNPLANNED_STEP_ID}:${toolName}`];
    const step = run.currentPlan?.orderedSteps.find((candidate) => candidate.id === stepId);
    const mutationChecks = step?.acceptanceChecks.filter((check) => (
      check.kind === "tool_result" && check.role === "mutation" && checkIds.includes(check.id)
    )).map((check) => check.id) ?? [];
    return mutationChecks.length > 0 ? mutationChecks : [`step:${stepId}`];
  }

  #unplannedMutationSlots(run: RunSnapshot): readonly string[] {
    return [...new Set(this.#store.listToolInvocations(run.runId).flatMap((invocation) => (
      invocation.stepId === UNPLANNED_STEP_ID
      && invocation.status === "succeeded"
      && this.#tools.get(invocation.toolName)?.contract.execution.effect.kind === "write"
        ? [`${UNPLANNED_STEP_ID}:${invocation.toolName}`]
        : []
    )))];
  }

  #verificationCheckIds(run: RunSnapshot, stepId: string): readonly string[] {
    const step = run.currentPlan?.orderedSteps.find((candidate) => candidate.id === stepId);
    return step?.acceptanceChecks.filter((check) => (
      check.kind === "tool_result" && check.role === "verification"
    )).map((check) => check.id) ?? [];
  }

  #rejectResponse(run: RunSnapshot, error: z.ZodError | ActionRejectedError, rawResponse: unknown, observer?: RuntimeObserver): RunSnapshot {
    const diagnostic = responseRejectionDiagnostic(error, rawResponse);
    const message = JSON.stringify(diagnostic);
    const detailsArtifact = new ArtifactStore(this.#artifactDir).putText(serializeRejectedResponse(rawResponse), "application/json").digest;
    const next = RunSnapshotSchema.parse({
      ...run,
      lastError: { code: "INVALID_MODEL_RESPONSE", message, retryable: true, detailsArtifact },
      updatedAt: this.#now()
    });
    return this.#commit(run, next, "response.rejected", { message, diagnostic, detailsArtifact }, observer);
  }

  #fail(
    run: RunSnapshot,
    stopReason: string,
    errorCode: string,
    observer?: RuntimeObserver,
    deliverySummary?: string
  ): RunSnapshot {
    const failedInput = RunSnapshotSchema.parse({
      ...run,
      lastError: run.lastError ?? { code: errorCode, message: stopReason, retryable: false, detailsArtifact: null }
    });
    const failed = transitionRunStatus(failedInput, "failed", {
      now: this.#now(),
      stopReason,
      delivery: deriveRunDelivery({
        run: failedInput,
        outcome: "failed",
        now: this.#now(),
        stopReason,
        ...(deliverySummary === undefined
          ? {}
          : { summary: deliverySummary, generatedBy: "model" as const })
      })
    });
    return this.#commit(run, failed, "run.failed", { stopReason, errorCode }, observer);
  }

  #blockForProvider(run: RunSnapshot, error: unknown, observer?: RuntimeObserver): RunSnapshot {
    const errorCode = providerBoundaryErrorCode(error);
    const retryable = this.#providerRecoveryAllowed(run.runId, 1);
    if (!retryable) {
      return this.#fail(
        RunSnapshotSchema.parse({
          ...run,
          lastError: { code: errorCode, message: errorMessage(error), retryable: false, detailsArtifact: null }
        }),
        errorCode,
        errorCode,
        observer,
        "Provider recovery is exhausted for the current progress window. Start a bounded continuation Run to continue from persisted facts."
      );
    }
    const blockedInput = RunSnapshotSchema.parse({
      ...run,
      lastError: { code: errorCode, message: errorMessage(error), retryable, detailsArtifact: null }
    });
    const blocked = transitionRunStatus(blockedInput, "blocked", {
      now: this.#now(),
      stopReason: errorCode,
      resumePredicate: {
        kind: "provider_reconnect",
        providerCode: errorCode,
        remainingRecoverySegments: MAX_PROVIDER_FAILURES_PER_PROGRESS_WINDOW - this.#providerFailureCount(run.runId) - 1,
        verification: "bounded_provider_probe"
      },
      delivery: deriveRunDelivery({
        run: blockedInput,
        outcome: "blocked",
        now: this.#now(),
        stopReason: errorCode,
      })
    });
    return this.#commit(run, blocked, "run.blocked", { stopReason: errorCode, resumePredicate: blocked.resumePredicate }, observer);
  }

  #assertResumePredicate(
    run: RunSnapshot,
    input: {
      readonly budgetExtension?: RuntimeBudgetExtension;
      readonly recoveryDecision?: RecoveryDecision;
      readonly recovery?: RecoveryDecision;
    }
  ): void {
    const predicate = run.resumePredicate;
    const recoveryDecision = input.recoveryDecision ?? input.recovery;
    if (predicate === null) return; // Explicit legacy compatibility: do not reinterpret historical blocked Runs.
    if (predicate.kind === "provider_reconnect") {
      if (!this.#providerRecoveryAllowed(run.runId) || predicate.remainingRecoverySegments <= 0) {
        throw this.#controlConflict(run.runId, "Provider recovery predicate is no longer satisfiable.");
      }
      return;
    }
    if (predicate.kind === "budget_extension") {
      if (input.budgetExtension === undefined) {
        throw this.#controlConflict(run.runId, "This Run requires its persisted Budget Extension predicate.");
      }
      const extension = RuntimeBudgetExtensionSchema.parse(input.budgetExtension);
      if (Object.entries(extension).some(([dimension]) => !predicate.allowedDimensions.includes(dimension as "iterations" | "modelCalls" | "toolCalls" | "retries"))) {
        throw this.#controlConflict(run.runId, "Budget Extension does not satisfy the persisted predicate.");
      }
      return;
    }
    if (predicate.kind === "tool_recovery_decision") {
      if (recoveryDecision === undefined && this.#canAutomaticallyReconcile(predicate.invocationIds)) return;
      if (recoveryDecision === undefined || !predicate.invocationIds.includes(recoveryDecision.invocationId)) {
        throw this.#controlConflict(run.runId, "Tool recovery decision does not satisfy the persisted predicate.");
      }
      return;
    }
    if (recoveryDecision !== undefined || input.budgetExtension !== undefined) {
      throw this.#controlConflict(run.runId, "Worker recovery predicate requires its persisted worker recovery actions.");
    }
  }

  #canAutomaticallyReconcile(invocationIds: readonly string[]): boolean {
    if (invocationIds.length === 0) return false;
    return invocationIds.every((invocationId) => {
      const invocation = this.#store.getToolInvocation(invocationId);
      const tool = invocation === null ? undefined : this.#tools.get(invocation.toolName);
      return invocation?.status === "unknown"
        && tool?.reconcile !== undefined
        && tool.contract.execution.reconciliation !== undefined;
    });
  }

  #blockForBudget(
    run: RunSnapshot,
    stopReason: string,
    observer?: RuntimeObserver,
    deliverySummary?: string
  ): RunSnapshot {
    if (stopReason === "DURATION_BUDGET_EXCEEDED") {
      return this.#fail(
        RunSnapshotSchema.parse({
          ...run,
          lastError: run.lastError ?? {
            code: stopReason,
            message: "The active execution segment reached its non-extendable duration limit.",
            retryable: false,
            detailsArtifact: null
          }
        }),
        stopReason,
        stopReason,
        observer,
        deliverySummary
      );
    }
    const blockedInput = RunSnapshotSchema.parse({
      ...run,
      lastError: run.lastError ?? {
        code: stopReason,
        message: "The active execution segment reached its configured resource boundary.",
        retryable: true,
        detailsArtifact: null
      }
    });
    const blocked = transitionRunStatus(blockedInput, "blocked", {
      now: this.#now(),
      stopReason,
      resumePredicate: {
        kind: "budget_extension",
        stopReason: stopReason as "ITERATION_BUDGET_EXCEEDED" | "MODEL_CALL_BUDGET_EXCEEDED" | "TOOL_CALL_BUDGET_EXCEEDED" | "RETRY_BUDGET_EXCEEDED",
        allowedDimensions: ["iterations", "modelCalls", "toolCalls", "retries"],
        minimumPositiveExtension: true
      },
      delivery: deriveRunDelivery({
        run: blockedInput,
        outcome: "blocked",
        now: this.#now(),
        stopReason,
        ...(deliverySummary === undefined ? {} : { summary: deliverySummary, generatedBy: "model" as const })
      })
    });
    return this.#commit(run, blocked, "run.blocked", { stopReason, resumable: true, resumePredicate: blocked.resumePredicate }, observer);
  }

  #blockForWorkerRecovery(
    run: RunSnapshot,
    recoveries: readonly WorkerRecoveryRequest[],
    observer?: RuntimeObserver
  ): RunSnapshot {
    const stopReason = "WORKER_RECOVERY_REQUIRED";
    const blockedInput = RunSnapshotSchema.parse({
      ...run,
      lastError: {
        code: stopReason,
        message: `${recoveries.length} delegated Worker Run(s) require explicit recovery.`,
        retryable: true,
        detailsArtifact: null
      }
    });
    const blocked = transitionRunStatus(blockedInput, "blocked", {
      now: this.#now(),
      stopReason,
      resumePredicate: {
        kind: "worker_recovery_decision",
        childRunIds: recoveries.map(({ childRunId }) => childRunId)
      },
      delivery: deriveRunDelivery({
        run: blockedInput,
        outcome: "blocked",
        now: this.#now(),
        stopReason
      })
    });
    return this.#commit(run, blocked, "run.blocked", {
      stopReason,
      workerRecoveries: recoveries.map(({ branchId, childRunId }) => ({ branchId, childRunId })),
      resumePredicate: blocked.resumePredicate
    }, observer);
  }

  #enforceConvergence(run: RunSnapshot, observer?: RuntimeObserver): RunSnapshot | null {
    const inherited = this.#inheritedNoProgressDiagnostic(run);
    if (inherited !== null) return this.#failForNoProgress(run, inherited, observer);
    const diagnostic = this.#noProgressDiagnostic(run.runId);
    if (diagnostic === null) return null;
    if (run.budgetsUsed.iterations < (diagnostic.kind === "repeated_invalid_response" ? 2 : 3)) return null;
    const minimumRepeats = diagnostic.kind === "repeated_invalid_response" ? 2 : 3;
    if (diagnostic.repeatCount < minimumRepeats) return null;
    // An identical schema rejection is already an authoritative fact: the
    // response was never executable and replaying it cannot produce progress.
    // Bound it on the second occurrence instead of spending another Provider
    // turn on a warning-only cycle.
    if (diagnostic.kind === "repeated_invalid_response") {
      return this.#failForNoProgress(run, diagnostic, observer);
    }
    const recentEvents = this.#store.listRecentEvents(run.runId, 64);
    const warning = [...recentEvents].reverse().find((event) => (
      event.type === "runtime.event"
      && event.payload.name === "execution.no_progress.warning"
      && event.payload.fingerprint === diagnostic.fingerprint
    ));
    if (warning === undefined) {
      const warningSequence = (recentEvents.at(-1)?.sequence ?? 0) + 1;
      const latestRejection = [...recentEvents].reverse().find((event) => event.type === "response.rejected");
      const forbiddenStrategy = diagnostic.kind === "repeated_response_rejection" && latestRejection !== undefined
        ? rejectionStrategyFingerprint(latestRejection)
        : diagnostic.fingerprint;
      this.#store.recordRunEvent({
        runId: run.runId,
        event: {
          type: "runtime.event",
          occurredAt: this.#now(),
          payload: {
            name: "execution.no_progress.warning",
            ...diagnostic,
            warningSequence,
            forbiddenStrategy,
            allowedRepairAttempts: 1
          }
        },
        fencingToken: this.#leases.requireFencingToken(run.runId)
      });
      this.#notify(run.runId, observer);
      return null;
    }

    const afterWarning = recentEvents.filter((event) => event.sequence > warning.sequence);
    const revisedPlan = afterWarning.find((event) => (
      event.type === "plan.set" && event.payload.noOp !== true
    ));
    const attemptedAfterReplan = revisedPlan === undefined
      ? undefined
      : afterWarning.find((event) => (
        event.sequence > revisedPlan.sequence
        && (event.type === "tool.succeeded" || event.type === "tool.failed" || event.type === "tool.recovered")
      ));
    // A Plan is an intent, not proof that its execution strategy changed. It
    // may earn one empirical Tool attempt after a warning, so a genuinely
    // different action can be observed; it must not reset the whole repeated
    // action window merely by changing objectives or step IDs.
    if (revisedPlan !== undefined && attemptedAfterReplan === undefined) return null;
    const repairAllowed = afterWarning.find((event) => (
      event.type === "runtime.event"
      && event.payload.name === "execution.no_progress.repair_allowed"
      && event.payload.warningSequence === warning.sequence
    ));
    if (repairAllowed !== undefined) {
      const authoritativeAttempt = afterWarning.find((event) => (
        event.sequence > repairAllowed.sequence
        && (event.type === "tool.succeeded" || event.type === "tool.failed" || event.type === "tool.recovered")
      ));
      if (authoritativeAttempt !== undefined) {
        this.#store.recordRunEvent({
          runId: run.runId,
          event: {
            type: "runtime.event",
            occurredAt: this.#now(),
            payload: {
              name: "execution.no_progress.probation_resolved",
              warningSequence: warning.sequence,
              progressSequence: authoritativeAttempt.sequence
            }
          },
          fencingToken: this.#leases.requireFencingToken(run.runId)
        });
        this.#notify(run.runId, observer);
        return null;
      }
    } else {
      const authoritativeAttempt = afterWarning.find((event) => (
        event.type === "tool.succeeded" || event.type === "tool.failed" || event.type === "tool.recovered"
      ));
      if (authoritativeAttempt !== undefined) {
        const invocationId = authoritativeAttempt.payload.invocationId;
        const invocation = typeof invocationId === "string"
          ? this.#store.listRecentToolInvocations(run.runId, 24).find((item) => item.id === invocationId)
          : undefined;
        if (invocation !== undefined && this.#isMateriallyDifferentProbationAttempt(invocation, warning.payload)) {
          this.#recordProbationResolved(run, warning.sequence, authoritativeAttempt, observer);
          return null;
        }
      }
      const rejection = [...afterWarning].reverse().find((event) => event.type === "response.rejected");
      if (rejection !== undefined && correctableRejection(rejection)) {
        const strategyFingerprint = rejectionStrategyFingerprint(rejection);
        if (strategyFingerprint !== warning.payload.forbiddenStrategy) {
          this.#store.recordRunEvent({
            runId: run.runId,
            event: {
              type: "runtime.event",
              occurredAt: this.#now(),
              payload: {
                name: "execution.no_progress.repair_allowed",
                fingerprint: diagnostic.fingerprint,
                warningSequence: warning.sequence,
                forbiddenStrategy: warning.payload.forbiddenStrategy,
                attemptedStrategy: strategyFingerprint,
                allowedRepairAttempts: 1
              }
            },
            fencingToken: this.#leases.requireFencingToken(run.runId)
          });
          this.#notify(run.runId, observer);
          return null;
        }
      }
    }
    return this.#failForNoProgress(run, diagnostic, observer);
  }

  #recordProbationResolved(
    run: RunSnapshot,
    warningSequence: number,
    attempt: RunEvent,
    observer?: RuntimeObserver
  ): void {
    this.#store.recordRunEvent({
      runId: run.runId,
      event: {
        type: "runtime.event",
        occurredAt: this.#now(),
        payload: {
          name: "execution.no_progress.probation_resolved",
          warningSequence,
          progressSequence: attempt.sequence,
          outcome: attempt.type === "tool.failed" ? "failed" : "succeeded",
          ...(typeof attempt.payload.payloadDigest === "string"
            ? { payloadDigest: attempt.payload.payloadDigest }
            : {})
        }
      },
      fencingToken: this.#leases.requireFencingToken(run.runId)
    });
    this.#notify(run.runId, observer);
  }

  #isMateriallyDifferentProbationAttempt(
    invocation: ToolInvocation,
    warning: Readonly<Record<string, unknown>>
  ): boolean {
    if (warning.kind !== "resource_churn") return false;
    const warnedResources = Array.isArray(warning.resources)
      ? warning.resources.filter((resource): resource is string => typeof resource === "string")
      : [];
    const resource = this.#invocationResource(invocation);
    return resource !== null && !warnedResources.includes(resource);
  }

  #noProgressDiagnostic(runId: string): NoProgressDiagnostic | null {
    const allEvents = this.#store.listRecentEvents(runId, 64);
    // A plain recovery Resume is not a new convergence window. Only a
    // persisted user input creates new facts; preserving the older window
    // prevents the same strategy being reopened indefinitely.
    const lastInputResume = [...allEvents].reverse().find((event) => (
      event.type === "run.resumed"
      && typeof event.payload.inputSequence === "number"
    ));
    const probationResolved = [...allEvents].reverse().find((event) => (
      event.type === "runtime.event"
      && event.payload.name === "execution.no_progress.probation_resolved"
    ));
    const segmentBoundary = [lastInputResume, probationResolved]
      .filter((event): event is RunEvent => event !== undefined)
      .sort((left, right) => right.sequence - left.sequence)[0];
    const inputSegmentRejections = allEvents.filter((event) => (
      event.type === "response.rejected"
      && isStateRejection(event)
      && (lastInputResume === undefined || event.sequence > lastInputResume.sequence)
    )).slice(-8);
    const repeatedStateBoundary = repeatedRejectionIssue(inputSegmentRejections);
    if (repeatedStateBoundary !== null) {
      return {
        fingerprint: digestCanonicalJson({
          kind: "invalid_state_transition",
          strategyFingerprint: repeatedStateBoundary.fingerprint,
          inputSequence: lastInputResume?.payload.inputSequence ?? 1
        }),
        kind: "repeated_invalid_response",
        repeatCount: repeatedStateBoundary.repeatCount,
        strategyFingerprints: [repeatedStateBoundary.fingerprint]
      };
    }
    const segmentStartedAt = segmentBoundary?.occurredAt ?? "";
    const invocations = this.#store.listRecentToolInvocations(runId, 24)
      .filter((invocation) => invocation.startedAt >= segmentStartedAt)
      .slice(-24);
    const resourceChurn = this.#resourceChurnDiagnostic(invocations);
    if (resourceChurn !== null) return resourceChurn;
    const latest = invocations.at(-1);
    if (latest !== undefined && (latest.status === "succeeded" || latest.status === "failed")) {
      const strategyFingerprint = invocationStrategyFingerprint(latest)!;
      const observationFingerprint = invocationObservationFingerprint(latest)!;
      const actionFingerprint = digestCanonicalJson({ strategyFingerprint, observationFingerprint });
      const completed = invocations.filter((invocation) => invocation.status === "succeeded" || invocation.status === "failed");
      let repeatCount = 0;
      let convergenceAnchor = `boundary:${segmentBoundary?.sequence ?? 0}`;
      for (let index = completed.length - 1; index >= 0; index -= 1) {
        const invocation = completed[index]!;
        const candidateStrategyFingerprint = invocationStrategyFingerprint(invocation)!;
        const candidateObservationFingerprint = invocationObservationFingerprint(invocation)!;
        const candidateFingerprint = digestCanonicalJson({
          strategyFingerprint: candidateStrategyFingerprint,
          observationFingerprint: candidateObservationFingerprint
        });
        if (candidateFingerprint !== actionFingerprint) {
          convergenceAnchor = invocation.id;
          break;
        }
        repeatCount += 1;
      }
      const fingerprint = digestCanonicalJson({ actionFingerprint, convergenceAnchor });
      if (repeatCount >= 3) return {
        fingerprint,
        kind: latest.status === "failed" ? "repeated_tool_failure" : "repeated_tool_result",
        repeatCount,
        strategyFingerprints: [strategyFingerprint],
        observationFingerprints: [observationFingerprint]
      };
    }
    const events = allEvents.filter((event) => segmentBoundary === undefined || event.sequence > segmentBoundary.sequence);
    const convergenceAnchor = events.reduce((sequence, event) => {
      const isToolOutcome = event.type === "tool.attempt.succeeded" || event.type === "tool.attempt.failed";
      const isAcceptedPlan = event.type === "plan.set" && event.payload.noOp !== true;
      return isToolOutcome || isAcceptedPlan ? event.sequence : sequence;
    }, segmentBoundary?.sequence ?? 0);
    const convergenceEvents = events.filter((event) => event.sequence > convergenceAnchor);
    const noOps = convergenceEvents.filter((event) => event.type === "plan.set" && event.payload.noOp === true).slice(-4);
    if (noOps.length >= 3) {
      const fingerprint = digestCanonicalJson({ kind: "equivalent_plan", version: noOps.at(-1)?.payload.version, convergenceAnchor });
      return {
        fingerprint,
        kind: "equivalent_plan",
        repeatCount: noOps.length,
        strategyFingerprints: [digestCanonicalJson({ kind: "equivalent_plan", version: noOps.at(-1)?.payload.version })]
      };
    }
    const rejections = convergenceEvents.filter((event) => event.type === "response.rejected").slice(-6);
    if (rejections.length >= 2) {
      const repeatedIssue = repeatedRejectionIssue(rejections);
      if (repeatedIssue !== null) {
        return {
          fingerprint: digestCanonicalJson({
            kind: "invalid_response_issue",
            strategyFingerprint: repeatedIssue.fingerprint,
            convergenceAnchor
          }),
          kind: "repeated_invalid_response",
          repeatCount: repeatedIssue.repeatCount,
          strategyFingerprints: [repeatedIssue.fingerprint]
        };
      }
      const latestMessage = rejections.at(-1)?.payload.message;
      const equivalent = rejections.filter((event) => event.payload.message === latestMessage).length;
      if (equivalent >= 3) {
        return { fingerprint: digestCanonicalJson({ kind: "response_rejected", message: latestMessage, convergenceAnchor }), kind: "repeated_response_rejection", repeatCount: equivalent };
      }
      if (equivalent >= 2) {
        let schema = false;
        try {
          schema = (JSON.parse(String(latestMessage)) as { readonly kind?: unknown }).kind === "schema";
        } catch {
          schema = false;
        }
        if (schema) {
          return { fingerprint: digestCanonicalJson({ kind: "invalid_response", message: latestMessage, convergenceAnchor }), kind: "repeated_invalid_response", repeatCount: equivalent };
        }
      }
    }
    return null;
  }

  #inheritedNoProgressDiagnostic(run: RunSnapshot): NoProgressDiagnostic | null {
    const allCurrentEvents = this.#store.listEvents(run.runId);
    const allCurrentInvocations = this.#store.listToolInvocations(run.runId);
    const correctiveResume = [...allCurrentEvents].reverse().find((event) => (
      event.type === "run.resumed" && event.payload.reason === "no_progress_corrective_input"
    ));
    const sameRunBlockedEvent = correctiveResume === undefined
      ? undefined
      : [...allCurrentEvents].reverse().find((event) => (
          event.sequence < correctiveResume.sequence
          && (event.type === "run.blocked" || event.type === "run.failed")
          && event.payload.stopReason === "NO_PROGRESS_DETECTED"
        ));
    const blockedAncestor = sameRunBlockedEvent === undefined
      ? [...this.#continuationAncestors(run)].reverse().find(({ run: ancestor }) => (
          (ancestor.status === "blocked" || ancestor.status === "failed")
          && ancestor.stopReason === "NO_PROGRESS_DETECTED"
        ))
      : undefined;
    const blockedEvent = sameRunBlockedEvent ?? (blockedAncestor === undefined
      ? undefined
      : [...blockedAncestor.events].reverse().find((event) => (
          (event.type === "run.blocked" || event.type === "run.failed")
          && event.payload.stopReason === "NO_PROGRESS_DETECTED"
        )));
    if (blockedEvent === undefined) return null;
    const priorEvents = sameRunBlockedEvent === undefined
      ? blockedAncestor!.events
      : allCurrentEvents.filter((event) => event.sequence <= sameRunBlockedEvent.sequence);
    const currentEvents = correctiveResume === undefined
      ? allCurrentEvents
      : allCurrentEvents.filter((event) => event.sequence > correctiveResume.sequence);
    const priorInvocations = invocationsReferencedByEvents(
      sameRunBlockedEvent === undefined ? blockedAncestor!.invocations : allCurrentInvocations,
      priorEvents
    );
    const currentInvocations = invocationsReferencedByEvents(allCurrentInvocations, currentEvents);
    const diagnostic = blockedEvent.payload.diagnostic;
    if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return null;
    const prior = diagnostic as Readonly<Record<string, unknown>>;
    const kind = typeof prior.kind === "string" ? prior.kind : "repeated_action";
    const priorRepeatCount = typeof prior.repeatCount === "number" ? prior.repeatCount : 1;
    const priorStrategies = Array.isArray(prior.strategyFingerprints)
      ? prior.strategyFingerprints.filter((item): item is string => typeof item === "string")
      : inheritedStrategyFingerprints(kind, priorEvents, priorInvocations);
    const priorObservations = Array.isArray(prior.observationFingerprints)
      ? prior.observationFingerprints.filter((item): item is string => typeof item === "string")
      : inheritedObservationFingerprints(kind, priorInvocations);
    if (hasAuthoritativeProgressBeyondStrategy(currentEvents, currentInvocations, priorStrategies, priorObservations)) return null;
    const currentStrategies = kind === "resource_churn"
      ? this.#resourceChurnDiagnostic([...currentInvocations])?.strategyFingerprints ?? []
      : currentFailureStrategyFingerprints(kind, currentEvents, currentInvocations);
    const repeatedStrategies = currentStrategies.filter((item) => priorStrategies.includes(item));
    if (repeatedStrategies.length === 0) return null;
    return {
      fingerprint: digestCanonicalJson({
        kind: "inherited_no_progress",
        sourceRunId: blockedAncestor?.run.runId ?? run.runId,
        sourceEventSequence: blockedEvent.sequence,
        repeatedStrategies
      }),
      kind,
      repeatCount: priorRepeatCount + 1,
      strategyFingerprints: repeatedStrategies,
      ...(Array.isArray(prior.resources)
        ? { resources: prior.resources.filter((item): item is string => typeof item === "string") }
        : {})
    };
  }

  #resourceChurnDiagnostic(
    invocations: ReturnType<RunStore["listRecentToolInvocations"]>
  ): NoProgressDiagnostic | null {
    const resources = new Map<string, { reads: number; mutations: number; failures: number }>();
    for (const invocation of invocations) {
      if (invocation.status !== "succeeded" && invocation.status !== "failed") continue;
      const effect = this.#tools.get(invocation.toolName)?.contract.execution.effect.kind;
      if (effect !== "read" && effect !== "write") continue;
      const resource = this.#invocationResource(invocation);
      if (resource === null) continue;
      const counts = resources.get(resource) ?? { reads: 0, mutations: 0, failures: 0 };
      if (effect === "read") counts.reads += 1;
      else {
        counts.mutations += 1;
        if (invocation.status === "failed") counts.failures += 1;
      }
      resources.set(resource, counts);
    }
    const candidate = [...resources.entries()]
      .filter(([, counts]) => counts.reads >= 4 && counts.mutations >= 3)
      .sort(([leftPath, left], [rightPath, right]) => (
        right.reads + right.mutations - left.reads - left.mutations
        || right.failures - left.failures
        || leftPath.localeCompare(rightPath)
      ))[0];
    if (candidate === undefined) return null;
    const [resource, counts] = candidate;
    return {
      fingerprint: digestCanonicalJson({ kind: "resource_churn", resource }),
      kind: "resource_churn",
      repeatCount: counts.reads + counts.mutations,
      strategyFingerprints: [digestCanonicalJson({ kind: "resource_churn", resource })],
      resources: [resource],
      reads: counts.reads,
      mutations: counts.mutations,
      failures: counts.failures
    };
  }

  #invocationResource(invocation: ToolInvocation): string | null {
    const input = invocation.inputJson;
    const path = input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as { readonly path?: unknown }).path
      : undefined;
    if (typeof path === "string" && path.trim().length > 0) return canonicalResource(path);
    const evidence = this.#store.getRun(invocation.runId)?.evidence.find((candidate) => (
      candidate.invocationId === invocation.id
    ));
    if (evidence !== undefined) return canonicalResource(evidence.subjectRef);
    const attempt = this.#store.listToolAttempts(invocation.runId)
      .filter((candidate) => candidate.invocationId === invocation.id && candidate.subjectRef !== null)
      .at(-1);
    return attempt?.subjectRef === null || attempt?.subjectRef === undefined
      ? null
      : canonicalResource(attempt.subjectRef);
  }

  #failForNoProgress(
    run: RunSnapshot,
    diagnostic: NoProgressDiagnostic,
    observer?: RuntimeObserver
  ): RunSnapshot {
    const stopReason = "NO_PROGRESS_DETECTED";
    const failedInput = RunSnapshotSchema.parse({
      ...run,
      lastError: {
        code: stopReason,
        message: `Execution repeated ${diagnostic.kind} ${diagnostic.repeatCount} times without a new authoritative fact.`,
        retryable: false,
        detailsArtifact: null
      }
    });
    const failed = transitionRunStatus(failedInput, "failed", {
      now: this.#now(),
      stopReason,
      delivery: deriveRunDelivery({ run: failedInput, outcome: "failed", now: this.#now(), stopReason })
    });
    return this.#commit(run, failed, "run.failed", { stopReason, diagnostic }, observer);
  }

  #budgetFailure(run: RunSnapshot, activeStartedAt: number): string | null {
    if (run.budgetsUsed.iterations >= run.budgets.maxIterations) return "ITERATION_BUDGET_EXCEEDED";
    if (run.budgetsUsed.modelCalls >= run.budgets.maxModelCalls) return "MODEL_CALL_BUDGET_EXCEEDED";
    if (run.budgetsUsed.toolCalls >= run.budgets.maxToolCalls) return "TOOL_CALL_BUDGET_EXCEEDED";
    if (Date.parse(this.#now()) - activeStartedAt >= run.budgets.maxDurationMs) return "DURATION_BUDGET_EXCEEDED";
    return null;
  }

  #services(signal: AbortSignal, runId?: string): RuntimeServices {
    const tools = runId === undefined ? this.#tools : this.#toolsForRun(runId);
    return {
      workspace: this.#workspaceFor(runId),
      tools,
      store: this.#store,
      now: () => this.#now(),
      createId: () => this.#createId(),
      signal,
      fencingToken: (runId) => this.#leases.requireFencingToken(runId),
      assertAuditIntegrity: (runId) => this.#assertAuditIntegrity(runId),
      notify: (runId, observer) => this.#notify(runId, observer),
      ...(runId === undefined ? {} : { forkContext: this.#forkContextFor(runId) }),
      withHeartbeat: (runId, operation) => (
        this.#leases.withHeartbeat(runId, operation)
      ),
      putArtifactText: (content, mediaType) => {
        const artifact = new ArtifactStore(this.#artifactDir).putText(
          content,
          mediaType
        );
        return { digest: artifact.digest, byteLength: artifact.byteLength };
      },
      commit: (previous, next, type, payload, observer) => (
        this.#commit(previous, next, type, payload, observer)
      ),
      fail: (run, stopReason, errorCode, observer) => (
        this.#fail(run, stopReason, errorCode, observer)
      )
    };
  }

  #toolsForRun(runId: string): ReadonlyMap<string, RuntimeTool> {
    const branch = this.#store.getBranchByChild(runId);
    const profileRef = branch?.lineage.at(-1)?.profileRef;
    if (profileRef === undefined) {
      return branch?.lineage.at(-1)?.delegationId === undefined ? this.#tools : new Map();
    }
    const allowlist = this.#workerToolPolicies.get(profileRef);
    if (allowlist === undefined) return new Map();
    return new Map([...this.#tools.entries()].filter(([name]) => allowlist.has(name)));
  }

  #commit(
    previous: RunSnapshot,
    next: RunSnapshot,
    type: string,
    payload: Record<string, unknown>,
    observer?: RuntimeObserver
  ): RunSnapshot {
    const committed = this.#store.commitRun({
      previous,
      next,
      fencingToken: this.#leases.requireFencingToken(previous.runId),
      event: { type, occurredAt: this.#now(), payload }
    });
    this.#notify(committed.runId, observer);
    return committed;
  }

  #notify(runId: string, observer?: RuntimeObserver): void {
    const event = this.#store.getLastEvent(runId);
    if (event === null) return;
    if (event.recordDigest !== undefined) this.#verifiedJournalHeads.set(runId, event.recordDigest);
    observer?.(event);
    for (const subscription of this.#subscriptions.get(runId) ?? []) {
      subscription.notify();
    }
  }

  #requireRun(runId: string): RunSnapshot {
    const run = this.#store.getRun(runId);
    if (run === null) {
      throw new RuntimeError({
        code: "RUN_NOT_FOUND",
        message: `Run not found: ${runId}`,
        runId
      });
    }
    return run;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RuntimeError({
        code: "RUNTIME_CLOSED",
        message: "Runtime is closed."
      });
    }
  }

  /** Resolves the workspace root for a Run: branch children use their isolated snapshot, others the root workspace. */
  #workspaceFor(runId?: string): string {
    if (runId !== undefined) {
      const branchRoot = this.#branchWorkspaces.get(runId);
      if (branchRoot !== undefined) return branchRoot;
    }
    return this.#workspace;
  }

  /** When the run is a branch child, its read-only parent inheritance boundary. */
  #forkContextFor(runId: string): ForkContext | null {
    const branch = this.#store.getBranchByChild(runId);
    if (branch === null) return null;
    const forkBase = this.#store.getForkBase(branch.branchId);
    if (forkBase === null) return null;
    return { parentRunId: branch.parentRunId, forkBase };
  }

  /** Fork API: creates an isolated exploratory branch from the parent's current revision. */
  async fork(runId: string, options: ForkOptions = {}): Promise<BranchHandle | null> {
    this.#assertOpen();
    return this.#forkRun(runId, options, undefined);
  }

  listBranches(runId: string): BranchRecord[] {
    this.#assertOpen();
    return this.#store.listBranches(runId);
  }

  #lineageForRun(runId: string): RunLineage {
    const branch = this.#store.getBranchByChild(runId);
    if (branch === null) return { kind: "root", parentRunId: null, branchId: null };
    return {
      kind: branch.lineage.at(-1)?.delegationId === undefined ? "manual_branch" : "delegated_worker",
      parentRunId: branch.parentRunId,
      branchId: branch.branchId
    };
  }

  #physicalToolExecutions(runId: string): number {
    return this.#store.listEvents(runId).filter((event) => (
      event.type === "tool.attempt.succeeded" && event.payload.physicalExecution !== false
    )).length;
  }

  #workerRecoveryRequests(parentRunId: string): readonly WorkerRecoveryRequest[] {
    return this.#store.listBranches(parentRunId).flatMap((branch) => {
      if (branch.status !== "active" && branch.status !== "creating") return [];
      if (branch.lineage.at(-1)?.delegationId === undefined) return [];
      const child = this.#store.getRun(branch.childRunId);
      if (child?.status !== "blocked") return [];
      return [{
        parentRunId,
        branchId: branch.branchId,
        childRunId: child.runId,
        status: "blocked" as const,
        stopReason: child.stopReason,
        actions: ["resume", "discard"] as const
      }];
    });
  }

  #providerRecoveryAllowed(runId: string, pendingFailures = 0): boolean {
    return this.#providerFailureCount(runId) + pendingFailures < MAX_PROVIDER_FAILURES_PER_PROGRESS_WINDOW;
  }

  #providerFailureCount(runId: string): number {
    const run = this.#requireRun(runId);
    const lineage = [
      ...this.#continuationAncestors(run).map((item) => item.events),
      this.#store.listEvents(runId)
    ].flat();
    const lastProgressIndex = lineage.reduce((latest, event, index) => (
      isProviderRecoveryProgressEvent(event) ? index : latest
    ), -1);
    return lineage.slice(lastProgressIndex + 1).filter((event) => (
      event.type === "run.blocked"
      && (event.payload.stopReason === "PROVIDER_UNAVAILABLE"
        || event.payload.stopReason === "CONTEXT_CAPACITY_EXCEEDED")
    )).length;
  }

  #isRecoverableContinuationParent(run: RunSnapshot): boolean {
    if (run.stopReason === "NO_PROGRESS_DETECTED") {
      return run.status === "blocked" || run.status === "failed";
    }
    if (run.status !== "blocked") return false;
    return (
      run.stopReason === "PROVIDER_UNAVAILABLE"
      || run.stopReason === "CONTEXT_CAPACITY_EXCEEDED"
    ) && !this.#providerRecoveryAllowed(run.runId);
  }

  /** Derived Child → Parent projection; Child Run remains the only authority. */
  listWorkerObservations(parentRunId: string): readonly WorkerObservation[] {
    this.#assertOpen();
    const events = this.#store.listEvents(parentRunId);
    const latestAccepted = [...events].reverse().find((event) => (
      event.type === "runtime.event"
      && event.payload.name === "workers.delegation.accepted"
      && typeof event.payload.delegationId === "string"
    ));
    const latestDelegationId = typeof latestAccepted?.payload.delegationId === "string"
      ? latestAccepted.payload.delegationId
      : null;
    const ordinals = new Map<string, number>();
    if (Array.isArray(latestAccepted?.payload.assignments)) {
      for (const item of latestAccepted.payload.assignments) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.assignmentId === "string" && typeof record.ordinal === "number") {
          ordinals.set(record.assignmentId, record.ordinal);
        }
      }
    }
    const branches = this.#store.listBranches(parentRunId)
      .filter((branch) => latestDelegationId === null
        || branch.lineage.at(-1)?.delegationId === latestDelegationId)
      .sort((left, right) => {
        const leftOrdinal = ordinals.get(left.lineage.at(-1)?.assignmentId ?? "") ?? Number.MAX_SAFE_INTEGER;
        const rightOrdinal = ordinals.get(right.lineage.at(-1)?.assignmentId ?? "") ?? Number.MAX_SAFE_INTEGER;
        return leftOrdinal - rightOrdinal || left.branchId.localeCompare(right.branchId);
      });
    return branches.map((branch) => {
      const child = this.#requireRun(branch.childRunId);
      const lineage = branch.lineage.at(-1);
      return Object.freeze({
        parentRunId,
        branchId: branch.branchId,
        childRunId: child.runId,
        delegationId: lineage?.delegationId ?? null,
        assignmentId: lineage?.assignmentId ?? null,
        profileRef: lineage?.profileRef ?? null,
        status: child.status,
        branchStatus: branch.status,
        summary: child.result?.summary ?? null,
        resultArtifact: child.result?.resultArtifact ?? null,
        delivery: child.delivery,
        evidenceRefs: Object.freeze(child.evidence.map((evidence) => evidence.subjectRef))
      });
    });
  }

  #workerObservationsForDecision(parentRunId: string): readonly WorkerObservation[] {
    const events = this.#store.listEvents(parentRunId);
    const joined = [...events].reverse().find((event) => (
      event.type === "runtime.event" && event.payload.name === "workers.delegated"
    ));
    if (joined === undefined) return this.listWorkerObservations(parentRunId);
    const later = events.filter((event) => event.sequence > joined.sequence);
    const lastModelTurn = [...later].reverse().find((event) => event.type === "model.turn");
    if (lastModelTurn === undefined) return this.listWorkerObservations(parentRunId);
    const rejectedAfterTurn = later.some((event) => (
      event.sequence > lastModelTurn.sequence && event.type === "response.rejected"
    ));
    return rejectedAfterTurn ? this.listWorkerObservations(parentRunId) : [];
  }

  getBranch(branchId: string): BranchView | null {
    this.#assertOpen();
    const branch = this.#store.getBranch(branchId);
    if (branch === null) return null;
    return this.#branchView(branch);
  }

  discardBranch(branchId: string, reason?: string): BranchRecord {
    this.#assertOpen();
    const branch = this.#store.getBranch(branchId);
    if (branch === null) throw new Error(`Branch not found: ${branchId}`);
    if (branch.status === "merged" || branch.status === "discarded") {
      throw new Error(`Branch is already ${branch.status}: ${branchId}`);
    }
    return this.#withControlLeaseSync(branch.parentRunId, () => {
      this.#assertControlIdle(branch.parentRunId);
      const cleanup = this.#branchWorkspaceCleanups.get(branch.childRunId);
      this.#store.updateBranchStatus({
        branchId,
        status: "discarded",
        parentRunId: branch.parentRunId,
        event: {
          type: "branch.discarded",
          occurredAt: this.#now(),
          payload: { branchId, childRunId: branch.childRunId, reason: reason ?? null }
        },
        fencingToken: this.#leases.requireFencingToken(branch.parentRunId)
      });
      if (cleanup !== undefined) cleanup();
      this.#branchWorkspaces.delete(branch.childRunId);
      this.#branchWorkspaceCleanups.delete(branch.childRunId);
      this.#notify(branch.parentRunId, undefined);
      return this.#store.getBranch(branchId)!;
    });
  }

  mergeBranch(branchId: string, options: { readonly decisions: MergeDecisions }): MergeOutcome {
    this.#assertOpen();
    const branch = this.#store.getBranch(branchId);
    if (branch === null) throw new Error(`Branch not found: ${branchId}`);
    if (branch.status !== "active" && branch.status !== "creating") {
      throw new Error(`Branch ${branchId} is not mergeable (status ${branch.status}).`);
    }
    return this.#withControlLeaseSync(branch.parentRunId, () => {
      this.#assertControlIdle(branch.parentRunId);
      return this.#applyBranchMerge(branch, options.decisions);
    });
  }

  #applyBranchMerge(branch: BranchRecord, decisions: MergeDecisions): MergeOutcome {
    const parent = this.#requireRun(branch.parentRunId);
    const child = this.#store.getRun(branch.childRunId);
    if (child === null) throw new Error(`Branch child run missing: ${branch.childRunId}`);

    // Strict whitelist: only inputs, a Plan proposal, artifact references, and a
    // non-authority summary may be merged. Evidence / Invocations / Approval /
    // completion state / side effects are never merged.
    const acceptedInputs: string[] = [];
    for (const input of decisions.inputs ?? []) {
      const text = input.trim();
      if (text) acceptedInputs.push(text);
    }
    const acceptedArtifacts: string[] = [];
    for (const ref of decisions.artifacts ?? []) {
      const match = /^sha256:[0-9a-f]{64}$/.exec(ref);
      if (match !== null && new ArtifactStore(this.#artifactDir).has(ref)) {
        acceptedArtifacts.push(ref);
      }
    }
    const planProposal = decisions.planProposal === true;
    const summary = decisions.summary === true;

    // The parent advances by a new revision (fenced, optimistic concurrency).
    const now = this.#now();
    const next = RunSnapshotSchema.parse({
      ...parent,
      updatedAt: now
    });
    const committed = this.#store.commitRun({
      previous: parent,
      next,
      fencingToken: this.#leases.requireFencingToken(parent.runId),
      event: {
        type: "branch.merged",
        occurredAt: now,
        payload: {
          branchId: branch.branchId,
          childRunId: branch.childRunId,
          inputs: acceptedInputs,
          planProposal,
          artifacts: acceptedArtifacts,
          summary,
          rejected: { currentPlan: planProposal === false, evidence: true, invocations: true, sideEffects: true }
        }
      }
    });
    const merged = this.#store.updateBranchStatus({
      branchId: branch.branchId,
      status: "merged",
      parentRunId: branch.parentRunId,
      event: {
        type: "branch.merged",
        occurredAt: now,
        payload: { branchId: branch.branchId, childRunId: branch.childRunId }
      },
      fencingToken: this.#leases.requireFencingToken(branch.parentRunId)
    });
    this.#branchWorkspaceCleanups.get(branch.childRunId)?.();
    this.#branchWorkspaces.delete(branch.childRunId);
    this.#branchWorkspaceCleanups.delete(branch.childRunId);
    this.#notify(branch.parentRunId, undefined);
    return {
      branch: merged,
      parentRunId: branch.parentRunId,
      parentRevision: committed.revision,
      accepted: { inputs: acceptedInputs, planProposal, artifacts: acceptedArtifacts, summary },
      rejected: { currentPlan: !planProposal, evidence: true, invocations: true, sideEffects: true }
    };
  }

  #branchView(branch: BranchRecord): BranchView {
    const forkBase = this.#store.getForkBase(branch.branchId);
    if (forkBase === null) throw new Error(`Branch fork base missing: ${branch.branchId}`);
    const child = this.#requireRun(branch.childRunId);
    const childInspection = projectRunInspection(
      child,
      this.#store.listToolInvocations(child.runId),
      this.#store.getLastEvent(child.runId)?.sequence ?? 0,
      this.#store.listModelCalls(child.runId),
      this.#lineageForRun(child.runId),
      [],
      this.#store.listEvents(child.runId).filter((event) => event.type === "plan.set").length,
      this.#physicalToolExecutions(child.runId)
    );
    return deepFreeze({ branch, forkBase, child: childInspection });
  }

  #createBranchHandle(branch: BranchRecord): BranchHandle {
    return {
      id: branch.branchId,
      inspect: async () => this.#branchView(branch),
      run: (options) => this.#executeBranchRun(branch, options),
      input: (text) => this.#inputHandle(branch.childRunId, text),
      approve: (options) => this.#approvalHandle(branch.childRunId, true, options),
      deny: (options) => this.#approvalHandle(branch.childRunId, false, options),
      cancel: (reason) => this.#cancelHandle(branch.childRunId, reason),
      merge: async (options) => this.mergeBranch(branch.branchId, options),
      discard: async (reason) => this.discardBranch(branch.branchId, reason)
    };
  }

  async #forkRun(
    runId: string,
    options: ForkOptions = {},
    observer?: RuntimeObserver
  ): Promise<BranchHandle | null> {
    const parent = this.#requireRun(runId);
    let handle: BranchHandle | null = null;
    await this.#withControlLease(runId, async () => {
      this.#assertControlIdle(runId);
      handle = this.#forkParentRun(parent, options, observer);
    });
    return handle;
  }

  #forkParentRun(
    parent: RunSnapshot,
    options: ForkOptions = {},
    observer?: RuntimeObserver,
    relation?: {
      readonly delegationId: string;
      readonly assignmentId: string;
      readonly profileRef?: string;
      readonly objectiveDigest: string;
    }
  ): BranchHandle | null {
    const runId = parent.runId;
    const now = this.#now();
    const branchId = this.#createId();
    const childRunId = this.#createId();
    const lastEvent = this.#store.getLastEvent(runId);
    const forkEventSequence = lastEvent?.sequence ?? 1;

    // 1. Isolated workspace directory snapshot. If a reliable snapshot cannot
    // be produced (e.g. symlinks present), the fork is refused rather than
    // sharing mutable workspace state with the parent.
    const branchesBase = join(this.#dataDir, "branches");
    let snapshot: {
      readonly root: string;
      readonly cleanup: () => void;
    } | null = null;
    try {
      snapshot = snapshotWorkspace({
        parentWorkspace: this.#workspace,
        targetBase: branchesBase,
        branchId,
        dataDir: this.#dataDir
      });
    } catch {
      return null;
    }

    // 2. Child snapshot deep-copied from the parent's current revision; the
    // child's Task Contract workspace is redirected to the branch snapshot.
    // The Plan's goalDigest is recomputed alongside so the invariant
    // `plan.goalDigest === digestTaskContract(taskContract)` stays intact for
    // the child (completion validation relies on it).
    const child = this.#store.createRunFromSnapshot(parent, childRunId, now);
    this.#localRunIds.add(child.runId);
    const redirectedContract = child.taskContract === null
      ? null
      : { ...child.taskContract, workspace: snapshot!.root };
    const initialInput = options.initialInput?.trim();
    const delegatedInputHistory = initialInput === undefined || initialInput.length === 0
      ? child.inputHistory
      : [
          ...(relation === undefined ? child.inputHistory : []),
          {
            id: randomUUID(),
            sequence: relation === undefined ? child.inputHistory.length + 1 : 1,
            text: initialInput,
            receivedAt: now
          }
        ];
    const childWithBranchWorkspace = RunSnapshotSchema.parse({
      ...child,
      ...(relation === undefined ? {} : {
        budgets: compileChildBudgets(parent, this.#delegationPolicy.childBudgets)!,
        budgetsUsed: { iterations: 0, modelCalls: 0, toolCalls: 0, retries: 0, startedAt: now }
      }),
      ...(initialInput === undefined || initialInput.length === 0
        ? {}
        : {
            inputHistory: delegatedInputHistory,
            taskContract: null,
            currentPlan: null,
            stepProgress: [],
            pendingRequest: null,
            lastError: null,
            result: null,
            delivery: null
          }),
      taskContract: initialInput === undefined || initialInput.length === 0 ? redirectedContract : null,
      currentPlan: initialInput !== undefined && initialInput.length > 0
        ? null
        : child.currentPlan === null
        ? null
        : {
            ...child.currentPlan,
            ...(redirectedContract === null
              ? {}
              : { goalDigest: digestTaskContract(redirectedContract) })
          }
    });

    // 3. Read-only inheritance boundary (parent facts at the fork point).
    const inheritedRefs = buildForkBaseInheritedRefs({
      parent,
      store: this.#store,
      artifactDir: this.#artifactDir
    });
    const inheritedFacts = buildForkBaseInheritedFacts({
      parent,
      store: this.#store,
      artifactDir: this.#artifactDir
    });

    // 4. Branch + Fork Base persisted atomically with the child run.
    const lineage: BranchRecord["lineage"] = [{
      parentRunId: runId,
      forkRevision: parent.revision,
      forkEventSequence,
      ...(relation === undefined ? {} : {
        delegationId: relation.delegationId,
        assignmentId: relation.assignmentId,
        ...(relation.profileRef === undefined ? {} : { profileRef: relation.profileRef }),
        objectiveDigest: relation.objectiveDigest
      })
    }];
    const branch: BranchRecord = {
      branchId,
      parentRunId: runId,
      forkRevision: parent.revision,
      forkEventSequence,
      childRunId,
      status: "creating",
      lineage,
      createdAt: now
    };
    this.#store.createBranch({
      branch,
      forkBase: {
        branchId,
        parentRunId: runId,
        forkRevision: parent.revision,
        forkEventSequence,
        inheritedRefs,
        inheritedFacts
      },
      child: childWithBranchWorkspace,
      parentEvent: {
        type: "branch.created",
        occurredAt: now,
        payload: {
          branchId,
          childRunId,
          forkRevision: parent.revision,
          ...(relation === undefined ? {} : {
            delegationId: relation.delegationId,
            assignmentId: relation.assignmentId,
            objectiveDigest: relation.objectiveDigest
          })
        }
      },
      parentFencingToken: this.#leases.requireFencingToken(runId)
    });

    // 5. Register the branch workspace and mark the branch active.
    this.#branchWorkspaces.set(childRunId, snapshot!.root);
    this.#branchWorkspaceCleanups.set(childRunId, snapshot!.cleanup);
    const active = this.#store.updateBranchStatus({
      branchId,
      status: "active",
      parentRunId: runId,
      event: {
        type: "runtime.event",
        occurredAt: now,
        payload: {
          name: "branch.activated",
          branchId,
          childRunId,
          forkRevision: parent.revision,
          ...(relation === undefined ? {} : {
            delegationId: relation.delegationId,
            assignmentId: relation.assignmentId
          })
        }
      },
      fencingToken: this.#leases.requireFencingToken(runId)
    });
    this.#notify(runId, observer);
    return this.#createBranchHandle(active);
  }

  async #executeBranchRun(
    branch: BranchRecord,
    _options: RunOptions = {}
  ): Promise<RunResult> {
    const child = this.#requireRun(branch.childRunId);
    if (this.#activeExecutions.has(child.runId)) {
      throw new RunControlError({
        code: "RUN_BUSY",
        runId: child.runId,
        message: "Branch child run already has an active execution segment."
      });
    }
    const controller = new AbortController();
    const execution = this.#resumeRun(child, { runId: child.runId }, controller, undefined);
    this.#trackExecution(child.runId, execution, controller);
    try {
      return await execution;
    } catch (error) {
      this.#deleteActiveExecution(child.runId, execution);
      throw error;
    }
  }

  #recoverBranchWorkspaces(dataDir: string): void {
    const branchesBase = join(dataDir, "branches");
    cleanupStagingWorkspaces(branchesBase);
    try {
      for (const branch of this.#store.listAllBranches()) {
        const root = join(branchesBase, branch.branchId);
        if (branch.status === "creating") {
          if (branchWorkspaceExists(root)) {
            this.#branchWorkspaces.set(branch.childRunId, root);
            this.#branchWorkspaceCleanups.set(
              branch.childRunId,
              () => removeDirectoryTree(root)
            );
            this.#store.updateBranchStatus({
              branchId: branch.branchId,
              status: "active",
              parentRunId: branch.parentRunId,
              event: {
                type: "branch.resumed",
                occurredAt: this.#now(),
                payload: { branchId: branch.branchId, childRunId: branch.childRunId }
              }
            });
          } else {
            this.#store.updateBranchStatus({
              branchId: branch.branchId,
              status: "failed",
              parentRunId: branch.parentRunId,
              event: {
                type: "branch.failed",
                occurredAt: this.#now(),
                payload: { branchId: branch.branchId, reason: "workspace_snapshot_incomplete" }
              }
            });
          }
        } else if (branch.status === "active" && branchWorkspaceExists(root)) {
          // Re-register the surviving workspace of a previously active branch so
          // a resumed child keeps executing against its isolated snapshot, and
          // re-attach the cleanup so a later discard/merge can remove it.
          this.#branchWorkspaces.set(branch.childRunId, root);
          this.#branchWorkspaceCleanups.set(
            branch.childRunId,
            () => removeDirectoryTree(root)
          );
        }
      }
    } catch {
      // Best-effort recovery; never block startup on stale branch metadata.
    }
  }

}

function isTerminalRun(run: RunSnapshot): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

function normalizePlanText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}

function normalizePlanValue(value: unknown): unknown {
  if (typeof value === "string") return normalizePlanText(value);
  if (Array.isArray(value)) return value.map(normalizePlanValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizePlanValue(nested)]));
  }
  return value;
}

function compileChildBudgets(
  parent: RunSnapshot,
  overrides: RuntimeDelegationPolicy["childBudgets"]
): RuntimeBudgets | null {
  const remainingIterations = parent.budgets.maxIterations - parent.budgetsUsed.iterations - 2;
  const remainingModelCalls = parent.budgets.maxModelCalls - parent.budgetsUsed.modelCalls - 2;
  const remainingToolCalls = parent.budgets.maxToolCalls - parent.budgetsUsed.toolCalls;
  if (remainingIterations < 1 || remainingModelCalls < 1 || remainingToolCalls < 1) return null;
  return RuntimeBudgetsSchema.parse({
    maxIterations: Math.min(overrides?.maxIterations ?? 12, remainingIterations),
    maxModelCalls: Math.min(overrides?.maxModelCalls ?? 12, remainingModelCalls),
    maxToolCalls: Math.min(overrides?.maxToolCalls ?? 24, remainingToolCalls),
    maxRetries: Math.min(overrides?.maxRetries ?? 0, parent.budgets.maxRetries),
    maxDurationMs: Math.min(overrides?.maxDurationMs ?? 120_000, parent.budgets.maxDurationMs)
  });
}

function isDelegationEnvelopeNoWider(
  current: RuntimeDelegationPolicy,
  persistedValue: unknown
): boolean {
  if (typeof persistedValue !== "object" || persistedValue === null) return false;
  const persisted = persistedValue as Record<string, unknown>;
  if (current.mode !== persisted.mode) return false;
  if (typeof persisted.maxConcurrentWorkers !== "number"
    || current.maxConcurrentWorkers > persisted.maxConcurrentWorkers) return false;
  const persistedProfiles = Array.isArray(persisted.allowedProfiles)
    ? new Set(persisted.allowedProfiles.filter((item): item is string => typeof item === "string"))
    : null;
  if (current.allowedProfiles !== undefined) {
    if (persistedProfiles === null || current.allowedProfiles.some((profile) => !persistedProfiles.has(profile))) return false;
  } else if (persistedProfiles !== null) {
    return false;
  }
  const persistedTools = typeof persisted.workerToolPolicies === "object" && persisted.workerToolPolicies !== null
    ? persisted.workerToolPolicies as Record<string, unknown>
    : {};
  for (const [profile, tools] of Object.entries(current.workerToolPolicies ?? {})) {
    const oldTools = persistedTools[profile];
    if (!Array.isArray(oldTools)) return false;
    const allowed = new Set(oldTools.filter((item): item is string => typeof item === "string"));
    if (tools.some((tool) => !allowed.has(tool))) return false;
  }
  const persistedBudgets = typeof persisted.childBudgets === "object" && persisted.childBudgets !== null
    ? persisted.childBudgets as Record<string, unknown>
    : {};
  for (const [key, value] of Object.entries(current.childBudgets ?? {})) {
    const oldValue = persistedBudgets[key];
    if (typeof oldValue !== "number" || typeof value !== "number" || value > oldValue) return false;
  }
  return true;
}

function isBudgetStopReason(value: string | null): boolean {
  return value === "ITERATION_BUDGET_EXCEEDED"
    || value === "MODEL_CALL_BUDGET_EXCEEDED"
    || value === "TOOL_CALL_BUDGET_EXCEEDED"
    || value === "DURATION_BUDGET_EXCEEDED";
}

function isProviderRecoveryProgressEvent(event: RunEvent): boolean {
  return event.type === "tool.attempt.succeeded"
    || event.type === "validation.passed"
    || event.type === "recovery.confirmed_succeeded"
    || event.type === "recovery.confirmed_failed"
    || event.type === "branch.merged";
}

function invocationsReferencedByEvents(
  invocations: readonly ToolInvocation[],
  events: readonly RunEvent[]
): readonly ToolInvocation[] {
  const invocationIds = new Set(events.flatMap((event) => (
    typeof event.payload.invocationId === "string" ? [event.payload.invocationId] : []
  )));
  return invocations.filter((invocation) => invocationIds.has(invocation.id));
}

function hasAuthoritativeProgressBeyondStrategy(
  events: readonly RunEvent[],
  invocations: readonly ToolInvocation[],
  priorStrategies: readonly string[],
  priorObservations: readonly string[] = []
): boolean {
  if (events.some((event) => (
    event.type === "tool.recovered"
    || event.type === "validation.passed"
    || event.type === "recovery.confirmed_succeeded"
    || event.type === "recovery.confirmed_failed"
    || event.type === "branch.merged"
    || event.type === "run.succeeded"
  ))) return true;
  return invocations.some((invocation) => {
    const strategy = invocationStrategyFingerprint(invocation);
    if (strategy === null) return false;
    if (!priorStrategies.includes(strategy)) return true;
    const observation = invocationObservationFingerprint(invocation);
    return observation !== null && !priorObservations.includes(observation);
  });
}

function repeatedRejectionIssue(
  rejections: readonly RunEvent[]
): { readonly fingerprint: string; readonly repeatCount: number } | null {
  const counts = new Map<string, number>();
  for (const rejection of rejections) {
    for (const fingerprint of rejectionIssueFingerprints(rejection)) {
      counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    }
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([leftFingerprint, leftCount], [rightFingerprint, rightCount]) => (
      rightCount - leftCount || leftFingerprint.localeCompare(rightFingerprint)
    ))[0];
  return repeated === undefined ? null : { fingerprint: repeated[0], repeatCount: repeated[1] };
}

function isStateRejection(event: RunEvent): boolean {
  if (event.type !== "response.rejected") return false;
  const diagnostic = event.payload.diagnostic;
  return diagnostic !== null
    && typeof diagnostic === "object"
    && !Array.isArray(diagnostic)
    && (diagnostic as { readonly kind?: unknown }).kind === "state";
}

function rejectionIssueFingerprints(event: RunEvent): readonly string[] {
  if (event.type !== "response.rejected") return [];
  const diagnostic = event.payload.diagnostic;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return [];
  const value = diagnostic as { readonly kind?: unknown; readonly issues?: unknown };
  if (!Array.isArray(value.issues)) return [];
  return value.issues.flatMap((issue) => {
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) return [];
    const item = issue as { readonly path?: unknown; readonly code?: unknown; readonly message?: unknown };
    if (typeof item.path !== "string" || typeof item.code !== "string") return [];
    return [digestCanonicalJson({
      kind: typeof value.kind === "string" ? value.kind : "unknown",
      path: item.path,
      code: item.code,
      ...(value.kind === "state" && item.code === "response_rejected" && typeof item.message === "string"
        ? { message: item.message }
        : {})
    })];
  });
}

function invocationStrategyFingerprint(invocation: ToolInvocation): string | null {
  if (invocation.status !== "succeeded" && invocation.status !== "failed") return null;
  return digestCanonicalJson({
    toolName: invocation.toolName,
    inputDigest: invocation.inputDigest,
  });
}

function invocationObservationFingerprint(invocation: ToolInvocation): string | null {
  if (invocation.status !== "succeeded" && invocation.status !== "failed") return null;
  const outcome = invocation.status === "succeeded"
    ? invocation.resultJson
    : (() => {
        const error = invocation.errorJson;
        if (error === null || typeof error !== "object" || Array.isArray(error)) return error;
        const value = error as { readonly code?: unknown; readonly retryable?: unknown; readonly details?: unknown };
        return {
          code: value.code,
          retryable: value.retryable,
          ...(value.details === undefined ? {} : { details: value.details })
        };
      })();
  return digestCanonicalJson({
    status: invocation.status,
    outcome
  });
}

function inheritedObservationFingerprints(
  kind: string,
  invocations: readonly ToolInvocation[]
): readonly string[] {
  if (kind !== "repeated_tool_failure" && kind !== "repeated_tool_result") return [];
  return invocations.flatMap((invocation) => {
    const fingerprint = invocationObservationFingerprint(invocation);
    return fingerprint === null ? [] : [fingerprint];
  });
}

function inheritedStrategyFingerprints(
  kind: string,
  events: readonly RunEvent[],
  invocations: readonly ToolInvocation[]
): readonly string[] {
  if (kind === "repeated_invalid_response" || kind === "repeated_response_rejection") {
    const rejection = [...events].reverse().find((event) => event.type === "response.rejected");
    return rejection === undefined ? [] : rejectionIssueFingerprints(rejection);
  }
  if (kind === "repeated_tool_failure" || kind === "repeated_tool_result") {
    const latest = [...invocations].reverse().find((invocation) => (
      invocation.status === "succeeded" || invocation.status === "failed"
    ));
    const fingerprint = latest === undefined ? null : invocationStrategyFingerprint(latest);
    return fingerprint === null ? [] : [fingerprint];
  }
  if (kind === "equivalent_plan") {
    const plan = [...events].reverse().find((event) => event.type === "plan.set" && event.payload.noOp === true);
    return plan === undefined ? [] : [digestCanonicalJson({ kind, version: plan.payload.version })];
  }
  if (kind === "resource_churn") {
    const blocked = [...events].reverse().find((event) => event.type === "run.blocked");
    const diagnostic = blocked?.payload.diagnostic;
    const resources = diagnostic !== null && typeof diagnostic === "object" && !Array.isArray(diagnostic)
      && Array.isArray((diagnostic as { readonly resources?: unknown }).resources)
      ? (diagnostic as { readonly resources: unknown[] }).resources.filter((item): item is string => typeof item === "string")
      : [];
    return resources.map((resource) => digestCanonicalJson({ kind, resource }));
  }
  return [];
}

function currentFailureStrategyFingerprints(
  kind: string,
  events: readonly RunEvent[],
  invocations: readonly ToolInvocation[]
): readonly string[] {
  if (kind === "repeated_invalid_response" || kind === "repeated_response_rejection") {
    return events.flatMap((event) => rejectionIssueFingerprints(event));
  }
  if (kind === "repeated_tool_failure" || kind === "repeated_tool_result") {
    return invocations.flatMap((invocation) => {
      const fingerprint = invocationStrategyFingerprint(invocation);
      return fingerprint === null ? [] : [fingerprint];
    });
  }
  if (kind === "equivalent_plan") {
    return events
      .filter((event) => event.type === "plan.set" && event.payload.noOp === true)
      .map((event) => digestCanonicalJson({ kind, version: event.payload.version }));
  }
  if (kind === "resource_churn") {
    return invocations.flatMap((invocation) => {
      if (invocation.status !== "succeeded" && invocation.status !== "failed") return [];
      const input = invocation.inputJson;
      if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
      const path = (input as { readonly path?: unknown }).path;
      if (typeof path !== "string") return [];
      return [digestCanonicalJson({
        kind,
        resource: path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase()
      })];
    });
  }
  return [];
}

function canonicalResource(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((item) => values.has(item));
}

function correctableRejection(event: RunEvent): boolean {
  if (event.type !== "response.rejected") return false;
  const diagnostic = event.payload.diagnostic;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return false;
  const recovery = (diagnostic as { readonly recovery?: unknown }).recovery;
  if (recovery === null || typeof recovery !== "object" || Array.isArray(recovery)) return false;
  const value = recovery as {
    readonly sideEffect?: unknown;
    readonly doNotRepeat?: unknown;
    readonly nextAction?: unknown;
  };
  return value.sideEffect === "none"
    && value.doNotRepeat === true
    && typeof value.nextAction === "string"
    && value.nextAction.trim().length > 0;
}

function rejectionStrategyFingerprint(event: RunEvent): string {
  if (event.type !== "response.rejected") return digestCanonicalJson({ event: event.type });
  return digestCanonicalJson({
    diagnostic: event.payload.diagnostic
  });
}

function addQuota(current: number, additional: number | undefined): number {
  if (additional === undefined) return current;
  const next = current + additional;
  if (!Number.isSafeInteger(next)) throw new Error("Budget Extension exceeds the safe integer range.");
  return next;
}

function providerBoundaryErrorCode(error: unknown): "PROVIDER_UNAVAILABLE" | "CONTEXT_CAPACITY_EXCEEDED" {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "CONTEXT_CAPACITY_EXCEEDED"
  ) return "CONTEXT_CAPACITY_EXCEEDED";
  return "PROVIDER_UNAVAILABLE";
}
