# Nexora Evaluation

Nexora evaluation uses **Harbor 0.22.0** for task and dataset packaging, isolated
Docker environments, trial/job execution, repeated attempts, concurrency,
external verification, generic rewards, logs, artifacts and result management.
Nexora does not fork or patch Harbor.

Nexora owns only the Runtime-specific layer:

- `harbor/nexora_harbor/agent.py`: Harbor → Nexora Runtime adapter;
- `src/runner.ts#runHarborRuntimeTrial`: Runtime execution and durable fact export;
- `harbor/nexora_harbor/verifier.py`: external-result + Runtime-grade composition;
- existing Runtime Integrity, Authority, Safety, ExpectedOutcome and
  `firstBrokenBoundary` graders;
- `src/fault-lab.mjs`: durable-boundary fault injection;
- `harbor/nexora_harbor/projection.py`: Nexora reliability metrics projected from
  Harbor job results.

The former TypeScript batch/repeat entry points are not production evaluation
paths. Harbor job configuration is the execution authority.

## Prerequisites

- Docker Desktop with Linux containers;
- Python 3.12+ and `uv`;
- Node.js 20+ and pnpm 11.7.0 for repository tests.

Harbor is pinned in `harbor/pyproject.toml` and `harbor/uv.lock`. The task image
contains a native-build fallback for `better-sqlite3`, so a transient prebuilt
binary download failure does not make setup non-deterministic.

## Capability evaluation

From the repository root in PowerShell:

```powershell
pnpm --filter @nexora/bench eval
```

This loads the local Harbor Dataset at
`harbor/datasets/nexora-capability-v1` and runs every `cap-*` task once. Each
Harbor trial seeds its own fixture into `/app`; the adapter resolves the trial's
Nexora scenario from Harbor's native session id (`scenario_id: auto`) against
`datasets/nexora-core-v1/capability-cohort-all.json`, so a trial always runs its
own plan, checks and budgets rather than a shared hardcoded scenario. Nexora
Runtime operates directly on that Harbor workspace; it does not create a second
task workspace. The hidden Harbor verifier independently checks the requested
files.

Every completed trial exposes these rewards together:

```text
reward                  # final STRICT_PASS
external_result         # Harbor external outcome verifier
runtime_integrity       # Nexora Runtime Integrity
authority               # Nexora Plan / State / Invocation authority
safety                  # approval, effects, idempotency and fencing safety
expected_outcome        # Nexora ExpectedOutcome semantics
nexora_strict_pass      # conjunction of Nexora-specific grades
```

Raw Runtime facts are collected as
`artifacts/logs/artifacts/nexora-runtime-fact-bundle.json`. The verifier writes
`verifier/nexora-projection.json`. Harbor writes the canonical trial and job
`result.json`, logs and artifact manifest under `harbor/jobs-output/`.

## Reliability

Harbor owns repeat and concurrency orchestration:

```powershell
pnpm --filter @nexora/bench reliability
```

`harbor/jobs/reliability-3.yaml` uses `n_attempts: 3` and
`n_concurrent_trials: 3`. Do not add a Nexora repeat loop.

Project a completed Harbor job into the allowed Nexora-specific metrics:

```powershell
Set-Location -LiteralPath "harness/nexora-bench/harbor"
uv run nexora-harbor-project "jobs-output/<job-directory>" `
  --output "jobs-output/<job-directory>/nexora-reliability.json"
```

The projection contains empirical strict pass rate, observed All-3/All-5 when
enough attempts exist, terminal distribution, first-broken-boundary distribution
and component pass rates. It does not schedule or retry trials.

## Runtime-specific Fault Lab

Fault injection remains Nexora-owned because prepared effects, unknown side
effects, crash prefixes, recovery, Lease/Fencing and durable authority cannot be
faithfully reduced to ordinary outcome tasks:

```powershell
pnpm --filter @nexora/bench fault-lab
```

Harbor may wrap this in an environment in the future, but Harbor is not the
authority for the injected durable boundary or its invariant grade.

## Validation

```powershell
pnpm --filter @nexora/bench test
pnpm --filter @nexora/bench typecheck
Set-Location -LiteralPath "harness/nexora-bench/harbor"
uv run python -m unittest discover -s tests -v
```

For a real Provider cohort, set the existing `NEXORA_MODEL_*` variables through
Harbor agent environment configuration and change `provider_mode` to `real` in a
separate job configuration. Deterministic and real-provider cohorts must remain
separate.

The Harbor job configuration and this guide define the normative evaluation boundary.
