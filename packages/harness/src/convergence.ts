import type {
  AgentStateView,
  RunEvent,
  ToolInvocation
} from "@nexora/runtime/internal";
import { digestCanonicalJson } from "@nexora/runtime/internal";

export type HarnessConvergenceDiagnostic = {
  readonly fingerprint: string;
  readonly kind: string;
  readonly repeatCount: number;
  readonly strategyFingerprints?: readonly string[];
  readonly observationFingerprints?: readonly string[];
  readonly resources?: readonly string[];
  readonly reads?: number;
  readonly mutations?: number;
  readonly failures?: number;
};

export type HarnessConvergenceDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "record"; readonly payload: Readonly<Record<string, unknown>> }
  | {
      readonly kind: "stop";
      readonly stopReason: "NO_PROGRESS_DETECTED";
      readonly message: string;
      readonly diagnostic: HarnessConvergenceDiagnostic;
    };

/** Deterministic task-convergence policy. Runtime facts are read-only inputs. */
export function decideHarnessConvergence(state: AgentStateView): HarnessConvergenceDecision {
  const inherited = inheritedNoProgressDiagnostic(state);
  if (inherited !== null) return stop(inherited);
  const diagnostic = noProgressDiagnostic(state);
  if (diagnostic === null) return { kind: "continue" };
  if (state.run.budgetsUsed.iterations < (diagnostic.kind === "repeated_invalid_response" ? 2 : 3)) {
    return { kind: "continue" };
  }
  const minimumRepeats = diagnostic.kind === "repeated_invalid_response" ? 2 : 3;
  if (diagnostic.repeatCount < minimumRepeats) return { kind: "continue" };
  if (diagnostic.kind === "repeated_invalid_response") return stop(diagnostic);

  const recentEvents = state.events.slice(-64);
  const warning = [...recentEvents].reverse().find((event) => (
    event.type === "runtime.event"
    && event.payload.name === "execution.no_progress.warning"
    && event.payload.fingerprint === diagnostic.fingerprint
  ));
  if (warning === undefined) {
    const latestRejection = [...recentEvents].reverse().find((event) => event.type === "response.rejected");
    const forbiddenStrategy = diagnostic.kind === "repeated_response_rejection" && latestRejection !== undefined
      ? rejectionStrategyFingerprint(latestRejection)
      : diagnostic.fingerprint;
    return {
      kind: "record",
      payload: {
        name: "execution.no_progress.warning",
        ...diagnostic,
        warningSequence: (recentEvents.at(-1)?.sequence ?? 0) + 1,
        forbiddenStrategy,
        allowedRepairAttempts: 1,
        owner: "harness"
      }
    };
  }

  const afterWarning = recentEvents.filter((event) => event.sequence > warning.sequence);
  const revisedPlan = afterWarning.find((event) => event.type === "plan.set" && event.payload.noOp !== true);
  const attemptedAfterReplan = revisedPlan === undefined ? undefined : afterWarning.find((event) => (
    event.sequence > revisedPlan.sequence && isToolOutcome(event)
  ));
  if (revisedPlan !== undefined && attemptedAfterReplan === undefined) return { kind: "continue" };

  const repairAllowed = afterWarning.find((event) => (
    event.type === "runtime.event"
    && event.payload.name === "execution.no_progress.repair_allowed"
    && event.payload.warningSequence === warning.sequence
  ));
  if (repairAllowed !== undefined) {
    const authoritativeAttempt = afterWarning.find((event) => (
      event.sequence > repairAllowed.sequence && isToolOutcome(event)
    ));
    if (authoritativeAttempt !== undefined) {
      return probationResolved(warning.sequence, authoritativeAttempt);
    }
  } else {
    const authoritativeAttempt = afterWarning.find(isToolOutcome);
    if (authoritativeAttempt !== undefined
      && isMateriallyDifferentProbationAttempt(state, authoritativeAttempt, warning.payload)) {
      return probationResolved(warning.sequence, authoritativeAttempt);
    }
    const rejection = [...afterWarning].reverse().find((event) => event.type === "response.rejected");
    if (rejection !== undefined && correctableRejection(rejection)) {
      const attemptedStrategy = rejectionStrategyFingerprint(rejection);
      if (attemptedStrategy !== warning.payload.forbiddenStrategy) {
        return {
          kind: "record",
          payload: {
            name: "execution.no_progress.repair_allowed",
            fingerprint: diagnostic.fingerprint,
            warningSequence: warning.sequence,
            forbiddenStrategy: warning.payload.forbiddenStrategy,
            attemptedStrategy,
            allowedRepairAttempts: 1,
            owner: "harness"
          }
        };
      }
    }
  }
  return stop(diagnostic);
}

function stop(diagnostic: HarnessConvergenceDiagnostic): HarnessConvergenceDecision {
  return {
    kind: "stop",
    stopReason: "NO_PROGRESS_DETECTED",
    message: `Harness bounded ${diagnostic.kind} after ${diagnostic.repeatCount} repeated ineffective action(s).`,
    diagnostic
  };
}

function probationResolved(warningSequence: number, attempt: RunEvent): HarnessConvergenceDecision {
  return {
    kind: "record",
    payload: {
      name: "execution.no_progress.probation_resolved",
      warningSequence,
      progressSequence: attempt.sequence,
      outcome: attempt.type === "tool.failed" ? "failed" : "succeeded",
      ...(typeof attempt.payload.payloadDigest === "string" ? { payloadDigest: attempt.payload.payloadDigest } : {}),
      owner: "harness"
    }
  };
}

function noProgressDiagnostic(state: AgentStateView): HarnessConvergenceDiagnostic | null {
  const allEvents = state.events.slice(-64);
  const lastInputResume = [...allEvents].reverse().find((event) => (
    event.type === "run.resumed" && typeof event.payload.inputSequence === "number"
  ));
  const probationResolvedEvent = [...allEvents].reverse().find((event) => (
    event.type === "runtime.event" && event.payload.name === "execution.no_progress.probation_resolved"
  ));
  const segmentBoundary = [lastInputResume, probationResolvedEvent]
    .filter((event): event is RunEvent => event !== undefined)
    .sort((left, right) => right.sequence - left.sequence)[0];
  const inputSegmentEvents = allEvents.filter((event) => (
    lastInputResume === undefined || event.sequence > lastInputResume.sequence
  ));
  const inputSegmentRejections = inputSegmentEvents
    .filter((event) => event.type === "response.rejected" && isStateRejection(event))
    .slice(-8);
  const progressAnchorSequence = inputSegmentEvents.reduce((sequence, event) => (
    isAuthoritativeProgressEvent(event) ? event.sequence : sequence
  ), lastInputResume?.sequence ?? 0);
  const repeatedStateBoundary = repeatedStateIssueWithinSegments(inputSegmentRejections, progressAnchorSequence);
  if (repeatedStateBoundary !== null) {
    return {
      fingerprint: digestCanonicalJson({
        kind: "invalid_state_transition",
        strategyFingerprint: repeatedStateBoundary.fingerprint,
        inputSequence: lastInputResume?.payload.inputSequence ?? 1
      }),
      kind: "repeated_invalid_response",
      repeatCount: repeatedStateBoundary.repeatCount,
      strategyFingerprints: [repeatedStateBoundary.fingerprint]
    };
  }

  const segmentStartedAt = segmentBoundary?.occurredAt ?? "";
  const invocations = state.invocations.filter((invocation) => invocation.startedAt >= segmentStartedAt).slice(-24);
  const resourceChurn = resourceChurnDiagnostic(state, invocations);
  if (resourceChurn !== null) return resourceChurn;
  const latest = invocations.at(-1);
  if (latest !== undefined && (latest.status === "succeeded" || latest.status === "failed")) {
    const strategyFingerprint = invocationStrategyFingerprint(latest)!;
    const observationFingerprint = invocationObservationFingerprint(latest)!;
    const actionFingerprint = digestCanonicalJson({ strategyFingerprint, observationFingerprint });
    const completed = invocations.filter((invocation) => invocation.status === "succeeded" || invocation.status === "failed");
    let repeatCount = 0;
    let convergenceAnchor = `boundary:${segmentBoundary?.sequence ?? 0}`;
    for (let index = completed.length - 1; index >= 0; index -= 1) {
      const invocation = completed[index]!;
      const candidateFingerprint = digestCanonicalJson({
        strategyFingerprint: invocationStrategyFingerprint(invocation),
        observationFingerprint: invocationObservationFingerprint(invocation)
      });
      if (candidateFingerprint !== actionFingerprint) {
        convergenceAnchor = invocation.id;
        break;
      }
      repeatCount += 1;
    }
    if (repeatCount >= 3) {
      return {
        fingerprint: digestCanonicalJson({ actionFingerprint, convergenceAnchor }),
        kind: latest.status === "failed" ? "repeated_tool_failure" : "repeated_tool_result",
        repeatCount,
        strategyFingerprints: [strategyFingerprint],
        observationFingerprints: [observationFingerprint]
      };
    }
  }

  const events = allEvents.filter((event) => segmentBoundary === undefined || event.sequence > segmentBoundary.sequence);
  const convergenceAnchor = events.reduce((sequence, event) => {
    const outcome = isAuthoritativeProgressEvent(event);
    const acceptedPlan = event.type === "plan.set" && event.payload.noOp !== true;
    return outcome || acceptedPlan ? event.sequence : sequence;
  }, segmentBoundary?.sequence ?? 0);
  const convergenceEvents = events.filter((event) => event.sequence > convergenceAnchor);
  const noOps = convergenceEvents.filter((event) => event.type === "plan.set" && event.payload.noOp === true).slice(-4);
  if (noOps.length >= 3) {
    return {
      fingerprint: digestCanonicalJson({ kind: "equivalent_plan", version: noOps.at(-1)?.payload.version, convergenceAnchor }),
      kind: "equivalent_plan",
      repeatCount: noOps.length,
      strategyFingerprints: [digestCanonicalJson({ kind: "equivalent_plan", version: noOps.at(-1)?.payload.version })]
    };
  }
  const rejections = convergenceEvents.filter((event) => event.type === "response.rejected").slice(-6);
  if (rejections.length >= 2) {
    const repeatedIssue = repeatedRejectionIssue(rejections);
    if (repeatedIssue !== null) {
      return {
        fingerprint: digestCanonicalJson({ kind: "invalid_response_issue", strategyFingerprint: repeatedIssue.fingerprint, convergenceAnchor }),
        kind: "repeated_invalid_response",
        repeatCount: repeatedIssue.repeatCount,
        strategyFingerprints: [repeatedIssue.fingerprint]
      };
    }
    const latestMessage = rejections.at(-1)?.payload.message;
    const equivalent = rejections.filter((event) => event.payload.message === latestMessage).length;
    if (equivalent >= 3) {
      return {
        fingerprint: digestCanonicalJson({ kind: "response_rejected", message: latestMessage, convergenceAnchor }),
        kind: "repeated_response_rejection",
        repeatCount: equivalent
      };
    }
    if (equivalent >= 2 && rejectionKind(latestMessage) === "schema") {
      return {
        fingerprint: digestCanonicalJson({ kind: "invalid_response", message: latestMessage, convergenceAnchor }),
        kind: "repeated_invalid_response",
        repeatCount: equivalent
      };
    }
  }
  return null;
}

function inheritedNoProgressDiagnostic(state: AgentStateView): HarnessConvergenceDiagnostic | null {
  const allCurrentEvents = state.events;
  const correctiveResume = [...allCurrentEvents].reverse().find((event) => (
    event.type === "run.resumed" && event.payload.reason === "no_progress_corrective_input"
  ));
  const sameRunBlockedEvent = correctiveResume === undefined ? undefined : [...allCurrentEvents].reverse().find((event) => (
    event.sequence < correctiveResume.sequence
    && (event.type === "run.blocked" || event.type === "run.failed")
    && event.payload.stopReason === "NO_PROGRESS_DETECTED"
  ));
  const blockedAncestor = sameRunBlockedEvent === undefined
    ? [...state.continuationAncestors].reverse().find(({ run }) => (
        (run.status === "blocked" || run.status === "failed") && run.stopReason === "NO_PROGRESS_DETECTED"
      ))
    : undefined;
  const blockedEvent = sameRunBlockedEvent ?? (blockedAncestor === undefined ? undefined : [...blockedAncestor.events].reverse().find((event) => (
    (event.type === "run.blocked" || event.type === "run.failed") && event.payload.stopReason === "NO_PROGRESS_DETECTED"
  )));
  if (blockedEvent === undefined) return null;
  const priorEvents = sameRunBlockedEvent === undefined
    ? blockedAncestor!.events
    : allCurrentEvents.filter((event) => event.sequence <= sameRunBlockedEvent.sequence);
  const currentEvents = correctiveResume === undefined
    ? allCurrentEvents
    : allCurrentEvents.filter((event) => event.sequence > correctiveResume.sequence);
  const priorSource = sameRunBlockedEvent === undefined ? blockedAncestor!.invocations : state.invocations;
  const priorInvocations = invocationsReferencedByEvents(priorSource, priorEvents);
  const currentInvocations = invocationsReferencedByEvents(state.invocations, currentEvents);
  const value = blockedEvent.payload.diagnostic;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prior = value as Readonly<Record<string, unknown>>;
  const kind = typeof prior.kind === "string" ? prior.kind : "repeated_action";
  const priorRepeatCount = typeof prior.repeatCount === "number" ? prior.repeatCount : 1;
  const priorStrategies = stringArray(prior.strategyFingerprints) ?? inheritedStrategyFingerprints(kind, priorEvents, priorInvocations);
  const priorObservations = stringArray(prior.observationFingerprints) ?? inheritedObservationFingerprints(kind, priorInvocations);
  if (hasAuthoritativeProgressBeyondStrategy(currentEvents, currentInvocations, priorStrategies, priorObservations)) return null;
  const currentStrategies = kind === "resource_churn"
    ? resourceChurnDiagnostic(state, currentInvocations)?.strategyFingerprints ?? []
    : currentFailureStrategyFingerprints(kind, currentEvents, currentInvocations);
  const repeatedStrategies = currentStrategies.filter((item) => priorStrategies.includes(item));
  if (repeatedStrategies.length === 0) return null;
  return {
    fingerprint: digestCanonicalJson({
      kind: "inherited_no_progress",
      sourceRunId: blockedAncestor?.run.runId ?? state.run.runId,
      sourceEventSequence: blockedEvent.sequence,
      repeatedStrategies
    }),
    kind,
    repeatCount: priorRepeatCount + 1,
    strategyFingerprints: repeatedStrategies,
    ...(stringArray(prior.resources) === null ? {} : { resources: stringArray(prior.resources)! })
  };
}

function resourceChurnDiagnostic(
  state: AgentStateView,
  invocations: readonly ToolInvocation[]
): HarnessConvergenceDiagnostic | null {
  const effects = new Map(state.tools.map((tool) => [
    tool.contract.identity.name,
    tool.contract.execution.effect.kind
  ]));
  const resources = new Map<string, { reads: number; mutations: number; failures: number }>();
  for (const invocation of invocations) {
    if (invocation.status !== "succeeded" && invocation.status !== "failed") continue;
    const effect = effects.get(invocation.toolName);
    if (effect !== "read" && effect !== "write") continue;
    const resource = invocationResource(state, invocation);
    if (resource === null) continue;
    const counts = resources.get(resource) ?? { reads: 0, mutations: 0, failures: 0 };
    if (effect === "read") counts.reads += 1;
    else {
      counts.mutations += 1;
      if (invocation.status === "failed") counts.failures += 1;
    }
    resources.set(resource, counts);
  }
  const candidate = [...resources.entries()]
    .filter(([, counts]) => counts.reads >= 4 && counts.mutations >= 3)
    .sort(([leftPath, left], [rightPath, right]) => (
      right.reads + right.mutations - left.reads - left.mutations
      || right.failures - left.failures
      || leftPath.localeCompare(rightPath)
    ))[0];
  if (candidate === undefined) return null;
  const [resource, counts] = candidate;
  return {
    fingerprint: digestCanonicalJson({ kind: "resource_churn", resource }),
    kind: "resource_churn",
    repeatCount: counts.reads + counts.mutations,
    strategyFingerprints: [digestCanonicalJson({ kind: "resource_churn", resource })],
    resources: [resource],
    ...counts
  };
}

function invocationResource(state: AgentStateView, invocation: ToolInvocation): string | null {
  const input = invocation.inputJson;
  const path = input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as { readonly path?: unknown }).path
    : undefined;
  if (typeof path === "string" && path.trim().length > 0) return canonicalResource(path);
  const evidence = state.run.evidence.find((candidate) => candidate.invocationId === invocation.id);
  if (evidence !== undefined) return canonicalResource(evidence.subjectRef);
  const attempt = state.attempts.filter((candidate) => (
    candidate.invocationId === invocation.id && candidate.subjectRef !== null
  )).at(-1);
  return attempt?.subjectRef === null || attempt?.subjectRef === undefined ? null : canonicalResource(attempt.subjectRef);
}

function isMateriallyDifferentProbationAttempt(
  state: AgentStateView,
  event: RunEvent,
  warning: Readonly<Record<string, unknown>>
): boolean {
  if (warning.kind !== "resource_churn") return false;
  const warnedResources = stringArray(warning.resources) ?? [];
  const invocationId = typeof event.payload.invocationId === "string" ? event.payload.invocationId : null;
  const invocation = invocationId === null ? undefined : state.invocations.find((item) => item.id === invocationId);
  if (invocation === undefined) return false;
  const resource = invocationResource(state, invocation);
  return resource !== null && !warnedResources.includes(resource);
}

function hasAuthoritativeProgressBeyondStrategy(
  events: readonly RunEvent[],
  invocations: readonly ToolInvocation[],
  priorStrategies: readonly string[],
  priorObservations: readonly string[]
): boolean {
  if (events.some((event) => (
    event.type === "tool.reconciled"
    || event.type === "validation.passed"
    || event.type === "recovery.confirmed_succeeded"
    || event.type === "recovery.confirmed_failed"
    || event.type === "branch.merged"
    || event.type === "run.succeeded"
  ))) return true;
  return invocations.some((invocation) => {
    const strategy = invocationStrategyFingerprint(invocation);
    if (strategy === null) return false;
    if (!priorStrategies.includes(strategy)) return true;
    const observation = invocationObservationFingerprint(invocation);
    return observation !== null && !priorObservations.includes(observation);
  });
}

function repeatedStateIssueWithinSegments(rejections: readonly RunEvent[], progressAnchorSequence: number) {
  const totals = new Map<string, number>();
  const windows = new Map<string, number>();
  for (const rejection of rejections) {
    for (const fingerprint of rejectionIssueFingerprints(rejection)) {
      totals.set(fingerprint, (totals.get(fingerprint) ?? 0) + 1);
      if (rejection.sequence > progressAnchorSequence) windows.set(fingerprint, (windows.get(fingerprint) ?? 0) + 1);
    }
  }
  let best: { fingerprint: string; repeatCount: number } | null = null;
  for (const fingerprint of new Set([...totals.keys(), ...windows.keys()])) {
    const inWindow = windows.get(fingerprint) ?? 0;
    const total = totals.get(fingerprint) ?? 0;
    if (inWindow < 2 && total < 3) continue;
    const repeatCount = inWindow >= 2 ? inWindow : total;
    if (best === null || repeatCount > best.repeatCount) best = { fingerprint, repeatCount };
  }
  return best;
}

function repeatedRejectionIssue(rejections: readonly RunEvent[]) {
  const counts = new Map<string, number>();
  for (const rejection of rejections) {
    for (const fingerprint of rejectionIssueFingerprints(rejection)) {
      counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    }
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([leftFingerprint, leftCount], [rightFingerprint, rightCount]) => (
      rightCount - leftCount || leftFingerprint.localeCompare(rightFingerprint)
    ))[0];
  return repeated === undefined ? null : { fingerprint: repeated[0], repeatCount: repeated[1] };
}

function rejectionIssueFingerprints(event: RunEvent): readonly string[] {
  if (event.type !== "response.rejected") return [];
  const diagnostic = event.payload.diagnostic;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return [];
  const value = diagnostic as { readonly kind?: unknown; readonly issues?: unknown };
  if (!Array.isArray(value.issues)) return [];
  return value.issues.flatMap((issue) => {
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) return [];
    const item = issue as { readonly path?: unknown; readonly code?: unknown; readonly message?: unknown };
    if (typeof item.path !== "string" || typeof item.code !== "string") return [];
    return [digestCanonicalJson({
      kind: typeof value.kind === "string" ? value.kind : "unknown",
      path: item.path,
      code: item.code,
      ...(value.kind === "state" && item.code === "response_rejected" && typeof item.message === "string"
        ? { message: item.message }
        : {})
    })];
  });
}

function invocationStrategyFingerprint(invocation: ToolInvocation): string | null {
  if (invocation.status !== "succeeded" && invocation.status !== "failed") return null;
  return digestCanonicalJson({ toolName: invocation.toolName, inputDigest: invocation.inputDigest });
}

function invocationObservationFingerprint(invocation: ToolInvocation): string | null {
  if (invocation.status !== "succeeded" && invocation.status !== "failed") return null;
  const outcome = invocation.status === "succeeded" ? invocation.resultJson : normalizedError(invocation.errorJson);
  return digestCanonicalJson({ status: invocation.status, outcome });
}

function normalizedError(error: unknown): unknown {
  if (error === null || typeof error !== "object" || Array.isArray(error)) return error;
  const value = error as { readonly code?: unknown; readonly retryable?: unknown; readonly details?: unknown };
  return { code: value.code, retryable: value.retryable, ...(value.details === undefined ? {} : { details: value.details }) };
}

function inheritedObservationFingerprints(kind: string, invocations: readonly ToolInvocation[]): readonly string[] {
  if (kind !== "repeated_tool_failure" && kind !== "repeated_tool_result") return [];
  return invocations.flatMap((invocation) => {
    const fingerprint = invocationObservationFingerprint(invocation);
    return fingerprint === null ? [] : [fingerprint];
  });
}

function inheritedStrategyFingerprints(kind: string, events: readonly RunEvent[], invocations: readonly ToolInvocation[]): readonly string[] {
  if (kind === "repeated_invalid_response" || kind === "repeated_response_rejection") {
    const rejection = [...events].reverse().find((event) => event.type === "response.rejected");
    return rejection === undefined ? [] : rejectionIssueFingerprints(rejection);
  }
  if (kind === "repeated_tool_failure" || kind === "repeated_tool_result") {
    const latest = [...invocations].reverse().find((item) => item.status === "succeeded" || item.status === "failed");
    const fingerprint = latest === undefined ? null : invocationStrategyFingerprint(latest);
    return fingerprint === null ? [] : [fingerprint];
  }
  if (kind === "equivalent_plan") {
    const plan = [...events].reverse().find((event) => event.type === "plan.set" && event.payload.noOp === true);
    return plan === undefined ? [] : [digestCanonicalJson({ kind, version: plan.payload.version })];
  }
  if (kind === "resource_churn") {
    const blocked = [...events].reverse().find((event) => event.type === "run.blocked" || event.type === "run.failed");
    const diagnostic = blocked?.payload.diagnostic;
    const resources = diagnostic !== null && typeof diagnostic === "object" && !Array.isArray(diagnostic)
      ? stringArray((diagnostic as { readonly resources?: unknown }).resources) ?? []
      : [];
    return resources.map((resource) => digestCanonicalJson({ kind, resource }));
  }
  return [];
}

function currentFailureStrategyFingerprints(kind: string, events: readonly RunEvent[], invocations: readonly ToolInvocation[]): readonly string[] {
  if (kind === "repeated_invalid_response" || kind === "repeated_response_rejection") {
    return events.flatMap(rejectionIssueFingerprints);
  }
  if (kind === "repeated_tool_failure" || kind === "repeated_tool_result") {
    return invocations.flatMap((invocation) => {
      const fingerprint = invocationStrategyFingerprint(invocation);
      return fingerprint === null ? [] : [fingerprint];
    });
  }
  if (kind === "equivalent_plan") {
    return events.filter((event) => event.type === "plan.set" && event.payload.noOp === true)
      .map((event) => digestCanonicalJson({ kind, version: event.payload.version }));
  }
  if (kind === "resource_churn") {
    return invocations.flatMap((invocation) => {
      const input = invocation.inputJson;
      if (invocation.status !== "succeeded" && invocation.status !== "failed") return [];
      if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
      const path = (input as { readonly path?: unknown }).path;
      return typeof path === "string" ? [digestCanonicalJson({ kind, resource: canonicalResource(path) })] : [];
    });
  }
  return [];
}

function invocationsReferencedByEvents(invocations: readonly ToolInvocation[], events: readonly RunEvent[]): readonly ToolInvocation[] {
  const ids = new Set(events.flatMap((event) => typeof event.payload.invocationId === "string" ? [event.payload.invocationId] : []));
  return invocations.filter((invocation) => ids.has(invocation.id));
}

function isStateRejection(event: RunEvent): boolean {
  const diagnostic = event.type === "response.rejected" ? event.payload.diagnostic : null;
  return diagnostic !== null && typeof diagnostic === "object" && !Array.isArray(diagnostic)
    && (diagnostic as { readonly kind?: unknown }).kind === "state";
}

function correctableRejection(event: RunEvent): boolean {
  if (event.type !== "response.rejected") return false;
  const diagnostic = event.payload.diagnostic;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return false;
  const recovery = (diagnostic as { readonly recovery?: unknown }).recovery;
  if (recovery === null || typeof recovery !== "object" || Array.isArray(recovery)) return false;
  const value = recovery as { readonly sideEffect?: unknown; readonly doNotRepeat?: unknown; readonly nextAction?: unknown };
  return value.sideEffect === "none" && value.doNotRepeat === true
    && typeof value.nextAction === "string" && value.nextAction.trim().length > 0;
}

function rejectionStrategyFingerprint(event: RunEvent): string {
  return digestCanonicalJson({ diagnostic: event.type === "response.rejected" ? event.payload.diagnostic : null });
}

function isAuthoritativeProgressEvent(event: RunEvent): boolean {
  return event.type === "tool.succeeded" || event.type === "tool.failed" || event.type === "tool.reconciled"
    || event.type === "validation.passed" || event.type === "recovery.confirmed_succeeded"
    || event.type === "recovery.confirmed_failed" || event.type === "branch.merged";
}

function isToolOutcome(event: RunEvent): boolean {
  return event.type === "tool.succeeded" || event.type === "tool.failed" || event.type === "tool.reconciled";
}

function rejectionKind(message: unknown): string | null {
  if (typeof message !== "string") return null;
  try {
    const parsed = JSON.parse(message) as { readonly kind?: unknown };
    return typeof parsed.kind === "string" ? parsed.kind : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function canonicalResource(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}
