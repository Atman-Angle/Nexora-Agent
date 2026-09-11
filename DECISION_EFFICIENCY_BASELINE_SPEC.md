# Decision Efficiency Baseline Specification

**File:** `DECISION_EFFICIENCY_BASELINE_SPEC.md`
**Status:** Draft — baseline / token-accounting specification only
**Date:** 2026-09-07
**Baseline branch:** `codex/harness-optimization-production-baseline`
**Predecessor state:** Context Harness Phase B scoped closure = verified / production-ready

> This document defines only the Decision Efficiency baseline, Token Accounting, telemetry / attribution contract, baseline task set, and the Go / No-Go gate for the first optimization candidate. It does not approve or implement any optimization. It must not be used as authority to change Runtime, Harness, Provider, Approval, Evidence, Completion Gate, or Context Phase B behavior.

## 1. Status

This is a specification for measurement and decision-making, not an implementation design and not an optimization approval.

This delivery permits only the creation of this document. It must not modify production code, tests, Provider request semantics, token meters, retry/cache policy, Runtime Authority, Tool Invocation Authority, Approval, Evidence, Completion Gate, Context eviction, compaction, rehydration, or Phase B projection.

The current workspace is the only reality baseline. Existing uncommitted changes and untracked files must remain untouched. This specification does not roll back, overwrite, or “clean” them.

Current conclusions from the 2026-09-07 repository audit are:

1. Context Harness Phase B is closed for its scoped candidate: native continuation observation dedupe is verified and production-ready, enabled by default, with `off` retained only as an experiment control.
2. The Phase B closure probe used `qwen3.8-flash` and `native_tools`, repeating each off/on treatment three times for repair, recovery, completion, and rehydration: 24 samples total.
3. All 24 samples passed valid-action and causal-fact checks. Each paired scenario reduced actual Provider input by 113 tokens and final request bytes by 383 bytes; substantive duplicate payloads fell from 1 to 0.
4. Long-run continuity is quality, safety, and memory-continuity evidence, but off/on trajectories differ. Their total token counts must not be presented as a causal A/B saving.
5. Final Provider body bytes and Provider-reported actual usage are already observable. Current `measuredInputTokens`, however, is a budget/capacity estimate and is not proof of complete Provider-visible wire token accounting.
6. There is no formal run-level Decision Efficiency aggregation contract yet, and current section views are not a tokenizer-exact, non-overlapping token partition.

Therefore, this phase first establishes a trustworthy baseline and attribution contract. No deletion, compression, filtering, batching, or projection change is inferred from an apparent duplicate.

## 2. Outcome

After the baseline is implemented, Nexora must answer the following from real Runtime, Harness, Provider, and evaluator telemetry—not from documentation estimates:

```text
How many input tokens did each Provider attempt actually receive?
Which logical model call did it belong to, and did it retry?
Where did those tokens come from: stable/system, dynamic context,
continuation, Provider tools, response format, wrapper, or envelope?

How many gross input tokens did a successful task consume?
How many logical calls, Provider attempts, and response Tool calls occurred?
How many input tokens and model calls were needed per effective action?
What was the wall-clock cost per successful task?

What Tool batch sizes, concurrency values, and retry counts occurred?
Which model calls actually advanced the task?
Which were no-tool, repair, rejection, no-progress, retry, or Provider failure?

What were the largest fixed, repeated, and non-productive token costs?
Would a candidate produce an explainable benefit without degrading
success, safety, Authority, recovery, or Context Phase B behavior?
```

Priority order:

1. correctness and safety;
2. task success and Completion Gate semantics;
3. comparable reduction in gross Provider input tokens;
4. reduction of logical calls, wasted calls, and wall-clock without reducing effective progress;
5. use of `input tokens / effective action` to expose false efficiency such as fewer calls but no advancement.

The following invariants must hold:

```text
success rate must not decrease
false success must not increase
Runtime Authority must not change
Approval semantics must not change
Completion Gate must not be relaxed
unsafe side effects must not increase
duplicate mutation must remain 0
recovery capability must not regress
Context Phase B must not regress
```

## 3. Scope

### 3.1 In scope

This specification defines:

- Decision Efficiency terms, formulas, numerators, and denominators;
- successful task, effective action, logical model call, Provider attempt, and Tool batch boundaries;
- Provider-visible input accounting and delta-explanation requirements;
- per-call and per-run attribution contracts;
- baseline task-set selection, fixed conditions, and repetition rules;
- Context Phase B compatibility gates;
- evidence status for the known candidates;
- a Go / No-Go gate for the first production optimization candidate.

### 3.2 Out of scope

The following may be measured or listed as unknown, but must not be implemented in this phase:

- Tool Catalog deduplication or removal;
- dynamic context compression;
- Tool batching or concurrency changes;
- read reuse;
- dynamic Tool filtering;
- new control projections;
- `NextActionProjection` or `CompletionProjection` additions/rework;
- bounded observations or observation-retention changes;
- Runtime state restructuring;
- Context eviction, compaction, or rehydration changes;
- a second Context pipeline;
- any benchmark-only relaxation of safety, Approval, or Completion Gate semantics.

### 3.3 Authority boundary

The existing ownership model remains authoritative:

- Runtime owns complete execution state and Authority;
- State Machine is the only writer of Run Status;
- Run-owned Structured Plan is the only current-plan Authority;
- Tool Invocation is the Authority for side effects and recovery judgment;
- Model, Tool, and Host Application do not directly modify Run;
- Prompt / Context is a derived decision view, not a second state source.

This specification changes none of those boundaries.

## 4. Current Architecture Evidence

The following evidence was re-read from the current workspace. Paths are relative to `D:\Nexora-1.1`.

### 4.1 Runtime, Context, and Prompt

| Layer | Current evidence | Interpretation |
|---|---|---|
| Runtime Authority and persistence | `packages/runtime/src/contracts.ts`, `packages/runtime/src/store/run-store.ts`, `packages/runtime/src/agent-runtime-port.ts` | Run, Plan, Evidence, Tool Invocation, Model Call Ledger, and Provider Attempts are Runtime / Core Store records. |
| Decision context | `packages/harness/src/context/decision-context.ts`, `packages/harness/src/context/hybrid-context.ts` | Model input is derived from Runtime state, not a replacement state store. |
| Prompt compilation | `packages/harness/src/prompt.ts` (`compilePrompt()`) | Stable prefix includes kernel, transport instructions, host policy, profile, project policy, Tool Catalog, and skills catalog. Dynamic input includes task contract, runtime directive, plan/progress, active invocations, Evidence/repair, observations, control state, hybrid views, coding strategy, strategy routing, skills metadata, and controls. |
| Budget and projection | `packages/harness/src/context/budget.ts`, `eviction.ts`, `rehydration.ts` | These are existing protective mechanisms. Their semantics remain unchanged. |
| Native continuation | `packages/harness/src/context/native-continuation.ts`, `packages/harness/src/providers/openai-compatible.ts` | Continuation is rebuilt from the latest audited `model.turn` and later Runtime events; native message ordering must remain unchanged. |

For `native_tools` with Phase B dedupe enabled, `projectToolObservationsForWire()` projects only a repeated complete observation to bounded metadata when the same substantive content is already carried by continuation. The reduced view is consistently propagated into observations and hybrid derived views. Runtime facts, invocation records, Evidence, Authority, and the continuation itself are not mutated.

### 4.2 Provider-neutral request and wire body

| Layer | Current evidence | Current fields / semantics |
|---|---|---|
| Provider-neutral request | `packages/harness/src/providers/adapter.ts` (`buildRequest()`) | `system`, `input`, `stablePrefix`, `responseFormat`, `transport`, `toolCatalog`, optional `continuation`, optional `tools`. |
| OpenAI-compatible body | `packages/harness/src/providers/openai-compatible.ts` | `model`, `temperature`, `max_tokens`, optional `stream`, `messages`, optional `response_format`, optional `tools`, `tool_choice: "auto"`, `parallel_tool_calls: true`, optional thinking toggle. |
| Native message order | `providerMessages()` | System message; when continuation exists, continuation instruction, assistant `tool_calls`, tool result messages; final dynamic user message. |
| Final body measurement | `measureOpenAIWireTelemetry()` | Exact UTF-8 bytes and digest of the compact JSON body passed to `fetch()`. |

`finalRequest.bytes` is the body-byte authority. HTTP headers, sockets, TLS, and transport protocol bytes are outside this phase.

### 4.3 Token meter and Model Call Ledger

`calibratedTokenMeter()` currently estimates from:

```text
system + input
or
system + JSON.stringify(continuation) + input
```

using UTF-8 bytes / 4, with calibrated multipliers for some qwen models. It reports `measurementMethod: "estimated"` and a meter such as `nexora:<model>:utf8-bytes/4*x<multiplier>:e101-v1`.

It has not proven inclusion of:

- Provider wrapper fields;
- message role / envelope serialization;
- native continuation’s real message envelope;
- Provider-native `tools`;
- `response_format`;
- thinking toggle or other Provider-visible fields;
- Provider tokenizer special tokens or serialization rules.

The current `measuredInputTokens` is consumed by `assessContextBudget()` and by
the deterministic eviction loop (`evictDecisionContextTowardBudget`). It is
therefore a production budget/capacity value, not a Provider-wire ledger. The
baseline must keep this value under the explicit name
`budgetMeasuredInputTokens` (or an equivalent lossless mapping) and must not
change its algorithm, limits, eviction, compaction, rehydration, or Phase B
behavior. Provider-visible accounting is telemetry-only and is recorded
separately as `providerVisibleEstimatedInputTokens`,
`actualProviderInputTokens`, and `providerVisibleMeasurementDelta`, where:

```text
providerVisibleMeasurementDelta =
  actualProviderInputTokens - providerVisibleEstimatedInputTokens
```

Instrumentation must not substitute Provider tools/response-format accounting
into the production budget meter or alter Context decisions.

`ModelCallRecordSchema` and the v2 model-call schema already persist call/run IDs, sequence, phase, provider/model, projection digest, context limits, measured tokens, meter, budget decision, status, actual usage, error, and timestamps. They do not persist the split Provider-visible estimate/delta fields or a complete per-section Provider-visible attribution.

The Provider gateway may make up to three Provider attempts for one logical call. Attempt-level usage, errors, and retryability are recorded, but logical-call reduction alone cannot hide physical attempt cost.

### 4.4 Existing wire telemetry

`packages/harness/src/providers/model-client.ts` defines `ProviderWireSectionTelemetry`, `ProviderWireTransportTelemetry`, and `ProviderWireTelemetry`.

`buildWireTelemetry()` currently observes:

- exact final body bytes and digest;
- business sections such as `stablePolicy`, `taskAuthority`, `runtimeDirective`, `planExecution`, `observations`, `controlState`, `currentState`, `recentTrajectory`, `workingSet`, `codingStrategy`, `strategyRouting`, `skills`, and `availableControls`;
- Provider sections: `toolSchema`, `responseSchema`, and `continuation`;
- Provider wrapper bytes, message envelope bytes, and transport overhead;
- `ref + digest` aggregates and duplicate substantive payloads;
- attempt-level actual usage and cache metadata.

These section measurements are attribution views. They may overlap and are not tokenizer-exact. They must not be summed as a substitute for final body bytes or Provider actual input tokens.

### 4.5 Model turn, Tool batch, and benchmark

`packages/harness/src/agent.ts` records `model.turn` with model decision ID, execution unit ID, text presence, finish reason, Tool/control call counts, action types, and Tool call IDs/names/arguments.

`packages/runtime/src/execution/runtime-execution.ts` records batch ID, invocation batch ordinal, `tool.batch.prepared` size/concurrency, and `tool.batch.finalized` size/retries.

`harness/nexora-bench/src/telemetry.ts`, `runner.ts`, and `report.ts` already report task/evaluator pass, false success, model-call and Tool-invocation counts, rejection, Provider failure, repair/recovery, effective tool ratio, duration, strategy provenance, and some cache / stable-prefix metrics. They do not yet implement this document’s unified per-call and per-run Decision Efficiency contract.

### 4.6 Phase B closure evidence

Artifact:

```text
agent-evaluation/runs/context-phase-b-closure-probe/2026-09-07T01-33-28.929Z.json
```

| Scenario | Off → on actual input | Off → on final body | Duplicate payloads |
|---|---:|---:|---:|
| repair | 6,351 → 6,238 (-113) | 28,839 → 28,456 (-383) | 1 → 0 |
| recovery | 6,569 → 6,456 (-113) | 29,870 → 29,487 (-383) | 1 → 0 |
| completion | 4,262 → 4,149 (-113) | 21,293 → 20,910 (-383) | 1 → 0 |
| rehydration | 6,214 → 6,101 (-113) | 28,029 → 27,646 (-383) | 1 → 0 |

All 24 samples passed action and causal-fact checks. Recovery did not repeat the unknown-side-effect mutation. Rehydration preserved untrusted-memory-pointer reconciliation with a live read. Cache behavior showed no regression.

This evidence supports scoped Phase B closure. It does not justify reopening eviction, compaction, rehydration, stable policy, or the Phase B candidate itself.

## 5. Metrics Model

### 5.1 Primary metrics

Every primary metric must report raw totals, distributions, and normalized values:

```text
gross actual input tokens / successful task
actual input tokens / effective action
logical model calls / successful task
logical model calls / effective action
wall-clock milliseconds / successful task
```

Definitions:

- Gross actual input tokens are the sum of Provider-reported input/prompt token usage. Cached input tokens are not counted as zero.
- `successful task` is defined in section 5.3.
- `effective action` is defined in section 6.
- Logical model calls and Provider attempts are always counted separately.

### 5.2 Required diagnostics

At minimum:

```text
total logical model calls
Provider attempts
Provider attempts / logical model call
actual input tokens by attempt
budget-measured input tokens by call
Provider-visible estimated input tokens by attempt
Provider-visible measurement delta distribution
response Tool call count
Tool invocation count
Tool batch size histogram
Tool batch concurrency histogram
Tool retry count
repair / rejection / no-tool / no-progress call count
Provider failure / timeout / cancellation count
false success count
cache status and cached input tokens
wall-clock and Provider latency
```

### 5.3 Successful task definition

A task enters the successful-task denominator only when all are true:

1. the independent evaluator/grader accepts the expected outcome;
2. Runtime terminal status is consistent with Completion Gate semantics;
3. required Evidence, artifacts, workspace state, or external outcomes satisfy the task contract;
4. there is no false success, unverified completion claim, or hidden Provider/Runtime failure;
5. Approval, safety, and Authority invariants were not violated.

Runtime `succeeded` alone is insufficient. Tasks with evaluator failure, Completion Gate failure, blocked, failed, cancelled, Provider-unavailable, or incomplete telemetry must remain visible in their own buckets rather than disappearing through defaults.

### 5.4 Denominator rules

- `input tokens / successful task`: sum gross actual input tokens only for successful tasks, while separately reporting attempted tasks and success rate.
- `input tokens / effective action`: divide gross actual input tokens by accepted, verifiable, non-duplicate effective actions. A run with zero effective actions is reported as `no-effective-action`, not as zero.
- `model calls / effective action`: must not substitute Tool call count or batch count for effective actions.
- Report `n`, p50, p95, and max. A mean alone is not sufficient evidence.
- Multiple attempts in one logical call count toward gross physical cost, while logical call count remains one.

### 5.5 Cache accounting

Cache is a cost property, not proof that input semantics were removed. Reports must include:

```text
cache status: disabled | unsupported | unknown | miss | partial_hit | hit
cached input tokens
cache write tokens, when provided
cache-eligible input tokens
```

Paired comparisons must use a fixed cache policy and distinguish cold misses, partial hits, and hits. Missing Provider usage must not be transformed into zero.

## 6. Effective Action Definition

### 6.1 Definition

An effective action is:

> an action triggered by a model decision, accepted by Runtime / Tool / Completion semantics, that produces a verifiable, attributable, non-duplicate advance in persistent task state, required Evidence, or legitimate delivery.

It is not automatically:

- a model response;
- a Tool call;
- a Provider attempt;
- a parallel batch;
- unaccepted text intent;
- a rejected, failed, repeated, or no-progress call.

### 6.2 Primary categories

Each effective action must have exactly one primary category:

1. `state_change` — an accepted state-changing Tool or control action that satisfies a previously unfinished task obligation.
2. `plan_progress` — an accepted Runtime plan transition that resolves a currently required planning obligation. Planning-only model text without a Runtime-accepted transition is not progress.
3. `evidence_read` — an accepted read/inspection whose observable result resolves a previously unresolved relevant fact, satisfies a required inspection, or supplies valid evidence for an unmet Evidence requirement. `laterReferenced` is separate telemetry, not a prerequisite; re-reading an already satisfied fact is not a new effective action.
4. `verification` — an accepted test, build, or validation event that satisfies a previously unmet acceptance check.
5. `recovery` — an accepted repair/retry/reconciliation that safely moves a failure, interruption, or unknown side effect toward a verifiable state. A retry is not automatically progress.
6. `completion_delivery` — a final delivery or completion action accepted by Completion Gate and the independent evaluator.

Category assignment is deterministic from Runtime events and Authority outcomes;
each progress delta is counted once, with no LLM judge and no future trajectory
requirement. `laterReferenced` may be reported independently.

For a batch:

- each independently attributable invocation satisfying the definition may count as one effective action;
- the batch itself counts once as a batch, never as an action count;
- redundant reads of the same fact are deduplicated under the non-duplicate-progress rule;
- independently unprovable invocations are `unclassified` and excluded from optimistic counts.

### 6.3 Non-effective classifications

These must remain in waste diagnostics:

```text
no_tool_response
planning_only
rejected_response
repair_only_without_progress
provider_retry_without_new_accepted_effect
failed_tool
duplicate_mutation
duplicate_read_or_no_progress
completion_claim_rejected
provider_failure
cancelled_or_interrupted
```

### 6.4 Attribution chain

An effective action must be traceable through:

```text
runId
→ logicalModelCallId
→ Provider attempt(s)
→ model.turn
→ response Tool call(s)
→ Tool invocation / control event
→ Evidence / state transition / Completion Gate result
```

If this chain is incomplete, record `unknown_action_outcome`; do not include it in primary efficiency numerators or denominators.

## 7. Token Accounting Contract

### 7.1 Scope

Provider-visible input accounting must cover:

```text
stable/system prefix
dynamic decision context
native continuation
provider-native tools schema
response format schema
other Provider-visible input
provider wrapper and message envelope
```

Conceptually:

```text
ProviderVisibleInput
  = stable/system prefix
  + dynamic input
  + continuation messages
  + Provider tools
  + response format
  + other Provider-visible fields
  + serialization/envelope overhead
```

The final serialized body is the byte authority. Provider usage is the actual token authority.

### 7.2 Authority hierarchy

When available, use this hierarchy:

1. Provider-reported attempt-level `input_tokens` / `prompt_tokens` — actual input-token authority.
2. A Provider exact tokenizer applied to the exact final payload — explanatory preflight measurement, subordinate to returned usage.
3. Existing calibrated meter or UTF-8 bytes/4 — budget/relative estimate, never exact wire accounting.

If Provider usage is missing:

```text
actualProviderInputTokens = null
measurementMethod / meter / final body bytes / digest remain recorded
attempt is bucketed as usage_missing
```

The attempt must not silently enter token totals as zero.

### 7.3 Required fields

Each Provider attempt must eventually provide:

```text
logicalModelCallId
providerAttemptId
attemptNumber
provider
model
transport
configFingerprint

actualProviderInputTokens: integer | null
budgetMeasuredInputTokens: integer | null
providerVisibleEstimatedInputTokens: integer | null
measurementMethod: exact | tokenizer | estimated | unavailable
meter: string | null
providerVisibleMeasurementDelta: integer | null

finalRequestBytes
finalRequestDigest
cacheStatus
cachedInputTokens
cacheEligibleInputTokens
```

The delta contract is:

```text
providerVisibleMeasurementDelta = actualProviderInputTokens - providerVisibleEstimatedInputTokens
```

If either side is null, delta is null. A logical-call or run-level delta may only aggregate fields with the same scope and meter semantics.

### 7.4 Section attribution

Each attempt must provide bytes, estimated tokens, digest, and provenance for:

```text
stablePrefix
dynamicContext
nativeContinuation
providerTools
responseFormat
otherProviderInput
providerWrapper
messageEnvelope
```

Rules:

- State whether each value is an exact serialized-value measurement or an attribution view.
- Name the meter and method for estimated tokens.
- Never present section estimated tokens as Provider-exact tokens.
- Keep final body bytes/digest as the total authority.
- Mark overlapping views; do not sum them as a partition.
- A non-overlapping partition, if produced, must be deterministically reconstructable from the final body. It must not be created by adding an empirical constant.

Token accounting has three explicit authority levels:

1. **Serialized byte authority:** `finalRequestBytes` and section serialized
   bytes from the actual wire serialization.
2. **Attempt-level actual token authority:** Provider usage
   (`input_tokens` / `prompt_tokens`) for the whole attempt.
3. **Component token attribution:** section token counts are only
   `estimated`/`diagnostic` unless produced by the Provider's exact tokenizer
   over the exact serialization; they are never Provider-exact section usage.

Reports must distinguish exact bytes, actual total tokens, and estimated
component tokens.

### 7.5 Delta explanation

The objective is explainable error, not artificial alignment. Non-zero deltas must be attributed to evidence-backed reasons such as:

```text
provider_tokenizer_difference
message_envelope_or_special_tokens
provider_wrapper_fields
tools_or_response_schema_omission
continuation_serialization_difference
thinking_or_transport_field_omission
provider_usage_semantics_difference
unknown
```

`unknown` may remain, but its share and distribution by provider/model/transport must be reported. Fine-grained optimization decisions must not rely on an attribution dominated by unexplained delta.

### 7.6 Cache accounting

Cache status and cached-token fields must accompany usage. Paired runs must fix cache policy and warm/cold protocol. A cache hit is not zero input and does not by itself prove that a semantic payload is unnecessary.

## 8. Telemetry Contract

### 8.1 Correlation keys

Events and summaries must join on:

```text
runId
executionUnitId, when present
logicalModelCallId / callId
providerAttemptId / attemptId
modelDecisionId, when present
model.turn sequence
batchId / batchOrdinal
invocationId
planVersion / stepId, when present
```

Cross-layer aggregation must reference source-event digests or Artifact refs. Large payloads must not become a second Authority copied into telemetry.

### 8.2 Required event families

The baseline report must consume the real event families:

```text
model call start / completion / failure
provider attempt start / completion / failure
model.turn
model.wire_telemetry
tool.batch.prepared
tool.batch.finalized
Tool invocation lifecycle
response.rejected
repair / recovery / completion events
Evidence / state transition / Completion Gate result
run terminal outcome
```

Missing events, broken ordering, or an unverifiable terminal outcome mark the run `incomplete_telemetry`; it must not default to success or zero cost.

### 8.3 Call classification

Each logical model call must receive a primary classification and optional flags:

```text
productive_action
planning_only
no_tool
repair
recovery
completion_attempt
rejected
no_progress
duplicate_or_redundant
provider_failure
provider_retry_only
cancelled
interrupted
refused
unknown
```

Classification must combine `model.turn`, Tool/control execution, state transition, repair/recovery, and Completion Gate evidence. `finishReason=tool_calls` alone is not productivity, and Runtime success alone is not task success.

### 8.4 Payload policy

Telemetry should carry metadata, digests, measurements, and Artifact refs. Large or sensitive content remains in the existing Artifact/capture/redaction system. The attribution contract must not duplicate full Runtime facts or wire payloads into events.

## 9. Per-call Attribution

Every logical model call needs a logical summary, and every Provider attempt needs a physical summary.

| Field group | Required fields | Rules |
|---|---|---|
| Identity | `runId`, `logicalModelCallId`, `providerAttemptIds`, `attemptNumber` | Never conflate logical calls with physical attempts. |
| Provider | `provider`, `model`, `transport`, `configFingerprint` | Causal comparisons require fixed values. |
| Usage | `actualProviderInputTokens`, `actualOutputTokens`, `actualTotalTokens` | From Provider usage; missing remains null. |
| Measurement | `budgetMeasuredInputTokens`, `providerVisibleEstimatedInputTokens`, `measurementMethod`, `meter`, `providerVisibleMeasurementDelta` | Budget and telemetry scopes are separate; delta requires the same attempt scope. |
| Wire | `finalRequestBytes`, `finalRequestDigest` | Exact compact JSON body; headers/socket excluded. |
| Sections | `stablePrefix`, `dynamicContext`, `continuation`, `providerTools`, `responseFormat`, `otherProviderInput`, `providerWrapper`, `messageEnvelope` | Include bytes, estimated tokens, digest, provenance, and overlap status. |
| Tools exposed | `toolCountExposed`, `exposedToolNames` | Actual request exposure, not response calls. |
| Response | `responseToolCallCount`, `responseToolNames`, `finishReason`, `hasText` | From actual response / `model.turn`. |
| Classification | `callClass`, `effectiveActionCount`, `wasteFlags` | Confirmed by Runtime and evaluator evidence. |
| Batch | `batchIds`, `batchSizes`, `concurrency`, `retriesUsed` | Joined from prepared/finalized and invocation records. |
| Cache | `cacheStatus`, `cachedInputTokens`, `cacheEligibleInputTokens` | Kept separate from gross token semantics. |
| Timing | `startedAt`, `completedAt`, `providerLatencyMs`, `wallClockContributionMs` | Preserve every attempt’s latency. |
| Quality | `responseRejected`, `repairTriggered`, `recoveryTriggered`, `completionGateResult` | Never trust model self-report as task success. |

### 9.1 Logical-call aggregation

A logical summary must preserve:

```text
providerAttemptCount
attemptIds
attempt statuses
sum(actual input tokens across available attempts)
sum(actual output tokens across available attempts)
final logical response status
retryable and non-retryable failure information
```

“Fewer model calls” uses logical call count. Provider input cost and latency use the gross sum over attempts. Neither number substitutes for the other.

### 9.2 Section-total rule

Each call reports:

```text
finalRequest.bytes
sum of explicitly non-overlapping partitions, when available
attribution-view sections, for diagnosis
```

If a partition does not equal final body bytes, report residual/unpartitioned bytes. Do not quietly assign residual bytes to stable or dynamic context.

## 10. Per-run Aggregation

### 10.1 Run summary

Every run needs an immutable summary with at least:

```text
runId
provider / model / transport / config fingerprint
initial state digest / task ID / dataset version
terminal outcome: successful | failed | blocked | cancelled | incomplete
independent evaluator result
Completion Gate result
false-success flag

logical model call count
Provider attempt count
Provider attempts per logical call
actual input / output / total tokens
budget-measured input tokens
Provider-visible estimated input tokens
Provider-visible measurement delta: sum, p50, p95, max, unknown count
final wire bytes: sum, p50, p95, max

stable / dynamic / continuation / tools / response-format attribution totals
response Tool call count
Tool invocation count
effective action count by category
input tokens / effective action
model calls / effective action
Tool batch size histogram
Tool batch concurrency histogram
Tool retry count

no-tool / repair / rejection / no-progress / Provider-failure waste
cache status distribution
wall-clock duration
```

### 10.2 Dataset aggregation

| Metric | Numerator | Denominator / filter |
|---|---|---|
| Input tokens / successful task | Gross actual input tokens for successful tasks | Independent evaluator + Completion Gate passed tasks |
| Input tokens / effective action | Gross actual input tokens | Effective actions; zero-action runs separately bucketed |
| Model calls / successful task | Logical model calls | Successful tasks |
| Model calls / effective action | Logical model calls | Effective actions |
| Wall-clock / successful task | Run wall-clock | Successful tasks |
| Success rate | Successful tasks | Attempted tasks |
| False-success rate | False successes | Attempted tasks |

Runs with missing usage are not low-token runs. They belong to a `usage-incomplete` analysis bucket; whether they enter the main aggregate must be explicit, not a silent filter.

### 10.3 Waste accounting

Each run must explain, without subtracting from gross cost:

```text
input tokens for no-tool calls
input tokens for rejected responses
input tokens for repair-only calls
input tokens for retry-only attempts
input tokens for no-progress calls
input tokens for Provider failures/timeouts
input tokens attributable to duplicate substantive payloads
```

### 10.4 Distribution and comparability

Aggregates report `n`, p50, p95, and max. Runs differing in Provider, model, transport, budget, initial state, or cache policy are grouped separately. They must not be merged into one causal baseline.

## 11. Baseline Dataset / Task Set

### 11.1 Required lanes

Use existing repository tasks; do not create a second synthetic Runtime for this specification.

1. **Phase B compatibility lane** — closure-probe repair, recovery, completion, and rehydration scenarios.
2. **Continuity / rehydration lane** — existing `context-memory-continuity-v1` or an equivalent established task.
3. **Recovery / unknown-side-effect lane** — stable tasks that exercise retry, repair, recovery, and unknown side effects without repeating unsafe mutations.
4. **Completion / Evidence lane** — tasks that distinguish valid completion, rejected completion, false success, and Completion Gate behavior.
5. **Stable execution / coding lane** — stable Runtime/coding/Terminal-Bench tasks with independent evaluators.
6. **Read / batch lane** — tasks with auditable read batches for batch size, concurrency, retry, and evidence-action observation.

Task IDs and dataset versions must be recorded in a baseline manifest. An unstable task is marked excluded; it must not be “stabilized” by adding production logic in this phase.

### 11.2 Qualification gate

A task enters the main baseline only when:

```text
the same provider/model/transport/budget has at least five control runs
the independent evaluator result is decidable
false successes are absent or explained
terminal outcome and Completion Gate events are complete
Authority and safety invariants pass
usage-missing, event-missing, and incomplete-run rates are recorded
```

Tasks with inherently random Provider trajectories may remain in a robustness lane, but their differing-trajectory totals are not causal A/B evidence. Controlled paired fixtures or explicitly classified, sufficiently large samples are required.

### 11.3 Fixed manifest

Each run manifest must record:

```text
dataset id / version / task id
provider / model / transport
system / project / host policy versions
prompt compiler version
contextProjectionDedupe treatment
model config, temperature, and max output tokens
context window and soft/hard input limits
initial Runtime state digest
workspace fixture digest
cache policy and warm/cold protocol
randomness/seed where supported
run repetition number
```

Production baseline controls use Phase B default `contextProjectionDedupe=on`. The `off` control is reserved for compatibility or future controlled A/B; it is not redefined as production default.

### 11.4 Snapshot size

The first snapshot should cover all qualified lanes, with at least five control runs per task. It must preserve raw run ledgers and aggregate reports; a single average is not a baseline.

Future candidate A/B should use the same task, initial state, and manifest. If the Provider still chooses different valid trajectories, the result may support quality/safety/duplicate evidence but not a causal token-saving claim.

## 12. Context Phase B Compatibility

### 12.1 Required compatibility

Baseline instrumentation and any later optimization must preserve:

```text
native continuation observation dedupe enabled by default
no reappearance of substantive duplicates
full ref + digest matching semantics
unchanged rehydration
unchanged eviction and compaction
unchanged native continuation ordering
unchanged Runtime facts / Authority / Evidence
```

The Phase B 24/24 action/fact checks, four-scenario 113-token input reduction, 383-byte body reduction, and zero-duplicate result are compatibility evidence. They do not reopen the Phase B optimization scope.

### 12.2 Continuation identity verification item

Current projection and telemetry use `ref + digest` as substantive identity. Native continuation correlation also uses Tool name and input digest and rebuilds results from Runtime Authority.

This audit does not establish a confirmed production `ref + digest` mismatch. If a dedicated check later finds one, it must be filed as an independent correctness issue:

- do not fix it inside Decision Efficiency optimization;
- do not use affected continuation attribution as unconditional causal evidence until resolved;
- do not expand eviction, rehydration, or Context projection scope because of it.

## 13. Known Optimization Candidates

These candidates are hypotheses to verify. None is approved for implementation.

### 13.1 Candidate A — stable Tool Catalog versus Provider-native `tools`

**Hypothesis:** stable-prefix Tool Catalog text and Provider-native `tools` schemas may contain semantic duplication, and both are large fixed costs on repeated calls.

Current evidence:

- `compilePrompt()` includes a Tool Catalog in the stable prefix.
- The native OpenAI-compatible request also sends Provider function name, description, and parameters in `tools`.
- Existing continuity telemetry showed representative stable-policy cost around 29.7 KB and native Tool-schema cost around 18.3 KB on repeated calls.

Current unknowns:

- field-level semantic overlap and byte overlap have not been precisely accounted;
- stable Tool Catalog may contain Provider schema guidance that is necessary for Tool selection, safety, Authority, Evidence, or Completion;
- cache effects must be isolated under a fixed policy;
- removing or compressing either representation may affect behavior and recovery.

Required baseline work is measurement only: stable Tool Catalog bytes/tokens/digest, Provider `tools` bytes/tokens/digest, exposed Tool count, Tool-selection outcomes, valid actions, success, false success, and recovery. Do not delete, merge, or filter either representation in this phase.

### 13.2 Candidate B — dynamic context semantic duplication

Observe but do not change:

```text
currentState vs controlState
runtimeDirective vs repair
continuation projections in multiple views
Evidence metadata vs observation refs
availableControls vs Provider tools
empty skills metadata
```

No current evidence proves these are safely compressible.

### 13.3 Candidate C — observation growth

Observe but do not change:

```text
full observation payload
fragment
reference
rehydration
```

Long-run telemetry has shown that required facts can be large, while digest-only merging can conflate artifact, invocation, and Evidence identities. Retention, rehydration, eviction, and compaction remain unchanged.

### 13.4 Lower-priority or deferred directions

Tool batching, read reuse, dynamic Tool filtering, composite Tools, new control projections, and Runtime state restructuring are not first candidates. They require separate evidence, contracts, and risk boundaries.

## 14. Non-goals

This phase explicitly does not:

```text
reduce Runtime Authority state
make Runtime stateless
add a second Context pipeline
add NextActionProjection
change Completion Gate
modify Approval
implement dynamic Tool filtering
increase Tool concurrency
implement composite Tools
modify read reuse
modify Context eviction / compaction / rehydration
disguise Provider trajectory variance as token savings
disguise cached input tokens as zero cost
disguise budgetMeasuredInputTokens or providerVisibleEstimatedInputTokens as exact wire tokens
relax safety boundaries to pass a benchmark
```

The guiding boundary remains:

> Runtime owns full execution state; Model receives only a decision-relevant projection.

This phase measures and proves cost and waste. It does not broadly redesign that boundary.

## 15. Acceptance Criteria

These criteria apply to the future baseline implementation, not to this specification-only delivery.

### 15.1 Token accounting

- Stable/system, dynamic, continuation, Provider tools, response format, other Provider-visible input, wrapper, and envelope are observable.
- Final wire body has exact UTF-8 bytes and digest.
- Provider attempts have actual input usage when returned.
- Available calls/attempts expose `actualProviderInputTokens`, `budgetMeasuredInputTokens`, `providerVisibleEstimatedInputTokens`, and `providerVisibleMeasurementDelta`.
- Delta causes are categorized; unknown share is visible.
- No empirical constant is used to force measured and actual alignment.
- Missing usage is null/missing, never zero.

### 15.2 Per-call and per-run telemetry

- Each logical call joins to all Provider attempts.
- Each attempt has wire digest, section attribution, cache, finish reason, and response Tool metadata.
- Each run has logical calls, attempts, Tool calls, batches, effective actions, waste categories, and wall-clock.
- Required efficiency ratios are computable.
- Tool batch size, concurrency, and retry distributions are observable.
- False success, blocked, failed, cancelled, Provider unavailable, and incomplete telemetry are distinguishable.

### 15.3 Invariant preservation

- Runtime Authority and Tool execution behavior are unchanged.
- Approval, Evidence, and Completion Gate semantics are unchanged.
- Phase B closure tests add no new failures.
- Production-default dedupe does not regress.
- Substantive duplicates do not reappear.
- Recovery does not repeat an unknown-side-effect mutation.
- Rehydration, eviction, compaction, and native continuation ordering remain unchanged.

## 16. Verification Plan

### 16.1 This specification-only delivery

1. Inspect current `git status --short` without altering existing diffs or untracked files.
2. Re-read current code, Phase B closure documentation, the closure artifact, and existing telemetry.
3. Create only this specification.
4. Run `git diff --check`.
5. Review the document to confirm no production code, test, benchmark, schema, or historical Development block was changed.

Full code tests are not required for a specification-only change.

### 16.2 Future baseline implementation order

If baseline instrumentation is later approved:

1. deterministic unit checks for section serialization, digest, scope, null usage, and delta arithmetic;
2. Provider-adapter wire fixtures for body, message order, tools, response format, and continuation;
3. Runtime integration for call/attempt/turn/batch/invocation correlation;
4. independent evaluator and Completion Gate aggregation;
5. fixed-provider repeated baseline runs;
6. Context Phase B compatibility regression;
7. only then, candidate-specific controlled A/B.

### 16.3 Candidate A verification requirements

A future Candidate A specification must:

- fix Provider, model, transport, budget, initial state, cache policy, and prompt compiler version;
- change only the candidate Tool Catalog / Provider-tools representation under test;
- preserve Runtime tools, Approval, Evidence, Completion, and Authority;
- report stable/native schema bytes, actual input tokens, delta, Tool selection, valid action, success, false success, recovery, and wall-clock;
- use paired runs and explicitly classify trajectory variance;
- prove any information removed from one representation is either retained elsewhere or not required by the model decision contract.

## 17. Risks / Unknowns

1. **Provider tokenizer unknown** — current metering is estimated; calibrated multipliers are not exact tokenizer accounting.
2. **Attribution overlap** — current business/provider sections and transport overhead are views, not necessarily disjoint byte slices.
3. **Missing usage** — Provider responses may omit usage; null must not become zero.
4. **Logical versus physical cost** — retries add Provider attempts and real input/latency cost even when logical-call count is unchanged.
5. **Cache comparability** — cold miss, partial hit, and hit have different cost interpretations.
6. **Trajectory variance** — identical inputs may produce different valid Tool trajectories, finish reasons, and call counts.
7. **Effective-action ambiguity** — read, repair, retry, and batched invocations cannot be simplified to Tool-call count.
8. **Candidate A semantic risk** — stable Tool Catalog may carry safety, use/avoid, effect, Authority, or completion guidance absent from the Provider schema; apparent duplication is not proof of safe removal.
9. **Observation identity risk** — digest-only merging can conflate different artifact, invocation, and Evidence refs; `ref + digest` remains necessary.
10. **Continuation correctness item pending** — a confirmed `ref + digest` correlation mismatch, if found later, is an independent correctness issue, not part of this optimization.
11. **Existing red tests** — E079, E122 twice, and E131 are recorded pre-existing Context-baseline failures; broader historical suites also contain unrelated Runtime-state failures. New failures, old failures, and incomplete telemetry must be separated.
12. **Selection bias** — choosing only easy tasks can create a false efficiency improvement; success, false success, failure, blocked, and long-tail distributions must remain visible.
13. **Privacy and artifact size** — full wire payloads may be sensitive or large; use metadata, digests, redacted artifacts, and section measurements.

## 18. Go / No-Go Gate for First Optimization Candidate

### 18.1 Gate purpose

A large section or repeated payload is not sufficient authority for deletion or compression. A candidate may enter the next production-optimization specification only when evidence, benefit, risk, and controllability all pass.

### 18.2 Hard Go conditions

All conditions must hold:

```text
real Provider wire telemetry exists, not documentation estimates

actualProviderInputTokens, budgetMeasuredInputTokens, providerVisibleEstimatedInputTokens, and providerVisibleMeasurementDelta scopes are explicit
major delta causes are explained; unknown does not mask the conclusion

the benefit source is a specific section, repeated payload, or waste-call class
the benefit is not an artifact of differing Provider trajectories

success rate does not decrease
false success does not increase
unsafe side effects do not increase
duplicate mutation remains 0
repair, recovery, rehydration, completion, Approval, and Evidence do not regress

Runtime Authority is not expanded or reduced
Tool Invocation Authority is unchanged
Completion Gate and Approval semantics are unchanged
Context Phase B scope is not expanded

a controlled paired A/B is possible under fixed Provider/model/transport/
budget/initial-state/cache conditions
the A/B independently observes Tool selection, effective action, quality,
safety, recovery, and wall-clock
```

Any failed condition is No-Go. A token reduction cannot override correctness, safety, Authority, or recovery failure.

### 18.3 Recommended first verification direction

**First candidate: Candidate A — stable Tool Catalog versus Provider-native `tools` duplication cost.**

Rationale:

- current telemetry already identifies stable policy and native Tool schema as large, repeated fixed costs;
- the two representations occupy separately observable regions of the Provider request;
- the effect can be measured against final body bytes, actual input tokens, Tool selection, effective actions, success/false success, recovery, and wall-clock;
- it avoids reopening eviction, compaction, rehydration, or observation retention after Phase B closure.

This recommendation is **not approval** and **not a Go**:

```text
Candidate A = preferred post-baseline verification direction
Candidate A implementation = not approved
Candidate A production Go = No-Go until baseline evidence exists
```

Only a later candidate-specific specification that passes every hard gate may approve a minimal, reversible, contract-preserving controlled A/B. Until then, do not modify stable Tool Catalog text, Provider `tools`, or any Context projection.

### 18.4 Current decision

As of 2026-09-07:

- **Phase B:** scoped native continuation observation dedupe is verified / production-ready; keep the default on and do not expand scope.
- **Decision Efficiency Baseline:** this specification defines the required contract; implementation has not started.
- **First candidate:** Candidate A is the only recommended post-baseline verification direction.
- **Production optimization decision:** **No-Go**. Do not implement an optimization before baseline, delta attribution, and controlled A/B evidence exist.

## Appendix A — Current-answer decision table

| Question | Current answer | Required baseline behavior |
|---|---|---|
| Is `measuredInputTokens` complete wire token accounting? | No; it is currently an estimated budget meter. | Keep it as `budgetMeasuredInputTokens`; separate Provider-visible telemetry from budget decisions. |
| Are final request bytes exact? | Yes, for the compact JSON body passed to `fetch()`. | Treat as body-byte authority; exclude headers/socket. |
| Is Provider usage always present? | No. | Preserve null and a missing-usage bucket. |
| Does one logical call equal one Provider request? | No; retries can create multiple attempts. | Report logical calls and attempts separately. |
| Is a Tool call an effective action? | Not necessarily. | Confirm through Runtime, Evidence, and Completion outcomes. |
| Can long-run off/on totals be causal A/B? | No, trajectories can differ. | Use controlled paired evidence and report trajectory class. |
| Should Phase B expand now? | No; scoped closure is complete. | Guard compatibility only. |
| What is the first candidate? | Candidate A, only as a post-baseline direction. | Baseline first; current implementation decision is No-Go. |
