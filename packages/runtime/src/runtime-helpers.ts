import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import type { Evidence, RunSnapshot, ToolInvocation } from "./contracts.js";
import type { ModelDecisionContext, ToolObservation } from "./model-client.js";
import type { RunResult, RuntimeTool } from "./runtime-types.js";

export const MAX_TOOL_OBSERVATIONS = 8;
export const MAX_TOOL_OBSERVATION_BYTES = 32 * 1024;

export class ActionRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "ActionRejectedError"; }
}

export function allowedActions(run: RunSnapshot): ModelDecisionContext["allowedActions"] {
  return run.currentPlan === null ? ["set_plan", "request_input"] : ["set_plan", "call_tool", "request_input", "propose_finish"];
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
export function projectToolObservations(invocations: readonly ToolInvocation[]): ToolObservation[] {
  const observations = invocations.filter((item): item is ToolInvocation & { status: "succeeded" | "failed"; completedAt: string } => (item.status === "succeeded" || item.status === "failed") && item.completedAt !== null).slice(-MAX_TOOL_OBSERVATIONS).map((item) => {
    const result = item.status === "succeeded" ? item.resultJson : null; const error = item.status === "failed" ? item.errorJson : null;
    return { invocationId: item.id, planVersion: item.planVersion, stepId: item.stepId, toolName: item.toolName, status: item.status, completedAt: item.completedAt, facts: result, error, truncated: false, digest: digestJson(item.status === "succeeded" ? result : error) } satisfies ToolObservation;
  });
  if (jsonBytes(observations) <= MAX_TOOL_OBSERVATION_BYTES || observations.length === 0) return observations;
  const itemBudget = Math.floor((MAX_TOOL_OBSERVATION_BYTES - observations.length - 1) / observations.length);
  return observations.map((observation) => boundObservation(observation, itemBudget));
}
function boundObservation(observation: ToolObservation, maxBytes: number): ToolObservation {
  if (jsonBytes(observation) <= maxBytes) return observation;
  const value = observation.status === "succeeded" ? observation.facts : observation.error; const serialized = JSON.stringify(value); let lower = 0; let upper = serialized.length; let bounded = observationPreview(observation, "");
  while (lower <= upper) { const middle = Math.floor((lower + upper) / 2); const candidate = observationPreview(observation, serialized.slice(0, middle)); if (jsonBytes(candidate) <= maxBytes) { bounded = candidate; lower = middle + 1; } else upper = middle - 1; }
  return bounded;
}
function observationPreview(observation: ToolObservation, preview: string): ToolObservation { return { ...observation, facts: observation.status === "succeeded" ? { preview } : null, error: observation.status === "failed" ? { preview } : null, truncated: true }; }
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

export function validateToolContract(contract: RuntimeTool["contract"]): void {
  const name = contract.identity.name; requireToolText(name, "identity.name", name); requireToolText(contract.capability.purpose, "capability.purpose", name); requireToolTexts(contract.capability.nonGoals, "capability.nonGoals", name); requireToolTexts(contract.decision.useWhen, "decision.useWhen", name); requireToolTexts(contract.decision.avoidWhen, "decision.avoidWhen", name); requireToolText(contract.execution.effect.description, "execution.effect.description", name); requireToolTexts(contract.evidence.produces, "evidence.produces", name);
}
function requireToolTexts(values: readonly string[], field: string, name: string): void { if (values.length === 0 || values.length > 4) throw new Error(`Runtime Tool ${name} ${field} must contain 1-4 items.`); for (const value of values) requireToolText(value, field, name); }
function requireToolText(value: string, field: string, name: string): void { if (!value.trim() || value.length > 240) throw new Error(`Runtime Tool ${name} ${field} must be non-empty and at most 240 characters.`); }
export function requireWorkspace(value: string): string { const workspace = resolve(value); if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`Runtime workspace does not exist or is not a directory: ${workspace}`); return workspace; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function actionRejectionDiagnostic(error: z.ZodError | ActionRejectedError, rawAction: unknown) {
  const actionType = typeof rawAction === "object" && rawAction !== null && "type" in rawAction && typeof (rawAction as { readonly type?: unknown }).type === "string" ? (rawAction as { readonly type: string }).type.slice(0, 100) : null;
  if (error instanceof z.ZodError) return { kind: "schema" as const, actionType, issues: error.issues.slice(0, 4).map((issue) => ({ path: issue.path.length === 0 ? "$" : issue.path.join(".").slice(0, 200), code: issue.code, message: issue.message.slice(0, 500) })) };
  return { kind: "state" as const, actionType, issues: [{ path: "$", code: "action_rejected", message: error.message.slice(0, 500) }] };
}
export function serializeRejectedAction(rawAction: unknown): string { try { const serialized = JSON.stringify(rawAction); return serialized ?? JSON.stringify({ unsupportedValueType: typeof rawAction }); } catch (error) { return JSON.stringify({ serializationError: errorMessage(error), receivedType: typeof rawAction }); } }
export function toRunResult(run: RunSnapshot): RunResult { return { runId: run.runId, status: run.status, stopReason: run.stopReason, summary: run.result?.summary ?? null, resultArtifact: run.result?.resultArtifact ?? null, evidence: run.evidence, lastError: run.lastError }; }
