# Autonomous Coding Execution v0.1
## Execution Contract Review Spec — Revised

**Status:** `REVIEW_SPEC_REVISED / FORMAL_PLAN_READY / FEATURE_CONTRACT_NOT_PROVEN`  
**Scope:** autonomous execution, recovery, stopping, and user-intervention semantics in the current repository.  
**Change policy:** this review changes only this Spec. It does not authorize or modify production code.

## 1. Current Repository Findings

The current repository provides a durable Runtime state machine, persisted Plans, Tool Invocations and Attempts, Evidence provenance, deterministic Completion Gate checks, waiting requests, approval enforcement, bounded Provider recovery, and convergence diagnostics. Existing primary-canary and nine-run reliability evidence remains valid evidence for ordinary Coding paths; this review does not redefine those passing results as failures.

The previous Review Spec remains correct about lifecycle ownership and the unknown-effect gap, but it is stale or too broad in four places:

| Finding | Current repository evidence | Review disposition |
|---|---|---|
| Runtime owns lifecycle; Agent owns strategy | Runtime commits transitions; Agent proposes commands | **Preserve** |
| Completion Gate, not prose, decides success | unresolved Invocations, stale/missing Evidence, and unverified writes reject completion | **Preserve** |
| Approval protects dangerous side effects | protected actions persist an approval request before execution | **Preserve** |
| Desktop projects Runtime state | public status maps `waiting` to input/approval variants | **Preserve** |
| `NO_PROGRESS_DETECTED` is blocked | current `#failForNoProgress()` commits `failed` | **Correct previous Spec** |
| all Provider/budget boundaries may be blocked | current code blocks both retryable and exhausted Provider/budget paths | **Definition is too broad** |
| premature input requests are generally prevented | Harness repair only guards the pre-Plan, zero-Tool-call window | **Evidence and enforcement are incomplete** |
| unknown Tool effects can be autonomously reconciled | Tool contract has only effect/idempotency; unknown maps to confirmation | **Actual contract gap** |

## 2. Existing v0.1 Capabilities That Must Be Preserved

- Runtime State Machine is the only Run lifecycle authority.
- Agent/Harness owns strategy selection: inspect, retry, repair, alternate Tool, replan, validate, or request an allowed boundary action.
- Model prose cannot directly set `waiting`, `blocked`, `failed`, or `succeeded`.
- Completion Gate deterministically validates Plan, required checks, Evidence provenance/freshness, unresolved Invocations, and post-mutation verification.
- Tool Invocation/Attempt records remain the side-effect and recovery ledger.
- Approval and protected-side-effect policy must not be weakened to increase autonomy.
- Idempotent interrupted/transient Tool recovery remains bounded and audited.
- Desktop remains a projection and control surface, never a second state machine.
- Existing primary-canary and 9-run reliability results remain positive evidence for the paths they exercised.

## 3. Autonomous Execution Contract

While work remains and Runtime has not proven a deterministic stopping condition, the Run must continue autonomously. Ordinary Tool failure, validation failure, invalid assumptions, missing paths, empty search results, or one unsuccessful strategy are execution facts for the Agent, not lifecycle stop decisions.

The Agent may choose a materially different next action. Runtime decides whether the action is admissible, whether execution may continue, whether a typed suspension is justified, and whether completion or terminal failure is proven.

Autonomy is bounded by permission, approval, cancellation, lease/fencing, hard resource limits, side-effect uncertainty, and proven convergence exhaustion. “The model cannot continue” is never sufficient evidence for a lifecycle transition.

## 4. Runtime vs Agent Authority

| Concern | Authority | Contract |
|---|---|---|
| Lifecycle status and stop reason | Runtime | commit only from persisted facts and deterministic rules |
| Strategy and Plan proposal | Agent/Harness | choose next useful action; cannot declare lifecycle facts |
| Tool admissibility and side-effect execution | Runtime/Host policy | validate schema, capability, approval, lease, and Invocation binding |
| Tool outcome | Tool Runtime + durable ledger | persist Attempt, outcome, digest, and reconciliation Evidence |
| Completion | Runtime Completion Gate | reject prose-only or unverifiable completion |
| User input/approval | Runtime pending request | typed waiting request, exact request id, same-Run resume |
| Desktop state | Runtime public snapshot | render and control only; never reinterpret status |

## 5. Recoverable Failure Semantics

An execution failure remains inside `running` when the Agent can safely inspect, repair, retry under changed conditions, choose another Tool/strategy, replan, or validate. Runtime may bound repeated identical actions, but a retry count alone does not prove that autonomous recovery is exhausted.

A non-terminal suspension is allowed only when autonomous execution cannot proceed **now**, recoverability is positively known, and an exact external resume predicate exists. If the predicate is already satisfied, Runtime resumes automatically. If no viable predicate exists, the Run fails terminally with a deterministic delivery.

## 6. Unknown Tool Effect / Reconciliation Semantics

### Current behavior

`reduceRecoveryState()` maps every `unknown` Invocation to `require_confirmation`. `recoverToolInvocation()` has no Tool-specific reconciliation operation; `RunHandle.resume()` requires a matching user Recovery Decision. The Tool capability contract exposes effect and a Boolean `idempotent`, but no query, reconciliation, compensation, risk, or replay-proof contract. Desktop therefore asks the user to confirm success/failure/abandonment.

This conservatively prevents duplicate non-idempotent effects, but it is not the target autonomous contract.

### Required Tool capability reconciliation contract

Every effectful Tool must declare enough durable capability metadata for Runtime to select this order:

1. **Query invocation state:** resolve by Invocation ID, provider operation ID, resource ID, or idempotency key.
2. **Inspect authoritative state:** query workspace, filesystem, managed-process state, or external resource state through a read-only reconciliation operation.
3. **Validate recovered facts:** parse the Tool-owned reconciliation result and persist provenance, digest, timestamp, and subject reference.
4. **Classify the effect:** `confirmed_succeeded`, `confirmed_no_effect`, `confirmed_failed`, `still_pending`, or `indeterminate`.
5. **Select safe continuation:** finalize success, continue after confirmed failure/no-effect, poll a bounded pending result, or replay only when safety is proven.
6. **Escalate minimally:** ask the user only when the effect is high-risk, remains unverifiable after supported probes, and replay/compensation cannot be proven safe.

Required capability facts include reconciliation support/mode, effect risk, replay policy, idempotency scope/key, authoritative query inputs, result schema, polling bound, and optional Tool-owned compensation semantics.

Generic blind replay is forbidden. A Boolean `idempotent` alone is insufficient if the idempotency domain or authoritative state cannot be verified. User confirmation is Evidence of the user's assertion, not proof synthesized by the model.

## 7. User Input Semantics

Only a user-exclusive fact, preference, choice, credential, or authority decision may create an input request. Information obtainable from workspace files, repository state, available Tools, current context, persisted session facts, or a safe reasonable inference must be pursued autonomously.

Current Runtime representation is appropriate: `request_input` commits a durable `waiting` state with `INPUT_REQUIRED`; a reply references the pending request, appends input history, and resumes the **same Run**. A new Turn/continuation is not the default for satisfying a pending input request.

Current Harness enforcement is incomplete. `shouldRepairPrematureInputRequest()` rejects only when no Plan exists, no Tool has been called, and Tools are available. Once a Plan or Tool call exists, the repository does not prove that a derivable question is rejected. The target gate must classify the reason, not merely the execution phase.

Desktop must project this as `waiting_for_input`, with neutral “waiting for your reply” language and the precise question. It must not display a normal input request as an error, failed Run, or generic `blocked` state. Current public projection and compact live-feedback path already separate `waiting_for_input` from `blocked`; full real-Electron interaction/restart coverage remains an evidence gap.

## 8. Approval Semantics

Approval is a user-authority boundary, not an execution-repair mechanism. Protected writes and dangerous, high-impact, or irreversible actions persist `waiting_for_approval` before execution. The exact pending action and request id are binding; stale or mismatched decisions are rejected. Denial must not execute the action and may lead to a precise input request for an alternate direction.

No autonomous-recovery change may weaken permission, approval, sandbox, or security policy.

## 9. Terminal Failure Semantics

`failed` is correct when Runtime can prove that the current Run cannot continue under its contract. Examples are:

- autonomous strategy space is demonstrably exhausted;
- a hard, non-extendable budget is exhausted;
- the allowed Provider/dependency set is exhausted with no recoverable predicate;
- a required capability is absent and no substitute exists;
- a deterministic environment or Runtime invariant failure prevents execution;
- the user explicitly abandons a high-risk indeterminate effect.

Terminal delivery must include the exact boundary, completed and unfinished work, confirmed Evidence, attempted strategy classes, and what external condition would be required for a new Run. A terminal Run is not reopened through generic Resume.

The current repository does not distinguish soft extendable budgets from hard non-extendable budgets and leaves exhausted Provider recovery in `blocked`. Those are contract gaps relative to this definition.

## 10. Convergence / No-Progress Semantics

### Current behavior

Current `NO_PROGRESS_DETECTED` is terminal `failed`, not blocked. Runtime diagnoses repeated invalid responses, repeated Tool failure/result fingerprints, equivalent Plans, response rejection, and resource churn. It records a warning for most classes, permits one probation path, allows a replan followed by an empirical Tool attempt, and has tests proving that an alternate Tool input can succeed after warning.

### Final contract

`NO_PROGRESS_DETECTED` is a **terminal convergence failure**, never a generic pause or request for user coaching. It may be committed only after Runtime can establish all of the following:

1. no new authoritative fact, verified mutation, satisfied acceptance check, or changed external condition exists in the convergence window;
2. repeated actions are equivalent by strategy **and** observation/effect, not merely Tool count;
3. the Agent received the diagnostic and had a bounded opportunity to choose a materially different strategy or replan;
4. available alternate Tools, safe probes, Plan branches, and known recovery actions have either been attempted, ruled out by capability/policy, or proven irrelevant;
5. oscillation across multiple strategies is included in the exhausted set;
6. the persisted diagnostic explains attempted strategy classes and why remaining candidates were unavailable or inadmissible.

If an alternate Tool, strategy, safe probe, or meaningful replan remains available, Runtime must continue and must not emit `NO_PROGRESS_DETECTED`. If all reasonable autonomous paths are proven exhausted, Runtime commits terminal `failed` with stop reason `NO_PROGRESS_DETECTED`.

Current fingerprint/warning/probation logic proves repeated local behavior and some alternate-path tolerance, but it does not enumerate or rule out the available capability/strategy space. Therefore the **final state direction is correct**, while the **exhaustion proof is not yet sufficient**.

## 11. Strict Definition and Independent Value of `blocked`

`blocked` remains independently useful, but only as a durable, non-terminal **operational suspension**:

> Runtime has proven that autonomous work cannot proceed at this moment, has also proven that the Run is recoverable without changing its Goal or truth history, and has a concrete, typed resume predicate that is not yet satisfied.

Required invariants:

- `blocked` is never used for ordinary failure, model uncertainty, validation failure, strategy failure, or convergence exhaustion.
- `blocked` is never used for user-exclusive information or Approval; those are typed `waiting` states.
- The stop reason identifies one exact recoverable boundary.
- Delivery states the resume predicate and allowed control operation.
- Runtime can test the predicate; generic “continue” is insufficient.
- When recovery becomes impossible or the allowed recovery envelope is exhausted, transition to terminal `failed`.

Valid target examples are a known-temporary Provider outage with recovery still available, an explicitly extendable **soft** budget awaiting an authorized extension, a recoverable worker/lease handoff with a concrete reconciliation action, or a high-risk unknown effect with a structured recovery request that cannot yet be resolved automatically. The last case must be rendered as a specific recovery confirmation, never generic blocked/error copy.

Invalid target examples are hard budget exhaustion, exhausted Provider availability, `NO_PROGRESS_DETECTED`, missing required capability with no substitute, or “the model needs guidance.”

Current implementation is broader: it blocks all budget boundaries, exhausted Provider recovery, worker recovery, and unknown effects. The Spec therefore preserves the state but narrows its admissibility contract.

## 12. State Transition Invariants

- Only Runtime changes Run lifecycle status.
- `waiting` has exactly one persisted typed request and resumes the same Run after a matching decision/reply.
- `blocked` has no generic question; it has a typed, testable resume predicate.
- `failed` is terminal and carries deterministic delivery and stop evidence.
- `succeeded` has no unresolved Invocation and passes Completion Gate.
- Unknown effects remain visible until Tool-owned reconciliation or explicit high-risk confirmation resolves them.
- Cancellation cannot erase an unknown side effect or falsely claim it did not occur.
- Resume never resets convergence history merely by reopening a Run or rewriting an equivalent Plan.
- Lease, fencing, audit integrity, and Plan/Invocation provenance remain mandatory.

## 13. Desktop Projection Rules

- `waiting_for_input`: neutral request state, exact minimal question, same-Run reply control.
- `waiting_for_approval`: authority decision, exact protected action, approve/deny controls.
- `blocked`: typed recoverable operational boundary and its specific resume predicate; never generic “need help.”
- `failed`: terminal “not completed” outcome with reason, completed/unfinished work, Evidence, and new-condition guidance; no Resume button.
- `TOOL_RESULT_UNKNOWN`: show Tool/Invocation identity and reconciliation status; request confirmation only after automatic probes are exhausted and risk is high.
- `NO_PROGRESS_DETECTED`: show terminal convergence failure and attempted strategies, not “change direction to continue this Run.”

Desktop must derive every projection from the public Runtime snapshot and control APIs. Current source separates waiting states, but contains stale blocked-oriented `NO_PROGRESS` copy and generic blocked/help copy; because the current Runtime now fails NO_PROGRESS, some stale branches may be unreachable, but source and real-Electron behavior still need verification before the projection contract is proven.

## 14. Adversarial Evaluation Matrix

Every case must assert final/public status, stop reason, pending/recovery request, Invocation/Attempt ledger, Evidence provenance, event sequence, delivery, duplicate-effect count, and Desktop projection.

| # | Scenario | Required Runtime outcome | Current evidence status |
|---:|---|---|---|
| 1 | ordinary Tool failure with repair available | stay autonomous; inspect/repair/alternate and succeed | partial repair tests; full product case required |
| 2 | repeated failure but alternate Tool/strategy exists | warning/probation then execute alternate; must not stop | alternate input/replan case exists; broader capability case missing |
| 3 | Plan assumption invalidated by new fact | persist fact, replan unfinished work, continue | `EVIDENCE_GAP` |
| 4 | strategy space truly exhausted | terminal `failed/NO_PROGRESS_DETECTED`; list attempted/rule-out reasons | repeated fingerprints tested; exhaustion proof missing |
| 5 | two strategies oscillate without new facts | detect set-level oscillation, then terminal failure only after alternatives ruled out | `EVIDENCE_GAP` |
| 6 | workspace contains requested information | reject user request and autonomously retrieve it | early repair only; post-Plan/post-Tool gap |
| 7 | genuinely user-exclusive fact or choice | `waiting_for_input`, exact question, same-Run resume | core path exists; adversarial classification gap |
| 8 | credential or authority is required | typed input/approval according to boundary; never generic blocked | partial |
| 9 | unknown effect queryable by operation/idempotency key | auto-reconcile, persist Tool-owned Evidence, continue | not implemented/proven |
| 10 | unknown effect provably produced no effect | safely retry only under declared replay policy | not implemented/proven |
| 11 | unknown effect high-risk and unverifiable | structured recovery request; only then ask user; no blind replay | current confirmation safety exists, automatic pre-probes absent |
| 12 | cancellation during unknown effect | preserve unknown ledger and reconcile before final claim | safety path exists; autonomous reconciliation absent |
| 13 | temporary Provider outage with recovery remaining | typed `blocked`, automatically resume when predicate is satisfied | bounded recovery tests pass |
| 14 | allowed Provider set exhausted | terminal failed with dependency boundary and new-run condition | current implementation remains blocked: contract gap |
| 15 | extendable soft budget exhausted | typed blocked awaiting exact extension; resume with extension | existing behavior tested |
| 16 | hard/non-extendable budget exhausted | terminal failed; no generic Resume | hard-vs-soft concept missing |
| 17 | dangerous mutation | `waiting_for_approval`; no physical execution before grant | existing approval boundary must remain |
| 18 | validation fails with repair path | remain autonomous; repair/replan/revalidate | partial; adversarial case required |
| 19 | Agent prose says “cannot continue” | no lifecycle transition; require admissible Runtime action | Completion/control boundary present; adversarial case required |
| 20 | Desktop refresh/restart in waiting/recovery/failed | reproduce exact Runtime projection and controls | source/unit evidence only; real Electron gap |

## 15. Acceptance Criteria

The execution contract is proven only when:

1. all preserved boundaries in Section 2 remain green;
2. `blocked` is accepted only with a typed recoverable predicate and exhausted predicates become terminal failure;
3. hard vs soft budget and recoverable vs exhausted Provider boundaries are explicit and tested;
4. NO_PROGRESS diagnostics prove strategy-space exhaustion, including alternate capabilities and oscillation, before terminal failure;
5. user-input admissibility is enforced throughout the Run, not only before Plan/Tool execution;
6. Tool contracts support validated reconciliation, bounded polling, replay safety, and high-risk escalation;
7. no case produces false success or duplicate non-idempotent effects;
8. Completion Gate and Approval behavior remain unchanged in strength;
9. Desktop real-runtime tests prove waiting, recovery, blocked, NO_PROGRESS failure, and restart projection;
10. all scenarios in Section 14 have deterministic evidence, with real Provider/external acceptance only where the contract requires it.

## 16. Non-goals

- Do not remove Runtime lifecycle authority or encode Agent strategy choices into the state machine.
- Do not eliminate every temporary suspension; narrow `blocked` to proven recoverability.
- Do not make every Tool replayable or infer idempotency from a Tool name.
- Do not weaken Approval, permission, sandbox, protected-write, or security boundaries.
- Do not treat model summaries, Desktop copy, or Harness repair labels as authoritative facts.
- Do not expand this Spec revision into production implementation, unrelated Desktop polish, or benchmark redesign.

## 17. Repository Evidence

Primary evidence reviewed:

- `packages/runtime/src/state-machine.ts`: allowed transitions and delivery/stop-reason requirements.
- `packages/runtime/src/runtime.ts`: waiting input, Provider/budget/worker blocking, convergence diagnostics, terminal NO_PROGRESS, and resume controls.
- `packages/runtime/src/runtime-types.ts`: Tool contract exposes effect/idempotency but no reconciliation capability; Recovery Decision is user-confirmed.
- `packages/runtime/src/execution/recovery-reducer.ts`: unknown maps directly to `require_confirmation`.
- `packages/runtime/src/execution/runtime-execution.ts`: safe idempotent recovery, unknown blocking, and user Recovery Decision application.
- `packages/runtime/src/completion-gate.ts`: deterministic completion and Evidence checks.
- `packages/harness/src/agent-loop.ts`: early premature-input repair and final-control enforcement.
- `packages/harness/src/context/decision-context.ts`: repair/no-progress guidance projected to the Agent.
- `packages/runtime/src/runtime-public.ts`: `waiting` public variants and unknown recovery projection.
- `apps/desktop/src/renderer/ui-projection.ts`, `apps/desktop/src/renderer/app.ts`, and `apps/desktop/src/runtime-service.ts`: Runtime projection and control paths.
- `tests/runtime/e129-bounded-execution-convergence.test.ts`: terminal NO_PROGRESS, warning, alternate replan, continuation, and loop bounds.
- `tests/runtime/e065-provider-transient-recovery.test.ts`: bounded Provider retry/block/resume behavior.

Focused verification executed during this revision:

`pnpm exec vitest run tests/runtime/e049-recovery.test.ts tests/runtime/d2-run-handle-interaction.test.ts tests/runtime/e065-provider-transient-recovery.test.ts tests/runtime/e129-bounded-execution-convergence.test.ts tests/runtime/e139-change-task-completion-authority.test.ts tests/desktop/ui-projection.test.ts tests/desktop/renderer-regression.test.ts`

Result: **7 test files passed, 71 tests passed, 0 skipped in the reported run.** Existing primary-canary and nine-run reliability artifacts were not rerun or invalidated. No production code was modified by this review.

## 18. Remaining Evidence Gaps and Plan Readiness

`EVIDENCE_GAP` remains for:

- capability-wide alternate-strategy exhaustion and multi-strategy oscillation;
- post-Plan/post-Tool user-input admissibility;
- Tool-owned unknown-effect reconciliation and safe replay proof;
- hard versus soft budget classification;
- exhausted Provider/dependency terminalization;
- real Electron waiting/recovery/failed restart projection;
- human-readable durable inventory of attempted and ruled-out strategies.

The contract is now specific enough to enter a formal `PLAN`. It is **not** implementation-complete or verification-complete. The next lifecycle mode should be `PLAN`, limited to the gaps above and preserving every boundary in Section 2.

## Review Conclusion

The revised final semantics are:

- **`blocked`:** only a proven-recoverable operational suspension with a typed, testable resume predicate; waiting input/approval and terminal impossibility are excluded.
- **`NO_PROGRESS_DETECTED`:** terminal `failed`, but only after a durable proof that reasonable autonomous strategy space is exhausted. Current Runtime reaches the correct final state but does not yet prove the full strategy-space premise.
- **User input:** only user-exclusive fact/choice/credential/authority; Runtime uses same-Run `waiting`/resume, and Desktop renders a neutral typed request rather than error/generic blocked.
- **Unknown effect:** query and reconcile authoritative state first; replay only with proven safety; ask the user only for high-risk, still-unverifiable effects.

Current status remains `FEATURE_CONTRACT_NOT_PROVEN`, with `FORMAL_PLAN_READY` as the highest honest lifecycle readiness.
