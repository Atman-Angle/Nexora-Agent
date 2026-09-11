# Decision Efficiency Candidate A — Tool Catalog Duplication Specification

**File:** `DECISION_EFFICIENCY_CANDIDATE_A_TOOL_CATALOG_SPEC.md`
**Status:** `CONTROLLED_A_B_FAILED_NO_GO`
**Date:** 2026-09-08
**Baseline branch:** `codex/harness-optimization-production-baseline`
**Predecessor state:** Pure Native Function Calling = verified / frozen

> This specification authorizes only a reversible controlled A/B experiment. It
> does not authorize deleting the Prompt Tool Catalog from the production
> default, changing Provider Function Schemas, changing Runtime Authority, or
> starting any other Decision Efficiency optimization.

## 1. Outcome

Candidate A tests whether the current Prompt `[TOOLS]` catalog is redundant
under Pure Native Function Calling.

The candidate changes only the model-visible presentation of per-Tool
definition facts:

```text
Control:
  Prompt stable [TOOLS] catalog
  + unchanged Provider-native function schemas

Candidate:
  omit per-Tool name / description / parameter contract from Prompt [TOOLS]
  + retain global Tool execution, safety, batching, control, Authority,
    Runtime, and Completion guidance
  + leave Provider-native function schemas byte-for-byte unchanged
```

The expected benefit is removal of duplicate Tool definition information, not
general Prompt shrinking. The canonical Runtime Tool Contract remains the sole
source of truth and continues to project the unchanged Provider Function
Schema.

## 2. Current Evidence

Current evidence is recorded in:

- `docs/evidence/pure-native-function-calling-real-provider-probe.json`
- `docs/evidence/decision-efficiency-candidate-a-tool-catalog-audit.json`

The current built-in set exposes:

```text
3 control functions
13 Runtime Tools
16 total Provider functions
```

Current structural measurements use the same Runtime Tool Contract and native
OpenAI-compatible projection:

```text
Prompt [TOOLS] stable segment: 17,553 bytes / 4,389 estimated tokens
Provider function schemas:     17,529 bytes / 4,383 estimated tokens

Control Tool portion of Prompt catalog:  5,255 bytes
Runtime Tool portion of Prompt catalog: 12,307 bytes
```

For a representative native request containing the complete built-in Tool set:

```text
request with Prompt Tool Catalog:    46,733 bytes
request without Prompt Tool Catalog: 27,383 bytes
exact byte delta:                    19,350 bytes
estimated token delta:                4,838 tokens
```

This is a structural maximum, not a guaranteed Provider billing saving. JSON
escaping, prompt cache hits, Provider tokenization, dynamic context, retries,
and differing trajectories can change the actual saving.

The current real `qwen3.8-flash` native probe produced:

```text
Single-call:
  2 logical Model Calls / 2 Provider attempts
  22,933 actual input tokens
  159 actual output tokens
  101,088 summed final request bytes
  final request byte p50 = 49,327, max = 51,761
  stablePrefix attribution = 57,928 bytes across 2 attempts
  providerTools attribution = 35,058 bytes across 2 attempts
  responseFormat attribution = 0 bytes

Multi-call:
  2 logical Model Calls / 2 Provider attempts
  23,938 actual input tokens
  251 actual output tokens
  103,718 summed final request bytes
  final request byte p50 = 49,477, max = 54,241
  stablePrefix attribution = 57,928 bytes across 2 attempts
  providerTools attribution = 35,058 bytes across 2 attempts
  responseFormat attribution = 0 bytes
```

Both probe scenarios completed successfully with:

```text
success rate = 100%
false success = 0
invalid/unknown function calls = 0
response rejection = 0
Provider failure = 0
failed Tool = 0
duplicate mutation = 0
usage-incomplete attempts = 0
wire-telemetry-incomplete attempts = 0
```

The no-tool completion turn is classified by the existing Decision Efficiency
waste taxonomy as `no_tool_response=1`; this is the expected final-answer turn,
not a protocol repair.

## 3. Exact Duplication Boundary

For every current control and Runtime Tool, the following source facts are
projected twice:

```text
canonical name
description
input schema
decision.useWhen
decision.avoidWhen
decision.nonGoals
effect kind
evidence.produces
```

The Prompt `[TOOLS]` catalog contains the canonical `ProviderToolContract`
objects. The Provider-native `tools` array contains a Provider-safe alias and a
function description that embeds the same name, description, use/avoid
guidance, non-goals, effect, produces, and the same JSON Schema as
`parameters`.

Prompt-only facts:

```text
ProviderToolContract.kind
canonical runtime Tool name in the Prompt catalog
```

Provider-only facts:

```text
Provider-safe function alias
OpenAI function wrapper and type field
parameters field name
```

These wrapper-only differences do not justify retaining duplicate semantic Tool
definitions. Alias normalization and canonical-name decoding already exist in
the native Function Calling path.

## 4. Control vs Candidate

### Control

The Control arm is the current verified Pure Native Function Calling baseline:

```text
Runtime Tool Contract
  -> Prompt stable [TOOLS] catalog
  -> Provider function schemas
```

### Candidate

The Candidate arm removes only the per-Tool definition objects from the Prompt
stable `[TOOLS]` segment:

```text
Runtime Tool Contract
  -> Provider function schemas
```

The Candidate must not alter:

```text
Runtime Tool Contract
Provider-safe alias generation
Provider function name
Provider function description
Provider parameters schema
tools array ordering
tool_choice
parallel_tool_calls
```

## 5. What Is Removed

The Candidate may remove only:

```text
the complete per-Tool [TOOLS] object list from the Prompt stable prefix
```

This includes the duplicated per-control and per-Runtime-Tool:

```text
name
description
inputSchema
decision.useWhen
decision.avoidWhen
decision.nonGoals
effect
produces
kind
```

The Candidate may replace the removed segment with a small stable statement
that says Tool definitions are supplied exclusively by Provider-native
functions. This statement must not duplicate per-Tool definitions.

## 6. What Must Remain

The following Prompt content is not Tool definition duplication and must remain:

```text
kernel Authority and safety rules
native transport rule
control function names and global control semantics
native/effectful Tool batch limits
Approval boundary rules
effect and side-effect safety rules
Runtime-owned ID and state rules
Completion Gate semantics
Host Policy
Agent Profile
Project Instructions
Skills catalog
```

Control semantics and global execution rules remain in Prompt even though
control schemas remain in Provider functions. The Candidate must not remove:

```text
nexora_update_plan semantics
nexora_request_input semantics
nexora_delegate_workers semantics
nexora_select_skills semantics when Skills are available
```

## 7. Measurement Contract

Every A/B task and attempt must record:

```text
exact final request bytes
actual Provider input tokens
actual Provider output tokens
actual Provider total tokens
provider-visible estimated input tokens
budget measured input tokens
providerVisibleMeasurementDelta

stablePrefix bytes / estimated tokens
stable Tool Catalog bytes / estimated tokens
Provider tools bytes / estimated tokens
dynamicContext bytes / estimated tokens
nativeContinuation bytes / estimated tokens
responseFormat bytes / estimated tokens

logical Model Calls
Provider attempts
success rate
false success
repair / rejection counts
invalid function calls
unknown function calls
Tool selection correctness
expected vs actual Tool arguments
Tool batch size and concurrency histograms
Approval decisions
Evidence count
effective action count
input tokens / successful task
input tokens / effective action
wall-clock duration
```

Stable Tool Catalog and Provider tools token attribution remain
`estimated_diagnostic`. They must never be reported as Provider-exact actual
tokens. Provider-exact values come only from Provider usage and exact request
byte telemetry.

Cache status must be recorded per attempt:

```text
cacheStatus
cachedInputTokens
cacheEligibleInputTokens
cacheWriteInputTokens
```

A token reduction observed only under differing cache trajectories is not a
causal saving.

## 8. Controlled A/B Design

The primary causal cohort must fix:

```text
Provider = OpenAI-compatible qwen3.8-flash
model = qwen3.8-flash
transport = native_tools
tool set = current complete built-in set
budgets
initial workspace fixture
task text
Host Policy
Project Instructions
Agent Profile
Provider reasoning policy
thinking parameter
prompt cache protocol
```

The primary cohort must disable prompt cache to isolate the structural input
change from cache-eligibility differences.

A secondary production-like cohort may use the current automatic cache policy,
but its results must be reported separately and cannot replace the primary
causal comparison.

### Task Lanes

The A/B must cover all of the following, not only the easiest single-Tool case:

1. **Single read:** read one known file and report exact content.
2. **Multi-call batch:** read at least two files in one native response and
   preserve call-ID/result mapping.
3. **Similar Tool selection:** distinguish `filesystem.read`,
   `filesystem.search`, and `git.show` when the task makes each one correct.
4. **Read vs mutation:** choose read when no change is requested and
   `filesystem.patch` or `filesystem.write` when an exact change is requested.
5. **Protected effect:** exercise a Tool requiring Approval and verify the
   Approval boundary.
6. **Destructive/protected Tool:** include `shell.execute` or `process.stop`
   with explicit denial and approval branches.
7. **Control vs Runtime Tool:** require `nexora_update_plan`,
   `nexora_request_input`, and a Runtime Tool in separate scenarios where each
   is correct.
8. **Recovery:** trigger a failed read or invalid path, then use a genuinely
   different safe strategy.
9. **Coding/filesystem task:** perform a bounded code or file change, verify it,
   and complete through the Completion Gate.

Each lane should use at least three paired repetitions. Pair order must be
randomized or alternated, and each pair must begin from an identical fixture.

## 9. Correctness and Safety Gates

Candidate A cannot pass if any of the following occur:

```text
success rate decreases
false success increases
invalid or unknown function calls increase
wrong Tool selection increases
wrong arguments increase
repair or response rejection increases
logical Model Calls increase without an equal or greater valid efficiency gain
Provider attempts increase
Approval behavior changes
idempotency or duplicate side-effect protection changes
Evidence or Artifact authority changes
recovery behavior regresses
Completion Gate acceptance or rejection semantics change
Context Phase B regression appears
```

Tool selection correctness must be judged from persisted Runtime facts:

```text
expected Tool names
actual Tool names
expected arguments
actual validated arguments
Approval request and decision
Invocation status
Evidence references
Completion Gate result
```

External workspace verification is required for mutation lanes.

## 10. Function Calling Compatibility

Candidate A must preserve all verified Pure Native Function Calling behavior:

```text
native-only transport
Provider function definitions
strict parameters schemas
tool_choice=auto
parallel_tool_calls=true
no response_format
null/empty assistant text with native calls
Provider call ID preservation
distinct call IDs in multi-call batches
ordinal preservation
one-to-one function result continuation
alias normalization
malformed argument rejection
unknown function rejection
duplicate call-ID rejection
native capability declaration and validation
```

The Candidate must not introduce structured output, JSON text parsing,
synthetic call IDs, or any second Action transport.

## 11. Context Phase B Compatibility

Candidate A must not change:

```text
Context projection dedupe
native continuation projection
rehydration
eviction
compaction
observation retention
artifact/invocation/evidence reference behavior
```

The only permitted Context effect is the intentional change to the stable
Prompt prefix digest and its estimated token attribution. Any change in native
continuation payload handling is a blocker.

## 12. Non-goals

Candidate A does not include:

```text
dynamic Tool filtering
Tool batching optimization
Tool schema shortening
Provider description shortening
Context compression
observation compression
stable kernel rewriting
Host/Profile/Project policy shrinking
Runtime changes
Approval changes
Completion changes
Function Calling protocol changes
production default change
```

Those are separate candidates and require separate authorization.

## 13. Acceptance Criteria

The controlled A/B is accepted only when all are true:

1. The Candidate arm removes the Prompt per-Tool `[TOOLS]` object list while
   leaving Provider `tools` byte-for-byte unchanged.
2. All correctness and safety gates in Section 9 pass.
3. All Function Calling and Context Phase B compatibility gates pass.
4. In the cache-disabled primary cohort, median actual input tokens per
   successful task decrease by at least 10% versus Control.
5. Actual input tokens per effective action do not increase.
6. Logical Model Calls and Provider attempts do not increase.
7. Tool selection correctness remains 100% on deterministic lanes.
8. False success remains zero.
9. Invalid/unknown calls and response rejection remain zero on deterministic
   lanes and do not increase on real-provider lanes.
10. Wall-clock does not show a material regression.
11. Complete usage and wire telemetry is present for every attempt.
12. Rollback restores the Control Prompt exactly and requires no data migration.

A byte or estimated-token reduction alone cannot pass any gate.

## 14. Verification Plan

Verification must be staged:

1. **Static contract check:** prove Provider `tools` bytes, ordering, aliases,
   descriptions, and schemas are identical between arms.
2. **Prompt telemetry check:** prove only the stable `[TOOLS]` segment changed.
3. **Deterministic protocol suite:** rerun native protocol, malformed argument,
   unknown function, duplicate ID, continuation, and capability boundary tests.
4. **Runtime authority suite:** rerun Tool validation, Approval, Invocation,
   idempotency, Evidence, Recovery, Plan, and Completion Gate tests.
5. **Context Phase B suite:** rerun continuation, dedupe, rehydration, and
   durable reopen tests.
6. **Controlled A/B:** execute the task lanes in Section 8.
7. **Real-provider evidence:** record Provider usage, cache status, exact wire
   bytes, call IDs, Tool selection, and completion evidence.
8. **Production decision:** promote the Candidate only after all acceptance
   criteria pass and a separate production release review approves the default.

## 15. Rollback Criteria

Rollback is mandatory if any correctness, safety, Authority, Approval,
Evidence, recovery, Completion, Function Calling, or Context Phase B gate fails.

Rollback must:

```text
disable the experiment switch
restore the complete Prompt [TOOLS] stable segment
leave Provider Function Schemas unchanged
require no persisted data migration
preserve all Runtime and audit facts
```

Rollback is also mandatory if observed token savings are explained primarily by
differing Provider trajectories or cache behavior rather than the removed
Prompt Tool Catalog.

## 16. Go / No-Go

### Audit decision

**GO for controlled A/B implementation.**

Rationale:

```text
Pure Native Function Calling is verified and frozen.
Provider Function Schemas already contain every per-Tool definition fact.
The Prompt [TOOLS] segment duplicates those facts at near 1:1 size.
The structural maximum is large enough to justify a controlled experiment.
The change can be isolated to one stable Prompt segment and rolled back
without a data migration.
```

### Production decision

**NO-GO for production default change.**

The Candidate must not become the default until the controlled A/B passes every
acceptance criterion and a separate production review approves promotion.

### Final status

```text
Candidate A audit = GO
Controlled A/B implementation = READY_FOR_IMPLEMENTATION
Production default change = NO-GO
```

## 17. Controlled A/B Result

Date: 2026-09-09

Evidence:

- `docs/evidence/decision-efficiency-candidate-a-ab-disabled.json`
- `docs/evidence/decision-efficiency-candidate-a-ab-analysis.json`

The controlled A/B used the current OpenAI-compatible `qwen3.8-flash`
Provider, ten high-risk task lanes, five interleaved repetitions per arm, and
50 valid paired invariants. Provider Function Schema bytes and digest were
identical between arms.

Result:

```text
Candidate A controlled A/B = failed
Candidate A = NO-GO
Production default = full Tool Catalog
```

Although the 45 pairs where both arms succeeded showed a 30.84% median actual
input-token reduction, the hard gates failed:

```text
success rate: 96% Control -> 92% Candidate
response rejection: 15 Control -> 20 Candidate
mutation success: 80% Control -> 60% Candidate
protected success: 80% Control -> 60% Candidate
maximum logical Model Calls: 5 Control -> 8 Candidate
```

The Provider also applied implicit cache hits despite the Nexora prompt-cache
policy being disabled. Therefore the run is warm implicit-cache evidence, not
cold-cache evidence. Token savings do not override the correctness and safety
regressions.
