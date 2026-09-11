# Pure Native Function Calling Specification

Status: `READY FOR IMPLEMENTATION`

Feature: `pure-native-function-calling`

Audit date: `2026-09-07`

Decision: `PARTIAL`

This document is based on the current working tree, including existing uncommitted
changes. It does not authorize production-code, test, migration, Runtime,
Completion Gate, Approval, or Context changes in the audit/specification phase.

## 1. Status

The repository audit is complete for the currently reachable Agent Tool / Action
transport surface. This specification is complete enough to start a separately
authorized implementation feature.

The specification is not an implementation report. `structured_output` remains
implemented and production-reachable at the time of writing.

## 2. Outcome

The target architecture is:

```text
Provider-native Function Calling
  -> Provider Adapter
  -> Canonical Function Call
  -> Harness deterministic routing
  -> Runtime Tool or Harness Control Function
  -> Runtime Authority
  -> Canonical Function Result
  -> Provider Adapter
  -> Provider continuation
```

The architectural migration is approved in principle. The current repository is
not yet approved for immediate global deletion because the compatibility surface,
capability boundary, completion contract, and migration verification are not yet
implemented.

## 3. Current State Evidence

### 3.1 Production Agent transport consumers

The following are real production-reachable consumers of `structured_output`:

| Surface | Evidence | Classification |
| --- | --- | --- |
| Prompt transport union and transport-specific prompt instructions | `packages/harness/src/prompt.ts` (`ProviderTransportProfile`, `transportInstructions`) | Production path |
| Adapter response-format selection | `packages/harness/src/providers/adapter.ts` (`json_schema` for structured mode) | Production path |
| OpenAI-compatible request wire | `packages/harness/src/providers/openai-compatible.ts` (`response_format.type=json_schema`) | Production path |
| OpenAI-compatible structured response parser | `packages/harness/src/providers/openai-compatible.ts` (`parseStructuredResponse`, `structuredCallId`) | Production path |
| Environment transport selection | `packages/harness/src/providers/openai-compatible.ts` (`NEXORA_MODEL_TOOL_TRANSPORT`) | Production path |
| Gateway missing-transport default | `packages/harness/src/provider-gateway.ts` defaults to `structured_output` | Production compatibility path |
| Desktop model profile schema and persistence | `apps/desktop/src/main.ts`, `apps/desktop/src/shared.ts`, `apps/desktop/src/runtime-service.ts` | Production path |
| Desktop transport selector | `apps/desktop/src/renderer/app.ts` | Production UI path |
| Desktop UAT scenarios | `apps/desktop/uat.mjs` | Production-adjacent acceptance path |

The native path is also a complete production Agent path:

```text
Provider native tool_calls
  -> adapter normalization
  -> ModelResponse
  -> Harness deterministic routing
  -> RuntimeAction
  -> Runtime Tool / control routing
  -> Invocation, Approval, Evidence, Completion Gate
```

Current controls observed in the repository are:

- `nexora_respond`
- `nexora_update_plan`
- `nexora_request_input`
- `nexora_delegate_workers`
- `nexora_select_skills`

Runtime tools remain distinct from control functions. A Provider function syntax
does not make a control function a Runtime Tool Invocation.

### 3.2 Structured output is not currently an independent production generator

The production search found `response_format`, `json_schema`, and the structured
parser only in the Agent decision/action transport implementation. No independent
production report, document, ordinary JSON-generation, or non-Agent structured
generation API was found.

This statement is limited to the scanned repository and current production
entrypoints. External consumers not present in this repository are `unknown`.

### 3.3 Test, fixture, benchmark, and documentation consumers

The following are not independent production consumers, but must be migrated or
removed before the transport can be deleted:

- `tests/fixtures/d5-external-consumers/provider.ts`: test-only structured Provider.
- `tests/runtime/d4-provider-adapter.test.ts`: structured response-format adapter
  tests.
- `tests/runtime/e120-general-agent-prompt-profile.test.ts`: dual-wire prompt
  assertions.
- `tests/runtime/e121-provider-native-tool-protocol.test.ts`: structured parsing,
  argument normalization, and rejection coverage.
- `tests/runtime/e151-provider-wire-telemetry.test.ts`: dual transport telemetry.
- Other runtime, Desktop, CLI, benchmark, and canary fixtures that explicitly
  set `structured_output` or `NEXORA_MODEL_TOOL_TRANSPORT`.
- `ARCHITECTURE.md`, `DATA_FLOW.md`, `SYSTEM_SOP.md`,
  `docs/PROVIDER_NATIVE_TOOL_PROTOCOL_SPEC.md`,
  `docs/PROVIDER_NATIVE_CONTINUATION_SPEC.md`,
  `docs/BUILD_WITH_NEXORA_RUNTIME.md`,
  `packages/harness/src/providers/README.md`, `TESTS.md`, and `apps/desktop/README.md`.

These consumers prove that the path is not dead code. They do not prove that it
is semantically indispensable after a native migration.

### 3.4 Fallback and ordinary text findings

No native-call failure to structured-output automatic fallback was found in the
current production code. The current Provider adapter selects one transport per
request/Run and does not switch transport after a failure.

There is, however, a compatibility default: `provider-gateway.ts` uses
`structured_output` when a custom `RuntimeProvider` does not declare a transport.
This is not a native-failure fallback, but it is an implicit structured transport
entry and must be removed or made an explicit native-only contract.

Current ordinary-text behavior is mixed:

- Native ordinary content is not parsed as a Tool.
- `agent-loop.ts` currently permits no-call text to compile to
  `propose_finish` in some direct-answer and finalization paths.
- After workspace execution, bare text is rejected with
  `FINAL_CONTROL_REQUIRED` and the model is instructed to call
  `nexora_respond`.

The audit does not find an authority distinction that justifies making
`nexora_respond` mandatory:

- `packages/harness/src/providers/model-response.ts:71-74` defines it as a
  strict `{ text }` wrapper.
- `packages/harness/src/agent-loop.ts:253-285` parses that wrapper and
  `packages/harness/src/agent-loop.ts:376-382` compiles it to the existing
  `propose_finish` boundary.
- `packages/harness/src/agent-loop.ts:415-430` can compile ordinary
  `ModelResponse.text` to the same `propose_finish` boundary in a direct-answer
  path.
- `packages/runtime/src/runtime.ts:1882-1903` receives only the summary and
  `completionMode`; it does not receive or persist a distinct
  `nexora_respond` authority.
- `packages/runtime/src/completion-gate.ts:104-206` determines acceptance from
  Run state, Plan/contract, Invocation resolution, Evidence, host requirements,
  and completion mode, not from the presence of `nexora_respond`.

Therefore `nexora_respond` adds a Function-call/schema layer, JSON argument
serialization, and an extra validation/repair surface around text that already
exists in `ModelResponse.text`, without adding Runtime Authority or Evidence.
The target contract is instead:

- Function Calling is the Agent Action Protocol for Tools and control actions.
- Final assistant text is the User-facing Delivery Protocol and a
  non-authoritative completion candidate.
- The existing Runtime Completion Gate remains the only completion authority.

Public text streaming may remain observational and non-authoritative. A
non-empty final text with no Function Call may enter the existing completion
boundary, but it may not execute a Tool, alter a Plan, request input, modify Run
status, or satisfy completion without the Completion Gate.

### 3.5 Existing wire and persistence evidence

The current native OpenAI-compatible adapter emits:

- `tools` with function definitions and true input schemas;
- `tool_choice: "auto"`;
- `parallel_tool_calls: true`;
- native `tool_calls` responses;
- assistant/tool continuation messages with matching `tool_call_id` values.

The current normalized response is:

```ts
type ModelResponse = {
  text: string | null;
  toolCalls: Array<{
    callId: string;
    name: string;
    arguments: JsonValue;
  }>;
  finishReason: string | null;
};
```

Native Provider call IDs are persisted in `model.turn` payloads and used to
rebuild native continuation. Structured output has no Provider call ID and
currently derives `structured_<contentDigest>_<index>` synthetic IDs.

`modelDecisionId`, `executionUnitId`, Runtime Invocation ID, logical model call
ID, Provider attempt ID, and Provider function call ID are different identifiers
in the current architecture. The Provider attempt/model-call ledger exists, but
Provider function call identity is currently primarily a `model.turn` fact, not a
separate canonical transport record.

## 4. Removal Decision

### Decision

`PARTIAL`:

- **Architecture target:** `GO`.
- **`nexora_respond`:** `REMOVE` as the mandatory completion Function and from
  the canonical control-function catalog.
- **Immediate global deletion in the current working tree:** `NO-GO`.
- **Reason:** structured mode has no proven independent production capability
  consumer, but it is still a real Agent transport and its public/configuration
  surface has not been migrated. Native capability verification and the revised
  text-candidate completion semantics are not yet implemented as the single
  contract.

The migration may proceed as a dedicated implementation feature after this
specification is accepted. The implementation feature must finish the migration
before deleting the last structured path. Removing `nexora_respond` does not
remove `compileModelFinish`, `completionMode`, or any Runtime Completion Gate
behavior.

## 5. Provider-facing Protocol

The Provider-facing contract is Function Calling, not a Provider-specific
message model.

Each Run uses one explicit native-function transport. The Adapter may map that
contract to a Provider's wire representation, for example:

```text
Provider-native function call items/messages
  <-> CanonicalFunctionCall
Provider-native function result items/messages
  <-> CanonicalFunctionResult
```

The Core must not require `assistant.tool_calls`, `role: tool`,
`function_call_output`, or any other single Provider wire shape.

The Provider request must expose the canonical Runtime Tool and control
functions, their canonical input schemas, deterministic aliases, and the
continuation facts required by that Provider. It must not expose Runtime-owned
Run, Plan, Step, Invocation, Evidence, Approval, or status identifiers as
model-owned arguments.

A Provider response that contains ordinary content but no Function Call is not an
Agent Tool or control action. It may be captured as non-authoritative text and,
when non-empty, routed as a completion candidate to the existing
`propose_finish`/Completion Gate boundary. It cannot execute a Tool, alter a
Plan, request user input, modify Run status, or complete a Run outside that
gate.

## 6. Canonical Function Call Contract

The canonical internal contract is Provider-neutral:

```ts
type CanonicalFunctionCall = {
  readonly providerCallId: string;
  readonly functionName: string;
  readonly arguments: JsonValue;
  readonly ordinal: number;
};

type CanonicalFunctionResult = {
  readonly providerCallId: string;
  readonly status: "succeeded" | "failed" | "rejected" | "unknown";
  readonly output: JsonValue;
};
```

The existing `ProviderToolCall` / `ModelResponse` shape is a close transitional
representation, but the implementation must make the Provider-neutral contract
explicit and preserve the distinction between Provider facts and Runtime
commands.

Invariants:

1. `providerCallId` preserves a Provider-native stable call identity when one is
   available.
2. If the Provider exposes an equivalent stable correlation primitive, the
   Adapter may map it deterministically to `providerCallId`.
3. If no stable native correlation identity exists, the Provider is unsupported
   for Agent execution.
4. A Function Call identity must never be synthesized as a general fallback
   from function name plus arguments digest, content digest, or ordinal alone.
   Two otherwise identical Function Calls must still be able to carry distinct
   identities.
5. A batch is ordered by `ordinal` and contains at most the existing bounded
   number of calls.
6. Every accepted call has exactly one deterministic result.
7. A result cannot be attached to another call, Run, model decision, or execution
   unit.
8. Function arguments are parsed as JSON and validated against the canonical
   function schema before Runtime compilation.
9. A Function Call is not itself an Invocation. Runtime creates the Invocation
   only after Harness routing and Runtime validation.

## 7. Runtime Tool Routing

Runtime Tool functions follow the existing authority path:

```text
CanonicalFunctionCall
  -> alias resolution
  -> canonical input parse/default expansion
  -> Harness batch validation
  -> Runtime Action
  -> Approval when required
  -> Tool Invocation
  -> side effect / read
  -> result, Evidence, recovery facts
  -> CanonicalFunctionResult
```

The Runtime remains the owner of Invocation ID, input digest, idempotency,
Approval, side-effect state, unknown-effect recovery, Evidence, and completion
authority.

Tool result payloads must remain bounded. Large content remains Artifact-owned
and is returned through the existing result/reference projection rather than
creating a transport-specific authority.

## 8. Control Function Routing

Control functions remain Harness controls even though they use Function Calling
syntax:

| Function | Routing | Runtime Invocation |
| --- | --- | --- |
| `nexora_update_plan` | Harness parses and compiles the existing Plan update | No |
| `nexora_request_input` | Harness validates and enters the existing waiting flow | No |
| `nexora_delegate_workers` | Harness compiles the existing delegation action | No |
| `nexora_select_skills` | Harness validates strategy-only Skill selection | No |

The current exclusivity and batching rules remain: input, delegation, and
skill-selection controls are exclusive where currently required; Plan
updates may coexist only where the existing contract permits them; Runtime Tool
calls retain the existing bounded batch and execution-unit rules.

No control function may grant Tool permission, bypass Approval, write Run
status, create Evidence directly, or become a second state machine.

## 9. Completion Semantics

The target completion contract is:

```text
Provider response contains Function Call
  -> Agent Action
  -> deterministic Harness / Runtime routing

Provider response contains non-empty final text and no Function Call
  -> non-authoritative completion candidate
  -> existing propose_finish boundary
  -> Runtime Completion Gate
  -> accepted: Result + succeeded
  -> rejected: existing repair / next-decision flow
```

The final text is valid as a candidate for both:

- a grounded direct answer before any Plan or Tool execution; and
- a final answer after execution, subject to the existing Evidence, Artifact,
  Plan, pending-request, and unknown-effect gates.

Ordinary assistant text:

- may be streamed to a non-authoritative UI observer;
- may be retained as Provider attempt evidence;
- may be routed only to the existing completion-candidate boundary;
- must never be parsed as a Tool, Plan update, input request, delegation, Skill
  selection, or any other control action;
- must never modify Run status or satisfy Completion Gate directly.

This deliberately changes the current post-execution bare-text behavior: it no
longer requires a synthetic completion Function, but it still cannot bypass the
Completion Gate. The implementation must remove `nexora_respond` from the
canonical function catalog, prompts, fixtures, and completion-specific repair
instructions while preserving the existing deterministic gate and repair flow.

## 10. Canonical Function Schema Authority

Deleting structured output does not delete JSON Schema. The authority covers
both Runtime Tools and Harness Control Functions.

The single source of truth remains:

```text
Runtime Tool Contract ───────┐
                             ├→ Canonical Function Descriptor
Control Function Contract ──┘
                                      ↓
                              Provider Function Schema
```

`nexora_update_plan`, `nexora_request_input`, `nexora_delegate_workers`,
`nexora_select_skills`, and every other control function must have one canonical
parameter schema and descriptor. The Provider schema, Prompt, and Agent Loop
must not maintain a second parameter protocol for the same Function.

The Provider must receive the true schema, including strict object boundaries,
required fields, enums, bounds, and nested structures. Prompt prose may explain
when to use a function, but it must not define a second parameter contract.

Tool Catalog duplication and token optimization are out of scope. Any existing
stable Tool Catalog cost is a later Decision Efficiency measurement concern, not
permission to weaken schemas or move schema authority into prompts.

## 11. Provider Capability Contract

An Agent-capable Provider must explicitly declare or pass verification for:

- native function definitions;
- native function-call responses;
- stable Provider call identity;
- function-result continuation;
- multi-turn Function Calling;
- null/empty assistant text with a Function Call;
- the supported maximum Function Call batch size;
- deterministic alias/argument preservation;
- Provider error reporting for unsupported function features.

If a Provider cannot satisfy the contract, it is explicitly unsupported for
Agent execution. It must not silently fall back to `structured_output`, JSON
Action, or ordinary-text action parsing.

Current evidence: the repository has model context/output capability metadata and
adapter contract tests, but no sufficiently authoritative production capability
probe for all Function Calling requirements above. The probe design and its
runtime result are therefore `unknown` and are a prerequisite for implementation
completion.

The capability contract should remain small: declaration plus a focused adapter
probe/contract test, not a new general capability framework.

## 12. Call-ID / Continuation Contract

Identifier mapping:

| Identifier | Owner | Purpose |
| --- | --- | --- |
| Provider function call ID | Provider/Adapter | Correlates a Function Call with its Provider result |
| Model decision ID | Harness/Runtime | Correlates one normalized model response and audit turn |
| Logical model call ID | Runtime ledger | Correlates one decision request across Provider attempts |
| Provider attempt ID | Runtime ledger | Correlates one physical request attempt |
| Execution unit ID | Harness/Runtime | Correlates a bounded Tool execution batch |
| Runtime Invocation ID | Runtime | Owns one Tool execution intent and recovery state |

Rules:

1. Provider-native stable call identity is preserved in the normalized
   `model.turn` audit fact and enough durable continuation data to reconstruct
   results after reopen.
2. An equivalent stable native correlation primitive may be mapped
   deterministically by the Adapter; no content-derived or ordinal-only
   identity is permitted.
3. Runtime never treats a Provider call ID as an Invocation ID or state key.
4. One batch preserves call order and one-to-one result mapping.
5. Continuation is rebuilt from Runtime facts, not from a live Provider session.
6. Native continuation deduplication from Context Phase B remains enabled only
   under its existing `ref + digest` evidence rule.
7. A missing, duplicate, or ambiguous Provider call ID is a Provider protocol
   failure; it is not repaired by creating a new Runtime-owned ID.

The existing OpenAI-compatible continuation implementation is evidence for the
native path, but its wire message construction must remain inside the Adapter.

## 13. Error / Repair Contract

The implementation must classify at least:

- unknown function;
- invalid arguments JSON;
- schema validation failure;
- unsupported Function Calling capability;
- missing call ID;
- duplicate call ID;
- ambiguous call/result mapping;
- Provider protocol violation;
- Runtime Tool failure;
- Approval rejection;
- unknown side effect;
- Completion Gate rejection.

Boundary rules:

- Provider wire/protocol errors fail at the Adapter/Harness boundary.
- Function arguments are validated before Runtime effect.
- Runtime Tool failures retain existing Invocation, Evidence, recovery, and
  retry semantics.
- Approval rejection remains an Approval fact, not a Provider transport error.
- Completion rejection remains a Completion Gate fact.
- No JSON Action repair parser remains.
- No Run may switch to structured output after a native error.

Repair may ask the model for a corrected Function Call through the same native
Function Calling channel. Repair must not broaden schemas, invent call IDs,
skip Runtime validation, or silently reinterpret ordinary text as a Tool or
control action. A rejected completion candidate follows the existing repair or
next-decision path; it is not accepted merely because the model said it was
complete.

## 14. Migration Scope

The implementation feature must:

1. Make native Function Calling the only Agent transport in the canonical
   Provider/Harness contract.
2. Introduce or formalize the canonical Function Call/Result boundary.
3. Migrate all control functions and Runtime Tool routing to that boundary.
4. Remove `nexora_respond` as a mandatory completion Function and route
   non-empty final text through the existing non-authoritative completion
   candidate boundary.
5. Add the minimal Provider capability declaration/probe required by Section 11.
6. Preserve native continuation, call identity, Approval, Invocation, Evidence,
   Recovery, Plan Authority, and Completion Gate behavior.
7. Migrate Desktop model profiles, environment parsing, CLI/canary entrypoints,
   benchmark metadata, fixtures, and UAT to native-only configuration.
8. Migrate tests from dual-transport assertions to native-only assertions plus
   explicit unsupported-provider negatives.
9. Re-audit all external package consumers and test fixtures before deletion.

No implementation step may change Runtime Authority or Context Phase B merely to
make the transport migration easier.

## 15. Legacy Removal Scope

After migration evidence passes, delete the Agent transport surfaces for:

- `structured_output` in `ProviderTransportProfile`;
- `NEXORA_MODEL_TOOL_TRANSPORT` values and Desktop selectors that choose it;
- `response_format` as an Agent action protocol;
- `json_schema` response envelopes for `ModelResponse`;
- `nexora_respond`, `DIRECT_RESPONSE_CONTROL`, and the explicit
  `ModelDirectResponseSchema`/parser path;
- `StructuredResponseSchema`, `parseStructuredResponse`, and synthetic
  `structured_<digest>_<index>` call IDs;
- structured-only prompt branches;
- structured-only telemetry fields and dual-transport reports;
- `json_actions` and old JSON Action envelope compatibility, if any external
  consumer audit finds none;
- structured-only tests, fixtures, UAT cases, benchmark data, and documentation;
- the gateway default that silently selects structured output.

Retain:

- canonical Tool input JSON Schema;
- strict Provider function parameter schemas;
- Harness parameter normalization where still needed for native JSON arguments;
- Runtime Tool capability metadata;
- Runtime Action compilation;
- `ModelResponse.text` and the existing `propose_finish`/`completionMode`
  boundary for non-authoritative completion candidates;
- Approval, Invocation, Evidence, Recovery, Artifact, and Completion Gate;
- native continuation and Provider call ID correlation;
- Provider attempt/model-call telemetry;
- ordinary text as non-authoritative display/audit content, if still useful.

## 16. Decision Efficiency Compatibility

This migration is primarily a protocol simplification and correctness feature.
It must not redefine the verified Decision Efficiency Baseline or implement
Candidate A.

Before/after comparison should preserve the existing metric meanings:

- input tokens per successful task;
- input tokens per effective action;
- logical model calls;
- Provider attempts;
- repair/rejection counts;
- Function Call batch distribution;
- success rate and false-success rate;
- wall-clock duration;
- Provider usage/cache status buckets.

The removal of the structured response envelope may change Provider-visible
bytes, schema overhead, and call trajectory. Those are measured outcomes, not
acceptance assumptions. A token reduction is not sufficient evidence for
semantic correctness.

## 17. Context Phase B Compatibility

The migration must preserve the verified native continuation behavior:

- continuation is derived from Runtime facts;
- call IDs, function names, arguments, and results remain correlated;
- `ref + digest` deduplication does not remove required causal facts;
- rehydration remains deterministic;
- Context eviction, compaction, and artifact/reference projection retain their
  current authority boundaries;
- no structured-only continuation path is introduced;
- no new Provider session state becomes an authority.

The existing Context Phase B evidence covers native continuation only. It does
not prove that changing completion semantics or removing structured mode is
already verified; that migration evidence is `unknown` until the implementation
feature runs its focused regressions and real Provider checks.

## 18. Non-goals

This feature does not:

- implement or optimize Decision Efficiency Candidate A;
- redesign Tool Catalog filtering, batching, or token compression;
- change Runtime State Machine ownership;
- change Plan Authority or Plan schema;
- change Approval policy;
- change Invocation idempotency or unknown-effect recovery;
- change Evidence or Artifact authority;
- change Context eviction, compaction, rehydration, or Phase B dedupe rules;
- add a second Provider session/state authority;
- create a general Provider capability framework;
- retain structured generation as a hidden Agent fallback;
- remove JSON Schema from Function Calling;
- prove compatibility for external Providers not present in this repository.

An independent future structured-generation feature, if required by a real
non-Agent consumer, must be specified outside Agent Tool / Action transport and
must not be reintroduced as a hidden Agent fallback. No such current consumer
was found.

## 19. Acceptance Criteria

The implementation is accepted only when all are true:

1. Production Agent code has one native Function Calling transport.
2. No production Agent request sends `response_format` for action semantics.
3. No production Agent parser converts ordinary JSON/text into a Tool or
   control Action; non-empty final text can only enter the existing
   non-authoritative completion-candidate boundary.
4. Every Runtime Tool and remaining control function routes through the
   canonical Function Call contract.
5. `nexora_respond` is absent from the canonical function catalog and no
   direct-answer path serializes final text as Function arguments.
6. Final text with no Function Call is always evaluated by the Runtime
   Completion Gate; a rejected candidate enters the existing repair or
   next-decision flow and cannot complete a Run.
7. Unsupported Providers fail explicitly and never fall back to structured
   output.
8. Provider call IDs survive normalized response audit, continuation, reopen,
   and multi-call batches without mismatch.
9. Runtime-owned IDs and authorities remain Runtime-owned.
10. Tool schemas are generated from the canonical Runtime Tool contract.
11. Existing Approval, Invocation, Evidence, Recovery, Plan, and Completion Gate
    tests remain green.
12. Context Phase B native continuation and dedupe regressions remain green.
13. Desktop, CLI, canary, benchmark, fixture, and documentation scans contain no
    Agent structured transport surface.
14. The capability probe passes for at least one compatible real Provider and
    records an explicit unsupported result for an incompatible Provider.
15. Decision Efficiency metrics remain comparable and report transport changes
    without redefining the baseline.

## 20. Verification Plan

Verification must be staged:

1. **Static audit:** scan production, tests, fixtures, configuration, Desktop,
   CLI, benchmark, and docs for structured transport and Action-envelope terms.
2. **Adapter contract tests:** verify function definitions, strict parameter
   schemas, null assistant text with calls, Provider call IDs, multiple calls,
   malformed arguments, unknown functions, duplicate IDs, and unsupported
   capability results.
3. **Harness tests:** verify Runtime Tool/control routing, absence of
   `nexora_respond`, direct-answer and post-execution text candidates,
   Completion Gate acceptance/rejection, repair, batch atomicity, and result
   mapping.
4. **Runtime regression:** run focused Approval, Invocation, Recovery, Evidence,
   Plan, Completion Gate, cancellation, rehydration, and continuation suites.
5. **Persistence/reopen:** prove equivalent continuation from the same Runtime
   facts after process restart.
6. **Desktop/CLI/UAT:** verify native-only configuration and a real workspace
   task with file effects and mechanical verification.
7. **Provider capability:** run the minimal probe against a compatible Provider
   and an explicitly unsupported Provider.
8. **Efficiency comparison:** compare the metrics in Section 16 using the same
   task cohort and report missing/unsupported external usage honestly.
9. **Final deletion scan:** only after all preceding gates pass, remove the
   structured production and compatibility surfaces.

No tests were run during this audit/specification phase. Current test status for
the future migration is therefore `not run`.

## 21. Breaking Changes

This is an intentional Provider-facing breaking change:

- Providers without native Function Calling are unsupported for Agent execution.
- `structured_output` is no longer a selectable Agent transport after migration.
- `response_format` no longer carries Agent action semantics.
- Ordinary text becomes a non-authoritative completion candidate rather than a
  post-execution protocol error or a Function-argument wrapper; it can complete
  only through the Runtime Completion Gate.
- `nexora_respond` is removed from the Agent Function catalog and is no longer
  required for model-originated completion.
- Custom `RuntimeProvider` implementations must declare the native transport and
  satisfy the capability contract.
- Existing structured-only test Providers, Desktop profiles, environment
  values, UAT scenarios, and external consumers must migrate.

These changes must be released as one coherent contract migration. Silent
compatibility branches are not permitted.

## 22. Go / No-Go

### Architectural Go

`GO`: the current repository provides a working native Function Calling path,
and the audit found no independent production structured-generation consumer
that requires `structured_output` to remain inside Agent Harness.

### Immediate deletion No-Go

`NO-GO`: do not delete the current structured path in the audit/specification
phase. It is still production-reachable, configured, tested, and documented.
The required native capability boundary and explicit completion migration have
not yet been implemented and verified.

### Final decision

`PARTIAL`: approve the pure-native migration as the next implementation feature,
but do not mark the repository as globally migrated or ready for deletion until
Sections 11, 19, and 20 are satisfied.

Implementation readiness:

- `PURE_NATIVE_FUNCTION_CALLING_SPEC.md`: `READY FOR IMPLEMENTATION`.
- Current repository for direct deletion: `NOT READY`.
- Independent non-Agent structured-generation consumer: `NOT FOUND IN REPOSITORY`;
  external consumers: `unknown`.
