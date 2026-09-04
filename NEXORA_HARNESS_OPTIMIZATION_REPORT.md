# Nexora Harness Optimization — Rounds 1–2 Report

> Date: 2026-09-04
> Scope: implement and verify a production Harness/Runtime optimization round based on the Post-Terminal-Bench Optimization Audit.
> Baseline: official Terminal-Bench full-89 retained result (frozen), Runtime Acceptance, Fault Lab and retained trajectories.
> Worktree discipline: pre-existing uncommitted changes were preserved. This closure review updates only the Harness projection/repair implementation, focused deterministic tests, and the report; no new Terminal-Bench model trial or full-89 run was started.

## 1. Objective

Implement a verified round of Harness/Runtime optimization instead of only auditing. Each treatment needed a GO / NO_GO / INCONCLUSIVE decision, regression coverage, and no weakening of Safety, Authority, Approval, Evidence, Completion Gate, containment, idempotency or typed closure semantics.

## 2. Treatments and decisions

### Treatment 1 (P0-1): progress-anchored repeated-state convergence — GO (deterministic)

Problem from the audit: an identical state-rejection code that recurs after authoritative Tool progress was counted as one no-progress loop and the run was terminated on the second occurrence, even when real work had happened between the two rejections.

Change in [packages/runtime/src/runtime.ts](packages/runtime/src/runtime.ts):

- Repeated-state equivalence is now measured inside the window opened by the most recent authoritative progress event (Tool success/failure/recovery, validation, confirmed recovery, merged Branch) instead of only the last user-input resume.
- Two identical state rejections separated by authoritative progress no longer terminate the run at the second occurrence; the model receives one bounded repair opportunity.
- Bounds are preserved: two identical rejections with no progress between still fail on the second occurrence; the same rejection code may appear at most three times per user-input segment, so rejection/progress alternation cannot loop beyond the hard cap; global iteration/model/tool/duration budgets are unchanged.
- No Completion Gate, Approval, Authority, containment or idempotency rule was changed.

Deterministic replay over all 88 retained runs with the recorded terminal windows:

| Category among 54 NO_PROGRESS FAILED_TASK rows | Count | Meaning |
|---|---:|---|
| State-repeat pair separated by authoritative progress | 41 | would no longer be terminated at the recorded terminal point |
| State-repeat pair adjacent (no progress between) | 7 | still terminated on the second occurrence (unchanged) |
| Failed by another convergence diagnostic | 6 | unaffected by this treatment |
| Non-failed rows (SUCCEEDED/BLOCKED/CANCELLED) that the new rule would flag | 0 | no false-kill risk observed |

Four of the six externally-passing false-negative rows are in the rescued set: `modernize-scientific-stack`, `kv-store-grpc`, `sparql-university`, `git-leak-recovery`. `cancel-async-tasks` and `distribution-search` fail with adjacent same-code plan-revision rejections, so they still terminate at two and need the Plan-repair/completion-projection affordance rather than this convergence change.

Regression coverage added in [tests/runtime/e129-bounded-execution-convergence.test.ts](tests/runtime/e129-bounded-execution-convergence.test.ts): three new deterministic tests that pin the new semantics:

1. a repeated state rejection separated by an authoritative Tool outcome continues past the second rejection and is bounded on the identical repeat;
2. rejection/progress alternation is bounded by the per-segment cap;
3. an adjacent repeated state rejection still terminates on the second occurrence.

Results: e129 33/33; affected runtime suites (e109, e076, e146, e147) all pass (47/47 combined); `pnpm --filter @nexora/runtime build` passes; `pnpm --filter @nexora/bench test` 26/26.

Real-model single-trial cohort (see section 3) did not reproduce the recorded failure mechanisms on any of the three sampled tasks, so it provides no direct measurement of the treatment effect. The decision is GO on deterministic mechanism and safety evidence, with the real-model A/B explicitly deferred until the external-verifier network and provider behavior are stable.

### Treatment 2: eval metric semantics — GO

Problem from the audit: the projection only exposed an internal `falseSuccess` computed against an empty internal grader, so Terminal-Bench rows with `SUCCEEDED + external=0` were indistinguishable from clean passes.

Change in [verifier.py](harness/nexora-bench/harbor/nexora_harbor/verifier.py): the projection now also carries machine-derived cross-product fields:

- `validatedSuccess`: Runtime terminal `succeeded` and official external result 1;
- `externalFailedAfterRuntimeSucceeded`: Runtime terminal `succeeded` and official external result 0 (the neutral name avoids claiming which side caused the failure);
- `internalFalseSuccess`: the legacy internal grader field, now explicitly labeled as internal.

The legacy `falseSuccess` key is kept for consumers. The new fields immediately classified the four real trial results correctly (two external-verifier network indeterminates, one real server-lifecycle failure, one real product failure).

Regression coverage added in [harbor/tests/test_verifier.py](harness/nexora-bench/harbor/tests/test_verifier.py). Results: all Harbor Python tests pass (20/20).

## 3. Real-model single-trial cohort (15:05–15:40)

Four tasks on the Round-1 composed diagnostic candidate (progress convergence and metric-semantics treatments active), using the same model/provider configuration as the frozen full-89 baseline, one trial each. These trials predate the Round-2 projections and provide no efficacy evidence for the later treatments.

| Task | Baseline (retained) | Candidate trial | External verifier this trial | Attribution |
|---|---|---|---|---|
| modernize-scientific-stack | FAILED_TASK, external 1 | SUCCEEDED/COMPLETED | 0 — verifier infra (could not download uv from github) | product indeterminate; trajectory had one rejection and did not exercise the changed convergence path |
| kv-store-grpc | FAILED_TASK, external 1 | SUCCEEDED/COMPLETED | 0 — real assertion: no server on 127.0.0.1:5328 | trajectory never reproduced the baseline duplicate-write loop (two rejections had different codes), so old code would also have succeeded here; result is model variance, and reveals a server-process lifecycle mismatch on clean completion |
| distribution-search | FAILED_TASK, external 1 | SUCCEEDED/COMPLETED | 0 — verifier infra (could not download uv from github) | product indeterminate; trajectory had zero rejections, so the change is not the cause |
| sanitize-git-repo | SUCCEEDED, external 1 (validated) | FAILED_TASK/NO_PROGRESS | 0 — real assertions failed | 24 provider failures and a different long trajectory; baseline itself is not robustly reproducible; no safety/authority regression |

All four candidate trials kept runtimeIntegrity=1, authority=1, safety=1, expectedOutcome=1, nexoraStrictPass=1, with zero exceptions. The single-trial cohort is INCONCLUSIVE as a capability measurement because (a) the sampled trajectories did not reproduce the mechanisms that the treatment changes, (b) two external results were verifier network failures, and (c) model/provider variance is large (18–26 provider failures per trial). It is also evidence that a meaningful A/B needs repeated trials per task and a stable external-verifier network.

## 4. Reliability status

- No State Machine, Plan, Invocation/Attempt, Approval, Evidence, Completion Gate, containment, idempotency or closure-semantics rule was weakened.
- No task-specific prompt, task-ID branch, verifier leakage or second Authority was added.
- The affected deterministic closure cohort (e076, e109, e120, e129, e142, e143, e144, e146, e147, e150; e129 contributes two files) passes **93/93 tests** across 11 files (20-second Vitest test timeout for the aggregate run); bench tests pass **26/26**.
- `pnpm --filter @nexora/runtime build` and `pnpm --filter @nexora/harness build` pass. The combined candidate includes the Round-1 Runtime/verifier changes plus the Round-2 Harness projections, structured rejection-code path, bounded remove-only Plan patch, and context deduplication.
- Harbor Python **20/20** remains retained prior evidence. The closure rerun could not collect tests because the local environments lacked the pinned `harbor` and `nexora_harbor` modules; no Harbor production code changed in this closure.

## 5. Files changed in this round

- [packages/runtime/src/runtime.ts](packages/runtime/src/runtime.ts) — progress-anchored repeated-state convergence (Treatment 1).
- [packages/harness/src/context/decision-context.ts](packages/harness/src/context/decision-context.ts) — structured rejection-code preservation, proactive Completion Gate projection, and derived navigation projections.
- [packages/harness/src/providers/model-client.ts](packages/harness/src/providers/model-client.ts) — typed repair and completion projection contracts.
- [packages/harness/src/providers/model-response.ts](packages/harness/src/providers/model-response.ts) and [packages/harness/src/planning.ts](packages/harness/src/planning.ts) — bounded remove-only Plan patch parsing and compilation.
- [packages/harness/src/prompt.ts](packages/harness/src/prompt.ts) and [packages/harness/src/index.ts](packages/harness/src/index.ts) — model-facing projection and export wiring, including compatibility fallback behavior.
- [tests/runtime/e129-bounded-execution-convergence.test.ts](tests/runtime/e129-bounded-execution-convergence.test.ts) and [tests/runtime/e150-turn-navigation-projection.test.ts](tests/runtime/e150-turn-navigation-projection.test.ts) — convergence and Round-2 closure regressions.
- [harness/nexora-bench/harbor/nexora_harbor/verifier.py](harness/nexora-bench/harbor/nexora_harbor/verifier.py) and [harness/nexora-bench/harbor/tests/test_verifier.py](harness/nexora-bench/harbor/tests/test_verifier.py) — Terminal-Bench metric fields and retained verifier tests.
- This report, [DEVELOPMENT.md](DEVELOPMENT.md), and retained Harbor trial outputs under `harness/nexora-bench/harbor/jobs-output/2026-09-04__15-05-40/`.

## 6. Remaining deferred scope and review boundary

The current candidate closes the deterministic Harness control-surface treatments identified for this review. The remaining evidence boundary is separate from implementation correctness:

1. Managed-process lifecycle: a clean Runtime completion can stop the supervised server that the official verifier expects to still be listening (`kv-store-grpc`). This is a general product-lifecycle question, not a benchmark hack, and remains **PRODUCT_DECISION_REQUIRED**.
2. External verifier setup depends on public network downloads inside trial containers; when that network is unavailable, external results are indeterminate and must not be read as product failures. The `externalFailedAfterRuntimeSucceeded` field plus verifier-output inspection make this distinction possible.
3. Real-model A/B attribution for proactive blocker guidance and the bounded Plan patch remains **INCONCLUSIVE/DEFERRED** because no new model trial was run in this closure and provider/network variance is material. The broader arbitrary Experiment D patch surface has not been validated.
4. An Environment/capability inventory Tool remains **DEFERRED / NOT_JUSTIFIED_YET**; no current evidence requires a new Runtime introspection authority.

The frozen full-89 result remains the official score baseline. No new full-89 or large model benchmark was started for this closure; any future rerun requires a separately justified review decision.


## Round 2 and architecture closure — control projections and constrained repair

Round 2 retained the reactive control surface from the earlier candidate and this closure review corrected the boundary between reactive repair navigation and proactive completion projection. All projection fields remain read-only navigation derived from Runtime facts; Runtime validation and mutation paths remain authoritative.

### Retained production treatments

| Treatment | Decision | Current implementation and evidence |
|---|---|---|
| Progress-anchored repeated-state convergence | **GO (deterministic)** | Runtime reopens the bounded rejection window only after authoritative progress; adjacent repeats still terminate at the existing cap. e129 remains 33/33. |
| Terminal-Bench metric semantics | **GO** | Harbor verifier retains `validatedSuccess`, `externalFailedAfterRuntimeSucceeded`, and `internalFalseSuccess`. Bench unit suite is 26/26; the retained Harbor verifier evidence is 20/20. |
| Reactive rejection/repair navigation | **GO (deterministic)** | Runtime rejection diagnostics expose structured `RepairIssue.code`/`path` when available; generic Provider schema codes remain diagnostic and cannot override a Runtime code. `repairCode` prefers structured Runtime-style codes and uses message-prefix parsing only for legacy adapters. `repairDirective` is guidance, not enforcement. e150 covers structured-code mapping and the compatibility fallback. |
| Derived unfinished-step navigation | **GO (deterministic)** | `nextUnfinishedStep` is explicitly the first ordered Step whose persisted progress is not `completed`. It is a derived navigation hint. Runtime active/ready semantics remain in `stepProgress.status` and Completion Gate facts. |
| Protected-action budget projection | **GO (deterministic)** | `protectedEffectsThisTurn` is a bounded phase/tool-catalog projection; it does not grant permission or change Approval. Covered by e150. |
| Context projection deduplication | **GO (deterministic)** | Duplicate `latestUserInput` was removed while the complete ordered input history remains under `originalTaskContract.userInputs`. |
| Proactive completion-blocker projection | **GO (deterministic projection; efficacy INCONCLUSIVE)** | `completionProjection` now calls Runtime-owned `validateCompletion` and exposes structured blocker fields (`code`, `stepId`, `checkId`, `subject`, `nextAction`, `detail`) plus `ready`. Focused e150 tests pass **12/12**, covering `STEP_INCOMPLETE`/`CHECK_UNSATISFIED` and the satisfied-evidence `ready: true` case; the same suite covers structured repair-code precedence and the legacy fallback. This is a read-only projection of the Completion Gate; it does not make P0-2 model-behavior efficacy claims because no new real-model or full-89 trial was run. |
| Constrained Plan repair/patch | **GO for bounded remove-only patch; Experiment D efficacy INCONCLUSIVE** | `nexora_update_plan` accepts a remove-only patch, rejects empty patches, rejects goal/scope mutation in remove-only form, preserves completed Steps, validates removable unfinished Step IDs, and compiles back to the same Runtime `set_plan` path. Focused e150 and existing e144 coverage pass. This is a bounded constrained patch, not a claim that the broader Experiment D arbitrary patch surface has been empirically validated. |

### Deferred or decision-required treatments

| Treatment | Status | Boundary |
|---|---|---|
| Environment/capability inventory Tool | **DEFERRED / NOT_JUSTIFIED_YET** | Existing repository/coding capability projections provide facts used by current workflows. No Runtime-side inventory Tool was implemented or validated, and no evidence requires adding one for this candidate. |
| Managed-process lifecycle redesign | **PRODUCT_DECISION_REQUIRED** | The `kv-store-grpc` trajectory exposed a general question about whether clean Run completion should stop supervised processes. No task-specific verifier workaround or lifecycle experiment was added. |
| Real-model A/B attribution for the Harness/Runtime treatments | **DEFERRED** | Provider/network variance and external-verifier setup failures make a new trial non-diagnostic under the current instruction. |
| Full-89 Terminal-Bench rerun | **DEFERRED** | The frozen full-89 result remains the official baseline; this closure did not start a new large benchmark. |

### Combined candidate validation

Current affected deterministic suites pass:

- e076/e109/e120/e129 (both files)/e142/e143/e144/e146/e147/e150: **93/93 tests** across 11 files (run with a 20-second Vitest test timeout to accommodate the aggregate long-running cohort);
- `pnpm --filter @nexora/runtime build`: **pass**;
- `pnpm --filter @nexora/harness build`: **pass**;
- `pnpm --filter @nexora/bench test`: **26/26**.

The retained Harbor Python evidence remains **20/20** from the prior candidate. A closure rerun was attempted with the local Python environments but could not collect tests because the environment did not expose the pinned `harbor` and `nexora_harbor` modules; no Harbor production code changed in this closure. This is an environment limitation on re-execution, not a newly observed verifier failure.

The earlier pre-existing drift remains excluded from this candidate: e088/e134 and the e084/e052/e090/e121 cluster reproduce their prior failures with the relevant Goal files reverted and are not attributed to these treatments.

### Architecture closure findings

- **Second Authority:** none added. `completionProjection`, `nextUnfinishedStep`, `protectedEffectsThisTurn`, `repairCode`, and `repairDirective` are Harness projections/guidance. Runtime Plan, Invocation, Approval, Evidence, Completion Gate, containment, idempotency and closure rules remain the enforcement authorities.
- **Heuristic presented as Runtime fact:** corrected. The field is named `nextUnfinishedStep`; it is ordered derived navigation. The implementation does not claim that the first incomplete Step is the Runtime's active or ready marker.
- **Reactive versus proactive semantics:** separated. A rejection's `repairCode`/`repairDirective` is reactive navigation after a failed proposal. `completionProjection` is proactive, read-only prediction from `validateCompletion`. Having a repair directive for a completion rejection does not imply that proactive P0-2 coverage is complete.
- **Structured rejection protocol:** `repairCode` is selected from a Runtime-style `RepairIssue.code` when present, then from top-level `RepairContext.code` when it is not the generic `INVALID_MODEL_RESPONSE` envelope. Message-prefix parsing is a bounded compatibility fallback only; it is not the primary protocol.
- **Duplicated policy:** the duplicate user-input projection was removed. The directive map is bounded model guidance keyed by Runtime-owned codes and cannot authorize or enforce an action.
- **Plan patch authority:** remove-only patches still compile through the canonical Runtime `set_plan` action, which performs the existing scope, completed-step, semantic-change and audit checks. No second Plan store or patch authority exists.

### Production-review verdict

The current combined candidate is **recommended to proceed into the formal production path, subject to the ordinary review gates**. The retained production changes have current deterministic regression evidence, the new proactive projection and bounded remove-only patch preserve Runtime authority, and the report distinguishes implementation evidence from unrun model-efficacy experiments. Environment inventory remains deferred because it is not justified by current evidence; managed-process lifecycle remains a product decision. No second Authority, heuristic masquerading as a Runtime fact, or duplicated enforcement policy was found.

This closure is complete for the current candidate. Deferred research items must be tracked separately and should not trigger automatic benchmark runs or further optimization in this review.
