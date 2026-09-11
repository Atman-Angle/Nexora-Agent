# NEXORA Terminal-Bench Report

## Dataset / environment identity

- Terminal-Bench version: 2.0 (official Harbor Hub dataset `terminal-bench@2.0`)
- Dataset identity: Harbor-native tasks (task.toml + prebuilt environment image
  + official hidden tests/test.sh).  89 tasks downloaded to
  `harness/nexora-bench/harbor/.tmp-tb/terminal-bench`.
- Harbor: 0.22.0 (pinned), Docker environment, official dataset and verifier
  untouched (no Harbor/Task/Verifier modifications).
- Provider / model: DashScope OpenAI-compatible, `qwen3.8-flash`,
  native-tools transport, reasoning dynamic.
- Adapter: `NexoraRuntimeAgent` (Node 22 bootstrap in minimal images) +
  `NexoraRuntimeVerifier` + open Runtime trial fallback for tasks outside a
  Nexora Eval Dataset.
- Verifier: official Terminal-Bench hidden `test.sh` (external reward) plus
  independent Nexora Runtime grades (runtime integrity / authority / safety /
  expectedOutcome) and Execution Closure classification.

## Executed cohorts

1. Subset cohort (10 official tasks x 1 attempt, concurrency 2), job
   `harness/nexora-bench/harbor/jobs-output/2026-09-04__02-13-52` (36m47s).
2. After cohort (2 official tasks, EDD-001+EDD-002 code), job
   `.../jobs-output/2026-09-04__02-39-33` (15m21s).

## Official task results (subset, 10 trials)

| Task | external | terminal | closure | rej | stop reason | strict |
| --- | --- | --- | --- | --- | --- | --- |
| fix-git | 0 | failed | FAILED_TASK | 3 | NO_PROGRESS_DETECTED | 0 |
| log-summary-date-ranges | 1 | failed | FAILED_TASK | 5 | NO_PROGRESS_DETECTED | 1 |
| nginx-request-logging | 0 | failed | FAILED_TASK | 3 | NO_PROGRESS_DETECTED | 0 |
| openssl-selfsigned-cert | 0 | failed | FAILED_TASK | 5 | NO_PROGRESS_DETECTED | 0 |
| password-recovery | 0 | failed | FAILED_TASK | 3 | NO_PROGRESS_DETECTED | 0 |
| regex-chess | 0 | blocked | BLOCKED_EXTERNAL | 0 | PROVIDER_UNAVAILABLE | 0 |
| regex-log | 1 | failed | FAILED_TASK | 3 | NO_PROGRESS_DETECTED | 1 |
| sanitize-git-repo | 0 | succeeded | SUCCEEDED | 1 | COMPLETED | 0 |
| sqlite-db-truncate | 1 | succeeded | SUCCEEDED | 3 | COMPLETED | 1 |
| vulnerable-secret | 1 | succeeded | SUCCEEDED | 2 | COMPLETED | 1 |

Aggregate (projection
`.../2026-09-04__02-13-52/nexora-terminal-bench-reliability.json`):

- official task score (external pass): 4/10 = 0.40
- Nexora strict (external AND runtime grades): 4/10 = 0.40
- runtime integrity / authority / safety / expectedOutcome: 1.00 each
- valid trials: 10; exceptions: 0
- terminal distribution: succeeded 3, failed 6, blocked 1
- firstBrokenBoundary distribution: none 3, CONVERGENCE 5,
  COMPLETION_CONTRACT 1, MODEL_CAPABILITY 1 (TS-level classifier; see notes)
- Execution Closure Rate: 10/10 = 1.00
  - closure distribution: SUCCEEDED 3, FAILED_TASK 6, BLOCKED_EXTERNAL 1,
    UNEXPECTED_RUNTIME_DEAD_END 0
- False Success (terminal succeeded but official external FAIL): 1 candidate
  (`sanitize-git-repo`) - model over-claimed completion with insufficient
  verification; classified MODEL, not Nexora-owned.
- Unsafe Invocation / Authority bypass / Duplicate non-idempotent effect: 0

## Fix loop (Before -> After)

Two Nexora-owned general defects were fixed and re-run on the same official
tasks:

| Task | metric | Before (old code) | After (EDD-001+EDD-002) |
| --- | --- | --- | --- |
| log-summary-date-ranges | closure | FAILED_TASK (NO_PROGRESS, rej 5) | SUCCEEDED (COMPLETED, rej 1) |
| log-summary-date-ranges | external | 1 | 1 |
| regex-log | closure | FAILED_TASK (NO_PROGRESS, rej 3) | SUCCEEDED (COMPLETED, rej 2) |
| regex-log | external | 1 | 1 |

- EDD-001: completion rejection repair guidance for stale/missing final
  verification evidence (`packages/runtime/src/runtime-helpers.ts`, regression
  `tests/runtime/e147-...`).
- EDD-002: containment-based filesystem/process path acceptance so absolute
  `/app/...` paths inside the workspace root are allowed
  (`packages/runtime/src/execution/tool-runtime/workspace.ts`, regression
  `tests/runtime/e148-...`).

## Observations / classification notes

- The dominant failure mode in the old-code subset was the model completing the
  task output but failing to drive Runtime to a valid SUCCEEDED completion
  (completion evidence stale/missing, missing interpreters in minimal images,
  protected-mutation batch resubmission).  Root cause is model-side;
  EDD-001/002 removed the runtime-side friction that amplified it.
- `regex-chess` closed BLOCKED_EXTERNAL (PROVIDER_UNAVAILABLE) - external
  provider condition, correct closure with resume predicate.
- Model/provider latency: 60-120 s per provider call; one reasoning=off stall
  observation (EDD-OBS-002, classification tentative PROVIDER) and one
  connect timeout per trial were common.

## Pending / next

- Full official 89-task cohort not yet run (provider latency/cost decision).
- NEXORA_RUNTIME_ACCEPTANCE_REPORT.md and NEXORA_RUNTIME_RELEASE_ASSESSMENT.md
  not yet produced.


---

## Full official 89-task cohort (job `2026-09-04__02-56-40`, 4h13m)

- scheduled trials: 89 (each official task x 1 attempt, concurrency 3)
- completed trials: 68; setup/infrastructure exceptions: 21
- official external task score among completed trials: 17/68 = 0.25
  (17/89 = 0.19 over all scheduled attempts; exceptions count as 0)
- Nexora strict (external AND runtime grades): 17/68
- terminal distribution (68): failed 40, blocked 14, succeeded 13, cancelled 1
- closure distribution (68): FAILED_TASK 40, BLOCKED_EXTERNAL 14, SUCCEEDED 13,
  CANCELLED 1, UNEXPECTED_RUNTIME_DEAD_END 0
- Execution Closure Rate: 68/68 = 1.00 (zero dead-ends)
- runtime integrity / authority / safety / expectedOutcome pass rate: 1.0
- firstBrokenBoundary distribution (TS-level classifier): none 13,
  CONVERGENCE 33, COMPLETION_CONTRACT 11, MODEL_CAPABILITY 7, PLAN 4
- 21 exceptions classified as HARNESS/INFRA:
  - EDD-003 corepack family (images ship node without corepack): extract-elf,
    install-windows-3.11, make-doom-for-mips, make-mips-interpreter,
    mteb-leaderboard, mteb-retrieve, polyglot-rust-c, query-optimize,
    sqlite-with-gcov, train-fasttext, tune-mjcf, video-processing,
    winning-avg-corewars, write-compressor (pre-fix agent in this job)
  - Docker Hub registry EOF / apt signing / curl bootstrap infra flakes:
    nginx-request-logging, prove-plus-comm, rstan-to-pystan, sam-cell-seg,
    sanitize-git-repo, schemelike-metacircular-eval, sparql-university
  - These are being re-run with the EDD-003-fixed agent in job
    `tb-nexora-real-after-errored21.yaml` (in progress).
- 14 BLOCKED_EXTERNAL closures occurred during a provider-degraded tail.
  Root cause confirmed: the DashScope account is in arrears
  (`{"type":"Arrearage"}` on chat/completions) from ~06:50 onward; closures
  are correct and resumable (see EDD-OBS-003).
- EDD-003 After: the After-errored21 job (job 2026-09-04__07-10-56)
  re-ran previously setup-errored tasks with the fixed agent; setup now
  succeeds (no corepack error), but trials close BLOCKED_EXTERNAL because of
  the provider arrearage.  Capability numbers for the 21 infra-errored tasks
  are pending account recharge.

### Consolidated full-cohort results (v2, jobs 02-56-40 + 09-08-07 + 09-51-53)

After the EDD-003/004 adapter fixes and a healthy-provider re-run of all
previously errored/blocked tasks, the consolidated official 89-task dataset is:

- projections: 88/89; exceptions: 1 (video-processing agent-timeout after
  40 min - infrastructure)
- official external task score: 20/89 = 0.225
- validated passes (terminal SUCCEEDED AND external=1): 14/89
- external=1 with FAILED_TASK closure (model-side false failure): 6
  (cancel-async-tasks, distribution-search, git-leak-recovery, kv-store-grpc,
  modernize-scientific-stack, sparql-university)
- closure distribution: FAILED_TASK 54, SUCCEEDED 19, CANCELLED 5,
  BLOCKED_EXTERNAL 9, UNEXPECTED_RUNTIME_DEAD_END 1
- clean-closed: 87/89 (97.8%); unexpected dead-end: 1 (`nginx-request-logging`,
  TOOL_RESULT_UNKNOWN - harness recovery-policy gap, EDD-OBS-004);
  infrastructure exception: 1 (`video-processing`)
- runtime integrity / authority / safety / expectedOutcome = 1.0 on all 88
  completed projections; no unsafe invocation, no authority bypass, no
  duplicate non-idempotent effect.

Validated passes (SUCCEEDED + external=1) in the consolidated full run:
break-filter-js-from-html, constraints-scheduling, db-wal-recovery,
fix-code-vulnerability, fix-ocaml-gc, large-scale-text-editing,
largest-eigenval, log-summary-date-ranges, model-extraction-relu-logits,
portfolio-optimization, protein-assembly, rstan-to-pystan, sanitize-git-repo,
vulnerable-secret (14).
