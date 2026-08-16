import type { RunEvent, RunStatus } from "./contracts.js";
import type {
  PublicPendingRequest,
  PublicRecoveryRequest,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeSubscription
} from "./runtime-types.js";

export interface ManagedRuntimeSubscription extends RuntimeSubscription {
  notify(): void;
}

export function projectRuntimeEvent(event: RunEvent): RuntimeEvent {
  const base = {
    schemaVersion: 1 as const,
    runId: event.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt
  };
  const payload = event.payload;

  if (event.type === "run.waiting") {
    const requestId = optionalString(payload.requestId);
    const prompt = optionalString(payload.prompt);
    if (payload.kind === "input" && requestId !== null && prompt !== null) {
      return { ...base, type: "input.required", requestId, prompt };
    }
  }
  if (event.type === "run.resumed") {
    const requestId = optionalString(payload.requestId);
    const inputSequence = optionalNumber(payload.inputSequence);
    if (requestId !== null && inputSequence !== null) {
      return {
        ...base,
        type: "input.received",
        requestId,
        inputSequence
      };
    }
  }
  if (event.type === "approval.requested") {
    const request = approvalRequestFromPayload(payload);
    if (request !== null) {
      return { ...base, type: "approval.required", request };
    }
  }
  if (event.type === "approval.granted" || event.type === "approval.denied") {
    const requestId = optionalString(payload.requestId);
    if (requestId !== null) {
      const reason = optionalString(payload.reason);
      return {
        ...base,
        type: event.type,
        requestId,
        ...(reason === null ? {} : { reason })
      };
    }
  }
  if (event.type === "tool.result_unknown") {
    const invocationId = optionalString(payload.invocationId);
    const toolName = optionalString(payload.toolName);
    if (invocationId !== null && toolName !== null) {
      const recovery: PublicRecoveryRequest = {
        invocationId,
        toolName,
        reason: "tool_result_unknown"
      };
      return { ...base, type: "recovery.required", recovery };
    }
  }
  if (
    event.type === "recovery.confirmed_succeeded"
    || event.type === "recovery.confirmed_failed"
    || event.type === "recovery.abandoned"
  ) {
    const invocationId = optionalString(payload.invocationId);
    if (invocationId !== null) {
      const outcome = event.type === "recovery.confirmed_succeeded"
        ? "confirmed_succeeded"
        : event.type === "recovery.confirmed_failed"
          ? "confirmed_failed"
          : "abandon_run";
      return {
        ...base,
        type: "recovery.resolved",
        invocationId,
        outcome
      };
    }
  }

  const mapped = lifecycleType(event.type);
  if (mapped !== null) {
    return { ...base, type: mapped, data: payload };
  }
  return {
    ...base,
    type: "runtime.event",
    name: event.type,
    data: payload
  };
}

export function createRuntimeSubscription(input: {
  readonly runId: string;
  readonly afterSequence: number;
  readonly listener: RuntimeEventListener;
  readonly readEvents: (afterSequence: number) => readonly RunEvent[];
  readonly readStatus: () => RunStatus;
  readonly onClose: (subscription: ManagedRuntimeSubscription) => void;
}): ManagedRuntimeSubscription {
  return new PersistedRuntimeSubscription(input);
}

class PersistedRuntimeSubscription implements ManagedRuntimeSubscription {
  readonly closed: Promise<void>;
  readonly #runId: string;
  readonly #listener: RuntimeEventListener;
  readonly #readEvents: (afterSequence: number) => readonly RunEvent[];
  readonly #readStatus: () => RunStatus;
  readonly #onClose: (subscription: ManagedRuntimeSubscription) => void;
  readonly #resolveClosed: () => void;
  readonly #rejectClosed: (error: unknown) => void;
  readonly #timer: ReturnType<typeof setInterval>;
  #scheduled: ReturnType<typeof setTimeout> | null = null;
  #cursor: number;
  #isClosed = false;
  #pumping = false;

  constructor(input: {
    readonly runId: string;
    readonly afterSequence: number;
    readonly listener: RuntimeEventListener;
    readonly readEvents: (afterSequence: number) => readonly RunEvent[];
    readonly readStatus: () => RunStatus;
    readonly onClose: (subscription: ManagedRuntimeSubscription) => void;
  }) {
    this.#runId = input.runId;
    this.#cursor = input.afterSequence;
    this.#listener = input.listener;
    this.#readEvents = input.readEvents;
    this.#readStatus = input.readStatus;
    this.#onClose = input.onClose;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    this.closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.#resolveClosed = resolveClosed;
    this.#rejectClosed = rejectClosed;
    void this.closed.catch(() => undefined);
    this.#timer = setInterval(() => this.notify(), 25);
    queueMicrotask(() => this.notify());
  }

  notify(): void {
    if (this.#isClosed || this.#pumping || this.#scheduled !== null) return;
    this.#scheduled = setTimeout(() => {
      this.#scheduled = null;
      if (this.#isClosed || this.#pumping) return;
      this.#pumping = true;
      void this.#pump();
    }, 0);
  }

  async close(): Promise<void> {
    this.#finish();
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#isClosed) {
        const events = this.#readEvents(this.#cursor);
        if (events.length === 0) break;
        for (const event of events) {
          if (this.#isClosed) break;
          if (event.runId !== this.#runId || event.sequence <= this.#cursor) {
            throw new Error("Persisted Runtime Event sequence is inconsistent.");
          }
          await this.#listener(deepFreeze(projectRuntimeEvent(event)));
          this.#cursor = event.sequence;
        }
      }
      if (
        !this.#isClosed
        && (
          this.#readStatus() === "cancelled"
          || this.#readStatus() === "failed"
          || this.#readStatus() === "succeeded"
        )
        && this.#readEvents(this.#cursor).length === 0
      ) {
        this.#finish();
      }
    } catch (error) {
      this.#finish(error);
    } finally {
      this.#pumping = false;
    }
  }

  #finish(error?: unknown): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    clearInterval(this.#timer);
    if (this.#scheduled !== null) {
      clearTimeout(this.#scheduled);
      this.#scheduled = null;
    }
    this.#onClose(this);
    if (error === undefined) this.#resolveClosed();
    else this.#rejectClosed(error);
  }
}

function approvalRequestFromPayload(
  payload: Record<string, unknown>
): Extract<PublicPendingRequest, { readonly kind: "approval" }> | null {
  const id = optionalString(payload.requestId);
  const prompt = optionalString(payload.prompt);
  const createdAt = optionalString(payload.createdAt);
  const toolName = optionalString(payload.toolName);
  const stepId = optionalString(payload.stepId);
  if (
    id === null
    || prompt === null
    || createdAt === null
    || toolName === null
    || stepId === null
    || !("input" in payload)
  ) {
    return null;
  }
  return {
    id,
    kind: "approval",
    prompt,
    createdAt,
    toolName,
    stepId,
    input: payload.input
  };
}

type LifecycleEventType = Exclude<
  Extract<RuntimeEvent, { readonly data: Record<string, unknown> }>["type"],
  "runtime.event"
>;

function lifecycleType(type: string): LifecycleEventType | null {
  const mapping: Record<string, LifecycleEventType> = {
    "run.created": "run.created",
    "run.resumed": "run.resumed",
    "run.blocked": "run.blocked",
    "run.cancelled": "run.cancelled",
    "run.failed": "run.failed",
    "run.succeeded": "run.succeeded",
    "plan.set": "plan.updated",
    "model.requested": "model.requested",
    "response.rejected": "model.response_rejected",
    "tool.started": "tool.started",
    "tool.succeeded": "tool.succeeded",
    "tool.failed": "tool.failed",
    "tool.retried": "tool.retried",
    "validation.requested": "validation.started",
    "validation.passed": "validation.passed",
    "validation.failed": "validation.failed"
  };
  return mapping[type] ?? null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : null;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
