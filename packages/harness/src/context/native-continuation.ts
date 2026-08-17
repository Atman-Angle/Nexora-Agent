import {
  digestCanonicalJson,
  type RunEvent,
  type RunSnapshot,
  type ToolInvocation
} from "@nexora/runtime/internal";

import {
  REQUEST_INPUT_CONTROL,
  UPDATE_PLAN_CONTROL
} from "../providers/model-response.js";
import type {
  JsonValue,
  NativeToolContinuation,
  ProjectedRunContext,
  ToolObservation
} from "../providers/model-client.js";
import { projectToolObservations } from "./projection.js";

type AuditedCall = NativeToolContinuation["calls"][number];

/**
 * Rebuilds only the latest fully resolved native call batch. Provider call IDs
 * remain correlation facts; all outcomes come from current Runtime Authority.
 */
export function projectNativeToolContinuation(input: {
  readonly run: RunSnapshot;
  readonly projectedRun: ProjectedRunContext;
  readonly events: readonly RunEvent[];
  readonly invocations: readonly ToolInvocation[];
}): NativeToolContinuation | undefined {
  const turn = [...input.events].reverse().find((event) => event.type === "model.turn");
  if (turn === undefined) return undefined;
  const calls = parseAuditedCalls(turn.payload.toolCalls);
  if (calls.length === 0) return undefined;

  const laterEvents = input.events.filter((event) => event.sequence > turn.sequence);
  const invocationById = new Map(input.invocations.map((invocation) => [invocation.id, invocation]));
  const startedInvocations = laterEvents
    .filter((event) => event.type === "tool.started")
    .map((event) => typeof event.payload.invocationId === "string"
      ? invocationById.get(event.payload.invocationId)
      : undefined)
    .filter((invocation): invocation is ToolInvocation => invocation !== undefined);
  const usedInvocations = new Set<string>();
  const rejection = laterEvents.find((event) => event.type === "response.rejected");
  const projected: AuditedCall[] = [];

  for (const call of calls) {
    const result = callResult({
      call,
      run: input.run,
      projectedRun: input.projectedRun,
      laterEvents,
      startedInvocations,
      usedInvocations,
      rejection
    });
    if (result === undefined) return undefined;
    projected.push({ ...call, result });
  }
  return { calls: projected };
}

function callResult(input: {
  readonly call: Omit<AuditedCall, "result">;
  readonly run: RunSnapshot;
  readonly projectedRun: ProjectedRunContext;
  readonly laterEvents: readonly RunEvent[];
  readonly startedInvocations: readonly ToolInvocation[];
  readonly usedInvocations: Set<string>;
  readonly rejection: RunEvent | undefined;
}): JsonValue | undefined {
  if (input.call.name === UPDATE_PLAN_CONTROL) {
    const event = input.laterEvents.find((candidate) => candidate.type === "plan.set");
    if (event !== undefined) {
      return {
        ok: true,
        status: "accepted",
        planVersion: typeof event.payload.version === "number"
          ? event.payload.version
          : input.run.currentPlan?.version ?? null
      };
    }
    return rejectedResult(input.rejection);
  }
  if (input.call.name === REQUEST_INPUT_CONTROL) {
    const waitingIndex = input.laterEvents.findIndex((candidate) => (
      candidate.type === "run.waiting" && candidate.payload.kind === "input"
    ));
    const resumed = waitingIndex < 0
      ? undefined
      : input.laterEvents.slice(waitingIndex + 1).find((candidate) => candidate.type === "run.resumed");
    const sequence = typeof resumed?.payload.inputSequence === "number"
      ? resumed.payload.inputSequence
      : undefined;
    if (sequence !== undefined) {
      const received = input.projectedRun.inputHistory.find((entry) => entry.sequence === sequence);
      if (received === undefined) return undefined;
      return { ok: true, status: "accepted", inputSequence: sequence, input: received.text };
    }
    return rejectedResult(input.rejection);
  }

  const invocation = input.startedInvocations.find((candidate) => (
    !input.usedInvocations.has(candidate.id)
    && candidate.toolName === input.call.name
    && candidate.inputDigest === digestCanonicalJson(input.call.arguments)
  ));
  if (invocation !== undefined) {
    input.usedInvocations.add(invocation.id);
    if (invocation.status !== "succeeded" && invocation.status !== "failed") return undefined;
    const observation = projectToolObservations([invocation])[0];
    if (observation === undefined) return undefined;
    return invocationResult(observation);
  }
  const denial = input.laterEvents.find((event) => event.type === "approval.denied");
  if (denial !== undefined) {
    return {
      ok: false,
      status: "denied",
      error: {
        code: "APPROVAL_DENIED",
        message: typeof denial.payload.reason === "string"
          ? boundedText(denial.payload.reason, 4_096)
          : "The protected Tool action was denied."
      }
    };
  }
  return rejectedResult(input.rejection);
}

function invocationResult(observation: ToolObservation): JsonValue {
  return {
    ok: observation.status === "succeeded",
    status: observation.status,
    observation: {
      invocationId: observation.invocationId,
      toolName: observation.toolName,
      payloadMode: observation.payloadMode,
      facts: isJsonValue(observation.facts) ? observation.facts : null,
      error: isJsonValue(observation.error) ? observation.error : null,
      payloadFragment: observation.payloadFragment,
      truncated: observation.truncated,
      originalBytes: observation.originalBytes,
      sourceRefs: observation.sourceRefs,
      digest: observation.digest
    }
  };
}

function rejectedResult(event: RunEvent | undefined): JsonValue | undefined {
  if (event === undefined) return undefined;
  return {
    ok: false,
    status: "rejected",
    error: {
      code: "INVALID_MODEL_RESPONSE",
      message: typeof event.payload.message === "string"
        ? boundedText(event.payload.message, 4_096)
        : "The Harness rejected this Tool call."
    }
  };
}

function parseAuditedCalls(value: unknown): readonly Omit<AuditedCall, "result">[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return [];
  const parsed: Omit<AuditedCall, "result">[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as { callId?: unknown; name?: unknown; arguments?: unknown };
    if (typeof candidate.callId !== "string" || candidate.callId.length === 0) return [];
    if (typeof candidate.name !== "string" || candidate.name.length === 0) return [];
    if (!isJsonValue(candidate.arguments)) return [];
    parsed.push({ callId: candidate.callId, name: candidate.name, arguments: candidate.arguments });
  }
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 16)}...[truncated]`;
}
