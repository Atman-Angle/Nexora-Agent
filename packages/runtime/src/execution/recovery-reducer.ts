import type {
  CancellationRequest,
  RunSnapshot,
  ToolAttempt,
  ToolInvocation
} from "../contracts.js";
import { UNPLANNED_STEP_ID } from "../contracts.js";

export type RecoveryAction =
  | { readonly type: "start_prepared"; readonly invocationId: string }
  | { readonly type: "retry_interrupted"; readonly invocationId: string; readonly nextAttemptNumber: number }
  | { readonly type: "retry_transient"; readonly invocationId: string; readonly nextAttemptNumber: number }
  | { readonly type: "await_backoff"; readonly invocationId: string; readonly until: string; readonly nextAttemptNumber: number }
  | { readonly type: "finalize_attempt"; readonly invocationId: string; readonly attemptId: string }
  | { readonly type: "require_confirmation"; readonly invocationId: string }
  | { readonly type: "none"; readonly invocationId: string };

export type RecoveryIssue = {
  readonly code:
    | "RUN_MISMATCH"
    | "PLAN_BINDING_MISMATCH"
    | "BATCH_ORDINAL_INVALID"
    | "ATTEMPT_INVOCATION_MISSING"
    | "ATTEMPT_RUN_MISMATCH"
    | "ATTEMPT_SEQUENCE_INVALID"
    | "MULTIPLE_ACTIVE_ATTEMPTS"
    | "TERMINAL_INVOCATION_HAS_ACTIVE_ATTEMPT";
  readonly message: string;
  readonly invocationId?: string;
};

export type RecoveryState = {
  readonly valid: boolean;
  readonly issues: readonly RecoveryIssue[];
  readonly actions: readonly RecoveryAction[];
  readonly cancellation: "none" | "requested" | "reconciled";
};

export function reduceRecoveryState(input: {
  readonly run: RunSnapshot;
  readonly invocations: readonly ToolInvocation[];
  readonly attempts: readonly ToolAttempt[];
  readonly cancellation: CancellationRequest | null;
  readonly now: string;
  readonly maxAttempts: number;
}): RecoveryState {
  const issues = validatePersistedExecution(input.run, input.invocations, input.attempts);
  const cancellation = input.cancellation?.status ?? "none";
  if (issues.length > 0) return { valid: false, issues, actions: [], cancellation };

  const attemptsByInvocation = new Map<string, ToolAttempt[]>();
  for (const attempt of input.attempts) {
    const attempts = attemptsByInvocation.get(attempt.invocationId) ?? [];
    attempts.push(attempt);
    attemptsByInvocation.set(attempt.invocationId, attempts);
  }
  for (const attempts of attemptsByInvocation.values()) {
    attempts.sort((left, right) => left.attemptNumber - right.attemptNumber);
  }

  const unresolved = input.invocations
    .filter(({ status }) => status === "prepared" || status === "started" || status === "unknown")
    .sort(compareInvocations);
  const actions = unresolved.map((invocation): RecoveryAction => {
    if (invocation.status === "unknown") {
      return { type: "require_confirmation", invocationId: invocation.id };
    }
    const attempts = attemptsByInvocation.get(invocation.id) ?? [];
    const latest = attempts.at(-1);
    if (latest === undefined) {
      return invocation.status === "prepared"
        ? { type: "start_prepared", invocationId: invocation.id }
        : invocation.idempotent
          ? { type: "retry_interrupted", invocationId: invocation.id, nextAttemptNumber: 1 }
          : { type: "require_confirmation", invocationId: invocation.id };
    }
    if (latest.status === "started" || latest.status === "interrupted") {
      return invocation.idempotent
        ? { type: "retry_interrupted", invocationId: invocation.id, nextAttemptNumber: latest.attemptNumber + 1 }
        : { type: "require_confirmation", invocationId: invocation.id };
    }
    if (latest.status === "succeeded" || latest.status === "unknown") {
      return latest.status === "succeeded"
        ? { type: "finalize_attempt", invocationId: invocation.id, attemptId: latest.id }
        : { type: "require_confirmation", invocationId: invocation.id };
    }
    if (
      invocation.idempotent
      && latest.attemptNumber < input.maxAttempts
      && isRetryableTransientToolFailure(latest.errorJson)
    ) {
      if (latest.backoffUntil !== null && Date.parse(latest.backoffUntil) > Date.parse(input.now)) {
        return {
          type: "await_backoff",
          invocationId: invocation.id,
          until: latest.backoffUntil,
          nextAttemptNumber: latest.attemptNumber + 1
        };
      }
      return {
        type: "retry_transient",
        invocationId: invocation.id,
        nextAttemptNumber: latest.attemptNumber + 1
      };
    }
    return { type: "finalize_attempt", invocationId: invocation.id, attemptId: latest.id };
  });
  return { valid: true, issues: [], actions, cancellation };
}

export function isRetryableTransientToolFailure(value: unknown): boolean {
  if (!isRecord(value) || value.retryable !== true) return false;
  const code = typeof value.code === "string" ? value.code.toUpperCase() : "";
  const status = typeof value.status === "number"
    ? value.status
    : typeof value.statusCode === "number"
      ? value.statusCode
      : null;
  return status === 429
    || status === 503
    || code === "429"
    || code === "503"
    || code === "HTTP_429"
    || code === "HTTP_503"
    || code === "RATE_LIMITED"
    || code === "SERVICE_UNAVAILABLE"
    || code === "TOOL_TIMEOUT"
    || code === "ETIMEDOUT"
    || code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "ENETUNREACH"
    || code === "EHOSTUNREACH"
    || code === "EAI_AGAIN";
}

function validatePersistedExecution(
  run: RunSnapshot,
  invocations: readonly ToolInvocation[],
  attempts: readonly ToolAttempt[]
): RecoveryIssue[] {
  const issues: RecoveryIssue[] = [];
  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  for (const invocation of invocations) {
    if (invocation.runId !== run.runId) {
      issues.push(issue("RUN_MISMATCH", `Invocation ${invocation.id} belongs to another Run.`, invocation.id));
    }
    if (invocation.status === "succeeded" || invocation.status === "failed") continue;
    const plan = run.currentPlan;
    const step = plan?.orderedSteps.find(({ id }) => id === invocation.stepId);
    const unplanned = invocation.stepId === UNPLANNED_STEP_ID
      && invocation.checkIds.length === 0;
    const bound = unplanned || (
      plan?.version === invocation.planVersion
      && step !== undefined
      && invocation.checkIds.every((checkId) => step.acceptanceChecks.some(
        (check) => check.id === checkId
      ))
    );
    if (!bound) {
      issues.push(issue("PLAN_BINDING_MISMATCH", `Invocation ${invocation.id} is not bound to the current Plan.`, invocation.id));
    }
  }

  const batches = new Map<string, ToolInvocation[]>();
  for (const invocation of invocations) {
    if (invocation.batchId === null || invocation.batchId === undefined) {
      if (invocation.batchOrdinal !== null && invocation.batchOrdinal !== undefined) {
        issues.push(issue("BATCH_ORDINAL_INVALID", `Invocation ${invocation.id} has an ordinal without a batch.`, invocation.id));
      }
      continue;
    }
    const batch = batches.get(invocation.batchId) ?? [];
    batch.push(invocation);
    batches.set(invocation.batchId, batch);
  }
  for (const [batchId, batch] of batches) {
    const ordinals = batch.map(({ batchOrdinal }) => batchOrdinal);
    const valid = ordinals.every((ordinal) => ordinal !== null && ordinal !== undefined)
      && new Set(ordinals).size === batch.length
      && [...ordinals].sort((left, right) => left! - right!).every((ordinal, index) => ordinal === index);
    if (!valid) {
      issues.push(issue("BATCH_ORDINAL_INVALID", `Batch ${batchId} ordinals are not unique and contiguous.`));
    }
  }

  const attemptsByInvocation = new Map<string, ToolAttempt[]>();
  for (const attempt of attempts) {
    const invocation = invocationById.get(attempt.invocationId);
    if (invocation === undefined) {
      issues.push(issue("ATTEMPT_INVOCATION_MISSING", `Attempt ${attempt.id} has no Invocation.`, attempt.invocationId));
      continue;
    }
    if (attempt.runId !== run.runId || attempt.runId !== invocation.runId) {
      issues.push(issue("ATTEMPT_RUN_MISMATCH", `Attempt ${attempt.id} belongs to another Run.`, invocation.id));
    }
    const invocationAttempts = attemptsByInvocation.get(invocation.id) ?? [];
    invocationAttempts.push(attempt);
    attemptsByInvocation.set(invocation.id, invocationAttempts);
  }
  for (const invocation of invocations) {
    const invocationAttempts = (attemptsByInvocation.get(invocation.id) ?? [])
      .sort((left, right) => left.attemptNumber - right.attemptNumber);
    if (invocationAttempts.some((attempt, index) => attempt.attemptNumber !== index + 1)) {
      issues.push(issue("ATTEMPT_SEQUENCE_INVALID", `Invocation ${invocation.id} attempt numbers are not contiguous.`, invocation.id));
    }
    const activeCount = invocationAttempts.filter(({ status }) => status === "started").length;
    if (activeCount > 1) {
      issues.push(issue("MULTIPLE_ACTIVE_ATTEMPTS", `Invocation ${invocation.id} has multiple active attempts.`, invocation.id));
    }
    if (activeCount > 0 && (invocation.status === "succeeded" || invocation.status === "failed" || invocation.status === "unknown")) {
      issues.push(issue("TERMINAL_INVOCATION_HAS_ACTIVE_ATTEMPT", `Terminal Invocation ${invocation.id} has an active attempt.`, invocation.id));
    }
  }
  return issues;
}

function compareInvocations(left: ToolInvocation, right: ToolInvocation): number {
  const batch = (left.batchId ?? "").localeCompare(right.batchId ?? "", "en");
  if (batch !== 0) return batch;
  const ordinal = (left.batchOrdinal ?? 0) - (right.batchOrdinal ?? 0);
  return ordinal !== 0 ? ordinal : left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id, "en");
}

function issue(
  code: RecoveryIssue["code"],
  message: string,
  invocationId?: string
): RecoveryIssue {
  return invocationId === undefined ? { code, message } : { code, message, invocationId };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
