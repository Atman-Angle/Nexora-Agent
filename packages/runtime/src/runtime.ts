import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
  type Evidence,
  type RunEvent,
  type RunSnapshot,
  type RunStatus,
  type RuntimeAction,
  type RuntimeBudgets,
  type ToolInvocation
} from "./contracts.js";
import {
  SemanticValidationVerdictSchema,
  type ModelDecisionContext,
  type RuntimeProvider
} from "./model-client.js";
import { openRunStore, type RunStore } from "./run-store.js";
import { transitionRunStatus } from "./state-machine.js";
import { digestTaskContract, validateCompletion } from "./validation.js";

const ToolResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    subjectRef: z.string().trim().min(1),
    output: JsonValueSchema
  }).strict(),
  z.object({
    status: z.literal("failure"),
    subjectRef: z.string().trim().min(1),
    error: z.object({
      code: z.string().trim().min(1),
      message: z.string().trim().min(1),
      retryable: z.boolean()
    }).strict()
  }).strict()
]);
export type RuntimeToolResult = z.infer<typeof ToolResultSchema>;

export type RuntimeTool = {
  readonly name: string;
  readonly risk: "read" | "write" | "execute";
  readonly idempotent: boolean;
  readonly inputSchema: z.ZodType<unknown>;
  execute(input: unknown, context: { readonly workspace: string; readonly runId: string; readonly invocationId: string }): Promise<RuntimeToolResult>;
};

export type CreateRuntimeOptions = {
  readonly workspace: string;
  readonly dataDir?: string;
  readonly provider: RuntimeProvider;
  readonly tools: readonly RuntimeTool[];
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly leaseTtlMs?: number;
};

export type StartInput = { readonly input: string; readonly budgets?: RuntimeBudgets };
export type ApprovalDecision = { readonly requestId: string; readonly approved: boolean; readonly reason?: string };
export type RecoveryDecision =
  | { readonly invocationId: string; readonly outcome: "confirmed_succeeded"; readonly subjectRef: string }
  | { readonly invocationId: string; readonly outcome: "confirmed_failed"; readonly reason?: string }
  | { readonly invocationId: string; readonly outcome: "abandon_run"; readonly reason?: string };
export type ResumeInput = {
  readonly runId: string;
  readonly input?: string;
  readonly approvalDecision?: ApprovalDecision;
  readonly recoveryDecision?: RecoveryDecision;
};
export type RuntimeObserver = (event: RunEvent) => void;

export type RunResult = {
  readonly runId: string;
  readonly status: RunStatus;
  readonly stopReason: string | null;
  readonly resultArtifact: string | null;
  readonly evidence: readonly Evidence[];
  readonly lastError: RunSnapshot["lastError"];
};

export type RunView = {
  readonly snapshot: RunSnapshot;
  readonly events: readonly RunEvent[];
  readonly toolInvocations: readonly ToolInvocation[];
};

class ActionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionRejectedError";
  }
}

export class RuntimeEngine {
  readonly #workspace: string;
  readonly #provider: RuntimeProvider;
  readonly #tools: Map<string, RuntimeTool>;
  readonly #store: RunStore;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #leases = new Map<string, number>();
  #closed = false;

  constructor(options: CreateRuntimeOptions) {
    this.#workspace = requireWorkspace(options.workspace);
    this.#provider = options.provider;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
    this.#ownerId = this.#createId();
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.#tools = new Map();
    for (const tool of options.tools) {
      if (this.#tools.has(tool.name)) throw new Error(`Duplicate Runtime Tool: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
    const dataDir = resolve(options.dataDir ?? join(this.#workspace, ".nexora"));
    this.#store = openRunStore({ databasePath: join(dataDir, "runtime-v1.1.db") });
  }

  async start(input: StartInput, observer?: RuntimeObserver): Promise<RunResult> {
    this.#assertOpen();
    const budgets = input.budgets === undefined ? undefined : RuntimeBudgetsSchema.parse(input.budgets);
    const now = this.#now();
    const snapshot = createInitialRunSnapshot({
      runId: this.#createId(),
      input: input.input,
      workspace: this.#workspace,
      now,
      ...(budgets === undefined ? {} : { budgets })
    });
    const created = this.#store.createRun(snapshot, { type: "run.created", occurredAt: now, payload: { inputSequence: 1 } });
    this.#notify(created.runId, observer);
    this.#acquireLease(created.runId);
    try {
      return await this.#runLoop(created, observer);
    } finally {
      this.#releaseLease(created.runId);
    }
  }

  async resume(input: ResumeInput, observer?: RuntimeObserver): Promise<RunResult> {
    this.#assertOpen();
    let run = this.#requireRun(input.runId);
    if (run.status === "failed" || run.status === "succeeded") return toRunResult(run);
    this.#acquireLease(run.runId);
    try {
      run = await this.#recoverToolInvocation(run, input.recoveryDecision, observer);
      if (run.status === "failed") return toRunResult(run);
      if (run.status === "blocked") return toRunResult(run);
      if (run.status === "waiting") {
        if (run.pendingRequest?.kind === "input") {
          if (input.input === undefined) return toRunResult(run);
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
          run = this.#commit(run, resumed, "run.resumed", { inputSequence: resumed.inputHistory.length }, observer);
        } else if (run.pendingRequest?.kind === "approval") {
          const decision = input.approvalDecision;
          if (decision === undefined || decision.requestId !== run.pendingRequest.id) {
            throw new Error("Approval decision does not match the pending Approval Request.");
          }
          const pendingAction = RuntimeActionSchema.parse(run.pendingRequest.action);
          if (pendingAction.type !== "call_tool") throw new Error("Pending Approval does not contain a Tool action.");
          const resumed = transitionRunStatus(run, "running", { now: this.#now() });
          run = this.#commit(run, resumed, decision.approved ? "approval.granted" : "approval.denied", {
            requestId: decision.requestId,
            ...(decision.reason === undefined ? {} : { reason: decision.reason })
          }, observer);
          if (decision.approved) run = await this.#callTool(run, pendingAction, observer, true);
          else run = RunSnapshotSchema.parse({
            ...run,
            lastError: {
              code: "APPROVAL_DENIED",
              message: decision.reason?.trim() || "The user denied the protected Tool action.",
              retryable: true,
              detailsArtifact: null
            }
          });
        }
      }
      if (run.status !== "running") return toRunResult(run);
      return await this.#runLoop(run, observer);
    } finally {
      this.#releaseLease(run.runId);
    }
  }

  async inspect(runId: string): Promise<RunView> {
    this.#assertOpen();
    return {
      snapshot: this.#requireRun(runId),
      events: this.#store.listEvents(runId),
      toolInvocations: this.#store.listToolInvocations(runId)
    };
  }

  async #recoverToolInvocation(
    runInput: RunSnapshot,
    decision: RecoveryDecision | undefined,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    const unresolved = this.#store.listToolInvocations(runInput.runId)
      .filter((item) => item.status === "started" || item.status === "unknown");
    if (unresolved.length === 0) {
      if (decision !== undefined) throw new Error("Recovery Decision has no matching unknown Tool invocation.");
      return runInput;
    }
    if (unresolved.length !== 1) throw new Error("Recovery requires exactly one unresolved Tool invocation.");
    const invocation = unresolved[0]!;

    if (invocation.status === "unknown") {
      if (decision === undefined) return runInput;
      if (decision.invocationId !== invocation.id) {
        throw new Error("Recovery Decision does not match the unknown Tool invocation.");
      }
      return this.#applyRecoveryDecision(runInput, invocation, decision, observer);
    }
    if (decision !== undefined) {
      throw new Error("Recovery Decision is only valid after a Tool invocation is marked unknown.");
    }

    if (!invocation.idempotent) {
      const now = this.#now();
      const blockedInput = RunSnapshotSchema.parse({
        ...runInput,
        lastError: {
          code: "TOOL_RESULT_UNKNOWN",
          message: `The result of non-idempotent Tool invocation ${invocation.id} is unknown.`,
          retryable: false,
          detailsArtifact: null
        }
      });
      const blocked = runInput.status === "blocked"
        ? RunSnapshotSchema.parse({ ...blockedInput, stopReason: "TOOL_RESULT_UNKNOWN", updatedAt: now })
        : transitionRunStatus(blockedInput, "blocked", { now, stopReason: "TOOL_RESULT_UNKNOWN" });
      const committed = this.#store.markToolInvocationUnknownAndCommitRun({
        invocationId: invocation.id,
        previous: runInput,
        next: blocked,
        fencingToken: this.#requireFencingToken(runInput.runId),
        event: { type: "tool.result_unknown", occurredAt: now, payload: { invocationId: invocation.id } }
      });
      this.#notify(runInput.runId, observer);
      return committed.run;
    }

    const tool = this.#tools.get(invocation.toolName);
    if (tool === undefined || !tool.idempotent) {
      throw new Error(`Recovery Tool is unavailable or no longer idempotent: ${invocation.toolName}`);
    }
    const parsedInput = tool.inputSchema.parse(invocation.inputJson);
    const now = this.#now();
    const running = runInput.status === "blocked"
      ? transitionRunStatus(runInput, "running", { now })
      : RunSnapshotSchema.parse({ ...runInput, updatedAt: now });
    const claimed = this.#store.claimToolInvocationAndCommitRun({
      invocationId: invocation.id,
      previous: runInput,
      next: running,
      fencingToken: this.#requireFencingToken(runInput.runId),
      event: { type: "tool.retried", occurredAt: now, payload: { invocationId: invocation.id } }
    });
    this.#notify(runInput.runId, observer);
    return this.#executeToolInvocation(claimed.run, claimed.invocation, tool, parsedInput, observer);
  }

  #applyRecoveryDecision(
    runInput: RunSnapshot,
    invocation: ToolInvocation,
    decision: RecoveryDecision,
    observer?: RuntimeObserver
  ): RunSnapshot {
    const now = this.#now();
    if (decision.outcome === "confirmed_succeeded") {
      if (!decision.subjectRef.trim()) throw new Error("Recovery confirmation requires a subject reference.");
      if (runInput.currentPlan === null) throw new Error("Recovery confirmation requires the persisted Plan.");
      const evidence: Evidence[] = invocation.checkIds.map((checkId) => ({
        id: this.#createId(),
        kind: "user_confirmation",
        source: "user",
        producedAt: now,
        planVersion: invocation.planVersion,
        stepId: invocation.stepId,
        checkId,
        subjectRef: decision.subjectRef,
        invocationId: invocation.id,
        artifactRef: null,
        digest: digestJson({ invocationId: invocation.id, outcome: decision.outcome, subjectRef: decision.subjectRef })
      }));
      const allEvidence = [...runInput.evidence, ...evidence];
      const running = transitionRunStatus({
        ...runInput,
        evidence: allEvidence,
        stepProgress: completeSatisfiedSteps(runInput.currentPlan, runInput.stepProgress, allEvidence),
        lastError: null
      }, "running", { now });
      const committed = this.#store.resolveUnknownToolInvocationAndCommitRun({
        invocationId: invocation.id,
        status: "succeeded",
        resolution: { outcome: decision.outcome, subjectRef: decision.subjectRef },
        previous: runInput,
        next: running,
        fencingToken: this.#requireFencingToken(runInput.runId),
        event: { type: "recovery.confirmed_succeeded", occurredAt: now, payload: { invocationId: invocation.id, evidenceIds: evidence.map((item) => item.id) } }
      });
      this.#notify(runInput.runId, observer);
      return committed.run;
    }

    const reason = decision.reason?.trim() || (decision.outcome === "confirmed_failed"
      ? "The user confirmed that the Tool invocation failed."
      : "The user abandoned the Run because the Tool result is unknown.");
    const base = RunSnapshotSchema.parse({
      ...runInput,
      lastError: { code: decision.outcome === "confirmed_failed" ? "TOOL_CONFIRMED_FAILED" : "RUN_ABANDONED", message: reason, retryable: false, detailsArtifact: null }
    });
    const next = decision.outcome === "abandon_run"
      ? transitionRunStatus(base, "failed", { now, stopReason: "RUN_ABANDONED" })
      : transitionRunStatus(base, "running", { now });
    const committed = this.#store.resolveUnknownToolInvocationAndCommitRun({
      invocationId: invocation.id,
      status: "failed",
      resolution: { outcome: decision.outcome, reason },
      previous: runInput,
      next,
      fencingToken: this.#requireFencingToken(runInput.runId),
      event: { type: decision.outcome === "abandon_run" ? "recovery.abandoned" : "recovery.confirmed_failed", occurredAt: now, payload: { invocationId: invocation.id, reason } }
    });
    this.#notify(runInput.runId, observer);
    return committed.run;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  async #runLoop(initial: RunSnapshot, observer?: RuntimeObserver): Promise<RunResult> {
    let run = initial;
    while (run.status === "running") {
      const budgetFailure = this.#budgetFailure(run);
      if (budgetFailure !== null) {
        run = this.#fail(run, budgetFailure, budgetFailure, observer);
        break;
      }

      run = this.#commit(run, {
        ...run,
        budgetsUsed: {
          ...run.budgetsUsed,
          iterations: run.budgetsUsed.iterations + 1,
          modelCalls: run.budgetsUsed.modelCalls + 1
        },
        updatedAt: this.#now()
      }, "model.requested", { allowedActions: allowedActions(run) }, observer);

      let rawAction: unknown;
      try {
        rawAction = await this.#withLeaseHeartbeat(run.runId, () => this.#provider.decide(this.#decisionContext(run)));
      } catch (error) {
        run = this.#blockForProvider(run, error, observer);
        break;
      }

      let action: RuntimeAction;
      try {
        action = RuntimeActionSchema.parse(rawAction);
        run = await this.#handleAction(run, action, observer);
      } catch (error) {
        if (!(error instanceof z.ZodError) && !(error instanceof ActionRejectedError)) throw error;
        run = this.#rejectAction(run, error, observer);
      }
    }
    return toRunResult(run);
  }

  async #handleAction(run: RunSnapshot, action: RuntimeAction, observer?: RuntimeObserver): Promise<RunSnapshot> {
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
      return this.#commit(run, waiting, "run.waiting", { reason: action.reason, requestId: waiting.pendingRequest?.id ?? null }, observer);
    }
    if (action.type === "call_tool") return this.#callTool(run, action, observer);
    return this.#proposeFinish(run, action, observer);
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

  async #callTool(
    runInput: RunSnapshot,
    action: Extract<RuntimeAction, { type: "call_tool" }>,
    observer?: RuntimeObserver,
    approved = false
  ): Promise<RunSnapshot> {
    const plan = runInput.currentPlan;
    if (plan === null) throw new ActionRejectedError("A Tool cannot run without a Plan.");
    const active = runInput.stepProgress.find((item) => item.status === "active");
    if (active === undefined || active.stepId !== action.stepId) throw new ActionRejectedError("Tool action does not target the active Step.");
    const step = plan.orderedSteps.find((item) => item.id === action.stepId);
    if (step === undefined) throw new ActionRejectedError("Active Step is missing from the Plan.");
    const checks = action.checkIds.map((id) => step.acceptanceChecks.find((item) => item.id === id));
    if (checks.some((check) => check === undefined)) throw new ActionRejectedError("Tool action references an unknown Acceptance Check.");
    if (checks.some((check) => check?.kind !== "tool_result" || check.toolName !== action.toolName)) {
      throw new ActionRejectedError("Tool action is not bound to a matching Tool Result Check.");
    }
    const tool = this.#tools.get(action.toolName);
    if (tool === undefined) throw new ActionRejectedError(`Tool is not registered: ${action.toolName}`);
    if (tool.risk !== "read" && !approved) {
      const now = this.#now();
      const waiting = transitionRunStatus(runInput, "waiting", {
        now,
        stopReason: "APPROVAL_REQUIRED",
        pendingRequest: {
          id: this.#createId(),
          kind: "approval",
          prompt: `Allow ${tool.name} for Step ${step.id}?`,
          createdAt: now,
          action
        }
      });
      return this.#commit(runInput, waiting, "approval.requested", {
        requestId: waiting.pendingRequest?.id ?? null,
        toolName: tool.name,
        stepId: step.id
      }, observer);
    }
    const parsedInput = tool.inputSchema.parse(action.input);
    const invocationId = this.#createId();
    const startedAt = this.#now();
    const started = this.#store.beginToolInvocationAndCommitRun({
      intent: {
        id: invocationId,
        runId: runInput.runId,
        planVersion: plan.version,
        stepId: step.id,
        checkIds: action.checkIds,
        toolName: tool.name,
        inputJson: parsedInput,
        inputDigest: digestJson(parsedInput),
        idempotencyKey: `${runInput.runId}:${plan.version}:${step.id}:${tool.name}:${digestJson(parsedInput)}`,
        idempotent: tool.idempotent,
        fencingToken: this.#requireFencingToken(runInput.runId),
        startedAt
      },
      previous: runInput,
      next: {
      ...runInput,
      budgetsUsed: { ...runInput.budgetsUsed, toolCalls: runInput.budgetsUsed.toolCalls + 1 },
      updatedAt: startedAt
      },
      fencingToken: this.#requireFencingToken(runInput.runId),
      event: { type: "tool.started", occurredAt: startedAt, payload: { invocationId, toolName: tool.name, stepId: step.id } }
    });
    this.#notify(runInput.runId, observer);
    return this.#executeToolInvocation(started.run, started.invocation, tool, parsedInput, observer);
  }

  async #executeToolInvocation(
    run: RunSnapshot,
    invocation: ToolInvocation,
    tool: RuntimeTool,
    parsedInput: unknown,
    observer?: RuntimeObserver
  ): Promise<RunSnapshot> {
    let result: RuntimeToolResult;
    try {
      result = ToolResultSchema.parse(await this.#withLeaseHeartbeat(run.runId, () => tool.execute(parsedInput, {
        workspace: this.#workspace,
        runId: run.runId,
        invocationId: invocation.id
      })));
    } catch (error) {
      result = {
        status: "failure",
        subjectRef: invocation.stepId,
        error: { code: "TOOL_EXECUTION_ERROR", message: errorMessage(error), retryable: false }
      };
    }
    const completedAt = this.#now();
    if (result.status === "failure") {
      const next = RunSnapshotSchema.parse({
        ...run,
        lastError: { ...result.error, detailsArtifact: null },
        updatedAt: completedAt
      });
      const completed = this.#store.completeToolInvocationAndCommitRun({
        invocationId: invocation.id,
        status: "failed",
        completedAt,
        fencingToken: this.#requireFencingToken(run.runId),
        errorJson: result.error,
        previous: run,
        next,
        event: { type: "tool.failed", occurredAt: completedAt, payload: { invocationId: invocation.id, error: result.error } }
      });
      this.#notify(run.runId, observer);
      return completed.run;
    }

    const outputDigest = digestJson(result.output);
    const newEvidence: Evidence[] = invocation.checkIds.map((checkId) => ({
      id: this.#createId(),
      kind: "tool_result",
      source: "tool",
      producedAt: completedAt,
      planVersion: invocation.planVersion,
      stepId: invocation.stepId,
      checkId,
      subjectRef: result.subjectRef,
      invocationId: invocation.id,
      artifactRef: null,
      digest: outputDigest
    }));
    const evidence = [...run.evidence, ...newEvidence];
    if (run.currentPlan === null) throw new Error("Recovered Tool invocation has no current Plan.");
    const stepProgress = completeSatisfiedSteps(run.currentPlan, run.stepProgress, evidence);
    const next = RunSnapshotSchema.parse({
      ...run,
      evidence,
      stepProgress,
      lastError: null,
      updatedAt: completedAt
    });
    const completed = this.#store.completeToolInvocationAndCommitRun({
      invocationId: invocation.id,
      status: "succeeded",
      completedAt,
      fencingToken: this.#requireFencingToken(run.runId),
      resultJson: result.output,
      previous: run,
      next,
      event: { type: "tool.succeeded", occurredAt: completedAt, payload: { invocationId: invocation.id, evidenceIds: newEvidence.map((item) => item.id) } }
    });
    this.#notify(run.runId, observer);
    return completed.run;
  }

  async #proposeFinish(runInput: RunSnapshot, action: Extract<RuntimeAction, { type: "propose_finish" }>, observer?: RuntimeObserver): Promise<RunSnapshot> {
    const unresolved = this.#store.listToolInvocations(runInput.runId).filter((item) => item.status === "started" || item.status === "unknown").length;
    const deterministic = validateCompletion(runInput, action.evidenceIds, unresolved);
    if (!deterministic.passed) {
      return this.#validationFailed(runInput, deterministic.issues, observer);
    }
    if (runInput.taskContract === null || runInput.currentPlan === null) {
      return this.#validationFailed(runInput, ["TASK_OR_PLAN_MISSING"], observer);
    }
    if (runInput.budgetsUsed.modelCalls >= runInput.budgets.maxModelCalls) {
      return this.#fail(runInput, "BUDGET_EXCEEDED", "MODEL_CALL_BUDGET_EXCEEDED", observer);
    }

    let run = this.#commit(runInput, {
      ...runInput,
      budgetsUsed: { ...runInput.budgetsUsed, modelCalls: runInput.budgetsUsed.modelCalls + 1 },
      updatedAt: this.#now()
    }, "validation.requested", { evidenceIds: deterministic.evidenceIds }, observer);
    let verdict: z.infer<typeof SemanticValidationVerdictSchema>;
    try {
      verdict = SemanticValidationVerdictSchema.parse(await this.#withLeaseHeartbeat(run.runId, () => this.#provider.validate({
        originalInput: run.inputHistory[0]!.text,
        currentInput: run.inputHistory.map((entry) => entry.text),
        taskContract: run.taskContract!,
        plan: run.currentPlan!,
        proposedSummary: action.summary,
        evidence: run.evidence,
        toolInvocations: this.#store.listToolInvocations(run.runId)
      })));
    } catch (error) {
      return this.#blockForProvider(run, error, observer);
    }
    const known = new Set(deterministic.evidenceIds);
    const invalidCitations = verdict.evidenceIds.filter((id) => !known.has(id));
    if (!verdict.passed || verdict.issues.length > 0 || invalidCitations.length > 0) {
      return this.#validationFailed(run, [...verdict.issues, ...invalidCitations.map((id) => `UNKNOWN_SEMANTIC_EVIDENCE:${id}`)], observer);
    }

    run = this.#commit(run, { ...run, lastError: null, updatedAt: this.#now() }, "validation.passed", {
      evidenceIds: deterministic.evidenceIds
    }, observer);
    const succeeded = transitionRunStatus(run, "succeeded", {
      now: this.#now(),
      stopReason: "VALIDATED",
      validation: { passed: true, evidenceIds: deterministic.evidenceIds },
      result: { summary: action.summary, resultArtifact: null, evidenceIds: [...deterministic.evidenceIds] }
    });
    return this.#commit(run, succeeded, "run.succeeded", { evidenceIds: deterministic.evidenceIds }, observer);
  }

  #validationFailed(run: RunSnapshot, issues: readonly string[], observer?: RuntimeObserver): RunSnapshot {
    const retries = run.budgetsUsed.retries + 1;
    if (retries > run.budgets.maxRetries) {
      return this.#fail(run, "VALIDATION_REPAIR_EXHAUSTED", "VALIDATION_FAILED", observer);
    }
    const next = RunSnapshotSchema.parse({
      ...run,
      budgetsUsed: { ...run.budgetsUsed, retries },
      lastError: { code: "VALIDATION_FAILED", message: issues.join(", "), retryable: true, detailsArtifact: null },
      updatedAt: this.#now()
    });
    return this.#commit(run, next, "validation.failed", { issues: [...issues] }, observer);
  }

  #rejectAction(run: RunSnapshot, error: z.ZodError | ActionRejectedError, observer?: RuntimeObserver): RunSnapshot {
    const retries = run.budgetsUsed.retries + 1;
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join("; ") : error.message;
    if (retries > run.budgets.maxRetries) {
      return this.#fail({
        ...run,
        budgetsUsed: { ...run.budgetsUsed, retries },
        lastError: { code: "INVALID_MODEL_ACTION", message, retryable: false, detailsArtifact: null }
      }, "ACTION_REPAIR_EXHAUSTED", "INVALID_MODEL_ACTION", observer);
    }
    const next = RunSnapshotSchema.parse({
      ...run,
      budgetsUsed: { ...run.budgetsUsed, retries },
      lastError: { code: "INVALID_MODEL_ACTION", message, retryable: true, detailsArtifact: null },
      updatedAt: this.#now()
    });
    return this.#commit(run, next, "action.rejected", { message }, observer);
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

  #budgetFailure(run: RunSnapshot): string | null {
    if (run.budgetsUsed.iterations >= run.budgets.maxIterations) return "ITERATION_BUDGET_EXCEEDED";
    if (run.budgetsUsed.modelCalls >= run.budgets.maxModelCalls) return "MODEL_CALL_BUDGET_EXCEEDED";
    if (run.budgetsUsed.toolCalls >= run.budgets.maxToolCalls) return "TOOL_CALL_BUDGET_EXCEEDED";
    if (Date.parse(this.#now()) - Date.parse(run.budgetsUsed.startedAt) >= run.budgets.maxDurationMs) return "DURATION_BUDGET_EXCEEDED";
    return null;
  }

  #decisionContext(run: RunSnapshot): ModelDecisionContext {
    return {
      run,
      allowedActions: allowedActions(run),
      tools: [...this.#tools.values()].map((tool) => ({ name: tool.name, risk: tool.risk, idempotent: tool.idempotent }))
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
    if (observer === undefined) return;
    const event = this.#store.getLastEvent(runId);
    if (event !== null) observer(event);
  }

  #requireRun(runId: string): RunSnapshot {
    const run = this.#store.getRun(runId);
    if (run === null) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Runtime is closed.");
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

function allowedActions(run: RunSnapshot): ModelDecisionContext["allowedActions"] {
  return run.currentPlan === null
    ? ["set_plan", "request_input"]
    : ["set_plan", "call_tool", "request_input", "propose_finish"];
}

function completeSatisfiedSteps(
  plan: NonNullable<RunSnapshot["currentPlan"]>,
  progress: RunSnapshot["stepProgress"],
  evidence: readonly Evidence[]
): RunSnapshot["stepProgress"] {
  let activeAssigned = false;
  return plan.orderedSteps.map((step) => {
    const existing = progress.find((item) => item.stepId === step.id);
    const satisfied = step.acceptanceChecks.filter((check) => check.required).every((check) => (
      evidence.some((item) => item.stepId === step.id && item.checkId === check.id && item.planVersion <= plan.version)
    ));
    if (satisfied) return { stepId: step.id, status: "completed", evidenceIds: evidence.filter((item) => item.stepId === step.id).map((item) => item.id) };
    if (!activeAssigned) {
      activeAssigned = true;
      return { stepId: step.id, status: "active", evidenceIds: existing?.evidenceIds ?? [] };
    }
    return { stepId: step.id, status: "pending", evidenceIds: existing?.evidenceIds ?? [] };
  });
}

function assertCompletedStepsUnchanged(run: RunSnapshot, nextSteps: readonly { readonly id: string }[]): void {
  if (run.currentPlan === null) return;
  for (const progress of run.stepProgress.filter((item) => item.status === "completed")) {
    const previous = run.currentPlan.orderedSteps.find((step) => step.id === progress.stepId);
    const next = nextSteps.find((step) => step.id === progress.stepId);
    if (previous === undefined || next === undefined || JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new ActionRejectedError(`Completed Step cannot be changed: ${progress.stepId}`);
    }
  }
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requireWorkspace(value: string): string {
  const workspace = resolve(value);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Runtime workspace does not exist or is not a directory: ${workspace}`);
  }
  return workspace;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toRunResult(run: RunSnapshot): RunResult {
  return {
    runId: run.runId,
    status: run.status,
    stopReason: run.stopReason,
    resultArtifact: run.result?.resultArtifact ?? null,
    evidence: run.evidence,
    lastError: run.lastError
  };
}
