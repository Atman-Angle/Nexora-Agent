# NexoraBench

NexoraBench is an external, native TypeScript evaluation harness for Nexora Runtime. It does not modify or bypass Runtime production code.

The harness runs versioned, reproducible tasks through the public Runtime API, checks the final workspace with independent deterministic graders, audits persisted Run authority, exports OpenTelemetry traces, and produces a bounded Codex optimization packet for failed runs.

It is also a private workspace component: `@nexora/bench` exports the existing Dataset loader, Runner, and Telemetry boundary for CI or host composition. The CLI calls the same Runner; there is no second execution path, plugin system, or alternate Runtime authority.

## What It Measures

Each task receives two independent grades:

- **Task grade:** file state, hidden command/test results, and unchanged-path checks performed outside the Runtime.
- **Authority grade:** expected terminal state, approval ordering, non-idempotent effect uniqueness, Invocation/Evidence integrity, Result citation integrity, and false-success detection.

The included `nexora-core-v1` Dataset v11 contains sixteen tasks:

- `NB-CODE-001`: multi-stage search/read/patch/test code repair;
- `NB-CONVERGE-001`: failure-driven replanning and semantic convergence across configuration repair and verification;
- `NB-LONG-001`: long sequence with three fact reads, approval-time process restart, mutation, and validation;
- `NB-SAFETY-001`: denied protected mutation that must remain unchanged and wait for revised input.
- `NB-BATCH-001`: one Provider Decision starts three independent delayed reads, then writes and validates an ordered aggregate after the batch barrier;
- `NB-RETRY-001`: an idempotent read receives one transient 503, retries under the same logical Invocation, then writes and validates the recovered value;
- `NB-CANCEL-001`: a Host cancels a later slow read while the Runtime preserves Evidence from an earlier confirmed read;
- `NB-RECOVERY-001`: a non-idempotent Effect becomes unknown, the Runtime restarts, and explicit recovery abandons the Run without replaying the Effect;
- `NB-ARTIFACT-001`: a long Tool payload is persisted through Artifact-backed authority;
- `NB-EXTENDED-001`: 24 independent reads survive multiple reopens before verified aggregation;
- `NB-BATCH-CANCEL-001`: cancellation preserves completed siblings and prevents unfinished batch work;
- `HB-WORLD-001`: pinned Harbor file-creation task;
- `HB-MULTI-001`: pinned Harbor multi-step state-continuity task;
- `HB-WORKDIR-001`: pinned Harbor working-directory task with a cross-platform verifier;
- `QB-GCD-001`: pinned QuixBugs Python `gcd` repair;
- `QB-MAXSUM-001`: pinned QuixBugs Python `max_sublist_sum` repair.

Scenario providers are deterministic so Runtime safety, persistence, Tools, Approval, Evidence, recovery, and Completion are reproducible. `--provider real` replaces only the Scenario Provider with Nexora's production OpenAI-compatible Provider; the fixture, tools, approvals, graders, and Authority checks remain unchanged.

Durable crash-prefix coverage remains in Runtime tests (`e110` through `e113`): prepared-before-effect, partial batch result, interrupted attempt, multiple unknown Invocations, cancellation reconciliation, and snapshot/watch handoff. The Dataset adds representative end-to-end cancellation and unknown-recovery scenarios, while exhaustive crash prefixes remain deterministic Runtime protocol tests rather than model-quality tasks.

The Harbor tasks are adapted from a pinned Apache-2.0 commit. The QuixBugs tasks retain pinned MIT-licensed buggy programs and test vectors and follow Harbor's parity-validated QuixBugs adapter design. See `THIRD_PARTY_NOTICES.md` and each task's `UPSTREAM.md`. These smoke subsets are not official Harbor or QuixBugs leaderboard scores.

## Run

From the repository root in PowerShell:

```powershell
pnpm --filter @nexora/bench test
pnpm --filter @nexora/bench typecheck
pnpm --filter @nexora/bench bench
```

Run a task or split:

```powershell
pnpm --filter @nexora/bench bench -- --task NB-CODE-001
pnpm --filter @nexora/bench bench -- --split dev
```

Run the same Dataset with the real Provider configured in the repository root `.env`:

```powershell
pnpm --filter @nexora/bench bench:real
pnpm --filter @nexora/bench bench:real -- --task QB-GCD-001 --keep-workspaces
```

`--keep-workspaces` preserves both final task files under `workspaces/<task-id>/` and the inspectable Runtime Store under `run-data/<task-id>/`. Reports label every task and trace with `providerMode`; deterministic and real-provider rates must not be combined.

Reports are written under `harness/nexora-bench/reports/<timestamp>/`:

```text
report.json
failures.jsonl
telemetry.jsonl
optimization-packet.json
codex-result.schema.json
codex-prompt.md
workspaces/          # only with --keep-workspaces
run-data/            # only with --keep-workspaces
```

## Langfuse

Local metadata-only `telemetry.jsonl` is always produced. Copy `.env.example` to `.env` inside this harness and configure both keys to additionally export the OpenTelemetry trace tree to Langfuse. The `bench`, `bench:dev`, and `optimize` commands load this file automatically:

```powershell
Copy-Item -LiteralPath "harness/nexora-bench/.env.example" -Destination "harness/nexora-bench/.env"
# Edit harness/nexora-bench/.env with the project keys, then run:
pnpm --filter @nexora/bench bench
```

The repository ignores `.env`, so local API keys are never part of the benchmark Dataset or committed source. Existing shell environment variables take precedence over values in `.env`.

For a self-hosted instance, set `LANGFUSE_BASE_URL` to its root URL. The adapter sends OTLP HTTP traces to `/api/public/otel/v1/traces` with ingestion version 4.

Langfuse observations include the root task input/output, model decision input/output, and Tool input/output so failures can be reconstructed. Every observation is recursively redacted and bounded to 16 KiB: secret-like keys and values are removed, Windows user names are replaced, strings/arrays/object depth are capped, and oversized observations become excerpts. Environment variables, credentials, raw Artifact blobs and unsanitized event payloads are never exported.

The benchmark propagates its trace name, tags, Dataset metadata, and `development` environment to every observation so Langfuse filters and dashboards remain accurate. Model calls are `generation` observations and Tool Invocations are `tool` observations. The provider is shut down before the CLI exits, which flushes queued spans.

Task reports and local `telemetry.jsonl` remain metadata-only. Their failure diagnostics include Run error code, stop reason, failed Tool/model error codes, and Action rejection counts. Prompt strategy reports add kernel/compiler/Profile/Host/Project/Tool/Transport provenance, stable-prefix digest/tokens, per-Attempt cache status and eligible/cached/write tokens. `unsupported`, `disabled`, and `unknown` remain visible in the distribution but are excluded from the cached-input ratio. These fields feed the optimization packet without copying Prompt, Provider output, or Tool payloads into the report.

Langfuse remains an optional observation backend. Export failure cannot change a Nexora Run, Evidence, Result, or grader outcome.

## Codex Optimization Loop

When a run fails, `optimization-packet.json` groups failures by the first broken boundary and includes authority references and reproduction commands. Invoke Codex from an isolated branch or CI workspace:

```powershell
$report = Get-ChildItem -LiteralPath "harness/nexora-bench/reports" -Recurse -Filter "optimization-packet.json" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$schema = Join-Path -Path $report.DirectoryName -ChildPath "codex-result.schema.json"
$prompt = Get-Content -LiteralPath (Join-Path -Path $report.DirectoryName -ChildPath "codex-prompt.md") -Raw

codex exec `
  --sandbox workspace-write `
  --output-schema $schema `
  -o (Join-Path -Path $report.DirectoryName -ChildPath "codex-result.json") `
  $prompt
```

The loop must remain bounded: one failure cluster per iteration, no Dataset/grader edits, no task-specific Runtime branches, maximum five iterations, and stop after the same root cause fails three times. Public Contract, Authority, security-boundary, destructive-migration, or heavyweight-dependency changes require human review.

The harness can enforce this loop directly. It is opt-in because it edits the current workspace:

```powershell
pnpm --filter @nexora/bench optimize -- `
  --packet "harness/nexora-bench/reports/<run>/optimization-packet.json" `
  --max-iterations 5 `
  --confirm
```

After each Codex iteration, the harness reruns the affected task reproductions and records the result in `optimization-history.jsonl`. It stops on success, after five iterations, when Codex reports a blocker, or when the same root cause repeats three times. Run this command only on an isolated branch or disposable CI workspace.

## Adding Tasks

1. Add an immutable fixture, `task.json`, and `scenario.ts` under the Dataset task directory.
2. Compute the fixture digest with `directoryDigest()` and lock it in `task.json`.
3. Prefer deterministic external graders and keep oracle information out of the Agent context.
4. Add the task path to the Dataset manifest, which changes the Dataset digest.
5. Run the task at least three times with a real Provider before using it for quality claims.

The repository Dataset manifest and fixtures are the benchmark source of truth. Langfuse Datasets and scores may mirror them for analysis, but cannot replace their version or digest.
