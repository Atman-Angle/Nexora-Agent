import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import type { Evidence, RunSnapshot } from "./contracts.js";
import type { RunResult, RuntimeTool } from "./runtime-types.js";
import { deriveFailureHandoff } from "./failure-handoff.js";

export class ActionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionRejectedError";
  }
}

export function completeSatisfiedSteps(plan: NonNullable<RunSnapshot["currentPlan"]>, progress: RunSnapshot["stepProgress"], evidence: readonly Evidence[]): RunSnapshot["stepProgress"] {
  let activeAssigned = false;
  return plan.orderedSteps.map((step) => {
    const existing = progress.find((item) => item.stepId === step.id);
    const requiredChecks = step.acceptanceChecks.filter((check) => check.required);
    const satisfied = requiredChecks.length > 0
      && requiredChecks.every((check) => evidence.some((item) => item.stepId === step.id && item.checkId === check.id && item.planVersion <= plan.version));
    if (satisfied) return { stepId: step.id, status: "completed", evidenceIds: evidence.filter((item) => item.stepId === step.id).map((item) => item.id) };
    if (!activeAssigned) { activeAssigned = true; return { stepId: step.id, status: "active", evidenceIds: existing?.evidenceIds ?? [] }; }
    return { stepId: step.id, status: "pending", evidenceIds: existing?.evidenceIds ?? [] };
  });
}

export function assertCompletedStepsUnchanged(run: RunSnapshot, nextSteps: readonly { readonly id: string }[]): void {
  if (run.currentPlan === null) return;
  for (const progress of run.stepProgress.filter((item) => item.status === "completed")) {
    const previous = run.currentPlan.orderedSteps.find((step) => step.id === progress.stepId);
    const next = nextSteps.find((step) => step.id === progress.stepId);
    if (previous === undefined || next === undefined || JSON.stringify(previous) !== JSON.stringify(next)) throw new ActionRejectedError(`Completed Step cannot be changed: ${progress.stepId}`);
  }
}

export function digestJson(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function digestCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => stringCompare(left, right))
      .map(([key, nested]) => [key, canonicalJsonValue(nested)])
  );
}

/** Locale-independent total order used by canonical serialization and value sorting. */
export function stringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function validateToolContract(contract: RuntimeTool["contract"]): void {
  const name = contract.identity.name; requireToolText(name, "identity.name", name); requireToolText(contract.capability.purpose, "capability.purpose", name); requireToolTexts(contract.capability.nonGoals, "capability.nonGoals", name); requireToolTexts(contract.decision.useWhen, "decision.useWhen", name); requireToolTexts(contract.decision.avoidWhen, "decision.avoidWhen", name); requireToolText(contract.execution.effect.description, "execution.effect.description", name); requireToolTexts(contract.evidence.produces, "evidence.produces", name);
  if (contract.execution.readCache !== undefined && (
    contract.execution.effect.kind !== "read" || !contract.execution.idempotent
  )) throw new Error(`Runtime Tool ${name} readCache requires an idempotent read Effect.`);
}
function requireToolTexts(values: readonly string[], field: string, name: string): void { if (values.length === 0 || values.length > 4) throw new Error(`Runtime Tool ${name} ${field} must contain 1-4 items.`); for (const value of values) requireToolText(value, field, name); }
function requireToolText(value: string, field: string, name: string): void { if (!value.trim() || value.length > 240) throw new Error(`Runtime Tool ${name} ${field} must be non-empty and at most 240 characters.`); }
export function requireWorkspace(value: string): string { const workspace = resolve(value); if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`Runtime workspace does not exist or is not a directory: ${workspace}`); return workspace; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function responseRejectionDiagnostic(error: z.ZodError | ActionRejectedError, rawResponse: unknown) {
  const responseType = rawResponse === null
    ? "null"
    : Array.isArray(rawResponse)
      ? "array"
      : typeof rawResponse;
  // Consumers may load Zod through a second package instance (for example a
  // workspace-linked harness). Prefer the stable `.issues` contract as well
  // as instanceof so schema rejections cannot be misclassified as state
  // errors across package boundaries.
  if (error instanceof z.ZodError || isZodErrorLike(error)) {
    const issues = error.issues.slice(0, 4).map(responseRepairIssue);
    return {
      kind: "schema" as const,
      responseType,
      issues,
      recovery: schemaRejectionRecovery(issues)
    };
  }
  return {
    kind: "state" as const,
    responseType,
    issues: [{ path: "$", code: "response_rejected", message: error.message.slice(0, 500) }],
    recovery: stateRejectionRecovery(error.message)
  };
}

function isZodErrorLike(error: unknown): error is z.ZodError {
  return error !== null
    && typeof error === "object"
    && Array.isArray((error as { readonly issues?: unknown }).issues);
}

function stateRejectionRecovery(message: string): {
  readonly sideEffect: "none";
  readonly doNotRepeat: true;
  readonly nextAction: string;
} {
  if (message.includes("duplicates an existing persisted Invocation with status succeeded")) {
    return {
      sideEffect: "none",
      doNotRepeat: true,
      nextAction: "The Tool effect already succeeded. Use its persisted result and do not resend the same Tool name and arguments."
    };
  }
  if (message.includes("PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME")) {
    return {
      sideEffect: "none",
      doNotRepeat: true,
      nextAction: "The protected mutation batch was rejected as a whole; no mutation was executed. Submit exactly one protected mutation or one complete write, and do not resend the rejected batch."
    };
  }
  if (message.includes("FINAL_CONTROL_REQUIRED")) {
    return {
      sideEffect: "none",
      doNotRepeat: true,
      nextAction: "The text was not accepted as a task result. Preserve completed Tool effects and submit the user-facing answer once through nexora_respond."
    };
  }
  return {
    sideEffect: "none",
    doNotRepeat: true,
    nextAction: "The Runtime rejected this action before execution. Correct the request using the rejection details and do not resend it unchanged."
  };
}


function schemaRejectionRecovery(
  issues: readonly { readonly path: string; readonly code: string; readonly message: string }[]
): {
  readonly sideEffect: "none";
  readonly doNotRepeat: true;
  readonly nextAction: string;
  readonly fields: readonly { readonly path: string; readonly code: string; readonly expectedFormat?: string }[];
} {
  const toolCallLimit = issues.find((issue) => (
    issue.path === "toolCalls" && issue.code === "too_big"
  ));
  if (toolCallLimit !== undefined) {
    return {
      sideEffect: "none",
      doNotRepeat: true,
      nextAction: "The response contained more than 8 Tool calls and no Tool was executed. Split the work across multiple Provider turns with at most 8 Tool calls in each response.",
      fields: [{ path: toolCallLimit.path, code: toolCallLimit.code, expectedFormat: "array with at most 8 Tool calls" }]
    };
  }
  const digestIssue = issues.find((issue) => issue.path === "expectedDigest");
  if (digestIssue !== undefined) {
    return {
      sideEffect: "none",
      doNotRepeat: true,
      nextAction: "Use the complete digest from the latest authoritative filesystem.read observation, or reread the file before retrying filesystem.patch.",
      fields: [{ path: digestIssue.path, code: digestIssue.code, expectedFormat: "sha256:<64 hexadecimal characters>" }]
    };
  }
  return {
    sideEffect: "none",
    doNotRepeat: true,
    nextAction: "Correct the invalid field(s) using authoritative facts and do not resend the rejected response unchanged.",
    fields: issues.map(({ path, code }) => ({ path, code }))
  };
}

function responseRepairIssue(issue: z.ZodIssue): { path: string; code: string; message: string } {
  const path = issue.path.length === 0 ? "$" : issue.path.join(".").slice(0, 200);
  return { path, code: issue.code, message: issue.message.slice(0, 500) };
}
export function serializeRejectedResponse(rawResponse: unknown): string { try { const serialized = JSON.stringify(rawResponse); return serialized ?? JSON.stringify({ unsupportedValueType: typeof rawResponse }); } catch (error) { return JSON.stringify({ serializationError: errorMessage(error), receivedType: typeof rawResponse }); } }
export function toRunResult(run: RunSnapshot): RunResult { return { runId: run.runId, status: run.status, stopReason: run.stopReason, summary: run.result?.summary ?? run.delivery?.summary ?? null, resultArtifact: run.result?.resultArtifact ?? null, evidence: run.evidence, lastError: run.lastError, delivery: run.delivery, failureHandoff: deriveFailureHandoff(run) }; }
