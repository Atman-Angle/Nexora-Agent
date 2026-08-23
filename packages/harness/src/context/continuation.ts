import { JsonValueSchema, type RunSnapshot } from "@nexora/runtime/internal";
import type { ContinuationTurn } from "../providers/model-client.js";
import type { ContextSource } from "./source.js";

/** Deterministic, provider-neutral history rebuilt from verified Runtime lineage. */
export function projectContinuationTurns(
  store: ContextSource,
  currentRunId?: string
): readonly ContinuationTurn[] {
  const ancestors = store.listContinuationRuns?.() ?? [];
  const turns = ancestors.map((run) => projectTurn(run, store));
  let requestedBoundary = -1;
  for (let index = 0; index < ancestors.length; index += 1) {
    if (store.listEvents(ancestors[index]!.runId).some((event) => event.type === "context.compaction.requested")) {
      requestedBoundary = index;
    }
  }
  const manuallyProjected = turns.map((turn, index) => index < requestedBoundary
    ? referenceContinuationTurn(turn)
    : index === requestedBoundary
      ? compactContinuationTurn(turn)
      : turn);
  if (currentRunId === undefined) return manuallyProjected;
  const priorProjection = latestContinuationProjection(store, currentRunId);
  if (priorProjection.size === 0) return manuallyProjected;
  return manuallyProjected.map((turn) => applyPersistedMode(
    turn,
    priorProjection.get(turn.sourceRunId)
  ));
}

function latestContinuationProjection(
  store: ContextSource,
  currentRunId: string
): ReadonlyMap<string, ContinuationTurn["payloadMode"]> {
  const requested = [...store.listEvents(currentRunId)].reverse().find((event) => (
    event.type === "model.requested"
    && Array.isArray(event.payload.continuationProjection)
  ));
  const modes = new Map<string, ContinuationTurn["payloadMode"]>();
  if (requested === undefined) return modes;
  for (const item of requested.payload.continuationProjection as readonly unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const sourceRunId = (item as { readonly sourceRunId?: unknown }).sourceRunId;
    const payloadMode = (item as { readonly payloadMode?: unknown }).payloadMode;
    if (
      typeof sourceRunId === "string"
      && (payloadMode === "full" || payloadMode === "compact" || payloadMode === "reference")
    ) modes.set(sourceRunId, payloadMode);
  }
  return modes;
}

function applyPersistedMode(
  turn: ContinuationTurn,
  persisted: ContinuationTurn["payloadMode"] | undefined
): ContinuationTurn {
  if (persisted === undefined) return turn;
  const rank = { full: 0, compact: 1, reference: 2 } as const;
  if (rank[persisted] <= rank[turn.payloadMode]) return turn;
  return persisted === "reference" ? referenceContinuationTurn(turn) : compactContinuationTurn(turn);
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
  return type === "context.compaction.requested"
    || type.startsWith("approval.")
    || type.startsWith("input.")
    || type.startsWith("validation.")
    || type.startsWith("recovery.")
    || type === "response.rejected"
    || type === "run.blocked"
    || type === "run.cancelled"
    || type === "run.failed"
    || type === "run.succeeded";
}

export function compactContinuationTurn(turn: ContinuationTurn): ContinuationTurn {
  if (turn.payloadMode === "reference") return turn;
  return {
    ...turn,
    outcome: turn.outcome === null ? null : {
      ...turn.outcome,
      summary: boundedContinuationText(turn.outcome.summary, 1_024),
      unfinishedWork: turn.outcome.unfinishedWork.map((item) => boundedContinuationText(item, 256)),
      exactCause: turn.outcome.exactCause === null ? null : {
        code: turn.outcome.exactCause.code,
        message: boundedContinuationText(turn.outcome.exactCause.message, 512)
      }
    },
    plan: turn.plan === null ? null : {
      goal: boundedContinuationText(turn.plan.goal, 512),
      steps: turn.plan.steps.map((step) => ({
        objective: boundedContinuationText(step.objective, 256),
        status: step.status
      }))
    },
    events: turn.events.map((event) => ({ ...event, data: null })),
    toolFacts: turn.toolFacts.map((fact) => ({ ...fact, input: null, facts: null, error: null })),
    payloadMode: "compact"
  };
}

export function referenceContinuationTurn(turn: ContinuationTurn): ContinuationTurn {
  return {
    ...compactContinuationTurn(turn),
    inputs: turn.inputs.map((input) => ({ ...input, text: `[available by ${input.ref}]` })),
    outcome: turn.outcome === null ? null : {
      ...turn.outcome,
      summary: boundedContinuationText(turn.outcome.summary, 512),
      unfinishedWork: [],
      exactCause: turn.outcome.exactCause === null ? null : {
        code: turn.outcome.exactCause.code,
        message: boundedContinuationText(turn.outcome.exactCause.message, 256)
      }
    },
    plan: null,
    events: [],
    toolFacts: [],
    payloadMode: "reference"
  };
}

function boundedContinuationText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = "\n...[omitted]...\n";
  const contentBudget = Math.max(0, maxLength - marker.length);
  const startLength = Math.ceil(contentBudget / 2);
  const endLength = Math.floor(contentBudget / 2);
  return `${value.slice(0, startLength)}${marker}${value.slice(value.length - endLength)}`;
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
