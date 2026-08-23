import {
  JsonValueSchema,
  type ForkContext,
  type RunSnapshot,
  type ToolAttempt,
  type ToolInvocation
} from "@nexora/runtime/internal";
import {
  deepFreeze,
  digestJson
} from "@nexora/runtime/internal";
import type {
  JsonValue,
  ModelDecisionContext,
  RepairContext,
  RehydratedFact
} from "../providers/model-client.js";
import type { AgentToolDescriptor } from "@nexora/runtime/internal";
import type { WorkerObservation } from "@nexora/runtime/internal";
import type { RuntimeMemoryOptions } from "../types.js";
import { providerJsonSchema } from "../tool-schema.js";
import { projectMemoryCandidates } from "../memory/recall.js";
import { automaticPublishedRefs } from "../memory-policy.js";
import type { ContextArtifactSource, ContextSource } from "./source.js";
import {
  projectRelevantToolObservations,
  projectRunContext
} from "./projection.js";
import { projectNativeToolContinuation } from "./native-continuation.js";
import { projectContinuationTurns } from "./continuation.js";
import { projectHistoryCandidates } from "./history-candidates.js";
import {
  admitRehydratedFacts,
  autoRehydrateForActiveStep,
  buildAvailableContextRefs,
  projectSessionArchive,
  resolveRehydratedFact
} from "./rehydration.js";

export type DecisionContextResult = {
  readonly context: ModelDecisionContext;
  /** sourceRefs that were successfully restored into rehydratedFacts this turn. */
  readonly injectedRehydratedRefs: readonly string[];
};

/**
 * Builds the full ModelDecisionContext the Provider sees for one decision
 * call, including any rehydrated facts admitted this turn. Pure function of
 * (run, invocations, tools, workspace and published source refs).
 *
 * Rehydration integrates here: the Harness passes this turn's model-requested
 * refs (already validated against the previous turn's manifest) and the
 * Harness auto-candidates are derived from the active step. Facts are admitted
 * under a dedicated budget in priority order: harness_required >
 * model_request > harness_helpful. When forkContext is present, the child's
 * readable universe also includes the Fork Base inherited facts (read-only).
 */
export function buildDecisionContext(args: {
  readonly run: RunSnapshot;
  readonly store: ContextSource;
  readonly workspace: string;
  readonly tools: ReadonlyMap<string, AgentToolDescriptor>;
  readonly artifacts: ContextArtifactSource;
  readonly forkContext?: ForkContext | null;
  readonly memory?: RuntimeMemoryOptions;
  readonly now?: string;
  readonly workerObservations?: readonly WorkerObservation[];
  readonly delegationPolicyMode?: "forbidden" | "allowed" | "required";
}): DecisionContextResult {
  const { run, store, workspace, tools, artifacts } = args;
  const invocations = store.listToolInvocations(run.runId);
  const events = store.listEvents(run.runId);
  const observations = projectRelevantToolObservations(run, invocations);
  const continuation = projectContinuationTurns(store);
  const inherited = args.forkContext === undefined || args.forkContext === null
    ? undefined
    : (() => {
        const parentRun = store.getRun(args.forkContext!.parentRunId);
        return parentRun === null
          ? undefined
          : { parentRun, refs: args.forkContext!.forkBase.inheritedRefs };
      })();

  const historyCandidates = projectHistoryCandidates({
    run,
    invocations,
    events,
    ...(inherited === undefined
      ? {}
      : {
          inherited: {
            parentRun: inherited.parentRun,
            refs: inherited.refs,
            facts: args.forkContext!.forkBase.inheritedFacts
          }
        })
  });
  const memoryCandidates = args.memory === undefined || !args.memory.store.isRecallEnabled(args.memory.scope)
    ? []
    : projectMemoryCandidates({
        run,
        records: args.memory.store.list({ scope: args.memory.scope, status: "active", limit: 500 }),
        asOf: args.now ?? new Date().toISOString()
      });

  const manifest = buildAvailableContextRefs({
    run,
    observations,
    store,
    artifacts,
    historyCandidates,
    memoryCandidates,
    continuation,
    ...(inherited === undefined ? {} : { inheritedRefs: inherited.refs })
  });

  const autoCandidates = autoRehydrateForActiveStep({ run, observations, invocations });
  const automaticRefs = automaticPublishedRefs(run, manifest, memoryCandidates);
  const candidates: RehydratedFact[] = [];
  for (const ref of [...automaticRefs, ...autoCandidates.required]) {
    if (candidates.some((candidate) => candidate.ref === ref)) continue;
    const memoryDigest = memoryCandidates.find((candidate) => candidate.ref === ref)?.digest;
    candidates.push(resolveRehydratedFact({
      ref,
      run,
      store,
      artifacts,
      manifest,
      origin: "harness_required",
      ...(memoryDigest === undefined ? {} : { expectedMemoryDigest: memoryDigest }),
      ...(args.memory === undefined ? {} : { memory: args.memory, asOf: args.now ?? new Date().toISOString() }),
      ...(inherited === undefined ? {} : { inherited })
    }));
  }
  for (const ref of autoCandidates.helpful) {
    if (!candidates.some((candidate) => candidate.ref === ref)) {
      candidates.push(resolveRehydratedFact({
        ref,
        run,
        store,
        artifacts,
        manifest,
        origin: "harness_helpful",
        ...(inherited === undefined ? {} : { inherited })
      }));
    }
  }
  // Provider-aware eviction owns the production wire budget. Admit exact
  // current facts here so large-window models can use them in full.
  const { accepted } = admitRehydratedFacts(candidates, {
    maxRefs: Number.MAX_SAFE_INTEGER,
    maxTokens: Number.MAX_SAFE_INTEGER,
    maxSingleFactTokens: Number.MAX_SAFE_INTEGER
  });
  const seenFacts = new Set<string>();
  const rehydratedFacts = accepted.filter((fact) => {
    if (seenFacts.has(fact.ref)) return false;
    seenFacts.add(fact.ref);
    return true;
  });
  const injectedRehydratedRefs = rehydratedFacts
    .filter((fact) => fact.error === null)
    .map((fact) => fact.ref);
  const projectedRun = projectRunContext(run);
  const nativeToolContinuation = projectNativeToolContinuation({
    run,
    projectedRun,
    events,
    invocations
  });
  const projection = deepFreeze(structuredClone({
    workspace,
    delegationAllowed: (args.forkContext === undefined || args.forkContext === null)
      && args.delegationPolicyMode !== "forbidden",
    delegationMode: args.forkContext === undefined || args.forkContext === null
      ? args.delegationPolicyMode ?? "allowed"
      : "forbidden",
    workerRun: args.forkContext !== undefined && args.forkContext !== null,
    delegationSatisfied: events.some((event) => (
      event.type === "runtime.event" && event.payload.name === "workers.delegation.accepted"
    )),
    run: projectedRun,
    continuation,
    providerContractVersion: 6 as const,
    activeInvocations: invocations
      .filter((invocation): invocation is ToolInvocation & { readonly status: "started" | "unknown" } => (
        invocation.status === "started" || invocation.status === "unknown"
      ))
      .map((invocation) => ({
        invocationId: invocation.id,
        toolName: invocation.toolName,
        status: invocation.status,
        inputDigest: invocation.inputDigest,
        planVersion: invocation.planVersion,
        stepId: invocation.stepId,
        idempotent: invocation.idempotent
      })),
    toolObservations: observations,
    workerObservations: (args.workerObservations ?? []).map((observation) => ({
      childRunId: observation.childRunId,
      branchId: observation.branchId,
      delegationId: observation.delegationId,
      assignmentId: observation.assignmentId,
      profileRef: observation.profileRef,
      status: observation.status,
      branchStatus: observation.branchStatus,
      summary: observation.summary,
      resultArtifact: observation.resultArtifact,
      deliveryOutcome: observation.delivery?.outcome ?? null,
      evidenceRefs: observation.evidenceRefs
    })),
    rehydratedFacts,
    historyCandidates,
    memoryCandidates,
    sessionArchive: projectSessionArchive({ run, events }),
    repair: projectRepairContext(run, invocations, store.listToolAttempts(run.runId), artifacts),
    ...(nativeToolContinuation === undefined ? {} : { nativeToolContinuation }),
    tools: [...tools.values()].map((tool) => ({
      identity: tool.contract.identity,
      capability: tool.contract.capability,
      decision: tool.contract.decision,
      execution: {
        effect: tool.contract.execution.effect,
        inputSchema: providerJsonSchema(tool.contract.execution.inputSchema),
        inputExample: tool.contract.execution.inputExample
      },
      evidence: { produces: tool.contract.evidence.produces }
    }))
  }));
  const context = deepFreeze({
    providerContractVersion: projection.providerContractVersion,
    workspace: projection.workspace,
    delegationAllowed: projection.delegationAllowed,
    delegationMode: projection.delegationMode,
    workerRun: projection.workerRun,
    delegationSatisfied: projection.delegationSatisfied,
    run: projection.run,
    continuation: projection.continuation,
    projection: {
      schemaVersion: 1 as const,
      digest: digestJson(projection)
    },
    activeInvocations: projection.activeInvocations,
    toolObservations: projection.toolObservations,
    ...(projection.workerObservations === undefined ? {} : { workerObservations: projection.workerObservations }),
    rehydratedFacts: projection.rehydratedFacts,
    historyCandidates: projection.historyCandidates,
    memoryCandidates: projection.memoryCandidates,
    sessionArchive: projection.sessionArchive,
    repair: projection.repair,
    ...(projection.nativeToolContinuation === undefined
      ? {}
      : { nativeToolContinuation: projection.nativeToolContinuation }),
    tools: projection.tools
  });
  return { context, injectedRehydratedRefs };
}

function projectRepairContext(
  run: RunSnapshot,
  invocations: readonly ToolInvocation[],
  attempts: readonly ToolAttempt[],
  artifacts: ContextArtifactSource
): RepairContext | null {
  const error = run.lastError;
  if (error === null) return null;
  const failedInvocation = [...invocations].reverse().find((invocation) => (
    invocation.status === "unknown"
      ? error.code === "TOOL_RESULT_UNKNOWN"
      : invocation.status === "failed" && invocationErrorCode(invocation) === error.code
  )) ?? null;
  const failedStep = failedInvocation === null || run.currentPlan === null
    ? null
    : run.currentPlan.orderedSteps.find((step) => step.id === failedInvocation.stepId) ?? null;
  const relevantAttempts = failedInvocation === null
    ? []
    : attempts.filter((attempt) => attempt.invocationId === failedInvocation.id);
  return {
    kind: repairKind(error.code, failedInvocation),
    code: error.code,
    issues: repairIssues(error.code, error.message, failedInvocation),
    failedObjective: failedStep?.objective ?? null,
    latestIntent: failedInvocation === null
      ? rejectedToolCall(run, artifacts)
      : {
          toolName: failedInvocation.toolName,
          arguments: JsonValueSchema.parse(failedInvocation.inputJson) as JsonValue
        },
    latestFailedAttempt: failedInvocation === null ? null : {
      invocationRef: `invocation:${failedInvocation.id}`,
      toolName: failedInvocation.toolName,
      inputDigest: failedInvocation.inputDigest,
      status: failedInvocation.status as "failed" | "unknown",
      errorCode: invocationErrorCode(failedInvocation),
      planVersion: failedInvocation.planVersion,
      stepId: failedInvocation.stepId,
      attemptCount: relevantAttempts.length
    }
  };
}

function rejectedToolCall(
  run: RunSnapshot,
  artifacts: ContextArtifactSource
): NonNullable<RepairContext["latestIntent"]> | null {
  if (run.lastError?.detailsArtifact === null || run.lastError?.detailsArtifact === undefined) return null;
  try {
    const raw = JSON.parse(artifacts.getText(run.lastError.detailsArtifact)) as {
      readonly toolCalls?: readonly {
        readonly name?: unknown;
        readonly arguments?: unknown;
      }[];
      readonly toolName?: unknown;
      readonly input?: unknown;
    };
    const call = raw.toolCalls?.[0];
    const parsedCallArguments = JsonValueSchema.safeParse(call?.arguments);
    if (typeof call?.name === "string" && parsedCallArguments.success) {
      return { toolName: call.name, arguments: parsedCallArguments.data as JsonValue };
    }
    const parsedInput = JsonValueSchema.safeParse(raw.input);
    if (typeof raw.toolName === "string" && parsedInput.success) {
      return { toolName: raw.toolName, arguments: parsedInput.data as JsonValue };
    }
  } catch {
    // The rejection diagnostic remains visible even if its archived raw intent
    // is unavailable or was not JSON.
  }
  return null;
}

function invocationErrorCode(invocation: ToolInvocation): string | null {
  const error = invocation.errorJson;
  return error !== null && typeof error === "object" && !Array.isArray(error)
    && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : null;
}

function repairKind(code: string, failedInvocation: ToolInvocation | null): RepairContext["kind"] {
  if (code === "INVALID_MODEL_RESPONSE") return "invalid_response";
  if (code === "COMPLETION_BLOCKED") return "completion_blocked";
  if (code === "APPROVAL_DENIED") return "approval_denied";
  if (failedInvocation !== null) return "tool_failure";
  return "runtime_error";
}

function repairIssues(
  code: string,
  message: string,
  failedInvocation: ToolInvocation | null
): RepairContext["issues"] {
  const addRecoveryGuidance = (issues: RepairContext["issues"]): RepairContext["issues"] => {
    if (failedInvocation === null || issues.some((issue) => issue.kind === "recovery_guidance")) {
      return issues;
    }
    const guidance = failedInvocation.status === "unknown"
      ? "The Tool effect is unknown; do not replay it. Request confirmation or use a safe read-only path."
      : "Treat this as a recoverable Tool failure. Use the returned facts and capability catalog to change the input or choose another Tool; do not repeat unchanged input without changed conditions.";
    return [...issues, { kind: "recovery_guidance", message: guidance }];
  };
  try {
    const parsed = JSON.parse(message) as { readonly issues?: unknown };
    if (Array.isArray(parsed.issues)) {
      const issues = parsed.issues
        .map((item) => (
          item !== null
          && typeof item === "object"
          && typeof (item as { readonly message?: unknown }).message === "string"
            ? {
                kind: parsedRepairIssueKind(
                  (item as { readonly kind?: unknown }).kind,
                  "unresolved_failure"
                ),
                message: (item as { readonly message: string }).message
              }
            : null
        ))
        .filter((item): item is RepairContext["issues"][number] => item !== null);
      if (issues.length > 0) return addRecoveryGuidance(issues);
    }
  } catch {
    // Keep the persisted message as bounded fallback feedback.
  }
  return addRecoveryGuidance([{
    kind: "unresolved_failure",
    message
  }]);
}

function parsedRepairIssueKind(
  value: unknown,
  fallback: RepairContext["issues"][number]["kind"]
): RepairContext["issues"][number]["kind"] {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}
