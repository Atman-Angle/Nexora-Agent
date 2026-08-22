import { JsonValueSchema, type RunSnapshot } from "@nexora/runtime/internal";
import type { ContinuationTurn } from "../providers/model-client.js";
import type { ContextSource } from "./source.js";

/** Deterministic, provider-neutral history rebuilt from verified Runtime lineage. */
export function projectContinuationTurns(store: ContextSource): readonly ContinuationTurn[] {
  return (store.listContinuationRuns?.() ?? []).map((run) => projectTurn(run, store));
}

function projectTurn(run: RunSnapshot, store: ContextSource): ContinuationTurn {
  const outcomeSummary = run.result?.summary ?? run.delivery?.summary ?? run.lastError?.message ?? null;
  return {
    sourceRunId: run.runId,
    status: terminalStatus(run),
    inputs: run.inputHistory.map((entry) => ({
      ref: namespaced(run.runId, `input:${entry.sequence}`),
      sequence: entry.sequence,
      text: entry.text
    })),
    outcome: outcomeSummary === null ? null : {
      summary: outcomeSummary,
      resultArtifact: run.result?.resultArtifact ?? null,
      unfinishedWork: run.delivery?.unfinishedWork ?? [],
      exactCause: run.delivery?.exactCause === undefined
        ? null
        : { code: run.delivery.exactCause.code, message: run.delivery.exactCause.message }
    },
    plan: run.currentPlan === null ? null : {
      goal: run.taskContract?.goal ?? "Persisted Run plan",
      steps: run.currentPlan.orderedSteps.map((step) => ({
        objective: step.objective,
        status: run.stepProgress.find((progress) => progress.stepId === step.id)?.status ?? "pending"
      }))
    },
    events: store.listEvents(run.runId)
      .filter((event) => isContinuationEvent(event.type))
      .map((event) => ({
        ref: namespaced(run.runId, `event:${event.sequence}`),
        type: event.type,
        occurredAt: event.occurredAt,
        data: nullableJson(event.payload)
      })),
    toolFacts: store.listToolInvocations(run.runId)
      .filter((invocation) => invocation.status === "succeeded" || invocation.status === "failed")
      .map((invocation) => ({
        ref: namespaced(run.runId, `invocation:${invocation.id}`),
        toolName: invocation.toolName,
        status: invocation.status as "succeeded" | "failed",
        input: nullableJson(invocation.inputJson),
        facts: nullableJson(invocation.resultJson),
        error: nullableJson(invocation.errorJson)
      })),
    evidenceRefs: run.evidence.map((evidence) => namespaced(run.runId, `evidence:${evidence.id}`)),
    occurredAt: run.updatedAt,
    payloadMode: "full"
  };
}

function isContinuationEvent(type: string): boolean {
  return type.startsWith("approval.")
    || type.startsWith("input.")
    || type.startsWith("validation.")
    || type.startsWith("recovery.")
    || type === "response.rejected"
    || type === "run.blocked"
    || type === "run.cancelled"
    || type === "run.failed"
    || type === "run.succeeded";
}

export function namespaced(runId: string, ref: string): string {
  return `run:${runId}/${ref}`;
}

function terminalStatus(run: RunSnapshot): ContinuationTurn["status"] {
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") return run.status;
  throw new Error(`Continuation ancestor is not terminal: ${run.runId}`);
}

function nullableJson(value: unknown): ContinuationTurn["toolFacts"][number]["input"] {
  if (value === null || value === undefined) return null;
  return JsonValueSchema.parse(value) as ContinuationTurn["toolFacts"][number]["input"];
}
