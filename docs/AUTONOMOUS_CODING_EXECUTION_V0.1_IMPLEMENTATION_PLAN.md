# Autonomous Coding Execution v0.1
## Formal Implementation Plan

**Mode:** `PLAN`  
**Plan status:** `READY_FOR_REVIEW`  
**Feature status:** `FEATURE_CONTRACT_NOT_PROVEN`  
**Scope:** close only the confirmed gaps recorded in `docs/AUTONOMOUS_CODING_EXECUTION_V0.1_EXECUTION_CONTRACT_REVIEW_SPEC.md`.  
**This plan does not authorize implementation in this turn.**

## 1. Goal and Frozen Contract

Nexora must autonomously continue any incomplete task while a safe, admissible action remains. Runtime owns lifecycle facts; Agent/Harness owns strategy. Completion Gate owns success. User intervention is reserved for user-exclusive information/authority or a high-risk external effect that remains unverifiable. A deterministic impossible boundary is terminal `failed`, not a generic pause.

The plan is successful only if it improves correctness of recovery and stopping semantics without optimizing for a lower `blocked` count and without weakening Approval, permission, provenance, or Completion Gate boundaries.

## 2. Repository Reality and State Matrix

Current repository facts:

- Runtime state transitions are centralized in `packages/runtime/src/state-machine.ts` and `packages/runtime/src/runtime.ts`.
- `RuntimeTool` currently declares effect and Boolean idempotency, but no reconciliation/risk/replay contract (`packages/runtime/src/runtime-types.ts`).
- Unknown Invocations are reduced to `require_confirmation` in `packages/runtime/src/execution/recovery-reducer.ts` and resolved by user `RecoveryDecision` in `packages/runtime/src/execution/runtime-execution.ts`.
- `NO_PROGRESS_DETECTED` currently commits terminal `failed` in `runtime.ts`; existing convergence tests cover repeated local behavior, warning/probation, alternate replan, and bounded continuations.
- Harness premature-input repair is phase-limited (`packages/harness/src/agent-loop.ts`).
- Desktop already distinguishes public `waiting_for_input` and `waiting_for_approval`, but has stale generic blocked/NO_PROGRESS presentation and incomplete real restart evidence.

```yaml
feature: autonomous-coding-execution-v0.1-execution-contract
mode: PLAN
scope_status: stable
spec_status: aligned
implementation_status: partial
migration_status: not_applicable
unit_test_status: passed
integration_test_status: partial
uat_status: partial
runtime_status: runnable
security_status: unverified
external_dependency_status: unverified
artifact_status: mixed_worktree_with_uncommitted_feature_artifacts
resolved_status: ready
```

The repository's `DEVELOPMENT.md` currently names `hybrid-decision-context-v0.1` as the active Feature. This plan is a separately authorized follow-on contract; it must not silently rewrite that active Feature's status until implementation and evidence are complete.

## 3. Scope, Non-goals, and Protected Invariants

### In scope

1. Tool capability-specific reconciliation for `started/unknown` effects.
2. Full-Run user-input admissibility.
3. Evidence-strengthened convergence and strategy exhaustion.
4. Typed Provider/budget recoverable versus terminal semantics.
5. Runtime-derived Desktop projection and restart/refresh verification.

### Non-goals

- No second Runtime state machine, workflow engine, global strategy registry, or model-strategy enumerator.
- No generic blind replay, inferred idempotency, automatic Approval bypass, or relaxed Completion Gate.
- No deletion/rewriting of historical Invocations, Attempts, Evidence, Events, Runs, or local workspace files.
- No broad reduction of `blocked` as a success metric.
- No change driven only by Agent prose such as “cannot continue”.
- No unrelated Desktop visual work, Provider redesign, Memory redesign, or benchmark framework rewrite.

### Invariants that must remain true

- Runtime owns lifecycle and stop reasons; Agent owns strategy.
- Completion requires deterministic Completion Gate and valid Evidence provenance/freshness.
- Approval/protected side effects remain Host/Runtime controlled.
- Invocation idempotency, lease/fencing, audit integrity, cancellation, and append-only events remain authoritative.
- Desktop is a public snapshot projection and control client only.

## 4. Target State and Data Flow

The authoritative flow remains:

```text
Agent proposal
  -> Runtime admissibility / approval gate
  -> Invocation + Attempt ledger
  -> Tool result or unknown boundary
  -> Tool-specific reconciliation (if supported)
  -> authoritative Evidence / classified outcome
  -> continue, typed waiting/blocked, or terminal failed
  -> Completion Gate for success only
  -> public snapshot -> Desktop
```

No new state authority is introduced. Reconciliation facts, strategy diagnostics, and boundary classifications are persisted as existing Run Events, Invocation/Attempt fields, Evidence, Delivery, and artifacts where size requires it.

## 5. Workstream A — Tool Reconciliation Contract

### Final behavior

For a `started` or `unknown` effect, Runtime first attempts the Tool-declared reconciliation sequence:

1. query Invocation/idempotency/provider operation/resource identity;
2. inspect authoritative workspace or external state with a read-only probe;
3. validate and persist Tool-owned facts with Invocation provenance, digest, subject, and timestamp;
4. classify `confirmed_succeeded`, `confirmed_no_effect`, `confirmed_failed`, `still_pending`, or `indeterminate`;
5. continue/finalize/poll/replay only under the declared safe policy;
6. request user recovery only for high-risk, still-unverifiable effects where replay and compensation are not proven safe.

Generic replay is forbidden. A Boolean idempotent flag alone cannot authorize replay without an idempotency scope and effect-specific proof.

### Minimal contract change

Extend the existing `RuntimeTool.contract.execution` with optional, capability-specific metadata/operations rather than a registry:

- risk classification (`low`, `high`);
- reconciliation mode and bounded probe/poll operation;
- idempotency key/scope and replay policy (`never`, `after_no_effect`, `idempotent_scope`);
- result schema for reconciliation facts;
- optional Tool-owned compensation operation;
- explicit “cannot reconcile” result.

The exact public shape must be versioned and schema-validated. Existing Tools without reconciliation remain safe-confirmation Tools; they do not gain implicit replay.

### Ownership and reuse

- Runtime: orchestration, validation, persistence, fencing, transition, and escalation.
- Tool: authoritative query/compensation semantics and fact schema.
- Harness: choose whether to propose a safe follow-up; never resolve unknown status.
- Reuse: `recovery-reducer`, `recoverToolInvocation`, Invocation/Attempt ledger, Evidence provenance, Artifact Store, and current Recovery Decision path.

### Required evidence

- deterministic read/write/process fixtures proving successful reconciliation, no-effect safe replay, pending polling bound, and high-risk confirmation;
- duplicate-effect counter proving no non-idempotent replay;
- restart/reopen test proving unknown state and reconciliation facts survive;
- negative test proving an unsupported Tool remains confirmation-only.

## 6. Workstream B — User Input Admissibility

### Final behavior

`request_input` is accepted only when the proposal identifies a missing user-exclusive fact, choice, credential, or authority. Workspace, repository, Tool, context, and persisted facts must be exhausted or mechanically shown insufficient first.

Runtime retains same-Run `waiting` with a persisted pending request and matching input resume. Harness supplies strategy and evidence references; Runtime performs deterministic admissibility checks and rejects a disguised completion, failure, or generic “should I continue?” question.

### Minimal contract change

Add a structured admissibility basis to the request proposal (for example: missing user-exclusive category, question, and why available authoritative sources cannot provide it). Keep the Runtime check narrow: it validates request shape, pending-state rules, available facts/Tools, and policy; it does not hard-code domain strategy.

Extend the existing early repair logic to all Run phases by reusing current context projections, active Invocations, Plan checks, and persisted facts. A rejected request records `response.rejected` and repair guidance; it does not change lifecycle.

### Ownership and reuse

- Agent/Harness: identify the minimum missing user fact and propose the request.
- Runtime: accept/reject, persist waiting request, same-Run resume.
- Desktop: render `waiting_for_input` as a normal request, not blocked/error.
- Reuse: `request_input` action, `pendingRequest`, input history, `RunHandle.input`, public waiting projection.

### Verification-only versus code

The same-Run waiting/resume path already exists and should first receive adversarial tests. Code is required only for the structured admissibility contract and all-phase enforcement if tests reproduce the current phase gap.

## 7. Workstream C — Convergence and Strategy Exhaustion

### Final behavior

`NO_PROGRESS_DETECTED` remains terminal `failed`, never a coaching pause. Runtime may commit it only when the current bounded window shows no new authoritative fact/progress, repeated behavior is equivalent by strategy and observation/effect, and available alternate classes have been attempted, ruled out by capability/policy, or proven irrelevant.

The implementation must not enumerate every model idea or create a global registry. It should persist a compact diagnostic manifest derived from observable facts:

- strategy class/fingerprint;
- failure/result/observation fingerprint;
- Plan revision and meaningful replan attempt;
- available Tool alternatives and policy exclusions;
- authoritative progress and verification facts;
- reset boundary and oscillation history;
- attempted and ruled-out recovery classes.

### Minimal change

Reuse `#noProgressDiagnostic`, warning/probation, strategy fingerprints, resource churn, Plan revisions, and continuation inheritance. Add only the missing evidence needed to distinguish “same local loop” from “all reasonable available classes exhausted”. Keep bounded counts and no-op/oscillation detection deterministic.

### Ownership

- Agent: choose alternate strategy/replan after warning.
- Runtime: decide whether evidence crosses terminal convergence threshold.
- Harness: expose repair guidance and available Tool catalog; never set failed.

### Verification-only candidates

Existing alternate-replan and repeated-failure tests should be retained. New code is not justified for a scenario that only lacks a test (for example, Plan invalidation followed by successful replan); add deterministic tests first. Implement only when the current diagnostic cannot persist or evaluate the required observable fact.

## 8. Workstream D — Provider and Budget Terminal Semantics

### Final classification

| Boundary | Status | Required predicate |
|---|---|---|
| temporary Provider/dependency boundary | `blocked` | recovery budget remains and connectivity/capacity predicate is testable |
| soft extendable budget | `blocked` | authorized extension is a valid explicit operation |
| hard non-extendable budget | terminal `failed` | no legal extension exists |
| exhausted Provider/dependency set | terminal `failed` | allowed set and bounded recovery are exhausted |
| Runtime invariant / deterministic environment failure | terminal `failed` | no safe continuation exists |

`blocked` is never used for NO_PROGRESS, ordinary Tool/validation failure, generic model uncertainty, hard budget, or exhausted Provider recovery.

### Minimal change

Introduce an explicit policy distinction for budget extensibility and Provider recovery exhaustion while preserving existing persisted snapshots through compatibility defaults. Centralize classification in Runtime; do not infer hardness from UI labels or model text. Delivery must state the exact predicate/condition for blocked and the new-Run condition for terminal failure.

### Compatibility risk

Existing callers may expect budget/Provider `blocked` results. The compatibility plan must version the public stop-reason/result contract, retain old event decoding, and make behavior changes opt-in or migration-safe for persisted Runs. No destructive migration is allowed.

## 9. Workstream E — Desktop Projection and Verification

### Final behavior

- `waiting_for_input`: exact minimal question; same-Run reply.
- `waiting_for_approval`: exact protected action; approve/deny.
- reconciliation: show Tool/Invocation, probe status, and whether user confirmation is actually required.
- `blocked`: show typed recoverable boundary and resume predicate; never generic “need help”.
- `failed`: terminal result, exact cause, completed/unfinished work, Evidence, and new-condition guidance; no generic Resume.
- `NO_PROGRESS_DETECTED`: terminal convergence explanation and attempted strategy classes.

Reuse `runtime-public.ts`, `ui-projection.ts`, `runtime-service.ts`, and existing Renderer controls. Do not add local status state. Fix or test stale copy only where it conflicts with the Runtime public contract.

### Verification

Add deterministic Host → snapshot → IPC → Renderer checks for waiting input, approval, reconciliation, blocked, failed, and NO_PROGRESS. Add refresh and process-restart checks that rebuild the same projection from persisted Runtime state. Existing source/unit projection evidence is not sufficient for the real Electron claim.

## 10. Test and Adversarial Evaluation Plan

Risk level is **L3** because the work touches Runtime Authority, recovery, side effects, public contracts, persistence, and Desktop integration.

### Deterministic Runtime/contract tests

1. ordinary Tool failure repairs/alternates and succeeds;
2. validation failure replans without waiting or blocking;
3. Plan assumption invalidation records new fact and replans;
4. same strategy/result repeats produce warning then terminal NO_PROGRESS only when alternatives are exhausted;
5. alternate Tool/strategy remains available and prevents NO_PROGRESS;
6. two strategies oscillate and converge only after ruled-out classes are persisted;
7. queryable unknown effect auto-reconciles and continues;
8. unknown no-effect safely replays only under declared policy;
9. high-risk unverifiable unknown requests explicit recovery confirmation;
10. unknown restart/reopen preserves ledger and does not duplicate effects;
11. derivable workspace information never creates waiting input, including post-Plan/post-Tool;
12. user-exclusive fact/choice/credential creates waiting and same-Run resume;
13. temporary Provider boundary blocks only while predicate remains recoverable;
14. exhausted Provider/dependency set fails terminally;
15. soft budget blocks for explicit extension; hard budget fails terminally;
16. dangerous mutation waits for Approval and performs no physical effect before grant;
17. Agent prose “cannot continue” leaves lifecycle unchanged;
18. Completion Gate rejects unresolved/unknown/stale/unverified outcomes.

### Loop and safety assertions

Every test records event sequence, status/stopReason, Delivery, Invocation/Attempt counts, Evidence provenance, and model/tool call counts. Explicitly assert:

- no false success;
- no duplicate high-risk/non-idempotent side effect;
- bounded retries, polling, repair, and replan loops;
- no generic Resume for terminal failure;
- no lifecycle transition from model prose;
- same persisted snapshot after restart/reopen.

### Verification-only cases

Alternate-path success, user-input classification, Desktop refresh projection, and several Plan-invalidation cases may initially be test-only additions because the repository already has the underlying mechanisms. Do not add production logic unless a deterministic test demonstrates a missing contract enforcement point.

## 11. Migration and Compatibility Strategy

- Prefer additive optional fields and schema-versioned contracts.
- Existing Tools without reconciliation remain safe-confirmation only.
- Existing persisted Invocations/Attempts remain readable; unknown records are not rewritten or replayed during migration.
- Existing stop reasons/events remain decodable; new hard/soft classifications add explicit metadata rather than reinterpret old history silently.
- Public `RunResult`, `RunInspection`, Recovery Decision, and Desktop control types require compatibility tests for old and new snapshots.
- No database migration is required unless the existing Store cannot persist the additive contract; if required, it must be forward/backward readable, idempotent, and verified before use.
- Rollback is contract-version rollback with old unknown/blocked behavior preserved for old records; no destructive data rollback.

## 12. Definition of Done

### Feature Core DoD

The Feature is locally complete only when:

1. every `blocked` outcome has a typed, testable recoverability predicate;
2. hard boundaries and exhausted Provider/dependency sets produce terminal failed delivery;
3. NO_PROGRESS terminal failure includes durable convergence evidence and does not fire while a valid alternate class remains;
4. user input is admitted only for user-exclusive needs throughout the Run;
5. unknown effects reconcile through Tool capability contracts before high-risk confirmation;
6. Completion Gate, Approval, Invocation, Evidence, lease, fencing, and cancellation invariants remain intact;
7. deterministic tests in Section 10 pass with no relevant skips;
8. Desktop real-runtime refresh/restart projection matches persisted Runtime state.

### Release gates

- full Core Regression for L3;
- security/permission and duplicate-side-effect review;
- observability for reconciliation, convergence, and terminal boundary reasons;
- persistence/restart and package-consumer compatibility;
- clean, isolated Git delivery for this Feature.

### External acceptance

- real Provider transient outage and recovery;
- real external Tool reconciliation where credentials/resources exist;
- real Electron Host acceptance across waiting, approval, recovery, blocked, and failed states.

External Provider availability must remain distinct from Runtime defects.

## 13. Plan Exit Criteria and Next Action

This PLAN is ready for review because scope, ownership, protected boundaries, target behavior, evidence, compatibility risks, and DoD are explicit. Approval of this document is required before `CONTINUE`.

After approval, enter `CONTINUE` only for the smallest vertical slice beginning with the reconciliation contract and its deterministic fixtures. Do not update the active `DEVELOPMENT.md` Feature status until implementation and verification evidence satisfy the DoD layers above.
