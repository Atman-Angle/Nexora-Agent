# Nexora EDD Log — Evaluation-Driven Development

每个修复记录：

```text
EDD-NNN
- source failure
- affected tasks
- first broken boundary
- classification
- root cause
- general failure class
- fix
- regression
- Before
- After
- invariant impact
```

Observation entries (no code change, classification only) are recorded as
`EDD-OBS-NNN` so the log preserves the evidence trail without pretending an
observation is a fix.

---

## EDD-OBS-001 — Open Terminal-Bench trial qualification (regex-log, qwen3.8-flash)

- source failure: official Terminal-Bench task `regex-log` did not pass; the
  Runtime closed the run with `failed` / `NO_PROGRESS_DETECTED` after bounded
  convergence.
- affected tasks: regex-log (representative of minimal Terminal-Bench images).
- first broken boundary: MODEL (repeated invalid protected-mutation batch;
  attempted `python3` which is absent from the minimal task image).
- classification: MODEL / ENVIRONMENT, not a Nexora Runtime defect.
- root cause:
  1. Model submitted two protected mutations in one Provider turn; Runtime
     correctly rejected the whole batch
     (`PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME`), then the model
     resubmitted the identical batch and converged to NO_PROGRESS.
  2. Model attempted `python3 -c ...` verification; the regex-log image has no
     python3 (official verifier installs it only in the verifier phase).
- general failure class: open-ended terminal agents require (a) single-mutation
  submission per turn and (b) environment introspection before invoking
  interpreters. Both are model-side capabilities.
- fix: none (not Nexora-owned).
- regression: none required.
- Before: no official Terminal-Bench trial through Nexora existed.
- After: first real Terminal-Bench trial executed end-to-end through the open
  adapter; Runtime executed correctly (plan set, per-turn approvals granted,
  no false success, no unsafe invocation) and closed with an explicit reason.
- invariant impact: none (Runtime invariants held; suite grades all passed).

Evidence: `harness/nexora-bench/harbor/jobs-output/2026-09-04__01-37-01`
(runtime event DB: run.failed NO_PROGRESS_DETECTED, 2 response.rejected,
5 tool invocations, approvals granted singly).

---

## EDD-OBS-002 — Provider latency / reasoning-off stall (DashScope qwen3.8-flash)

- source failure: with `NEXORA_MODEL_REASONING=off`, a real open trial did not
  make progress for >13 minutes in Docker and exceeded a 120 s run budget on
  the host without terminating (the budget is only enforced between Provider
  turns, so a single stuck Provider attempt can exceed it).
- first broken boundary: PROVIDER (single attempt never resolved within the
  observed window; no idle-timeout event observed).
- classification: PROVIDER (tentative; requires a controlled reproduction to
  confirm whether the client idle timeout is correctly enforced when a stream
  emits sparse frames).
- root cause: not yet confirmed.  DashScope responds in ~1 s to plain and
  tool-call streaming probes from the same container, so the stall is specific
  to the large native-tools decision request, not connectivity.
- general failure class: provider attempt duration / stream idle behavior.
- fix: none yet (not confirmed Nexora-owned).
- regression: none.
- Before: real runs used the default `.env` (reasoning dynamic); each Provider
  attempt took ~60-120 s and the run closed on budget.
- After: (open) — observation only.
- invariant impact: none observed.


---

## EDD-001 — Completion rejection repair guidance for stale/missing final verification evidence

- source failure: official Terminal-Bench trial `log-summary-date-ranges`:
  the model completed the task (official external verifier PASS = 1) but the
  Runtime closed the run as `failed` / `NO_PROGRESS_DETECTED` (closure
  FAILED_TASK) after 5 rejected completions.  The Completion Gate repeatedly
  rejected with `CHECK_EVIDENCE_STALE` because the model's verification
  Evidence predated its last write, and the rejection recovery text only said
  the generic "Correct the request using the rejection details", which the
  model could not act on.  The model then tried illegal scope-changing Plan
  revisions (`TASK_SCOPE_REVISION_REQUIRES_NEW_USER_INPUT`) and unchanged
  Plans (`PLAN_UNCHANGED`) before convergence stopped it.
- affected tasks: log-summary-date-ranges (observed); general failure class
  applies to any open/capability task where a write lands after verification.
- first broken boundary: HARNESS/RUNTIME repair guidance (rejection recovery
  `nextAction` was not actionable for the verification-evidence family).
- classification: RUNTIME repair guidance (P2, evidence-backed and frequent)
  compounded by MODEL non-compliance; the Completion Gate itself is correct
  and unchanged.
- root cause: `stateRejectionRecovery` in
  `packages/runtime/src/runtime-helpers.ts` had targeted guidance for tool
  duplicates, protected mutation batches and mutation-verification ordering,
  but completion-gate rejections fell through to the generic fallback, so the
  model was never told that a fresh verification Tool run after the last write
  is the legal continuation path.
- general failure class: completion rejection without an actionable recovery
  instruction for stale/missing final-step verification evidence.
- fix: `packages/runtime/src/runtime-helpers.ts` now returns targeted
  recovery guidance when the completion message names `CHECK_EVIDENCE_STALE`,
  `STEP_VERIFICATION_REQUIRED` or `UNPLANNED_MUTATION_UNVERIFIED` ("Run the
  verification Tool now so a fresh Tool Result is persisted after the last
  mutation ..."), and completion-specific guidance for any other
  "Completion is not valid:" rejection.  The Completion Gate, approval
  boundary and authority invariants are untouched; only the model-visible
  repair message changed.
- regression: `tests/runtime/e147-completion-rejection-guidance.test.ts`
  (5 assertions) covers stale-verification, verification-role, preserved
  targeted guidance, generic completion guidance and the unchanged fallback.
  Existing runtime suites e049/e109/e120/e129/e146 all pass (59 tests).
- Before: 1/1 observed affected trial closed FAILED_TASK with external PASS
  (false failure); model never produced a fresh verification Evidence.
- After: clean After job `2026-09-04__02-39-33` (same tasks, qwen3.8-flash,
  EDD-001+EDD-002 code):
  - log-summary-date-ranges: external=1, terminal=succeeded, closure=SUCCEEDED,
    stopReason=COMPLETED, responseRejectedCount 1, boundary null (Before:
    external=1 but closure FAILED_TASK / NO_PROGRESS_DETECTED, rej 5).
  - regex-log: external=1, terminal=succeeded, closure=SUCCEEDED,
    stopReason=COMPLETED, responseRejectedCount 2, boundary null (Before:
    closure FAILED_TASK / NO_PROGRESS_DETECTED, rej 3).
- invariant impact: none.  Recovery `nextAction` content only; no gate,
  authority, idempotency, or safety relaxation.


---

## EDD-002 — Accept workspace-inside absolute paths in filesystem/process Tools

- source failure: official Terminal-Bench trials repeatedly hit
  `PATH_ESCAPE` / "Only non-empty workspace-relative paths are allowed" when
  the model followed Terminal-Bench instructions that name files with the
  absolute workspace root (for example `/app/regex.txt` or `/app/solution.txt`).
  Observed PATH_ESCAPE tool failures in 3/5 completed subset trials
  (log-summary-date-ranges x2, openssl-selfsigned-cert x2,
  password-recovery x1) plus `INVALID_PATH` where the model passed the bare
  absolute root.
- affected tasks: all open tasks whose instructions are written in absolute
  `/app/...` terms (Terminal-Bench 2.0 style).
- first broken boundary: TOOL contract (path resolution rejected paths that
  are inside the workspace purely because they were absolute).
- classification: RUNTIME TOOL (P2, evidence-backed, high frequency).
- root cause: `candidate()` in
  `packages/runtime/src/execution/tool-runtime/workspace.ts` rejected every
  absolute path up front.  In Harbor the workspace root is `/app`, so an
  absolute `/app/<path>` is exactly the same safe target as the relative
  `<path>`, but the model burned turns on PATH_ESCAPE recoveries (and often
  then converged to NO_PROGRESS).
- general failure class: filesystem/process path policy is relative-only
  instead of containment-based.
- fix: `candidate()` now accepts absolute paths that resolve inside the
  workspace root (containment is still enforced).  String-level containment
  compares the resolved (not realpath-expanded) root so the check is stable
  when realpath expands short/8.3 names on Windows; the existing callers keep
  authoritative realpath containment for existing files and parent
  directories, so symlink escapes remain rejected.
- regression: `tests/runtime/e148-workspace-absolute-inside.test.ts`
  (absolute-inside read+write succeed; absolute-outside and symlink escapes
  still PATH_ESCAPE; relative behavior unchanged).  `e049-tool-runtime` 14/14
  still passes after `@nexora/runtime` rebuild.
- Before: `/app/x.txt` rejected when workspace == /app; PATH_ESCAPE churn in
  3/5 trials.
- After: same After job as EDD-001 (log-summary-date-ranges) reached a valid
  SUCCEEDED closure; the PATH_ESCAPE churn on /app-prefixed writes is resolved
  by containment-based path acceptance.
- invariant impact: none.  Escape protection, symlink policy and
  workspace containment are unchanged; only absolute-inside-root paths are
  newly admitted.


---

## EDD-003 — Node bootstrap must require the full toolchain (node>=20 + npm + corepack)

- source failure: full 89-task official cohort trial `extract-elf` errored at
  agent setup: `RuntimeError: Nexora install failed: bash: line 1: corepack:
  command not found`.  The task image ships a bare `node` without `npm` /
  `corepack`, so the previous bootstrap (which exited early whenever `node`
  existed) skipped and the subsequent `pnpm install` failed.
- affected tasks: Terminal-Bench images that provide a partial Node install
  (observed: extract-elf; latent for any image with node but no corepack).
- first broken boundary: HARNESS adapter setup (agent Node bootstrap).
- classification: HARNESS / RUNTIME adapter (P1 - trial cannot run at all on
  such images).
- root cause: `NexoraRuntimeAgent._ensure_node_command()` only checked for the
  presence of `node`; it did not verify `npm` / `corepack` / `pnpm` or a Node
  major version >= 20 (the Runtime's engine requirement).
- general failure class: agent environment bootstrap is incomplete for images
  with partial Node toolchains.
- fix: `_ensure_node_command()` now only exits early when node major >= 20 AND
  npm AND corepack AND pnpm are all present.  Otherwise it installs the pinned
  Node 22 binary (which provides node/npm/corepack) through the image's
  package manager, then links them into /usr/local/bin.
- regression: Harbor adapter unit test `test_node_bootstrap_is_idempotent_and_pins_node`
  updated to assert the complete-toolchain fast path and corepack/npm links
  (Harbor Python 17/17 green).
- Before: extract-elf trial errored at setup (corepack missing).
- After: (pending - the running full-89 job uses the pre-fix agent class in
  memory; an After job on extract-elf will be run after the cohort completes).
- invariant impact: none (adapter setup only).


---

## EDD-OBS-003 — Provider account in arrears (external blocker)

- source: DashScope chat/completions returns HTTP 400
  `{"type":"Arrearage","code":"Arrearage"}` ("Access denied... overdue
  payment").  Verified directly from the host against the configured
  NEXORA_MODEL_BASE_URL with the configured model/key.
- first broken boundary: PROVIDER (external account/credit state).
- classification: PROVIDER / HOST, not a Nexora defect.
- impact: the tail of the full 89-task cohort (from ~06:50 onward) and all
  trials in the After-errored21 job close BLOCKED_EXTERNAL because Provider
  calls fail with the arrearage error; no new capability data can be produced
  until the account is recharged.
- fix: none in-repo (requires the user to restore the DashScope account).
- affected work: full-cohort capability numbers for the 21 infra-errored
  tasks and any BLOCKED_EXTERNAL re-runs remain pending account recharge.
- invariant impact: none.  Closure semantics are correct (BLOCKED_EXTERNAL
  with provider reason, resumable).


---

## EDD-004 — Native build toolchain + workspace bootstrap for Terminal-Bench images

- source failure: full-cohort rerun (job 2026-09-04__09-08-07) - a persistent
  error class on retry: `better-sqlite3 install: Failed` (node-gyp) in images
  that have Node but lack python3/make/g++ (observed: feal-*, make-doom-for-mips,
  mteb-leaderboard, nginx-request-logging, polyglot-rust-c, and more).  A
  second, rarer failure was `Runtime workspace does not exist or is not a
  directory: /app` (prove-plus-comm) where the task image does not pre-create
  /app.
- affected tasks: Terminal-Bench images without a native build toolchain or
  without a pre-created /app workspace.
- first broken boundary: HARNESS adapter setup (native dependency install;
  workspace precondition).
- classification: HARNESS / RUNTIME adapter (P1 - trial cannot run at all on
  such images).  Distinct failure class from EDD-001/002/003.
- root cause: the adapter bootstrapped Node but never ensured the native build
  toolchain that better-sqlite3 needs when its prebuilt binary cannot be
  fetched, and it did not ensure the /app workspace exists before starting the
  Runtime.
- general failure class: agent environment bootstrap is incomplete for
  Terminal-Bench images (native toolchain + workspace precondition).
- fix: `NexoraRuntimeAgent.setup` now runs `_ensure_native_toolchain_command()`
  (installs python3/make/g++/gcc via apt/apk/microdnf when missing,
  best-effort, idempotent) and `run` now executes `mkdir -p /app` before
  starting the Runtime trial.
- regression: Harbor adapter unit test
  `test_native_toolchain_bootstrap_is_idempotent` added (Harbor Python 18/18).
- Before: better-sqlite3 node-gyp failures and missing-/app failures on many
  official tasks.
- After: (pending - the in-flight rerun job uses the pre-fix agent; a retry
  pass with the fixed agent is required for the affected tasks).
- invariant impact: none (adapter setup/precondition only).


---

## EDD-OBS-004 — Unknown-invocation dead-end in an open task (nginx-request-logging)

- source: final-pass job 2026-09-04__09-51-53, task nginx-request-logging.
  Runtime closed `blocked` with stopReason/runErrorCode TOOL_RESULT_UNKNOWN
  (firstBrokenBoundary INVOCATION_RECOVERY); the open-task driver has no
  scripted recovery decision for unknown invocations, so the run remained
  blocked-with-recovery (closure UNEXPECTED_RUNTIME_DEAD_END).  Harbor then
  hit the 2400 s agent timeout on the same trial.
- first broken boundary: HARNESS (open-task driver recovery policy), combined
  with an unknown tool outcome.
- classification: HARNESS gap (recoverable-failure-abandoned for open tasks),
  single occurrence in >100 real trials; not confirmed reproducible.
- invariant impact: none - the Runtime itself blocked correctly (unknown
  non-idempotent effects must not be auto-replayed); only the eval driver
  lacked a decision.
- decision: not auto-fixed (bounded hardening budget after EDD-001..004);
  recorded as unresolved P2 harness item for the next engineering decision
  (e.g., a conservative open-task recovery policy that abandons the run with
  an explicit reason on first unknown invocation, converting the dead-end into
  a clean FAILED_TASK closure).
