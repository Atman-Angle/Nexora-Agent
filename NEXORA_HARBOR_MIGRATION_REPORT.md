# Nexora Harbor Migration Report

Final status: **HARBOR_ADOPTED**

Date: 2026-09-03  
Harbor repository: <https://github.com/laude-institute/harbor>  
Audited upstream commit: `106d19109903b45a1c9467e340765496176628ae`  
Pinned package: `harbor==0.22.0`

## Outcome

Nexora's production evaluation entry points now use Harbor for generic Agent
Evaluation Infrastructure and retain Nexora code only for Runtime-specific
execution, facts, invariant grading, Fault Lab and result projection.

Harbor ran the migrated `cap-data-ordered-report` V2 Capability Task inside a
Docker environment. Nexora Runtime operated directly on Harbor's `/app`
workspace. Harbor's hidden external verifier and Nexora's independent Runtime
grades were emitted in the same trial. A separate Harbor job ran three concurrent
attempts successfully. The Runtime-specific Fault Lab remained intact and passed.

No Harbor source was forked or modified. Official custom Agent and Verifier import
paths, local Dataset/Task contracts, job attempts/concurrency, artifact collection
and result records covered the required integration.

## Migration inventory

| Existing capability | Classification | Final owner/path |
| --- | --- | --- |
| Task and Dataset packaging | MIGRATE_TO_HARBOR | `harbor/datasets/nexora-capability-v1` |
| Fixture injection and isolated workspace | MIGRATE_TO_HARBOR | Harbor task environment and Docker lifecycle |
| Batch/trial/job execution | MIGRATE_TO_HARBOR | Harbor job configs |
| Repeated attempts and concurrency | MIGRATE_TO_HARBOR | Harbor `n_attempts` / `n_concurrent_trials` |
| Generic external verifier lifecycle | MIGRATE_TO_HARBOR | Harbor verifier plus task `tests/test.sh` |
| Generic rewards, logs, artifacts and results | MIGRATE_TO_HARBOR | Harbor trial/job records |
| Harbor → Nexora bridge | ADAPT | `harbor/nexora_harbor/agent.py` |
| Public instruction handoff | ADAPT | Harbor instruction injected into `runHarborRuntimeTrial`; legacy profile text is not authoritative |
| Runtime execution and control driving | KEEP_NEXORA | `runHarborRuntimeTrial` and existing Runtime APIs |
| Runtime fact/bundle export | KEEP_NEXORA | `nexora-runtime-fact-bundle.json` |
| Runtime Integrity Grader | KEEP_NEXORA | existing `suite-grader.ts` logic |
| Authority Grader | KEEP_NEXORA | existing persisted-fact grading |
| Safety Grader | KEEP_NEXORA | existing approval/effect/idempotency/fencing checks |
| ExpectedOutcome | KEEP_NEXORA | existing accepted-terminal/stop/confirmation semantics |
| STRICT_PASS composition | ADAPT | Harbor external result AND all Nexora-specific grades |
| firstBrokenBoundary | KEEP_NEXORA | exported from the Runtime task report and aggregated by projection |
| Reliability metrics | ADAPT | read-only projection from Harbor results |
| Runtime-specific Fault Lab | KEEP_NEXORA | `src/fault-lab.mjs` |
| TypeScript repeat orchestrator | REMOVE | `src/reliability-eval.mjs` deleted |
| `bench`, `bench:dev`, `bench:real`, `reliability:real` production scripts | REMOVE | replaced by `eval` and `reliability` Harbor entry points |
| Legacy V1/V2 batch runner | DEPRECATE | retained only for compatibility tests and non-migrated Runtime profiles; not a production evaluation entry point |
| Legacy task instruction field for migrated profiles | DEPRECATE | overridden by the Harbor Task instruction |
| Langfuse-specific generic experiment authority | DEPRECATE | telemetry may observe Runtime; Harbor result records are canonical |

The existing task metadata is still used where it expresses Nexora-only Runtime
budgets, scenario controls, ExpectedOutcome and sealed grading policy. It is not
used to create Harbor environments, schedule attempts, run repeats, or own the
external task result.

## Implemented architecture

```text
Harbor Dataset / Task
        |
        v
Harbor Docker environment (/app)
        |
        v
NexoraRuntimeAgent -> runHarborRuntimeTrial -> Nexora Runtime Store
        |                                      |
        |                                      v
        |                         Runtime fact bundle + telemetry
        v
Harbor hidden external verifier -----> NexoraRuntimeVerifier
                                      |
                                      v
      external_result + Runtime Integrity + Authority + Safety
      + ExpectedOutcome + STRICT_PASS in Harbor TrialResult
                                      |
                                      v
                 Harbor JobResult -> Nexora metrics projection
```

The adapter no longer creates a second task workspace or copies a pre-evaluated
workspace back into Harbor. This was explicitly parity-tested during migration;
the final path runs Runtime directly against the Harbor-owned workspace.

## Capability and grading evidence

Smoke job `4a85b3dd-5ffc-41e1-909b-56ea861b8272`, trial
`6a6e4e27-3a90-4bfc-a0e9-bbfd174b2331` completed with:

| Reward | Value |
| --- | ---: |
| final `reward` / STRICT_PASS | 1 |
| `external_result` | 1 |
| `runtime_integrity` | 1 |
| `authority` | 1 |
| `safety` | 1 |
| `expected_outcome` | 1 |
| `nexora_strict_pass` | 1 |

The external verifier checked the exact ordered aggregate and preserved source
facts. Nexora grades were derived from persisted Run/Plan/Event/Invocation/
Attempt/Evidence/Result facts. They do not consume model self-description.

## Reliability evidence

Harbor job `3239b326-eda0-45b8-a2f5-48223cd25e50` used three native attempts
with concurrency three for the migrated `cap-data-ordered-report` task:

- completed trials: 3;
- exceptions: 0;
- empirical strict pass rate: 1.0;
- observed All-3: true;
- observed All-5: unavailable because only three attempts were requested;
- terminal distribution: `succeeded=3`;
- firstBrokenBoundary distribution: `none=3`;
- every component mean: 1.0.

Nexora's projection reads Harbor trial results after completion. It contains no
repeat, retry or scheduling logic.

## Scenario mapping correction

The first aggregate smoke/reliability job configurations hardcoded
`scenario_id: cap-data-ordered-report` for every trial in the Dataset. Harbor
therefore ran ten trials whose external instructions and fixtures came from ten
different tasks, while Nexora Runtime executed the same ordered-report scenario
(plan, steps, checks) each time. Trial directories and result files showed the
mismatch directly, e.g. `task_name=cap-artifact-incident-handoff` next to
`scenario_id=cap-data-ordered-report`. Those aggregate runs are superseded and
must not be used as acceptance evidence.

The adapter now resolves the scenario from Harbor's own trial identity:
Harbor assigns each agent a session id of the form
`<task-id>__<trial-id>__agent`, and the Nexora capability task ids in the Harbor
Dataset match the Nexora scenario ids, so `scenario_id: auto` derives the
correct scenario per trial (`harbor/nexora_harbor/agent.py`,
`_resolve_scenario_id`). The aggregate jobs now point at a single manifest that
actually contains all ten tasks
(`datasets/nexora-core-v1/capability-cohort-all.json`) instead of the
three-task pilot manifest. An explicit `scenario_id` remains available as an
override for jobs that need it.

The corrected smoke/reliability jobs are ready and unit-tested (7/7 Harbor
Python tests, including auto-resolution regression coverage). The definitive
aggregate re-run is pending the Docker engine being started on the host; until
that run completes, the single-task smoke and three-attempt evidence above
remains the verified acceptance evidence.

## Fault Lab and validation

- Runtime Fault Lab: 28/28 cases passed, 0 failures;
- Nexora bench tests: 23/23 passed;
- Runtime verification-replay regression (`tests/runtime/e146-verification-replay.test.ts`): passed;
- Nexora bench TypeScript typecheck: passed;
- Harbor adapter/projection Python tests: 7/7 passed, including missing-bundle
  failure retention;
- `git diff --check`: passed.

The repository-wide `pnpm typecheck` is not green: it reports existing contract
drift in unrelated canary, desktop and Runtime test files outside this migration
(for example `tests/desktop/ui-projection.test.ts` and
`tests/runtime/e142-hybrid-decision-context.test.ts`). The scoped
`@nexora/bench` typecheck is green; this migration did not modify those failing
tests or widen scope to repair them.

Machine-readable evidence is recorded in
`docs/evidence/NEXORA_HARBOR_ACCEPTANCE.json`. Harbor's complete local job records
remain under the ignored `harness/nexora-bench/harbor/jobs-output/` directory.

## Running the migrated suite

Prerequisites are Docker Desktop (Linux containers), Python 3.12+, `uv`, Node.js
20+ and pnpm 11.7.0.

From the repository root in PowerShell:

```powershell
# One attempt over the Harbor Dataset
pnpm --filter @nexora/bench eval

# Three Harbor-owned attempts, up to three concurrently
pnpm --filter @nexora/bench reliability

# Project a completed Harbor job into Nexora metrics
Set-Location -LiteralPath "harness/nexora-bench/harbor"
uv run nexora-harbor-project "jobs-output/<job-directory>" `
  --output "jobs-output/<job-directory>/nexora-reliability.json"

# Runtime durable-boundary faults
Set-Location -LiteralPath "D:\Nexora-1.1"
pnpm --filter @nexora/bench fault-lab

# Static/unit checks
pnpm --filter @nexora/bench test
pnpm --filter @nexora/bench typecheck
Set-Location -LiteralPath "harness/nexora-bench/harbor"
uv run python -m unittest discover -s tests -v
```

Harbor generates a new job name when none is specified in the config. For real
Provider evaluation, use a separate job config with `provider_mode: real` and
pass the existing `NEXORA_MODEL_*` environment values through the Harbor Agent
configuration. Never combine deterministic and real-provider cohorts.

## Residual scope

Only one representative V2 Capability Task was required for adoption acceptance
and has been migrated. Additional legacy tasks should be converted incrementally
to Harbor Tasks when admitted into active release cohorts. They must not revive
the removed TypeScript repeat/job path. Historical benchmark reports remain
evidence, not an execution authority.

A separate Plan-Control hardening change to
`packages/runtime/src/execution/runtime-execution.ts` and the `execute_step`
batch preflight in `packages/runtime/src/runtime.ts` (verification replay for a
duplicate `execute` whose durable result is required by the active Step) is
tracked in `NEXORA_PLAN_CONTROL_HARDENING_REPORT.md`; regression and paired
real re-runs are complete (focused `cap-env-coherent-mapping` Before 1/3 ->
After 3/3; full ten-task real After cohort 28/30 strict).

## Aggregate acceptance (corrected scenario mapping)

After the `scenario_id: auto` fix, Harbor jobs ran the full ten-task Dataset:

- deterministic smoke `2026-09-03__23-41-06`: 10/10 trials, 0 exceptions, all
  component means 1.0, task==scenario for every trial;
- deterministic reliability `2026-09-03__23-50-14`: 30/30 trials
  (10 tasks x 3 native attempts), 0 exceptions, 30/30 strict, observed All-3
  true, firstBrokenBoundary `none=30`, task==scenario for every trial;
- real provider After (frozen cohort, qwen3.8-flash): 10 jobs x 3 attempts,
  28/30 strict, 29/30 external, 0 false success / unsafe invocation
  (`docs/evidence/NEXORA_REAL_PROVIDER_HARDENING_AFTER_V1.json`).

The Docker image currently permits public network during setup because pnpm
dependencies are installed from the registry. Evaluation tools themselves remain
bounded to the Harbor workspace. A prebuilt, digest-pinned Nexora evaluation image
may later remove setup network access without changing this ownership model.
