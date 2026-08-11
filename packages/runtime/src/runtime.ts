import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  RunSnapshotSchema,
  RuntimeActionSchema,
  RuntimeBudgetsSchema,
  StructuredPlanSchema,
  TaskContractSchema,
  JsonValueSchema,
  createInitialRunSnapshot,
  type BranchRecord,
  type PlanTaskContract,
  type RunSnapshot,
  type RuntimeAction,
  type TaskContract
} from "./contracts.js";
import { ArtifactStore } from "./store/artifacts.js";
import {
  branchWorkspaceExists,
  cleanupStagingWorkspaces,
  removeDirectoryTree,
  snapshotWorkspace
} from "./store/branch-workspace.js";
import {
  requestModel
} from "./context/request-model.js";
import {
  buildDecisionContext
} from "./context/decision-context.js";
import type { ForkContext } from "./contracts.js";
import {
  buildForkBaseInheritedFacts,
  buildForkBaseInheritedRefs,
  parseRequestContextAction,
  type RequestContextAction
} from "./context/rehydration.js";
import type {
  RuntimeProvider
} from "./providers/model-client.js";
import {
  resolveProviderModelProfile
} from "./context/budget.js";
import { openRunStore, type RunStore } from "./store/run-store.js";
import { transitionRunStatus } from "./state-machine.js";
import { MemoryScopeSchema } from "./memory/index.js";
import { digestTaskContract, proposeFinish } from "./validation.js";
import {
  ActionRejectedError,
  allowedActions,
  assertCompletedStepsUnchanged,
  deepFreeze,
  digestJson,
  errorMessage,
  actionRejectionDiagnostic,
  requireWorkspace,
  serializeRejectedAction,
  toRunResult,
  validateToolContract
} from "./runtime-helpers.js";
import {
  callTool,
  recoverToolInvocation
} from "./execution/runtime-execution.js";
import type {
  BranchHandle,
  BranchView,
  CreateRuntimeOptions,
  DenialOptions,
  ForkOptions,
  MergeDecisions,
  MergeOutcome,
  RequestOptions,
  ResumeInput,
  RunFinalResult,
  RunHandle,
  RunHandleResumeOptions,
  RunInspection,
  RunOptions,
  RunResult,
  RunView,
  RuntimeEventListener,
  RuntimeObserver,
  RuntimeServices,
  RuntimeSubscription,
  RuntimeTool,
  StartInput,
  SubscribeOptions
} from "./runtime-types.js";
import {
  projectRunFinalResult,
  projectRunInspection
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

export type {
  ApprovalDecision,
  BranchHandle,
  BranchView,
  CreateRuntimeOptions,
  ForkOptions,
  MergeDecisions,
  MergeOutcome,
  PublicEvidence,
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
  RunResult,
  RunView,
  RuntimeObserver,
  RuntimeMemoryOptions,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeSubscription,
  SubscribeOptions,
  RuntimeTool,
  RuntimeToolResult,
  StartInput
} from "./runtime-types.js";
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
  readonly #provider: RuntimeProvider;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #store: RunStore;
  readonly #memory: CreateRuntimeOptions["memory"];
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
  /** Branch child runId → isolated workspace root (directory snapshot). */
  readonly #branchWorkspaces = new Map<string, string>();
  readonly #branchWorkspaceCleanups = new Map<string, () => void>();
  /**
   * Transient rehydration bookkeeping. Not an authority: pending requests are
   * rebuilt from the context.rehydrate_requested / context.rehydrated event
   * pair on resume, and the available-context manifest is republished every
   * decision turn.
   */
  readonly #rehydrationRequests = new Map<
    string,
    {
      readonly requestId: string;
      readonly refs: readonly string[];
      readonly memoryDigests: Readonly<Record<string, string>>;
    }
  >();
  readonly #publishedMemoryDigests = new Map<string, Readonly<Record<string, string>>>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: CreateRuntimeOptions) {
    try {
      const workspace = requireWorkspace(options.workspace);
      if (
        options.provider === null
        || typeof options.provider !== "object"
        || typeof options.provider.decide !== "function"
        || typeof options.provider.validate !== "function"
      ) {
        throw new Error("Runtime Provider must implement decide() and validate().");
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
      this.#provider = options.provider;
      if (options.memory !== undefined) {
        if (
          options.memory.store === null
          || typeof options.memory.store !== "object"
          || typeof options.memory.store.get !== "function"
          || typeof options.memory.store.list !== "function"
          || typeof options.memory.store.isRecallEnabled !== "function"
        ) {
          throw new Error("Runtime Memory Store must implement get(), list() and isRecallEnabled().");
        }
        this.#memory = {
          store: options.memory.store,
          scope: MemoryScopeSchema.parse(options.memory.scope)
        };
      } else {
        this.#memory = undefined;
      }
      resolveProviderModelProfile(options.provider);
      this.#now = now;
      this.#createId = createId;
      this.#tools = tools;
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
    return this.#createHandle(runId);
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
    try {
      budgets = input.budgets === undefined
        ? undefined
        : RuntimeBudgetsSchema.parse(input.budgets);
    } catch (error) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: errorMessage(error),
        cause: error
      });
    }
    const now = this.#now();
    let snapshot: RunSnapshot;
    try {
      snapshot = createInitialRunSnapshot({
        runId: this.#createId(),
        input: input.input,
        workspace: this.#workspace,
        now,
        ...(budgets === undefined ? {} : { budgets })
      });
    } catch (error) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: errorMessage(error),
        cause: error
      });
    }
    const created = this.#store.createRun(snapshot, { type: "run.created", occurredAt: now, payload: { inputSequence: 1 } });
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
    this.#leases.acquire(run.runId);
    try {
      run = await recoverToolInvocation(
        this.#services(controller.signal, run.runId),
        run,
        input.recoveryDecision,
        observer
      );
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
      if (
        run.status === "blocked"
        && run.lastError?.code === "PROVIDER_UNAVAILABLE"
        && input.recoveryDecision === undefined
      ) {
        const now = this.#now();
        const resumed = transitionRunStatus(run, "running", { now });
        run = this.#commit(run, resumed, "run.resumed", {
          reason: "provider_retry"
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
      this.#rebuildRehydrationRequests(run.runId);
      return await this.#runLoop(run, controller.signal, observer);
    } finally {
      this.#leases.release(run.runId);
    }
  }

  async inspect(runId: string): Promise<RunView> {
    this.#assertOpen();
    return {
      snapshot: this.#requireRun(runId),
      events: this.#store.listEvents(runId),
      toolInvocations: this.#store.listToolInvocations(runId),
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
      await this.#provider.dispose?.();
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
    this.#leases.acquire(created.runId);
    try {
      return await this.#runLoop(created, controller.signal, observer);
    } finally {
      this.#leases.release(created.runId);
    }
  }

  #createHandle(runId: string): RunHandle {
    return Object.freeze({
      id: runId,
      inspect: async () => await this.#inspectHandle(runId),
      wait: async () => await this.#waitForHandle(runId),
      result: async () => await this.#resultForHandle(runId),
      subscribe: (
        listener: RuntimeEventListener,
        options?: SubscribeOptions
      ) => this.#subscribeHandle(runId, listener, options),
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
    const unresolved = this.#store.listToolInvocations(runId)
      .filter(
        (invocation) => invocation.status === "started"
          || invocation.status === "unknown"
      );
    const unknown = unresolved.filter(
      (invocation) => invocation.status === "unknown"
    );
    if (unknown.length > 1) {
      throw this.#controlConflict(
        runId,
        "Run has multiple unknown Tool Invocations."
      );
    }
    if (unknown.length === 1) {
      if (options.recovery === undefined) {
        throw this.#controlConflict(
          runId,
          "The unknown Tool Invocation requires a Recovery Decision."
        );
      }
      if (options.recovery.invocationId !== unknown[0]!.id) {
        throw this.#controlConflict(
          runId,
          "Recovery Decision does not match the current unknown Tool Invocation."
        );
      }
    } else if (options.recovery !== undefined) {
      throw this.#controlConflict(
        runId,
        "Run has no unknown Tool Invocation to recover."
      );
    }
    if (run.status === "running" && unresolved.length === 0) {
      throw this.#controlConflict(
        runId,
        "Running Run has no interrupted Tool Invocation to recover."
      );
    }
    await this.#performControl(runId, async () => {
      await this.resume({
        runId,
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
      if (!controller.signal.aborted) controller.abort(message);
      try {
        await active;
      } catch (error) {
        throw this.#mapExecutionBoundaryError(error, runId);
      }
      this.#assertCancellationOutcome(runId);
      return;
    }

    if (this.#hasUnknownInvocation(runId)) {
      throw this.#toolResultUnknown(runId);
    }

    if (run.status === "running") {
      const interruptedController = new AbortController();
      interruptedController.abort(message);
      const execution = this.#resumeRun(
        run,
        { runId },
        interruptedController
      );
      this.#trackExecution(runId, execution, interruptedController);
      try {
        await execution;
      } catch (error) {
        throw this.#mapExecutionBoundaryError(error, runId);
      }
      this.#assertCancellationOutcome(runId);
      return;
    }

    try {
      this.#leases.acquire(runId);
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
    const snapshot = this.#requireRun(runId);
    const lastEvent = this.#store.getLastEvent(runId);
    return projectRunInspection(
      snapshot,
      this.#store.listToolInvocations(runId),
      lastEvent?.sequence ?? 0
    );
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
          retryable: true,
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
      stopReason: "CANCELLED"
    });
    return this.#commit(
      run,
      cancelled,
      "run.cancelled",
      { reason: message },
      observer
    );
  }

  async #runLoop(
    initial: RunSnapshot,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunResult> {
    let run = initial;
    const activeStartedAt = Date.parse(this.#now());
    while (run.status === "running") {
      if (signal.aborted) {
        run = this.#cancelPersistedRun(
          run,
          cancellationReason(signal),
          observer
        );
        break;
      }
      const budgetFailure = this.#budgetFailure(run, activeStartedAt);
      if (budgetFailure !== null) {
        run = this.#fail(run, budgetFailure, budgetFailure, observer);
        break;
      }

      const pendingRequest = this.#rehydrationRequests.get(run.runId);
      const decisionResult = buildDecisionContext({
        run,
        store: this.#store,
        workspace: this.#workspaceFor(run.runId),
        tools: this.#tools,
        artifactDir: this.#artifactDir,
        ...(this.#memory === undefined ? {} : { memory: this.#memory, now: this.#now() }),
        ...(pendingRequest === undefined ? {} : { rehydrateRequests: pendingRequest.refs }),
        ...(pendingRequest === undefined ? {} : { rehydrateMemoryDigests: pendingRequest.memoryDigests }),
        forkContext: this.#forkContextFor(run.runId)
      });
      this.#publishedMemoryDigests.set(run.runId, Object.fromEntries(
        decisionResult.context.memoryCandidates.map((candidate) => [candidate.ref, candidate.digest])
      ));
      const modelCall = await requestModel(
        {
          provider: this.#provider,
          store: this.#store,
          workspace: this.#workspaceFor(run.runId),
          tools: this.#tools,
          artifactDir: this.#artifactDir,
          now: () => this.#now(),
          createId: () => this.#createId(),
          requireFencingToken: (runId) => this.#leases.requireFencingToken(runId),
          withLeaseHeartbeat: (runId, op) => this.#leases.withHeartbeat(runId, op),
          notify: (runId, obs) => this.#notify(runId, obs),
          forkContext: this.#forkContextFor(run.runId),
          ...(this.#memory === undefined ? {} : { memory: this.#memory })
        },
        run,
        "decision",
        decisionResult.context,
        { allowedActions: decisionResult.context.allowedActions },
        signal,
        observer,
        true
      );
      if (pendingRequest !== undefined && modelCall.outcome === "succeeded") {
        this.#completeRehydrationRequest(
          run.runId,
          pendingRequest.requestId,
          pendingRequest.refs,
          observer
        );
      }
      run = modelCall.run;
      if (modelCall.outcome === "budget_exceeded") break;
      if (modelCall.outcome === "failed") {
        const error = modelCall.error;
        if (signal.aborted) {
          run = this.#cancelPersistedRun(
            run,
            cancellationReason(signal),
            observer
          );
          break;
        }
        run = this.#blockForProvider(run, error, observer);
        break;
      }
      const rawAction = modelCall.output;
      if (signal.aborted) {
        run = this.#cancelPersistedRun(
          run,
          cancellationReason(signal),
          observer
        );
        break;
      }

      // ModelAction dispatch: request_context is a Harness control action and
      // never reaches the Core state machine / #handleAction.
      const requestContextAction = parseRequestContextAction(rawAction);
      if (requestContextAction !== null) {
        run = await this.#handleRequestContext(run, requestContextAction, signal, observer);
        continue;
      }

      let action: RuntimeAction;
      try {
        action = RuntimeActionSchema.parse(rawAction);
        run = await this.#handleAction(run, action, signal, observer);
      } catch (error) {
        if (
          error instanceof RuntimeError
          && error.code === "CANCELLED"
        ) {
          run = this.#requireRun(run.runId);
          run = this.#cancelPersistedRun(
            run,
            error.message.replace(/^CANCELLED:\s*/, ""),
            observer
          );
          break;
        }
        if (!(error instanceof z.ZodError) && !(error instanceof ActionRejectedError)) throw error;
        run = this.#rejectAction(run, error, rawAction, observer);
      }
    }
    return toRunResult(run);
  }

  /**
   * Harness handler for the request_context control action. Validates the
   * requested refs against the manifest of refs published to the model last
   * turn (only refs the model actually saw, with matching digest), records a
   * context.rehydrate_requested audit event, and queues the accepted refs for
   * the next decision turn. The Run snapshot is never modified.
   */
  async #handleRequestContext(
    run: RunSnapshot,
    action: RequestContextAction,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    signal.throwIfAborted();
    // Every requested ref is queued; the next decision turn resolves each one
    // against that turn's manifest (ref already published + digest matches) and
    // reports the outcome back in rehydratedFacts. Refs that were never
    // published, belong to another Run, or drifted resolve to REF_UNAVAILABLE
    // without disclosing whether the object exists.
    const requestId = this.#createId();
    const publishedMemoryDigests = this.#publishedMemoryDigests.get(run.runId) ?? {};
    const memoryDigests = Object.fromEntries(action.refs.flatMap((ref) => (
      publishedMemoryDigests[ref] === undefined ? [] : [[ref, publishedMemoryDigests[ref]]]
    )));
    this.#store.recordRunEvent({
      runId: run.runId,
      event: {
        type: "context.rehydrate_requested",
        occurredAt: this.#now(),
        payload: { requestId, refs: action.refs, memoryDigests }
      },
      fencingToken: this.#leases.requireFencingToken(run.runId)
    });
    this.#notify(run.runId, observer);
    this.#rehydrationRequests.set(run.runId, { requestId, refs: action.refs, memoryDigests });
    return run;
  }

  #completeRehydrationRequest(
    runId: string,
    requestId: string,
    refs: readonly string[],
    observer?: RuntimeObserver
  ): void {
    this.#store.recordRunEvent({
      runId,
      event: {
        type: "context.rehydrated",
        occurredAt: this.#now(),
        payload: { requestId, refs }
      },
      fencingToken: this.#leases.requireFencingToken(runId)
    });
    this.#rehydrationRequests.delete(runId);
    this.#notify(runId, observer);
  }

  /**
   * Rebuilds transient rehydration requests from the audit event stream on
   * resume: a context.rehydrate_requested event without a matching
   * context.rehydrated event was never consumed, so its accepted refs are
   * queued for the next decision turn. No authority table is involved.
   */
  #rebuildRehydrationRequests(runId: string): void {
    const events = this.#store.listEvents(runId);
    const fulfilled = new Set<string>();
    for (const event of events) {
      if (event.type !== "context.rehydrated") continue;
      const requestId = event.payload.requestId;
      if (typeof requestId === "string") fulfilled.add(requestId);
    }
    for (const event of events) {
      if (event.type !== "context.rehydrate_requested") continue;
      const requestId = event.payload.requestId;
      if (typeof requestId !== "string" || fulfilled.has(requestId)) continue;
      const refs = Array.isArray(event.payload.refs)
        ? event.payload.refs.filter((item): item is string => typeof item === "string")
        : [];
      const memoryDigests = event.payload.memoryDigests !== null
        && typeof event.payload.memoryDigests === "object"
        && !Array.isArray(event.payload.memoryDigests)
        ? Object.fromEntries(Object.entries(event.payload.memoryDigests).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          ))
        : {};
      if (refs.length > 0) {
        this.#rehydrationRequests.set(runId, { requestId, refs, memoryDigests });
      }
    }
  }

  async #handleAction(
    run: RunSnapshot,
    action: RuntimeAction,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    if (!allowedActions(run).includes(action.type)) {
      throw new ActionRejectedError(`${action.type} is not allowed in the current Run state.`);
    }
    if (action.type === "set_plan") return this.#setPlan(run, action, observer);
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
      return callTool(this.#services(signal, run.runId), run, action, observer);
    }
    return proposeFinish(this.#services(signal, run.runId), run, action, observer);
  }

  /**
   * Harness-level orchestration action: the model proposes, in one Decision,
   * multiple Tool Actions that are already determinable within the active Step.
   * The whole batch is pre-validated (so a malformed batch never partially
   * executes), then executed serially through the existing callTool chain —
   * each sub-action keeps full approval / Evidence / sourceRefs / persistence /
   * recovery authority. Execution stops at the first Tool failure, the first
   * action requiring approval, or once the Step completes; dropped actions are
   * not executed and the next Decision re-decides on the latest facts.
   */
  async #handleExecuteStep(
    run: RunSnapshot,
    action: Extract<RuntimeAction, { type: "execute_step" }>,
    signal: AbortSignal,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    signal.throwIfAborted();
    const services = this.#services(signal, run.runId);
    const plan = run.currentPlan;
    if (plan === null) throw new ActionRejectedError("A Tool cannot run without a Plan.");
    const active = run.stepProgress.find((item) => item.status === "active");
    if (active === undefined || active.stepId !== action.stepId) {
      throw new ActionRejectedError("execute_step does not target the active Step.");
    }
    const step = plan.orderedSteps.find((item) => item.id === action.stepId);
    if (step === undefined) throw new ActionRejectedError("Active Step is missing from the Plan.");

    // Pre-flight: validate every sub-action so a malformed batch is rejected as
    // a whole (repair budget) before any sub-action executes.
    const seenIdempotency = new Set<string>();
    for (const sub of action.actions) {
      if (sub.stepId !== action.stepId) {
        throw new ActionRejectedError("execute_step sub-action does not target the active Step.");
      }
      const checks = sub.checkIds.map((id) => step.acceptanceChecks.find((check) => check.id === id));
      if (checks.some((check) => check === undefined)) {
        throw new ActionRejectedError("execute_step sub-action references an unknown Acceptance Check.");
      }
      if (checks.some((check) => check?.kind !== "tool_result" || check.toolName !== sub.toolName)) {
        throw new ActionRejectedError("execute_step sub-action is not bound to a matching Tool Result Check.");
      }
      const tool = this.#tools.get(sub.toolName);
      if (tool === undefined) throw new ActionRejectedError(`Tool is not registered: ${sub.toolName}`);
      const parsedInput = JsonValueSchema.parse(tool.contract.execution.inputSchema.parse(sub.input));
      const key = `${run.runId}:${plan.version}:${step.id}:${tool.contract.identity.name}:${digestJson(parsedInput)}`;
      if (seenIdempotency.has(key)) {
        throw new ActionRejectedError("execute_step contains duplicate Tool Invocations.");
      }
      seenIdempotency.add(key);
      if (this.#store.listToolInvocations(run.runId).some((item) => item.idempotencyKey === key)) {
        throw new ActionRejectedError("execute_step duplicates an existing persisted Invocation.");
      }
    }
    if (run.budgetsUsed.toolCalls + action.actions.length > run.budgets.maxToolCalls) {
      throw new ActionRejectedError("execute_step exceeds the remaining Tool-call budget.");
    }

    // Serial execution with fail-fast: at most one in-flight invocation at any
    // time (keeps Recovery's exactly-one unresolved invocation invariant), and
    // the batch stops at the first Tool failure, approval, or Step completion.
    let current = run;
    let executed = 0;
    let stoppedReason: "completed" | "step_completed" | "approval_required" | "tool_failed" | "run_status_changed" = "completed";
    for (const sub of action.actions) {
      if (current.status !== "running") {
        stoppedReason = current.status === "waiting" ? "approval_required" : "run_status_changed";
        break;
      }
      if (current.lastError !== null) {
        stoppedReason = "tool_failed";
        break;
      }
      const nowActive = current.stepProgress.find((item) => item.status === "active")?.stepId;
      if (nowActive !== action.stepId) {
        stoppedReason = "step_completed";
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
    } else if (
      executed < action.actions.length
      && current.stepProgress.find((item) => item.status === "active")?.stepId !== action.stepId
    ) {
      stoppedReason = "step_completed";
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
      if (action.taskContract !== undefined) contract = this.#deriveTaskContract(run, action.taskContract);
      if (action.taskContract === undefined && JSON.stringify(action.orderedSteps) === JSON.stringify(current.orderedSteps)) {
        throw new ActionRejectedError("Plan is unchanged; execute the active Step instead.");
      }
      assertCompletedStepsUnchanged(run, action.orderedSteps);
    }
    if (contract === null) throw new ActionRejectedError("Task Contract is missing.");

    const version = current === null ? 1 : current.version + 1;
    const plan = StructuredPlanSchema.parse({
      version,
      basedOnVersion: action.basedOnVersion,
      goalDigest: digestTaskContract(contract),
      orderedSteps: action.orderedSteps
    });
    const completed = new Map(run.stepProgress.filter((item) => item.status === "completed").map((item) => [item.stepId, item]));
    const completedStepIds = new Set(completed.keys());
    const evidence = current === null ? [] : run.evidence.filter((item) => completedStepIds.has(item.stepId));
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
    return this.#commit(run, next, "plan.set", { version, basedOnVersion: action.basedOnVersion }, observer);
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

  #rejectAction(run: RunSnapshot, error: z.ZodError | ActionRejectedError, rawAction: unknown, observer?: RuntimeObserver): RunSnapshot {
    const retries = run.budgetsUsed.retries + 1;
    const diagnostic = actionRejectionDiagnostic(error, rawAction);
    const message = JSON.stringify(diagnostic);
    const detailsArtifact = new ArtifactStore(this.#artifactDir).putText(serializeRejectedAction(rawAction), "application/json").digest;
    if (retries > run.budgets.maxRetries) {
      return this.#fail({
        ...run,
        budgetsUsed: { ...run.budgetsUsed, retries },
        lastError: { code: "INVALID_MODEL_ACTION", message, retryable: false, detailsArtifact }
      }, "ACTION_REPAIR_EXHAUSTED", "INVALID_MODEL_ACTION", observer);
    }
    const next = RunSnapshotSchema.parse({
      ...run,
      budgetsUsed: { ...run.budgetsUsed, retries },
      lastError: { code: "INVALID_MODEL_ACTION", message, retryable: true, detailsArtifact },
      updatedAt: this.#now()
    });
    return this.#commit(run, next, "action.rejected", { message, diagnostic, detailsArtifact }, observer);
  }

  #fail(run: RunSnapshot, stopReason: string, errorCode: string, observer?: RuntimeObserver): RunSnapshot {
    const failedInput = RunSnapshotSchema.parse({
      ...run,
      lastError: run.lastError ?? { code: errorCode, message: stopReason, retryable: false, detailsArtifact: null }
    });
    const failed = transitionRunStatus(failedInput, "failed", { now: this.#now(), stopReason });
    return this.#commit(run, failed, "run.failed", { stopReason, errorCode }, observer);
  }

  #blockForProvider(run: RunSnapshot, error: unknown, observer?: RuntimeObserver): RunSnapshot {
    const blockedInput = RunSnapshotSchema.parse({
      ...run,
      lastError: { code: "PROVIDER_UNAVAILABLE", message: errorMessage(error), retryable: true, detailsArtifact: null }
    });
    const blocked = transitionRunStatus(blockedInput, "blocked", { now: this.#now(), stopReason: "PROVIDER_UNAVAILABLE" });
    return this.#commit(run, blocked, "run.blocked", { stopReason: "PROVIDER_UNAVAILABLE" }, observer);
  }

  #budgetFailure(run: RunSnapshot, activeStartedAt: number): string | null {
    if (run.budgetsUsed.iterations >= run.budgets.maxIterations) return "ITERATION_BUDGET_EXCEEDED";
    if (run.budgetsUsed.modelCalls >= run.budgets.maxModelCalls) return "MODEL_CALL_BUDGET_EXCEEDED";
    if (run.budgetsUsed.toolCalls >= run.budgets.maxToolCalls) return "TOOL_CALL_BUDGET_EXCEEDED";
    if (Date.parse(this.#now()) - activeStartedAt >= run.budgets.maxDurationMs) return "DURATION_BUDGET_EXCEEDED";
    return null;
  }

  #services(signal: AbortSignal, runId?: string): RuntimeServices {
    return {
      workspace: this.#workspaceFor(runId),
      provider: this.#provider,
      tools: this.#tools,
      store: this.#store,
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
      now: () => this.#now(),
      createId: () => this.#createId(),
      signal,
      fencingToken: (runId) => this.#leases.requireFencingToken(runId),
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
      requestModel: (run, phase, context, eventPayload, observer, countIteration) => (
          requestModel(
            {
              provider: this.#provider,
              store: this.#store,
              workspace: this.#workspaceFor(run.runId),
              tools: this.#tools,
              artifactDir: this.#artifactDir,
              now: () => this.#now(),
              createId: () => this.#createId(),
              requireFencingToken: (runId) => this.#leases.requireFencingToken(runId),
              withLeaseHeartbeat: (runId, op) => this.#leases.withHeartbeat(runId, op),
              notify: (runId, obs) => this.#notify(runId, obs),
              forkContext: this.#forkContextFor(run.runId),
              ...(this.#memory === undefined ? {} : { memory: this.#memory })
            },
          run,
          phase,
          context,
          eventPayload,
          signal,
          observer,
          countIteration
        )
      ),
      commit: (previous, next, type, payload, observer) => (
        this.#commit(previous, next, type, payload, observer)
      ),
      fail: (run, stopReason, errorCode, observer) => (
        this.#fail(run, stopReason, errorCode, observer)
      ),
      blockForProvider: (run, error, observer) => (
        this.#blockForProvider(run, error, observer)
      )
    };
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
  async fork(runId: string, _options: ForkOptions = {}): Promise<BranchHandle | null> {
    this.#assertOpen();
    return this.#forkRun(runId, undefined);
  }

  listBranches(runId: string): BranchRecord[] {
    this.#assertOpen();
    return this.#store.listBranches(runId);
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
      this.#store.getLastEvent(child.runId)?.sequence ?? 0
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
    observer?: RuntimeObserver
  ): Promise<BranchHandle | null> {
    const parent = this.#requireRun(runId);
    let handle: BranchHandle | null = null;
    await this.#withControlLease(runId, async () => {
      this.#assertControlIdle(runId);
      handle = this.#forkParentRun(parent, observer);
    });
    return handle;
  }

  #forkParentRun(
    parent: RunSnapshot,
    observer?: RuntimeObserver
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
    const redirectedContract = child.taskContract === null
      ? null
      : { ...child.taskContract, workspace: snapshot!.root };
    const childWithBranchWorkspace = RunSnapshotSchema.parse({
      ...child,
      taskContract: redirectedContract,
      currentPlan: child.currentPlan === null
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
      forkEventSequence
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
        payload: { branchId, childRunId, forkRevision: parent.revision }
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
        type: "branch.created",
        occurredAt: now,
        payload: { branchId, childRunId, forkRevision: parent.revision }
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

export function createRuntime(options: CreateRuntimeOptions): RuntimeEngine {
  return new RuntimeEngine(options);
}
