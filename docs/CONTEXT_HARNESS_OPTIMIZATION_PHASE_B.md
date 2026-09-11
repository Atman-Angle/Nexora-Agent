# Context Harness Optimization — Phase B

Status: **verified / production-ready (scoped native continuation dedupe)**

This document remains the active Phase-B specification. It is not a second
Context architecture. The Runtime remains the complete-fact and Authority
owner; Prompt Projection is a deterministic, derived view for the current
model decision. Phase B may remove repeated wire payloads only when telemetry
shows a substantive duplicate and an A/B proves lower Provider input without a
quality or protocol regression.

## Invariants

- Runtime facts, Tool Invocation Authority, Evidence, Approval, Completion
  Gate, native continuation ordering, and Provider transport semantics remain
  unchanged.
- The model receives the minimum sufficient decision context. Goal, scope,
  constraints, acceptance, current Plan, unfinished work, and causal facts may
  not be lost through projection, compaction, eviction, or rehydration.
- A substantive fact is fully expanded at most once on a wire when the same
  `ref + digest` is already carried authoritatively elsewhere. Other views use
  bounded `ref` / `sourceRefs`, `digest`, status, and retention metadata.
- `toolObservations` is canonical only for Tool-generated facts. It is not a
  universal source for Task Contract, Plan, control state, Evidence, or other
  Authority data.
- Compaction and eviction remain protective budget mechanisms, not the primary
  duplicate-removal strategy. No Shadow Authority or second Context state may
  be introduced.

## Implemented candidate: native continuation observation deduplication

When a `native_tools` continuation contains a complete observation with
`payloadMode="full"`, substantive payload, and matching `sourceRefs + digest`,
the derived dynamic `toolObservations` view is projected through the existing
`referenceObservation()` shape. The wire keeps the necessary ref/digest/status/
retention metadata and does not repeat `facts`, `error`, or `payloadFragment`.

The reduced observation view is fed consistently to `observationsAndRepair`,
`currentState`, `recentTrajectory`, and `workingSet`; otherwise a derived
projection could re-expand the same payload in another section. Runtime
`context.toolObservations`, invocation records, Evidence, Authority, and the
native continuation messages are not mutated.

The production default is `contextProjectionDedupe: "on"`. `"off"` is retained
only as an experiment control. Prompt compiler version is `1.5.0`, and the
strategy digest includes the treatment so cache/rehydration continuity cannot
silently mix variants.

## Evidence

### Deterministic verification

The focused suite passes the new behavior and the affected projections:

- E151 provider wire telemetry: 7/7
- E114 observation deduplication: 3/3
- E142 hybrid decision context: 4/4
- E150 turn/navigation projection: 12/12
- E131 continuity: 4/5; the one failure is the recorded pre-existing
  `failed` vs `waiting` baseline failure.

The full specified Context baseline reports **48 passed / 4 failed** (52 tests
total). The four failures are the unchanged E079/E122/E122/E131 baseline
failures; no new failure was introduced.

### Real Provider A/B: direct continuation fixture

Artifact: `agent-evaluation/runs/context-native-continuation-ab/2026-09-06T16-26-24.704Z.json`

| Metric | Dedupe off | Dedupe on | Change |
|---|---:|---:|---:|
| Final request bytes | 27,641 | 27,258 | -383 (-1.39%) |
| Provider actual input tokens | 6,121 | 6,008 | -113 (-1.85%) |
| `observations` bytes | 948 | 780 | -168 (-17.7%) |
| Continuation bytes | 769 | 769 | unchanged |
| Duplicate substantive payloads | 1 (`fullExpansionCount=5`) | 0 | removed |
| Response shape | 1 Tool Call, `tool_calls` | 1 Tool Call, `tool_calls` | unchanged |

The direct fixture was repeated three additional times on 2026-09-07. Every
trial reproduced the same values and response shape. This is the causal
adoption evidence for the fixed Provider/model fixture. A full continuity
ON/OFF run is not used for causal token attribution when the Provider selects
different valid trajectories.

### Telemetry-driven pipeline audit

The successful real continuity run with `native_tools`, automatic cache, and a
131,072-token window
(`agent-evaluation/runs/context-memory-continuity-v1/2026-09-07T00-09-26-504Z`)
reported 5/5 successful model calls, 8/8 shard reads, correct memory recall,
113,974 actual input tokens, and zero duplicate `ref + digest` payloads after
projection. Representative call attribution was:

- stable policy: 29,710 bytes on every call;
- native Tool schema: 18,258 bytes on every call;
- continuation: 2,764, 2,429, and 70,055 bytes on continuation calls;
- observations: 2,304, 4,672, 2,304, 8,951, then 73,083 bytes;
- current state: 752–1,145 bytes;
- working set: 247–1,301 bytes;
- recent trajectory: 2–1,735 bytes.

The large final `observations` section contains the eight required shard facts
once. The preceding continuation carries Tool-call protocol history, not a
second copy of those substantive results. Digest-only merging would be unsafe:
artifact, invocation, and Evidence refs may share a digest while retaining
different Authority meaning.

A paired continuity attempt completed successfully on both treatments with
8/8 shard reads, correct `ORCHID` memory recall, no safety violations, and no
eviction. The off run used five model calls and 131,325 actual input tokens;
the on run used two calls and 47,661 actual input tokens. Because Provider
trajectories differed, these totals are quality/safety and duplicate-existence
evidence only, not a causal token A/B estimate.

Two 32,768-token runs exercised the protective budget path. Both treatments
restored the target memory, read all 8 shards, preserved 16 confirmed facts,
and recorded no forbidden invocation or hard-limit violation, but both ended
at `TOOL_CALL_BUDGET_EXCEEDED`. The on run recorded 6 duplicate records across
3 calls; the off run recorded 18 across 6 calls. Their Provider trajectories
differed, so this is fact-preservation and duplicate-existence evidence, not a
causal comparison. No eviction or compaction change is justified.

## Candidates measured but not changed

- Stable policy/kernel and native Tool schema are the largest fixed costs, but
  telemetry does not prove semantic redundancy. Removing or splitting protocol
  text would change the model contract and is deferred.
- Observations, currentState, trajectory, working set, history/memory/archive,
  rehydration, and compaction contain required facts and/or Authority-specific
  references in the successful long run. No safe additional reduction is
  proven beyond the continuation candidate.
- Automatic Provider cache is functioning. No cache protocol change is
  justified; changing cache layout without Provider support would risk cache
  misses and transport drift.
- Token calibration has visible estimator deltas, but actual usage is captured
  and the existing budget/eviction behavior is unchanged. Calibration remains
  deferred until a multi-provider sample shows a systematic actionable error.
- Coding/repository context and response/tool schemas were observed, but no
  duplicate substantive fact or safe bounded projection was demonstrated.

## Production closure verification

Artifact: `agent-evaluation/runs/context-phase-b-closure-probe/2026-09-07T01-33-28.929Z.json`

The closure probe used the configured real Provider/model (`qwen3.8-flash`),
native transport, one fixed synthetic Runtime Context per scenario, and three
repetitions for each paired `off`/`on` treatment. Request construction,
stable-prefix inputs, initial facts, and transport were held constant within
each pair.

| Scenario | Off actual input | On actual input | Off → on request bytes | Duplicate substantive payloads | Cache | Quality gates |
|---|---:|---:|---:|---:|---|---|
| repair | 6,351 | 6,238 | 28,839 → 28,456 (-383) | 1 → 0 | first off control cold `miss`, then `partial_hit`; on-runs `partial_hit` | valid action, causal fact preserved, no repeat |
| recovery | 6,569 | 6,456 | 29,870 → 29,487 (-383) | 1 → 0 | `partial_hit` on all runs | read-only reconciliation, no repeated mutation, causal fact preserved |
| completion | 4,262 | 4,149 | 21,293 → 20,910 (-383) | 1 → 0 | `partial_hit` on all runs | valid completion, no protected mutation, causal fact preserved |
| rehydration | 6,214 | 6,101 | 28,029 → 27,646 (-383) | 1 → 0 | `partial_hit` on all runs | untrusted memory pointer reconciled with live read |

Across all 12 pairs, `on` reduced Provider actual input by exactly 113 tokens
and the final request by 383 bytes. Every `off` sample contained one substantive
duplicate (`fullExpansionCount=5`); every `on` sample contained zero. All 24
samples passed valid-action and causal-fact checks. Recovery never repeated the
unknown-side-effect mutation.

Every `on` sample was `partial_hit`; one first `off` control sample was a normal
cold `miss`, and subsequent controls were `partial_hit`. No cache or
stable-prefix change was needed. The latest rehydration repetitions all used
valid `tool_calls`; an earlier probe also observed a valid `stop` response.
This finish-reason variance caused no fact or action regression.

The 131,072-token continuity gate passed: 5/5 model calls, 8/8 shard reads,
correct `ORCHID` memory recall, required facts preserved, automatic-cache
partial hits, and no forbidden invocation. Different paired long-run
trajectories mean totals are not causal A/B evidence. The 32,768-token
`TOOL_CALL_BUDGET_EXCEEDED` result is classified as Provider trajectory/runtime
Tool-budget termination, not a Context, eviction, or compaction defect.

The specified Context baseline remains **48 passed / 4 failed**: E079 ×1,
E122 ×2, and E131 ×1. E151 is 7/7, E114 3/3, E142 4/4, and E150 12/12.
`pnpm build` passes. Repository-wide `pnpm exec tsc --noEmit` remains red only
on unrelated pre-existing test/canary typing errors; the closure probe itself
is type-clean after aligning its fixture to the current `stepProgress`
contract. The wider historical `test:context-quality` suite still has
unrelated pre-existing Runtime-state failures and is not the Phase-B gate.

## Closure decision

The native continuation observation dedupe is **production-ready for the
scoped Phase-B candidate**. It is enabled by default for `native_tools`, keeps
`off` only as an experiment control, and does not authorize further changes to
stable policy, Tool schema, rehydration, eviction, compaction, cache protocol,
or other Context projections without new telemetry. Phase B is verified and
closed for this optimization scope; the four pre-existing baseline failures
remain recorded and are not part of this closure.
