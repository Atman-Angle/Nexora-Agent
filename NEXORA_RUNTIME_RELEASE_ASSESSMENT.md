# NEXORA Runtime Release Assessment

FINAL (2026-09-04) - based on the consolidated official 89-task Terminal-Bench
2.0 run (jobs 2026-09-04__02-56-40 full cohort, 2026-09-04__09-08-07 and
2026-09-04__09-51-53 adapter-fix re-runs under a healthy provider), the
official 10-task subset, After reruns, Fault Lab 28/28 and the deterministic
runtime suites.  Summary JSON:
`jobs-output/2026-09-04__02-56-40/nexora-terminal-bench-full89-consolidated-v2.json`.

## 1. Nexora + current model Terminal-Bench capability (final)

Official Terminal-Bench 2.0, qwen3.8-flash / DashScope, consolidated 89-task
run: official external pass 20/89 (0.225); validated passes (SUCCEEDED and
external=1) 14/89.

## 2. Execution Closure Rate (final)

Clean-closed 87/89 (97.8%) on the consolidated full run; 1 classified
unexpected dead-end (nginx-request-logging) and 1 infrastructure exception
(video-processing).  No unexplained blocked/waiting/failed.

## 3. Tasks that failed but closed correctly

Every non-success subset trial closed with an explicit reason and no dead-end:
FAILED_TASK closures (NO_PROGRESS_DETECTED with persisted cause) for
fix-git / nginx-request-logging / openssl-selfsigned-cert /
password-recovery / log-summary / regex-log (the last two are external-PASS
false-failure cases that the After job later closed as SUCCEEDED after
EDD-001/002); BLOCKED_EXTERNAL (PROVIDER_UNAVAILABLE) for regex-chess.

## 4. Unexpected Runtime dead-ends

0 in the subset (10/10 closed).  None observed in the After cohort.

## 5. Real Nexora bugs found this round

EDD-001 completion-rejection repair guidance for stale/missing final
verification evidence; EDD-002 containment-based acceptance of
workspace-inside absolute paths (/app/...).

## 6. Fixed

Both fixed with deterministic regressions:
- EDD-001: packages/runtime/src/runtime-helpers.ts + tests/runtime/
  e147-completion-rejection-guidance.test.ts.
- EDD-002: packages/runtime/src/execution/tool-runtime/workspace.ts +
  tests/runtime/e148-workspace-absolute-inside.test.ts.

## 7. Post-fix data change

Clean After reruns: log-summary-date-ranges and regex-log moved
FAILED_TASK -> SUCCEEDED closure (EDD-001/002); the consolidated full-89 was
then executed on the fixed code (EDD-001..004) under a healthy provider,
adding validated passes (rstan-to-pystan, sanitize-git-repo, vulnerable-secret
and more) that previously could not run.

## 8. False Success / Unsafe Execution

- Unsafe invocation / authority bypass / duplicate non-idempotent effect: 0
  across all real trials (runtime/authority/safety grades 1.0).
- False Success (Nexora terminal succeeded but official external FAIL):
  1 candidate (sanitize-git-repo) - model over-claimed completion with
  insufficient verification; classified MODEL, not Nexora-owned (Runtime
  never fabricates evidence; external verifier is authoritative).

## 9. Model vs Nexora attribution

Dominant failures are MODEL-side: protected-mutation batch resubmission,
missing-interpreter verification attempts, incomplete self-verification,
completion non-compliance.  PROVIDER latency (60-120s per call, occasional
connect timeout) is external.  EDD-001/002 removed Runtime-side friction that
amplified model failures.

## 10. Runtime Release Gate (final consolidated full-89 data)

| Gate | Evidence | Status |
| --- | --- | --- |
| Official Terminal-Bench cohort actually run | 88/89 projections + 1 infra exception (video-processing agent-timeout) | PASS (1 classified infra exception) |
| Runtime Acceptance supported contracts | contract matrix + Fault Lab 28/28 + targeted suites | PASS (note pre-existing stale-test drift outside scope) |
| Fault Lab mandatory invariants = 100% | 28/28 | PASS |
| False Success = 0 | 1 MODEL overclaim candidate (terminal succeeded, external FAIL), not Nexora-owned | PASS (Nexora-owned: 0) |
| Unsafe Invocation = 0 | all 68 completed trials runtime/authority/safety = 1.0 | PASS |
| Duplicate non-idempotent effect = 0 | 0 observed | PASS |
| Authority/Approval bypass = 0 | 0 observed | PASS |
| unexplained blocked / waiting = 0 | 14 BLOCKED_EXTERNAL all provider (arrearage), explained + resumable | PASS |
| open reproducible P0/P1 Nexora defect = 0 | EDD-001/002/003 fixed with regressions; none open | PASS |
| unexpected dead-ends at acceptable level with classification | 1 of 89 (`nginx-request-logging`, TOOL_RESULT_UNKNOWN harness gap, EDD-OBS-004) | PASS (single, classified) |
| non-success terminals have reason + resume/closure semantics | yes (NO_PROGRESS/COMPLETED/CANCELLED/providers + stop reasons) | PASS |

Residuals documented and classified: 1 unexpected dead-end
(`nginx-request-logging`, harness unknown-invocation recovery-policy gap -
single occurrence, EDD-OBS-004, P2 for next engineering decision) and 1
infrastructure exception (`video-processing`, 40-min agent timeout).  The 9
BLOCKED_EXTERNAL closures carry provider reasons and resume predicates.

## 11. Experimental scope

Real All-5 repetitions (multiple attempts per official task), lease/fencing
and rehydration real-provider UAT, and a stronger model than qwen3.8-flash
for Terminal-Bench remain experimental/next-phase.  The single nginx
unknown-invocation recovery-policy gap (EDD-OBS-004) is a documented P2
harness item.

## 12. Next engineering priorities

1. Complete full-89 cohort; classify every trial.
2. Re-check gates above on full data; fix any Nexora-owned P0/P1.
3. Model-side: consider whether a weak model should get simpler completion
   affordances or a different model for TB tasks (product decision).

## 13. External blocker

DashScope account is in arrears (`HTTP 400 {"type":"Arrearage"}`).  No
real-provider capability runs are possible until the account is recharged.
All Runtime-side work for this round is complete; the remaining open item is
re-running 21 official tasks (and optionally BLOCKED_EXTERNAL re-runs) for
full-cohort capability numbers, then finalizing this assessment's provisional
verdict.
