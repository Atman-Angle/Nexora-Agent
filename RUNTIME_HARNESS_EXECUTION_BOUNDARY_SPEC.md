# Runtime / Harness Execution Responsibility Boundary Specification

**Status:** `READY FOR IMPLEMENTATION`
**Date:** 2026-09-09
**Repository baseline:** `D:\Nexora-1.1`
**Branch / HEAD:** `codex/harness-optimization-production-baseline` / `95b5141`
**Scope:** architecture audit and target behavior only; no production-code change
**Risk:** L3 — Agent Loop, Completion Gate, Run terminal semantics, Recovery boundary
**Related evidence:** `DECISION_EFFICIENCY_CANDIDATE_A_FAILURE_AND_NO_PROGRESS_AUDIT.md`

## 1. Outcome

Nexora must have one task controller and one reliable execution authority:

```text
Harness
owns task meaning, Plan / Replan, next-action choice, repair strategy,
semantic progress, semantic convergence and the user-facing final answer

        ↓ proposed action / terminal proposal

Runtime
owns legal and reliable execution: validation, permission, Approval,
Invocation / Attempt lifecycle, idempotency, side-effect safety, recovery,
persistence, execution Evidence provenance, cancellation and hard boundaries

        ↓ persisted execution facts / derived execution receipt

Harness
re-decides from current Runtime authority
```

The normative distinction is:

> Runtime owns what happened, whether an effect is safe to execute or resume, and whether a terminal transition is mechanically safe. Harness owns what those facts mean for the task and what to do next.

This Feature must reduce duplicate task authority without weakening Runtime reliability.

## 2. Current architecture evidence

The current repository already has the physical dependency direction needed by the target design, but responsibility is not yet cleanly divided.

| Evidence | Current behavior | Boundary classification |
|---|---|---|
| `packages/harness/src/agent-loop.ts:124-433` | Harness owns the Provider loop, parses responses, compiles Plan/Tool/input/finish actions and continues after ordinary action outcomes. | Correct Harness foundation. |
| `packages/runtime/src/agent-runtime-port.ts:178-258` | Runtime exposes a narrow mechanical port plus `readState`; Harness cannot access the Store or mutate Runtime facts directly. | Correct Runtime boundary foundation. |
| `packages/runtime/src/runtime.ts:1602-1626` | `AgentStateView` is rebuilt from Run, Invocation, Attempt, Event, continuation and Artifact authorities. | Sufficient pull/recovery foundation. |
| `packages/runtime/src/execution/runtime-execution.ts:539-924` | Runtime validates Tool input, applies Approval, creates Invocation/Attempt records, executes effects, persists result/error and derives Evidence. | Correct Runtime execution authority. |
| `packages/runtime/src/execution/runtime-execution.ts:831-866` | An ordinary Tool failure persists a failed Invocation and `lastError`, but leaves the Run available to the Harness loop. | Correct `Action failed != Task failed` behavior. |
| `packages/runtime/src/execution/runtime-execution.ts:927-970, 1156-1246` | Unknown non-idempotent effects block safely; reconciliation resolves the same Invocation and may replay only after confirmed no effect. | Correct Runtime recovery authority. |
| `packages/runtime/src/runtime-types.ts:235-280, 372-391` and `packages/runtime/src/runtime-events.ts:14-102` | `inspect`/`readState` provide pull; persisted event subscription provides push; current state remains authoritative. | Structurally sufficient Push/Pull foundation. |
| `packages/runtime/src/runtime.ts:2957-3084, 3125-3411` | Runtime interprets repeated actions, Plan revisions, rejection families and resource churn, then sets the entire Run to `failed / NO_PROGRESS_DETECTED`. | Task convergence policy incorrectly owned by Runtime. |
| `packages/runtime/src/runtime.ts:2489-2620` | Runtime validates not only Plan shape/CAS but also required-outcome coverage, semantic equivalence and whether a Plan change is useful. | Plan semantic authority is incorrectly shared; User Task Contract and Harness Plan must be separated. |
| `packages/runtime/src/runtime.ts:2659-2708` | Runtime decides that a successful mutation has satisfied a semantic “mutation outcome” and requires verification or finish before another write. | Mixed safety and task-control policy. |
| `packages/runtime/src/runtime.ts:2757-2835, 3575-3603` | Runtime currently creates `provider_reconnect` predicates, counts Provider failures and may block/fail after recovery exhaustion. | Provider orchestration is incorrectly coupled to Runtime; target ownership moves retry/reconnection/switching decisions to Harness. |
| `packages/runtime/src/completion-gate.ts:22-218` | One gate checks both hard execution invariants and Scope/Plan/Step semantic obligations. | Completion authority is mixed. |
| `packages/harness/src/context/decision-context.ts:318-367` | Harness imports the Runtime completion validator to project semantic blockers and suggested actions. | Same algorithm, but wrong package ownership and circular control responsibility. |
| `packages/runtime/src/delivery.ts:7-91` and `packages/runtime/src/failure-handoff.ts:4-19` | Runtime derives completed work, unfinished work and next task action from Plan semantics. | User-facing task interpretation incorrectly owned by Runtime. |
| `packages/runtime/src/runtime.ts:390-420` | Runtime continuation creation copies what it considers unfinished Plan Steps from a no-progress parent. | Resume reconstructs task meaning inside Runtime. |

There is also a direct documentation/code contradiction. `ARCHITECTURE.md:135` says objective-only Plan Steps are navigation and only explicitly declared mechanical checks participate in completion. Current `completion-gate.ts:171-180` rejects every task-result Plan Step without a required non-semantic check and requires every Step to be marked completed. Current code, not the document claim, is the audit baseline.

## 3. Current responsibility map

### 3.1 Harness currently owns

- Provider/LLM transport, native Function Calling normalization and call-ID continuation;
- bounded Agent turn ordering;
- decision Context, rehydration, Phase B projection and Tool catalog projection;
- parsing Provider Plan, input, delegation, Skill and Runtime Tool calls;
- compiling Provider facts into `RuntimeAction`;
- initial Task Scope shaping and Plan task/check compilation;
- active Tool selection, batched execution cadence and post-failure model repair projection;
- direct-response versus task-result proposal mode;
- requesting the next model decision.

### 3.2 Runtime currently owns

- Run State Machine and durable Journal;
- Run/Plan/Task Contract persistence, Runtime-generated IDs, revision and CAS;
- Tool capability lookup, input-schema validation, permission/risk/Approval;
- Invocation/Attempt lifecycle, idempotency key, duplicate protection and effect execution;
- Tool result/failure normalization, Artifact storage and Evidence provenance;
- cancellation, lease/fencing, retry, reconciliation, reopen and resume;
- hard execution/resource budgets and Worker recovery boundaries;
- Provider/LLM transport belongs to Harness, but current Provider failure/reconnection state handling still partly enters Runtime; that overlap is included in the target ownership correction;
- Completion Gate and success transition;
- additionally, semantic Plan coverage/immutability rules, mutation cadence, no-progress/convergence, task-level failure delivery and unfinished-work projection.

The last group is the boundary defect. Runtime is both the execution authority and a second task controller.

## 4. Target responsibility boundary

### 4.1 Normative ownership answers

| Question | Sole owner |
|---|---|
| Who owns the immutable user goal, constraints and required outcomes? | The User Task Contract: explicit user/Host input is the semantic constraint; Harness may interpret it but cannot silently remove or rewrite it. Runtime only persists its version/digest/integrity. |
| Who owns the Plan, Steps and execution strategy? | Harness. It may create, delete, replace, reorder and replan them while preserving the User Task Contract. |
| Who decides the next action? | Harness. |
| Who decides whether a Tool/action may execute? | Runtime, from schema, capability, permission, Approval, idempotency, current effect state and hard execution policy. |
| Who owns action idempotency? | Runtime. |
| Who owns side-effect state and duplicate-effect protection? | Runtime. |
| Who owns retry, reconciliation, checkpoint/reopen and resume of an admitted action? | Runtime. |
| Who owns execution state? | Runtime Store, Invocation, Attempt, Event, Evidence and Artifact authorities. |
| Who decides whether the task still has meaningful work? | Harness. |
| Who decides semantic convergence? | Harness. |
| When may Runtime reject an action? | When execution legality, safety, integrity, permission, schema, capability, idempotency, recovery or hard resource constraints fail. |
| When may Runtime stop the Run? | Only at a hard mechanical boundary, or after an explicit Harness waiting/blocking/terminal proposal passes mechanical admission. Runtime does not initiate Provider orchestration or task convergence. |
| How does Harness receive live execution state? | Persisted Runtime events/observer notifications plus the dispatch receipt; events wake readers but do not replace state. |
| How does Harness recover after restart? | Query `AgentStateView`/Runtime inspection and Artifact refs from Runtime authority, then rebuild the trajectory without Provider session or conversation-memory authority. |

### 4.2 Semantic ownership versus storage ownership

`RunSnapshot.currentPlan` remains the only current Plan and remains transactionally persisted by Runtime. That does not make Runtime the semantic author of the Plan. The User Task Contract is a separate semantic input: its explicit goal, constraints and required outcomes are immutable unless the user/Host explicitly supplies a new contract update.

- Harness is the sole semantic interpreter of the User Task Contract and the sole author/reviser of Plan ordering, Steps, execution strategy and the interpretation of remaining work. Harness may freely create, delete, replace, reorder and replan Plan content, but it must preserve every user-required outcome unless an explicit user/Host contract update changes that requirement.
- Runtime supplies IDs/version/CAS, persists the User Task Contract and Plan, records their digests and revisions, validates serialized shape/references/integrity and preserves immutable execution provenance. Runtime does not interpret whether a user outcome is covered, necessary, equivalent, removable or satisfied.
- Runtime may reject structurally invalid references, stale revisions, attempts to mutate already-persisted Invocation/Evidence facts, or a Plan update that would make an unresolved Invocation unrecoverable.
- Runtime must not reject a Plan because it considers a user outcome unnecessary, semantically equivalent, insufficiently useful, removable/non-removable, covered or already satisfied at the task level. Preserving the User Task Contract is a Harness controller invariant, not Runtime semantic interpretation.
- Existing `stepProgress` may remain a deterministic navigation projection of declared mechanical checks. It is not semantic completion authority and must not independently stop or complete a Run.

No second Plan Store, progress state machine or semantic task state is permitted.

## 5. Runtime execution authority

Runtime must retain all of the following:

1. Runtime Action and Tool schema validation, including canonical input normalization.
2. Capability existence, permission, workspace boundary, risk and Approval enforcement.
3. Runtime-owned Run, Invocation, Attempt, request, Evidence and Artifact identities.
4. Atomic Invocation intent persistence before side effect.
5. Idempotency keys, exact duplicate detection, read-result reuse rules and duplicate side-effect protection.
6. Tool effect status: prepared, started, succeeded, failed and unknown.
7. Execution-layer retries for safe/idempotent Tool failures, with bounded attempts and durable Attempt records. Provider/LLM retry, reconnection and switching remain Harness transport policy.
8. Unknown-effect blocking, reconciliation, confirmation and replay-only-after-confirmed-no-effect.
9. Lease, fencing, cancellation, timeouts and hard resource/execution budgets.
10. Durable Run Journal, payload digests, Artifact integrity, audit provenance and crash/reopen recovery.
11. Mechanical Evidence derivation from verified Tool/validator/user/context sources.
12. Runtime-safe terminal admission and State Machine transitions.

Runtime duplicate protection must be based on execution identity, input digest, idempotency, effect status, resource generation/freshness and Tool-specific safety. It must not reject a genuinely different write merely because Runtime believes the semantic Plan outcome should now be verified or finished. The current `MUTATION_VERIFICATION_REQUIRED` policy therefore must be separated into:

- retained Runtime protection for exact/unsafe duplicate effects and unknown effects; and
- Harness-owned advice about whether to verify, repair, mutate again or finish.

## 6. Harness task authority

Harness must solely own:

- interpreting the immutable User Task Contract (goal, constraints and required outcomes) without silently changing it;
- Task Scope shaping that preserves every user-required outcome;
- Plan creation, Plan revision and removal/replacement/reordering of Plan Steps and remaining execution strategy;
- deciding whether an observation changes the task trajectory;
- deciding whether to read, mutate, verify, replan, change strategy, request user input or finish;
- deciding whether a Tool failure is worth retrying at the task layer;
- interpreting Evidence and Tool results against user acceptance criteria;
- semantic progress and a deterministic, bounded trajectory/convergence controller;
- enforcing bounded repeated ineffective actions, repeated rejection/result patterns, strategy-reset attempts, and Harness model-call/execution budgets; these limits must not be delegated to a model or Prompt;
- semantic completion and the final user-facing answer;
- a truthful semantic failure/stop proposal when no safe meaningful path remains.

Harness decisions must always be based on current Runtime authority. Harness may not claim an effect, result, recovery or Evidence fact that Runtime has not persisted.

## 7. Runtime ↔ Harness event and query contract

### 7.1 Runtime → Harness push

The persisted Journal remains the event source. At minimum, the existing event families must remain available:

```text
approval.requested / approval.granted / approval.denied
tool.started / tool.attempt.* / tool.retried
tool.succeeded / tool.failed / tool.result_unknown / tool.reconciled
recovery.*
run.waiting / run.blocked / run.cancelled / run.failed / run.succeeded
context and Artifact provenance events
```

Push is notification, not authority. A missed or duplicated notification must be recoverable by querying the persisted state after its sequence cursor.

The actual recovery event is `tool.reconciled`. `tool.recovered` is forbidden in new detection/projection logic because it has no emitter or persisted event contract.

### 7.2 Harness → Runtime pull

`AgentStateView` is the canonical internal pull boundary. From the current Run revision it must allow deterministic recovery of:

- all active/prepared/started/unknown Invocations;
- completed Invocation results and failures;
- Tool Attempts and retry/reconciliation state;
- pending Approval or input request;
- current Run status and typed resume predicate;
- current Plan plus its revision, without treating it as execution truth;
- Evidence and Artifact provenance;
- Journal events and continuation ancestors.

The public `RunHandle.inspect/history/subscribe/watch` projection remains the Host equivalent. No Harness access to the Store and no second mutable cache is allowed.

### 7.3 Dispatch outcome

The Harness must not infer a task outcome from `RunSnapshot.lastError` alone. Every accepted dispatch must provide, directly or by a revision-consistent query, a derived execution receipt containing:

- action correlation identity;
- created/reused/rejected Invocation identities;
- per-Invocation status and whether physical execution occurred;
- waiting/blocking boundary, if any;
- result/error/Evidence/Artifact references;
- the final authoritative Run revision.

This receipt is a projection of existing persisted facts. It is not a new status table or execution authority. Existing `modelDecisionId`, `executionUnitId`, batch metadata, Provider call ID and Runtime Invocation ID must remain distinct.

## 8. Action outcome and Run boundary semantics

| Action-level outcome | Required Runtime behavior | Harness responsibility |
|---|---|---|
| schema/capability/permission rejection before effect | Persist bounded rejection facts where applicable; no Invocation/effect; Run remains running. | Correct action or choose another strategy. |
| exact/unsafe duplicate rejected | Return the existing Invocation/result reference or a side-effect-free rejection; Run remains running. | Reuse facts, verify, replan or choose another action. |
| result safely reused | Persist/reveal provenance and `physicalExecution=false`; Run remains running. | Interpret reused fact. |
| waiting for Approval | `waiting / APPROVAL_REQUIRED` with exact Pending Request. | Pause semantic loop until Host decision. |
| Invocation succeeded | Persist result/Evidence; Run remains running unless a separately proposed terminal transition is accepted. | Decide what it means and what comes next. |
| Invocation failed | Persist failed Invocation/Attempt and error facts; Run remains running. | Retry with changed conditions, change Tool/strategy, replan, ask user, or stop semantically. |
| effect unknown/reconciling | Persist unknown/recovery state and block unsafe forward execution. | Do not reinterpret or replay; resume only from Runtime recovery result. |
| reconciled succeeded/failed/no-effect | Resolve the same Invocation, persist `tool.reconciled` and Evidence/result facts, return to the legal mechanical state. | Re-decide the task trajectory. |
| user cancellation | Persist cancellation and terminate. | Produce no contradictory success claim. |
| hard budget/resource boundary | Persist typed blocked/terminal boundary. | Request extension/input, create continuation, or provide truthful final delivery. |
| Provider unavailable, retry exhausted, reconnection or Provider switching | Persist a waiting/blocked/terminal transition only when explicitly proposed by Harness and mechanically admissible; do not start Provider retries or switching. | Own transport retry, reconnection, bounded exhaustion handling and Provider selection/switching. |
| fatal integrity/persistence/runtime failure | Persist failure if safe to do so; never execute further effects. | Surface the exact hard failure. |
| Harness semantic terminal proposal | Runtime verifies mechanical terminal safety and commits through State Machine. | Own the semantic outcome and user-facing text. |

The following must not by themselves block or fail the Run:

- ordinary Tool failure;
- Tool argument/schema rejection;
- duplicate action rejection;
- a rejected Completion proposal;
- an invalid or unchanged Plan proposal;
- a failed task-level repair attempt;
- repeated read/result with no changed task fact;
- a no-progress diagnostic.

## 9. Run waiting, blocked and terminal semantics

### 9.1 `waiting`

`waiting` is reserved for a specific persisted request:

- Runtime Approval; or
- user input explicitly requested by Harness because only the user can supply the missing fact/choice.

### 9.2 `blocked`

`blocked` is a rare recoverable boundary with a typed resume predicate. Legitimate classes are:

- unknown non-idempotent Tool effect requiring reconciliation/confirmation;
- worker/child execution recovery that cannot advance safely;
- extendable hard execution budget;
- another explicit external condition for which Harness requests a block and Runtime can state the exact safe mechanical resume predicate;
- a Provider wait/block requested by Harness after Harness has applied its own bounded transport policy. Runtime only validates and persists that requested mechanical transition; it does not retry, reconnect or switch Providers.

Plan repair, ordinary Tool failure, Completion rejection and semantic no-progress are not blocked states.

### 9.3 `failed`

Runtime may directly fail only for non-recoverable execution integrity, persistence, fencing/authority, fatal environment, non-extendable hard limit, explicit user abandonment, or another mechanical condition that makes safe execution impossible.

Harness may propose task-level failure after it has semantically concluded that no safe meaningful path remains. Runtime then verifies there is no unresolved effect or other illegal terminal condition and persists the transition. The existing `NO_PROGRESS_DETECTED` code may be retained for compatibility only as a Harness-owned trajectory conclusion; Runtime must not independently derive it from task history.

### 9.4 `succeeded`

Success requires both:

1. Harness semantic completion proposal; and
2. Runtime mechanical terminal admission.

Neither side can succeed the Run alone.

## 10. `NO_PROGRESS_DETECTED` ownership

`NO_PROGRESS_DETECTED` is task-convergence policy and belongs to Harness. Harness must implement this as a deterministic, bounded trajectory/convergence controller; it must not leave the decision to continue entirely to a model or Prompt.

Runtime may expose deterministic facts such as:

```text
same Tool/input strategy
same result/error digest
exact duplicate rejected
no physical execution
no Run/Invocation/Evidence delta
repeated response rejection
accepted Plan revision
tool.reconciled recovery result
execution/resource budget and recovery facts
```

Runtime must not decide that these facts mean the task has no progress. In particular it must not:

- classify Plan wording or Plan replacement as useful/useless task progress;
- decide that a repeated result proves no meaningful work exists;
- grant a one-turn semantic probation after a Plan revision;
- infer task failure from resource churn;
- transition the Run to failed because its task-level convergence heuristic fired.

Harness's controller must deterministically count and bound repeated ineffective actions, repeated rejection/result patterns, strategy-reset attempts and model-call/execution budgets. The model may propose replan, strategy reset, changed Tool/input, verification, completion or user input, but cannot override those bounds. The controller then chooses whether to continue, replan, request input or issue an explicit terminal proposal. Runtime supplies execution facts and enforces independent hard side-effect/resource safety limits; it does not derive task convergence.

The confirmed `tool.reconciled` versus `tool.recovered` mismatch must be removed wherever progress/recovery facts are projected. A successful reconciliation is a new execution fact; Harness then decides whether it is task progress.

## 11. Completion ownership

### 11.1 Runtime hard gate

Runtime Completion must enforce only mechanically decidable invariants:

- Run is in a completable mechanical state;
- no pending Approval/input request conflicts with completion;
- no prepared/started/unknown Invocation or unfinished reconciliation exists;
- no active Worker/external interaction remains when terminal safety requires closure;
- Journal, Artifact and Evidence provenance/digests are valid;
- required Host-declared mechanical completion policy is satisfied;
- every explicitly declared required mechanical Check used for terminal admission has valid, current Evidence;
- direct-response mode has not bypassed an executed effect or Host evidence requirement;
- State Machine transition is legal.

Runtime may verify that declared evidence exists and is trustworthy. It may not decide whether that evidence semantically satisfies the user's goal.

### 11.2 Harness semantic completion

Harness owns:

- whether every user-required outcome is satisfied;
- whether a delivery-only outcome belongs in final prose rather than a Tool-verifiable Plan Step;
- whether Plan outcomes should be removed/replaced/rebound;
- whether a test result, Artifact or observation is sufficient for the task;
- whether remaining work is required or optional;
- the final answer and its semantic claims.

### 11.3 Current checks that must be separated

Retain as Runtime hard/integrity checks:

```text
RUN_NOT_COMPLETABLE
PENDING_REQUEST
PLAN_GOAL_DIGEST_MISMATCH
TOOL_INVOCATION_UNRESOLVED
EVIDENCE_ARTIFACT_INVALID
EVIDENCE_PROVENANCE_INVALID
DIRECT_RESPONSE_FORBIDDEN_BY_HOST
DIRECT_RESPONSE_AFTER_PLAN / DIRECT_RESPONSE_AFTER_TOOL
explicit Host-required Tool/Evidence policy
explicitly declared required mechanical Check provenance/freshness
UNPLANNED_MUTATION_UNVERIFIED when defined as effect-safety policy
```

Move out of Runtime terminal authority or redefine as Harness-owned semantics:

```text
SCOPE_PLAN_REQUIRED
SCOPE_STEP_RELATION_MISSING
SCOPE_REQUIRED_OUTCOME_UNCOVERED / DUPLICATED
STEP_UNVERIFIABLE
blanket STEP_INCOMPLETE for navigation-only Steps
STEP_VERIFICATION_REQUIRED inferred merely from final-Step position
task-level CHECK_UNSATISFIED interpretation
```

An explicitly declared required mechanical Check may still be enforced by Runtime. The defect is Runtime inventing or interpreting the task obligation, not Runtime verifying an obligation that the Host/Harness explicitly declared.

## 12. Recovery and resume semantics

Recovery remains Runtime-owned and conversation-independent:

```text
process restart
→ reopen Runtime Store
→ verify Journal/Artifact integrity
→ query Run + Invocation + Attempt + pending request + recovery predicate
→ safely resume idempotent/interrupted execution or block unknown effect
→ persist outcome/reconciliation facts
→ Harness rebuilds bounded decision Context
→ Harness chooses the next task action
```

The Provider session, hidden model reasoning and conversation transcript must never become recovery authority.

Runtime must not copy what it semantically considers “unfinished Plan work” into a continuation as an independent decision. It may preserve the parent Plan and immutable facts as lineage data. Harness queries those facts and creates/revises the child Run's one authoritative current Plan.

Long-running execution must continue to expose started Invocation/Attempt state, managed-process facts where applicable, cancellation state, checkpoint/Artifact refs where Tool contracts provide them, and the exact reconciliation path. A generic progress percentage is not required and must not be invented.

## 13. Evidence boundary

Runtime owns:

- which Invocation/Attempt actually ran;
- canonical input, status, timestamps, result/error and payload digest;
- Artifact and Evidence provenance;
- whether Evidence is authentic, current for a declared mechanical Check and linked to the correct effect;
- whether recovery changed unknown state to a known execution fact.

Harness owns:

- what an exit code, file digest, test report or Artifact means for the user goal;
- which validation is appropriate;
- whether the available facts are enough to finish;
- how those facts are explained in the final answer.

Runtime `RunDelivery` fallback may report only mechanical facts and exact hard causes. Semantic `completedWork`, `unfinishedWork` and recommended task strategy must be supplied by Harness or explicitly labeled as non-authoritative projection. Runtime must not infer completed user outcomes from Step/check bookkeeping.

## 14. Compatibility invariants

This Feature must preserve:

- Pure Native Function Calling as the only production Agent transport;
- Provider-native call-ID continuation and separation from Runtime-owned IDs;
- canonical Tool schema validation before effect;
- Approval and permission boundaries;
- Invocation/Attempt lifecycle and idempotency keys;
- duplicate side-effect protection and read reuse provenance;
- unknown-effect recovery and reconcile-before-replay;
- Evidence/Artifact provenance and Journal integrity;
- lease, fencing, cancellation and hard budgets;
- reopen, rehydration and continuation from Runtime facts;
- Context Phase B native-continuation observation dedupe;
- Decision Efficiency telemetry and its correlation identities;
- State Machine as the only writer of Run Status;
- Run-owned Structured Plan as the only current Plan;
- Host/Renderer prohibition on direct Store, status, Invocation or Evidence mutation.

Candidate A and Candidate A2 remain paused. This Feature must not change Tool Catalog projection or perform token optimization.

## 15. Minimal architecture adjustment

The minimum target change is an ownership correction, not a new subsystem:

1. Harness becomes the sole Task Controller: it preserves the immutable User Task Contract, owns the mutable Plan/Steps/strategy, and runs a deterministic bounded trajectory/no-progress controller; Runtime stops interpreting task convergence.
2. Runtime continues to emit/query deterministic repetition, rejection, Invocation, recovery and state-delta facts.
3. Plan semantic interpretation and legal repair selection live in Harness; Runtime retains User Task Contract/Plan persistence, version/digest/integrity, schema, CAS, referential/provenance and unresolved-effect safety without interpreting outcome meaning.
4. Completion is split into Harness semantic completion and Runtime mechanical terminal admission, using the same persisted facts.
5. Broad mutation-cadence policy is removed from Runtime; exact duplicate/unknown-effect safety remains.
6. Harness supplies semantic terminal text/outcome; Runtime persists it only after mechanical admission and supplies a mechanical fallback for fatal interruption.
7. Existing Push/Pull surfaces are retained; dispatch gains or exposes a revision-consistent derived execution receipt rather than new state.
8. All recovery-progress consumers use the real `tool.reconciled` event.
9. Provider unavailable/retry/reconnection/switching orchestration remains Harness-owned; Runtime only admits and persists an explicitly proposed mechanical waiting/blocking/terminal transition.

### State decision

**No new persisted Runtime state is required.** Existing Run, Invocation, Attempt, Event, Evidence, Artifact, pending request and resume predicate records are sufficient.

### Model Context decision

**No new model Context section is required.** The existing Run/Plan, Tool observations, `repair`, continuation and completion projection surfaces are sufficient. Their ownership and contents must be corrected: Runtime facts remain factual; Harness-generated semantic guidance stays in the existing bounded repair/control projection.

## 16. Migration boundary

Allowed implementation scope:

- internal Runtime/Harness port and derived dispatch-receipt contract;
- movement of convergence/trajectory policy from Runtime ownership to Harness ownership;
- separation of immutable User Task Contract semantics from mutable Harness Plan/Step strategy;
- movement of Provider retry/reconnection/switching orchestration out of Runtime and into Harness;
- narrowing Completion Gate to mechanical invariants;
- Plan semantic validation/repair ownership correction;
- semantic delivery ownership correction;
- `tool.reconciled` signal coherence;
- focused tests and living architecture/data-flow/SOP/status documentation.

Compatibility may retain current event/error strings, including `NO_PROGRESS_DETECTED`, when their owner/actor and semantics are unambiguous. Compatibility must not preserve the old Runtime task-controller behavior behind a second path.

No database migration is justified by the current evidence. If implementation discovers that an existing persisted fact cannot express a hard execution invariant, work must pause for a separate contract decision rather than adding speculative state.

## 17. Non-goals

- Removing or weakening Approval, idempotency, duplicate-effect protection, Evidence or Recovery.
- Letting the model directly modify Run, Plan storage, Invocation, Evidence or status.
- Moving reliable execution protocol into prompts.
- Creating a second Plan, progress, completion or recovery authority.
- Adding a generic workflow engine, NextActionProjection or semantic state machine.
- Redesigning Provider transport, native Function Calling or call-ID continuation.
- Changing Context Phase B eviction, compaction, rehydration or dedupe.
- Token, Tool Catalog or Candidate A/A2 optimization.
- Adding a generic progress percentage or pretending every long-running Tool supports checkpoints.
- Reclassifying genuine Provider, persistence, unknown-effect or hard-budget failures as ordinary model repair.

## 18. Acceptance criteria

1. A Tool success or failure always persists a truthful Invocation/Attempt outcome and returns control to Harness unless a hard boundary is present.
2. Tool validation rejection, duplicate rejection, Completion rejection, Plan rejection and one or more repair failures do not by themselves change Run to blocked/failed.
3. Runtime no longer makes a task-level no-progress/convergence decision.
4. The immutable User Task Contract preserves explicit user goal/constraints/required outcomes; Harness may freely replan Plan/Steps/strategy but cannot silently remove or rewrite a required outcome.
5. Repeated identical no-effect work is deterministically bounded by Harness's trajectory controller and independent hard Runtime budgets without duplicate protected effects; the model/Prompt cannot disable those bounds.
6. `tool.reconciled` clears stale recovery/no-progress projections and is treated as a new execution fact.
7. Unknown non-idempotent effects remain blocked and are never automatically replayed before reconciliation/confirmation.
8. Runtime rejects terminal success while an Invocation/Approval/recovery/Worker or integrity invariant is unresolved.
9. Runtime does not reject completion solely because a navigation/delivery-only Plan Step has no Tool-verifiable check.
10. Explicitly declared required mechanical checks still require valid current Evidence.
11. Harness can remove/replace/rebind Plan Steps and strategy without Runtime interpreting whether the user outcome is important, while past Invocation/Evidence provenance remains immutable and User Task Contract outcomes remain preserved.
12. A legitimate second/different mutation is not rejected solely because Runtime thinks the semantic outcome should be verified or finished; unsafe duplicates remain rejected/reused deterministically.
13. After process restart, Harness reconstructs the current trajectory from Runtime query authority and continues without Provider session or conversation memory.
14. Push event loss/duplication is recoverable through sequence-based pull; no event consumer becomes a second state authority.
15. Provider unavailable/retry/reconnection/switching decisions are made by Harness; Runtime only validates/persists the resulting requested mechanical boundary.
16. Runtime-generated fatal fallback delivery reports only mechanical facts and does not claim semantic task completion.
17. Pure Native Function Calling, Provider call IDs, Approval, Invocation, Recovery, Evidence, rehydration, Phase B and Decision Efficiency telemetry regressions remain intact.
18. No new persisted Runtime state, semantic progress table or new top-level model Context block is introduced.
19. Candidate A/A2 and Tool Catalog projection remain unchanged.

## 19. Verification plan

Implementation evidence must cover all of the following behavior, not merely typecheck or unit success:

### Boundary and action outcomes

- Tool schema rejection → no Invocation/effect → Harness receives rejection fact → changed action can succeed.
- ordinary Tool failure → failed Invocation → Run remains running → Harness chooses a different strategy and completes.
- duplicate protected action → no duplicate physical effect → existing fact/rejection projected → Harness continues.
- completion rejection → no Run block/failure → Harness repairs or revises semantic Plan without repeating completed effect.

### No-progress ownership

- replay the exact Candidate A mutation and protected-operation failure shapes;
- prove the requested external effect executes once;
- prove Harness's deterministic controller bounds repeated ineffective/rejected/result patterns and strategy resets even when the model keeps proposing them;
- prove Harness replans/finishes or explicitly proposes a semantic stop;
- prove identical rejected/no-effect work remains bounded;
- prove Runtime itself never emits a task-level failed transition from its own convergence heuristic.

### User Task Contract and Provider ownership

- prove explicit user required outcomes survive Plan deletion, replacement, reorder and replan unless an explicit user/Host contract update is present;
- prove Runtime persists User Task Contract/Plan version, digest and integrity without interpreting outcome semantics;
- prove Provider unavailable, retry exhaustion, reconnection and switching are decided by Harness and Runtime only admits/persists the requested mechanical boundary.

### Completion split

- delivery-only outcome with truthful existing execution facts can pass semantic Harness completion plus Runtime hard gate;
- unresolved Invocation, pending Approval, invalid Artifact/Evidence and stale explicitly required verification still fail the hard gate;
- Scope/Plan navigation changes do not manufacture or invalidate immutable execution facts.

### Recovery and restart

- idempotent interrupted Invocation resumes safely;
- non-idempotent interrupted Invocation becomes unknown and requires recovery;
- reconcile confirmed success/no-effect/failure persists `tool.reconciled`, updates the same Invocation and is visible after reopen;
- Harness rebuilds its decision from `AgentStateView`/lineage and does not replay a completed side effect.

### Compatibility regression

- focused Runtime/Harness boundary tests;
- Approval, duplicate, recovery reducer, crash matrix, Completion and cancellation suites;
- Pure Native Function Calling and Provider-native call-ID continuation suites;
- Context Phase B dedupe, eviction, rehydration and continuation suites;
- Decision Efficiency telemetry correlation tests;
- public RunHandle inspect/history/subscribe/watch and package-consumer tests;
- real entry-point UAT for read, mutation/Approval/verification, denial safety and restart recovery.

Every relevant skip or unavailable external dependency must be reported. A green test that does not exercise the new ownership boundary is not completion evidence.

## 20. Go / No-Go

### Architectural decision

`GO`.

The current Store, Invocation, Attempt, Event, Evidence, Artifact, RunHandle and AgentStateView foundations are sufficient. The observed failures are caused by responsibility overlap, not missing durable execution infrastructure.

### Implementation readiness

`READY FOR IMPLEMENTATION`.

All core authority questions have one owner in this Spec: Harness is the sole Task Controller, Runtime is the sole Reliable Execution Authority, the User Task Contract is the immutable semantic constraint, and Provider orchestration belongs to Harness. No new Runtime state, database migration, second Plan/progress authority or new model Context is required.

### Release No-Go conditions

Implementation is `NO-GO` if it:

- weakens Approval, idempotency, duplicate protection or unknown-effect recovery;
- lets Harness/Model silently remove or rewrite a user-required outcome through Plan edits;
- lets Harness/model claim execution facts not present in Runtime authority;
- lets a model/Prompt bypass the deterministic Harness trajectory/convergence bounds;
- leaves Runtime semantic no-progress, Provider orchestration or Scope/Step convergence as a second controller/terminal authority;
- removes mechanical Completion safeguards together with semantic checks;
- introduces a second persisted task/progress/completion state;
- breaks Pure Native Function Calling, Provider call-ID continuation, Phase B or Decision Efficiency telemetry;
- combines this Feature with Candidate A/A2 or token optimization.
