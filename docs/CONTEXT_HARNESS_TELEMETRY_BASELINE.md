# Nexora Context Harness Telemetry Baseline

Date recorded: 2026-09-06
Branch: `codex/harness-optimization-production-baseline`

## Purpose

This is the pre-Phase-A regression baseline for Hybrid Context / Decision
Context / Prompt Projection telemetry. The failures below are pre-existing
worktree baseline failures. Phase A telemetry must not change their count or
semantics; they are not in scope for this implementation.

Command used:

```powershell
pnpm exec vitest run `
  tests/runtime/e079-context-budget-token-accounting.test.ts `
  tests/runtime/e105-provider-token-meter-calibration.test.ts `
  tests/runtime/e114-context-observation-deduplication.test.ts `
  tests/runtime/e122-context-working-set-read-reuse.test.ts `
  tests/runtime/e131-session-context-continuity.test.ts `
  tests/runtime/e142-hybrid-decision-context.test.ts `
  tests/runtime/e150-turn-navigation-projection.test.ts `
  tests/runtime/e151-provider-wire-telemetry.test.ts `
  --no-file-parallelism --testTimeout=20000
```

Observed result after the six-test E151 telemetry suite: **47 passed, 4
failed**. The six E151 tests are Phase-A telemetry coverage and pass. The four
failures below are the unchanged pre-Phase-A baseline failures.

## Failure classification

| Area | Test | Classification | Phase-A disposition |
|---|---|---|---|
| E079 | `meters the exact projected OpenAI-compatible request and records returned usage` | Prompt fixture/assertion mismatch: the test expects a legacy prompt fragment that is not present in the current General Agent prompt kernel. | Record only; do not repair in telemetry phase. |
| E122 | `retains the current file working set ahead of unrelated history under token pressure` | Working-set projection failure: current-file projection is empty under the exercised pressure path. | Record only; do not alter projection/eviction. |
| E122 | `invalidates declared read reuse after a mutation` | Approval/runtime-flow failure: the test reaches the approval assertion without a pending request. | Record only; do not alter approval or execution flow. |
| E131 | `reuses the persisted automatic ancestor projection instead of compacting the same history on every model call` | Continuation/runtime behavior failure: the scenario returns `failed` instead of `waiting`. | Record only; do not alter continuation or rehydration semantics. |

## Verification rule

Phase A is allowed to add observational `model.wire_telemetry` records and
exact final-request measurements only. It must not modify Prompt construction,
Hybrid projection, eviction, rehydration selection, Provider transport
semantics, Runtime Authority, or the four failure outcomes above.

## Revised Phase-A decisions

The telemetry-only implementation follows the approved revisions:

1. Provider wrapper fields are not business wire sections. Business sections,
   provider-native sections, and transport overhead are reported separately.
2. Duplicate accounting is keyed by `ref + digest`; one wire may contain at
   most one substantive full expansion in the eventual optimization policy,
   while telemetry also records bounded metadata occurrences.
3. `toolObservations` is canonical only for Tool-generated facts; it is not a
   universal canonical source for Plan, user scope, control state, or other
   facts.
4. Rehydration bounce is not controlled by hidden prior-round state. Any future
   selection change must be deterministic and measured first.
5. Phase A observes the final request object with minimal instrumentation and
   does not change Prompt construction, message construction, Provider
   lifecycle, or transport semantics.

No Phase-B projection or rehydration-selection change was included in Phase A.
The Phase-B candidate remained deferred pending telemetry and A/B evidence.

## Measurement semantics

`finalRequest.bytes` and `finalRequest.digest` are the authoritative Phase-A
measurement: they are computed from the exact UTF-8 JSON string passed as the
OpenAI-compatible `fetch()` body. `businessSections`, `providerSections`, and
`transportOverhead` are diagnostic attribution views. They are reported
separately and must not be added together as a replacement for final body size:
a logical section is reserialized for attribution and may overlap a
protocol-level view.

The telemetry event contains only counts, digests, section names, reference
metadata, Provider usage, and cache metadata. It never stores the final body or
dynamic prompt content. An observer/write failure cannot prevent a Provider
request, and a request that reaches the Provider but fails still records the
attempt telemetry when the Runtime audit store is available.

## Initial real-Provider sample

The following is a baseline observation, not an optimization claim. It was run
on 2026-09-06 with the configured OpenAI-compatible DashScope Provider
(`qwen3.8-flash`) and a 32,768-token canary context window:

```powershell
$env:NEXORA_CANARY_CONTEXT_WINDOW_TOKENS='32768'
node --env-file=.env --import tsx tests/canaries/context-memory-continuity.ts
```

Artifact: `agent-evaluation/runs/context-memory-continuity-v1/2026-09-06T02-24-43-723Z`

| Provider call | Actual input tokens | Prompt estimate | Final request bytes |
|---|---:|---:|---:|
| 1 | 7,370 | 8,210 | 45,590 |
| 2 | 7,878 | 8,867 | 48,336 |
| 3 | 12,589 | 9,971 | 53,427 |

All three calls returned Provider usage (27,837 actual input tokens total),
completed the canary, restored required facts, and reported no duplicated
substantive `ref + digest` payload in this workload. The dominant attribution
views were stable policy (25,744–29,654 bytes), response schema (10,259 bytes),
and the growing observations section (2,304, 3,663, then 7,113 bytes).

This is one three-turn workload only. Its mixed estimator error, especially the
third call's input undercount, means neither byte/4 nor the current token meter
is a valid optimization target by itself. A multi-workload before/after sample
is required before changing a projection.

## Additional exploratory wire samples

Two additional OpenAI-compatible samples were run on 2026-09-06 after the
initial canary. They are evidence for prioritization only; no projection
behavior was changed based on them.

| Workload | Calls | Result | Actual input tokens | Wire observations |
|---|---:|---|---:|---|
| short direct answer | 1 | succeeded / completed | 5,412 | stable policy 16,226 bytes; native Tool schema 5,988 bytes; dynamic business sections about 1.1 KB |
| one-file read and exact answer | 2 | succeeded / completed | 23,489 total | stable policy 29,710 bytes per call; native Tool schema 18,258 bytes; second call had one full result in `continuation` and the same `ref + digest` full result in `observations` |

The read sample was the first measured Phase-B candidate: the same Tool fact
had `fullExpansionCount=2` across Provider-native continuation and dynamic
observations, plus bounded metadata in `currentState` and `recentTrajectory`.
This did not justify removing all observations or making `toolObservations` a
universal Authority. The short sample also showed that fixed policy and native
Tool-schema costs vary with selected transport/tool catalog and must remain
separate Provider/business attribution views.

## Final Phase-A verification

Reverified on 2026-09-06 after the telemetry test's persisted-event type
narrowing:

- E151 telemetry coverage: **6 passed, 0 failed**.
- Specified Context baseline: **47 passed, 4 failed**, exactly E079, E122 (two),
  and E131 as classified above.
- `pnpm build`: passed.
- Scoped ESLint for all Phase-A production and test files: passed.
- `git diff --check` for Phase-A production and test files: passed.
- Repository-wide `pnpm typecheck`: red on pre-existing Canary, Desktop, and
  E062/E120/E129/E142/E143/E150/testkit errors. E151 no longer appeared; those
  unrelated failures were not changed in Phase A.

No Prompt, Hybrid projection, Decision Context selection, eviction,
rehydration admission, or continuation projection change was enabled in Phase
A. Phase B remained deferred for review and paired A/B evidence.

## Phase-B addendum (continuation dedupe and pipeline audit)

The Phase-A candidate was implemented and measured. The production treatment
is `contextProjectionDedupe: "on"` for `native_tools`; `"off"` is retained only
for A/B control. The implementation in `packages/harness/src/prompt.ts` uses
the existing reference projection, preserving Runtime facts, native message
order, Authority, Evidence, and transport behavior.

Direct real Provider A/B (`tests/canaries/context-native-continuation-ab.ts`)
showed:

- final request: 27,641 → 27,258 bytes (-1.39%);
- Provider actual input: 6,121 → 6,008 tokens (-1.85%);
- observations: 948 → 780 bytes (-17.7%);
- continuation: 769 → 769 bytes (unchanged);
- duplicate substantive payloads: one (`fullExpansionCount=5`) → zero;
- response shape unchanged (one Tool Call, `finish_reason=tool_calls`).

The same direct fixture was repeated three more times on 2026-09-07 with the
same result on every trial. The successful long-run telemetry also reported
5/5 successful calls, 8/8 shard reads, correct target memory restoration,
113,974 actual input tokens, and automatic-cache partial hits of 10,240 tokens
per call. A low-window run that ended in a malformed Provider Tool name remains
recorded as Provider response variance, not a dedupe regression.

A paired native-tools continuity attempt completed on both treatments with 8/8
shard reads, correct memory recall, and no safety violations. The off treatment
used five calls and 131,325 actual input tokens; one 208,296-byte request
contained 16 duplicate records. The on treatment used two calls and 47,661
actual input tokens with zero duplicate records. Different trajectories make
these totals non-causal; they are quality/safety and duplicate-existence
evidence only.

Additional 32,768-token on/off runs restored memory, read all 8 shards, and
preserved 16 confirmed facts without safety violations, then stopped at
`TOOL_CALL_BUDGET_EXCEEDED`. The on run had 6 duplicate records and the off run
18, but differing trajectories prevent causal token attribution. This does not
justify changing eviction or compaction semantics.

The canary Provider wrapper was corrected to preserve `provider.transport`.
Earlier `cache: disabled` records from the 32,768-token run are not production
cache evidence; they came from falling back to the gateway's
structured-output disabled-cache default.

Long-run attribution does not justify further changes. Stable policy (about
29.7 KB) and native Tool schema (about 18.3 KB) are large fixed costs, but no
semantic redundancy or safe contract-preserving projection was proven.
Digest-only merging would conflate distinct artifact, invocation, and Evidence
refs and is not allowed by the Authority model. CurrentState, trajectory,
working set, history/memory/archive, rehydration, compaction/eviction,
coding/repository context, response schema, and token calibration remain
measured but unchanged candidates.

Updated verification after the canary-wrapper correction:

- specified Context baseline: **48 passed / 4 failed** (52 tests total);
- the four failures remain E079, E122 (two), and E131; no new failure was
  introduced;
- E151: 7/7, E114: 3/3, E142: 4/4, E150: 12/12;
- the wider historical `test:context-quality` suite still has unrelated
  pre-existing Runtime-state failures and is not the Phase-B regression gate.

## Phase-B production closure (2026-09-07)

The real-Provider closure artifact is
`agent-evaluation/runs/context-phase-b-closure-probe/2026-09-07T01-33-28.929Z.json`.
It fixes Provider/model (`qwen3.8-flash`), native transport, stable-prefix
inputs, and synthetic Runtime Context per scenario, then repeats each
`off`/`on` pair three times for repair, recovery, completion, and rehydration.

| Scenario | Off → on actual input | Off → on final request | Duplicate substantive payloads | Cache / action safety |
|---|---:|---:|---:|---|
| repair | 6,351 → 6,238 (-113) | 28,839 → 28,456 (-383) | 1 → 0 | first off control cold `miss`, then `partial_hit`; on `partial_hit`; valid repair; causal fact retained |
| recovery | 6,569 → 6,456 (-113) | 29,870 → 29,487 (-383) | 1 → 0 | `partial_hit`; no repeated unknown-side-effect write |
| completion | 4,262 → 4,149 (-113) | 21,293 → 20,910 (-383) | 1 → 0 | `partial_hit` on all runs; valid completion; no protected mutation |
| rehydration | 6,214 → 6,101 (-113) | 28,029 → 27,646 (-383) | 1 → 0 | `partial_hit`; untrusted memory pointer reconciled with live read |

All 12 pairs (24 samples) passed valid-action and causal-fact checks. Every
`on` sample was `partial_hit`; one first `off` control was a normal cold `miss`
and subsequent controls were `partial_hit`. The latest rehydration repetitions
all used valid `tool_calls`; an earlier probe also observed a valid `stop`
response. This Provider finish-reason variance caused no fact or action
regression.

The 131,072-token continuity run remains the long-run quality gate: 5/5 model
calls, 8/8 shard reads, correct `ORCHID` memory recall, required facts
preserved, automatic-cache partial hits, and no forbidden invocation. Its
paired off/on totals are not causal because Provider trajectories differ. The
on path has zero duplicate records and no safety violation.

The 32,768-token runs both preserved memory and 16 confirmed facts but ended at
`TOOL_CALL_BUDGET_EXCEEDED`. This is classified as Provider trajectory/runtime
Tool-budget termination, not a Context, eviction, or compaction defect.

Closure decision: the scoped native continuation observation dedupe is
**verified / production-ready**. It remains on by default for `native_tools`,
with `off` retained only as an experiment control. No additional Context
pipeline changes are justified by current telemetry.
