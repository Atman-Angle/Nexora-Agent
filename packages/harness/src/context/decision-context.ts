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
  ContinuationTurn,
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
import type { SkillDecisionContext } from "../skills.js";

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
  readonly skills?: SkillDecisionContext;
}): DecisionContextResult {
  const { run, store, workspace, tools, artifacts } = args;
  const invocations = store.listToolInvocations(run.runId);
  const events = store.listEvents(run.runId);
  const hasPriorAutomaticCompaction = events.some((event) => (
    event.type === "model.requested" && event.payload.compacted === true
  ));
  const observations = projectRelevantToolObservations(run, invocations);
  const continuation = projectContinuationTurns(store, run.runId);
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
  const allRehydratedFacts = accepted.filter((fact) => {
    if (seenFacts.has(fact.ref)) return false;
    seenFacts.add(fact.ref);
    return true;
  });
  const rehydratedFacts = hasPriorAutomaticCompaction
    ? allRehydratedFacts.filter((fact) => fact.origin !== "harness_helpful")
    : allRehydratedFacts;
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
    historyCandidates: hasPriorAutomaticCompaction ? [] : historyCandidates,
    memoryCandidates: hasPriorAutomaticCompaction ? [] : memoryCandidates,
    ...(hasPriorAutomaticCompaction ? {} : { sessionArchive: projectSessionArchive({ run, events }) }),
    repair: projectRepairContext(run, invocations, store.listToolAttempts(run.runId), artifacts, events)
      ?? projectContinuationRecoveryRepair(continuation),
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
    })),
    skills: args.skills ?? {
      catalogDigest: digestJson([]),
      catalog: [],
      active: [],
      activeDigest: digestJson([])
    }
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
    ...(projection.sessionArchive === undefined ? {} : { sessionArchive: projection.sessionArchive }),
    repair: projection.repair,
    ...(projection.nativeToolContinuation === undefined
      ? {}
      : { nativeToolContinuation: projection.nativeToolContinuation }),
    tools: projection.tools,
    skills: projection.skills
  });
  return { context, injectedRehydratedRefs };
}

function projectRepairContext(
  run: RunSnapshot,
  invocations: readonly ToolInvocation[],
  attempts: readonly ToolAttempt[],
  artifacts: ContextArtifactSource,
  events: ReturnType<ContextSource["listEvents"]>
): RepairContext | null {
  const error = run.lastError;
  if (error === null) return projectNoProgressRepair(events);
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
  const rejectionRecovery = parseRejectionRecovery(error.code, error.message)
    ?? toolFailureRecovery(failedInvocation);
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
    },
    ...(rejectionRecovery === undefined ? {} : { recovery: rejectionRecovery })
  };
}

function parseRejectionRecovery(
  code: string,
  message: string
): RepairContext["recovery"] | undefined {
  if (code !== "INVALID_MODEL_RESPONSE") return undefined;
  try {
    const parsed = JSON.parse(message) as { readonly recovery?: unknown };
    const recovery = parsed.recovery;
    if (recovery === null || typeof recovery !== "object" || Array.isArray(recovery)) return undefined;
    const value = recovery as {
      readonly sideEffect?: unknown;
      readonly doNotRepeat?: unknown;
      readonly nextAction?: unknown;
      readonly fields?: unknown;
    };
    if (
      (value.sideEffect !== "none" && value.sideEffect !== "unknown" && value.sideEffect !== "possible")
      || typeof value.doNotRepeat !== "boolean"
      || typeof value.nextAction !== "string"
    ) return undefined;
    const fields = Array.isArray(value.fields)
      ? value.fields.flatMap((field) => {
          if (field === null || typeof field !== "object" || Array.isArray(field)) return [];
          const item = field as { readonly path?: unknown; readonly code?: unknown; readonly expectedFormat?: unknown };
          if (typeof item.path !== "string" || typeof item.code !== "string") return [];
          return [{
            path: item.path,
            code: item.code,
            ...(typeof item.expectedFormat === "string" ? { expectedFormat: item.expectedFormat } : {})
          }];
        })
      : undefined;
    return {
      sideEffect: value.sideEffect,
      doNotRepeat: value.doNotRepeat,
      nextAction: value.nextAction,
      ...(fields === undefined ? {} : { fields })
    };
  } catch {
    return undefined;
  }
}

function toolFailureRecovery(invocation: ToolInvocation | null): RepairContext["recovery"] | undefined {
  if (invocation === null) return undefined;
  const code = invocationErrorCode(invocation);
  if (code === null) return undefined;
  if (invocation.status === "unknown") {
    return {
      sideEffect: "unknown",
      doNotRepeat: true,
      nextAction: "The Tool effect is unknown; do not replay it. Request confirmation or use a safe read-only path."
    };
  }
  if (code === "PROCESS_START_FAILED") {
    return {
      sideEffect: "none",
      doNotRepeat: true,
      nextAction: "The process did not start. Use the returned executable facts, such as the platform-specific command form (for example npm.cmd), and retry only with a changed executable or arguments."
    };
  }
  if (code === "PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME") {
    return {
      sideEffect: "none",
      doNotRepeat: true,
      nextAction: "The protected mutation batch was rejected as a whole; no mutation was executed. Submit exactly one protected mutation or one complete write, and do not resend the rejected batch."
    };
  }
  return {
    sideEffect: "possible",
    doNotRepeat: false,
    nextAction: "Use the Tool failure facts and change the input or choose another Tool; do not repeat unchanged input without changed conditions."
  };
}

function projectNoProgressRepair(
  events: ReturnType<ContextSource["listEvents"]>
): RepairContext | null {
  const warning = [...events].reverse().find((event) => (
    event.type === "runtime.event"
    && event.payload.name === "execution.no_progress.warning"
  ));
  if (warning === undefined) return null;
  const hasLaterProgress = events.some((event) => (
    event.sequence > warning.sequence
    && (
      event.type === "tool.succeeded"
      || event.type === "tool.failed"
      || event.type === "tool.recovered"
      || event.type === "run.resumed"
      || (event.type === "plan.set" && event.payload.noOp !== true)
    )
  ));
  if (hasLaterProgress) return null;
  const resources = Array.isArray(warning.payload.resources)
    ? warning.payload.resources.filter((item): item is string => typeof item === "string").slice(0, 4)
    : [];
  const kind = typeof warning.payload.kind === "string" ? warning.payload.kind : "repeated_action";
  const repeatCount = typeof warning.payload.repeatCount === "number" ? warning.payload.repeatCount : 3;
  const reads = typeof warning.payload.reads === "number" ? warning.payload.reads : null;
  const mutations = typeof warning.payload.mutations === "number" ? warning.payload.mutations : null;
  const failures = typeof warning.payload.failures === "number" ? warning.payload.failures : null;
  const resourceSuffix = resources.length === 0 ? "" : ` for ${resources.join(", ")}`;
  const countSuffix = reads === null || mutations === null
    ? ""
    : ` (${reads} reads, ${mutations} mutations${failures === null ? "" : `, ${failures} failed`})`;
  return {
    kind: "runtime_error",
    code: "NO_PROGRESS_WARNING",
    issues: [{
      kind: "recovery_guidance",
      message: `Execution repeated ${kind}${resourceSuffix}${countSuffix} ${repeatCount} times. The latest resource facts are authoritative; verify the current result or finish, and do not continue the same read/mutation cycle without a new failure or digest.`
    }],
    failedObjective: null,
    latestIntent: null,
    latestFailedAttempt: null
  };
}

function projectContinuationRecoveryRepair(
  continuation: readonly ContinuationTurn[]
): RepairContext | null {
  const blocked = [...continuation].reverse().find((turn) => turn.status === "blocked");
  if (blocked?.outcome?.exactCause?.code !== "NO_PROGRESS_DETECTED") return null;
  return {
    kind: "runtime_error",
    code: "NO_PROGRESS_RECOVERY",
    issues: [{
      kind: "recovery_guidance",
      message: "The previous Run was blocked after repeating a strategy without new authoritative facts. Use its confirmed facts and choose a materially different action; do not replay the previous read/mutation cycle."
    }],
    failedObjective: null,
    latestIntent: null,
    latestFailedAttempt: null
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
  if (code === "INVALID_MODEL_RESPONSE") {
    try {
      const parsed = JSON.parse(message) as { readonly issues?: unknown; readonly recovery?: { readonly nextAction?: unknown } };
      if (Array.isArray(parsed.issues)) {
        const issues = parsed.issues.flatMap((item) => (
          item !== null
          && typeof item === "object"
          && typeof (item as { readonly message?: unknown }).message === "string"
            ? [{
                kind: parsedRepairIssueKind((item as { readonly code?: unknown }).code, "unresolved_failure"),
                message: (item as { readonly message: string }).message
              }]
            : []
        ));
        const nextAction = parsed.recovery?.nextAction;
        if (typeof nextAction === "string") issues.push({ kind: "recovery_guidance", message: nextAction });
        if (issues.length > 0) return issues;
      }
    } catch {
      // Fall through to the bounded persisted-message projection.
    }
  }
  const addRecoveryGuidance = (issues: RepairContext["issues"]): RepairContext["issues"] => {
    if (failedInvocation === null || issues.some((issue) => issue.kind === "recovery_guidance")) {
      return issues;
    }
    const recovery = toolFailureRecovery(failedInvocation);
    const guidance = recovery?.nextAction
      ?? "Treat this as a recoverable Tool failure. Use the returned facts and capability catalog to change the input or choose another Tool; do not repeat unchanged input without changed conditions.";
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
