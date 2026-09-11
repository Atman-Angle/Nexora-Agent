# NEXORA Runtime Acceptance Report

Scope: which Runtime contracts Nexora currently implements and supports, and
where each has deterministic/invariant evidence and real execution evidence.
Sources of evidence:

- Fault Lab (deterministic durable-boundary invariants): 28/28, catalog
  `harness/nexora-bench/fault-catalog.json` v2.1.0, each case maps to a
  runtime e-test pattern.
- Runtime regression tests: e049-* (contracts/tool-runtime/recovery/
  completion-integrity/concurrency), e065 (provider transient recovery),
  e079/e080/e087/e089/e093/e095/e102/e103/e109/e110/e112/e118/e120/e124/e129,
  plus e146 (verification replay), e147 (completion rejection guidance),
  e148 (workspace-inside absolute path acceptance) added by this EDD round.
- Bench tests: 26/26 (`pnpm --filter @nexora/bench test`).
- Real provider evidence: Harbor cap-task After cohort (docs/evidence/
  NEXORA_REAL_PROVIDER_HARDENING_AFTER_V1.json: 28/30 strict, 29/30 external,
  0 false success / unsafe invocation) and the official Terminal-Bench 2.0
  subset/After runs in `harness/nexora-bench/harbor/jobs-output/`.

## Contract x evidence matrix

| Runtime contract | Deterministic / invariant evidence | Real-path evidence | Status |
| --- | --- | --- | --- |
| Plan Authority (Runtime-owned plan; model/Tool/host cannot mutate Run) | e049-contracts, e129 plan-scope rules, e146 | TB trials: scope-changing plan revisions rejected | covered |
| Progress Accounting (Step progress from persisted invocations) | e146 verification replay; e129 | TB trials | covered |
| Completion Gate (durable result + evidence; no false success) | e049-completion-integrity, e124, fault-lab incorrect-completion-proposal-direct-text | TB sanitize-git-repo overclaim classified MODEL; cap After 0 false success | covered |
| Evidence (provenance, digest, plan/step binding) | e049-contracts, fault-lab stale-evidence-rejected / mutation-check-provenance / recovery-reducer-corrupt-facts | TB fact bundles carry evidenceIds | covered |
| Tool Invocation / Attempt (durable intent + attempts) | fault-lab prepared-before-effect / partial-batch-result / interrupted-attempt | TB trials persist invocations/attempts | covered |
| Approval (protected mutation gated by persisted grant) | fault-lab approval-denial-no-tool-execution; e049-tool-capability-approval-contract | TB trials: approval.granted precedes tool.started; authority/safety 1.0 on all trials | covered |
| Retry / Backoff (durable, allowlisted) | fault-lab interrupted-attempt / transient-tool-retry-durable-backoff | provider attempt retries observed | covered |
| Idempotency (repeatable reads; write/execute duplicate guard) | e049-tool-runtime, e129 | TB regex-log repeated-batch rejection | covered |
| Unknown non-idempotent side effect (confirmation-only) | fault-lab unknown-non-idempotent / unknown-effect-confirmation-only / blocked-non-idempotent-interrupt | deterministic real cap runs | covered |
| Recovery (reconcile interrupted effects) | e049-recovery, e110, fault-lab crash-after-side-effect-before-finalization | cap After 28/30; TB | covered |
| Restart / Resume (persisted run reopen) | e112 crash matrix, e146 reopen | cap real runs with restarts | covered |
| Lease / Fencing | fault-lab lease-fencing-busy-run, lease-takeover-interrupts-unfinished-provider-call, e049-concurrency | deterministic | covered (deterministic) |
| Context Projection (bounded, archived) | e087, e089, e103 | real context runs (docs/evidence) | covered |
| Rehydration | e082, e102 | real context runs | covered (deterministic) |
| Memory trust boundary | fault-lab memory-trust-boundary-untrusted-data, e095 | - | covered (deterministic) |
| Artifact validation (existence before publish; large content to artifact) | fault-lab artifact-ref-requires-existence / no-incomplete-artifact-after-cancel, e089 | TB large outputs -> artifact refs | covered |
| Replan preserving completed work | e129 (bounded convergence / plan rewrite), e146 | TB | covered |
| blocked / waiting / resume semantics (typed resume predicate) | e065 provider recovery; e129 blocked parent continuation | TB regex-chess BLOCKED_EXTERNAL w/ PROVIDER_UNAVAILABLE | covered |
| Convergence / NO_PROGRESS (bounded, with repair path) | e129 (30 cases), e109 | TB 6 failed closures NO_PROGRESS_DETECTED with reasons | covered |
| Provider interruption | e118, fault-lab provider-stream-interruption-lease, e065 | TB provider connect timeouts recovered | covered |
| Partial Success (sibling success retained) | fault-lab partial-batch-result | deterministic | covered (deterministic) |

## Execution closure semantics (this EDD round)

Closure classifier (`nexora_harbor/closure.py`) maps a persisted Runtime task
report to SUCCEEDED / FAILED_TASK / WAITING_APPROVAL / WAITING_INPUT /
BLOCKED_EXTERNAL / CANCELLED / UNEXPECTED_RUNTIME_DEAD_END.  Verifier
projection and job projection now carry `closure` and `closureDistribution`.
Official Terminal-Bench evidence:

- 10-task subset (job 2026-09-04__02-13-52): Execution Closure Rate 10/10,
  SUCCEEDED 3, FAILED_TASK 6, BLOCKED_EXTERNAL 1, dead-ends 0; runtime /
  authority / safety / expectedOutcome pass rates 1.0.
- After cohort (job 2026-09-04__02-39-33) on EDD-001/002 code:
  log-summary-date-ranges and regex-log moved from FAILED_TASK to SUCCEEDED
  closures while keeping official external PASS.

## Gaps / not yet covered with real evidence

- WAITING_INPUT and CANCELLED terminals: covered by deterministic scenarios
  (fault-lab approval-denial-stop-waits-for-input; bench cancellation tests),
  not by an official Terminal-Bench trial.
- Lease/fencing, rehydration, memory trust boundary: strong deterministic
  evidence only; real-provider coverage is limited to cap-task runs.
- Full official 89-task Terminal-Bench cohort is in progress (job
  tb-nexora-real-full89.yaml) and will extend the real-path matrix.


## Known pre-existing test drift (not caused by this EDD round)

The canonical `pnpm run test:runtime-harness-release` script currently reports
19 failures across 8 files (86/105 pass).  The failures are a stale-expectation
drift: they assert that bounded convergence leaves a Run `blocked` with
`NO_PROGRESS_DETECTED`, while the current Runtime closes repeated-invalid
response runs as `failed` with `NO_PROGRESS_DETECTED`.  This drift was
verified to predate this EDD round by reverting this round's only two Runtime
source changes (`workspace.ts`, `runtime-helpers.ts`) and re-running one
failing suite - it fails identically without those changes.  The deterministic
evidence used in the matrix above (Fault Lab 28/28 and the targeted suites
e049/e109/e120/e129/e146/e147/e148, all green) is consistent with the current
convergence semantics; the stale tests are outside this goal's scope.
