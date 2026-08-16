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
    const satisfied = step.acceptanceChecks.filter((check) => check.required).every((check) => evidence.some((item) => item.stepId === step.id && item.checkId === check.id && item.planVersion <= plan.version));
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
}
function requireToolTexts(values: readonly string[], field: string, name: string): void { if (values.length === 0 || values.length > 4) throw new Error(`Runtime Tool ${name} ${field} must contain 1-4 items.`); for (const value of values) requireToolText(value, field, name); }
function requireToolText(value: string, field: string, name: string): void { if (!value.trim() || value.length > 240) throw new Error(`Runtime Tool ${name} ${field} must be non-empty and at most 240 characters.`); }
export function requireWorkspace(value: string): string { const workspace = resolve(value); if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`Runtime workspace does not exist or is not a directory: ${workspace}`); return workspace; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function actionRejectionDiagnostic(error: z.ZodError | ActionRejectedError, rawAction: unknown) {
  const actionType = typeof rawAction === "object" && rawAction !== null && "type" in rawAction && typeof (rawAction as { readonly type?: unknown }).type === "string" ? (rawAction as { readonly type: string }).type.slice(0, 100) : null;
  if (error instanceof z.ZodError) return { kind: "schema" as const, actionType, issues: error.issues.slice(0, 4).map(planningRepairIssue) };
  return { kind: "state" as const, actionType, issues: [{ path: "$", code: "action_rejected", message: error.message.slice(0, 500) }] };
}

/**
 * Renders one Zod issue for the model. Empty acceptanceChecks on a Plan Step
 * gets a step-level, actionable repair hint ("Step N has no verifiable
 * completion condition. Revise Step N only.") instead of the raw Zod text, so
 * the model makes the minimal fix rather than rebuilding the whole Plan. The
 * original path is preserved for audit; the raw action is archived separately.
 */
function planningRepairIssue(issue: z.ZodIssue): { path: string; code: string; message: string } {
  const path = issue.path.length === 0 ? "$" : issue.path.join(".").slice(0, 200);
  if (
    issue.path.length === 3
    && issue.path[0] === "orderedSteps"
    && typeof issue.path[1] === "number"
    && issue.path[2] === "acceptanceChecks"
    && issue.code === z.ZodIssueCode.too_small
  ) {
    const stepNumber = issue.path[1] + 1;
    return {
      path,
      code: "empty_acceptance_checks",
      message: `Step ${stepNumber} has no verifiable completion condition. Revise Step ${stepNumber} only.`
    };
  }
  return { path, code: issue.code, message: issue.message.slice(0, 500) };
}
export function serializeRejectedAction(rawAction: unknown): string { try { const serialized = JSON.stringify(rawAction); return serialized ?? JSON.stringify({ unsupportedValueType: typeof rawAction }); } catch (error) { return JSON.stringify({ serializationError: errorMessage(error), receivedType: typeof rawAction }); } }
export function toRunResult(run: RunSnapshot): RunResult { return { runId: run.runId, status: run.status, stopReason: run.stopReason, summary: run.result?.summary ?? run.delivery?.summary ?? null, resultArtifact: run.result?.resultArtifact ?? null, evidence: run.evidence, lastError: run.lastError, delivery: run.delivery, failureHandoff: deriveFailureHandoff(run) }; }
