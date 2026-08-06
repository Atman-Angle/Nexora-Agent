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
  type RunSnapshot,
  type RuntimeAction,
  type ToolInvocation
} from "./contracts.js";
import { ArtifactStore } from "./store/artifacts.js";
import {
  requestModel
} from "./context/request-model.js";
import {
  buildDecisionContext
} from "./context/decision-context.js";
import type {
  RuntimeProvider
} from "./providers/model-client.js";
import {
  resolveProviderModelProfile
} from "./context/budget.js";
import { openRunStore, type RunStore } from "./store/run-store.js";
import { transitionRunStatus } from "./state-machine.js";
import { digestTaskContract, proposeFinish } from "./validation.js";
import {
  ActionRejectedError,
  allowedActions,
  assertCompletedStepsUnchanged,
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
  CreateRuntimeOptions,
  ResumeInput,
  RunResult,
  RunFinalResult,
  RunHandle,
  RunHandleResumeOptions,
  RunInspection,
  RunOptions,
  RunView,
  RuntimeObserver,
  RuntimeEventListener,
  RuntimeSubscription,
  SubscribeOptions,
  RequestOptions,
  DenialOptions,
  RuntimeServices,
  RuntimeTool,
  StartInput
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

export type {
  ApprovalDecision,
  CreateRuntimeOptions,
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
  readonly #provider: RuntimeProvider;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #store: RunStore;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #artifactDir: string;
  readonly #leases = new Map<string, number>();
  readonly #activeExecutions = new Map<string, Promise<RunResult>>();
  readonly #executionControllers = new Map<string, AbortController>();
  readonly #subscriptions = new Map<
    string,
    Set<ManagedRuntimeSubscription>
  >();
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
      this.#provider = options.provider;
      resolveProviderModelProfile(options.provider);
      this.#now = now;
      this.#createId = createId;
      this.#ownerId = createId();
      this.#leaseTtlMs = leaseTtlMs;
      this.#tools = tools;
      this.#artifactDir = join(dataDir, "artifacts");
      this.#store = openRunStore({
        databasePath: join(dataDir, "runtime-v1.1.db")
      });
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
    this.#acquireLease(run.runId);
    try {
      run = await recoverToolInvocation(
        this.#services(controller.signal),
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
              this.#services(controller.signal),
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
      return await this.#runLoop(run, controller.signal, observer);
    } finally {
      this.#releaseLease(run.runId);
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
    this.#acquireLease(created.runId);
    try {
      return await this.#runLoop(created, controller.signal, observer);
    } finally {
      this.#releaseLease(created.runId);
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
      this.#acquireLease(runId);
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
      this.#releaseLease(runId);
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
      this.#acquireLease(runId);
    } catch (error) {
      throw this.#mapControlBoundaryError(error, runId);
    }
    try {
      await operation();
    } finally {
      this.#releaseLease(runId);
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

      const modelCall = await requestModel(
        {
          provider: this.#provider,
          store: this.#store,
          workspace: this.#workspace,
          tools: this.#tools,
          artifactDir: this.#artifactDir,
          now: () => this.#now(),
          createId: () => this.#createId(),
          requireFencingToken: (runId) => this.#requireFencingToken(runId),
          withLeaseHeartbeat: (runId, op) => this.#withLeaseHeartbeat(runId, op),
          notify: (runId, obs) => this.#notify(runId, obs)
        },
        run,
        "decision",
        buildDecisionContext({
          run,
          store: this.#store,
          workspace: this.#workspace,
          tools: this.#tools,
          artifactDir: this.#artifactDir
        }),
        { allowedActions: allowedActions(run) },
        signal,
        observer,
        true
      );
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
      return callTool(this.#services(signal), run, action, observer);
    }
    return proposeFinish(this.#services(signal), run, action, observer);
  }

  #setPlan(run: RunSnapshot, action: Extract<RuntimeAction, { type: "set_plan" }>, observer?: RuntimeObserver): RunSnapshot {
    const current = run.currentPlan;
    let contract = run.taskContract;
    if (current === null) {
      if (action.basedOnVersion !== null) throw new ActionRejectedError("The first Plan must be based on null.");
      if (action.taskContract === undefined) throw new ActionRejectedError("The first Plan requires a Task Contract.");
      contract = TaskContractSchema.parse(action.taskContract);
    } else {
      if (action.basedOnVersion !== current.version) throw new ActionRejectedError("Plan revision conflict.");
      const hasNewInput = contract !== null && contract.inputVersion < run.inputHistory.length;
      if (hasNewInput && action.taskContract === undefined) throw new ActionRejectedError("New user input requires an updated Task Contract.");
      if (!hasNewInput && action.taskContract !== undefined) throw new ActionRejectedError("Task Contract cannot change without new user input.");
      if (action.taskContract !== undefined) contract = TaskContractSchema.parse(action.taskContract);
      assertCompletedStepsUnchanged(run, action.orderedSteps);
    }
    if (contract === null) throw new ActionRejectedError("Task Contract is missing.");
    if (contract.workspace !== this.#workspace) throw new ActionRejectedError("Task Contract workspace does not match Runtime workspace.");
    if (contract.inputVersion !== run.inputHistory.length) throw new ActionRejectedError("Task Contract does not cover the complete input history.");

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

  #services(signal: AbortSignal): RuntimeServices {
    return {
      workspace: this.#workspace,
      provider: this.#provider,
      tools: this.#tools,
      store: this.#store,
      now: () => this.#now(),
      createId: () => this.#createId(),
      signal,
      fencingToken: (runId) => this.#requireFencingToken(runId),
      notify: (runId, observer) => this.#notify(runId, observer),
      withHeartbeat: (runId, operation) => (
        this.#withLeaseHeartbeat(runId, operation)
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
            workspace: this.#workspace,
            tools: this.#tools,
            artifactDir: this.#artifactDir,
            now: () => this.#now(),
            createId: () => this.#createId(),
            requireFencingToken: (runId) => this.#requireFencingToken(runId),
            withLeaseHeartbeat: (runId, op) => this.#withLeaseHeartbeat(runId, op),
            notify: (runId, obs) => this.#notify(runId, obs)
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
      fencingToken: this.#requireFencingToken(previous.runId),
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

  #acquireLease(runId: string): void {
    const lease = this.#store.acquireLease({
      runId,
      ownerId: this.#ownerId,
      now: this.#now(),
      ttlMs: this.#leaseTtlMs
    });
    this.#leases.set(runId, lease.fencingToken);
  }

  #releaseLease(runId: string): void {
    const fencingToken = this.#leases.get(runId);
    if (fencingToken === undefined) return;
    this.#store.releaseLease({ runId, ownerId: this.#ownerId, fencingToken });
    this.#leases.delete(runId);
  }

  #requireFencingToken(runId: string): number {
    const token = this.#leases.get(runId);
    if (token === undefined) throw new Error(`RUN_LEASE_MISSING: ${runId}`);
    return token;
  }

  async #withLeaseHeartbeat<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const fencingToken = this.#requireFencingToken(runId);
    this.#store.renewLease({
      runId,
      ownerId: this.#ownerId,
      fencingToken,
      now: this.#now(),
      ttlMs: this.#leaseTtlMs
    });
    let leaseError: unknown = null;
    const interval = setInterval(() => {
      if (leaseError !== null) return;
      try {
        this.#store.renewLease({
          runId,
          ownerId: this.#ownerId,
          fencingToken,
          now: this.#now(),
          ttlMs: this.#leaseTtlMs
        });
      } catch (error) {
        leaseError = error;
      }
    }, Math.max(10, Math.floor(this.#leaseTtlMs / 3)));
    try {
      const result = await operation();
      if (leaseError !== null) throw leaseError;
      return result;
    } finally {
      clearInterval(interval);
    }
  }
}

export function createRuntime(options: CreateRuntimeOptions): RuntimeEngine {
  return new RuntimeEngine(options);
}
