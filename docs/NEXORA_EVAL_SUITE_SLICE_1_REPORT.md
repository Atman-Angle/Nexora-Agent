# Nexora Eval Suite — Slice 1 Report

## Delivered

- Evolved the existing `harness/nexora-bench` in place; no second evaluation framework was created.
- Added a V2 task contract with separated agent-visible input, execution metadata, ExpectedOutcomePolicy, identity digests, family/difficulty/secondary coverage, and a runner-only `sealed.graderRef`.
- Added V1-to-normalized-V2 compatibility. Existing V1 tasks remain executable as migration pilots; V2 is the formal contract.
- Added a deterministic, evaluation-owned Runtime Integrity checker. It reads persisted Run, Invocation, Attempt, Evidence, Result, Event, and Tool-contract facts and does not import or call the production Completion Gate or recovery reducer.
- Added separate Task, Runtime Integrity, Safety/Authority, and Expected Outcome verdicts. V2 `STRICT_PASS` requires all of them. Model text is not a grading authority.
- Added V2 report output fields for task/grader/tool-catalog digests, source task schema version, strict results, and an explicit host-isolation capability state. V1 report consumers remain compatible with schema version `1` reports.
- Added a stratified split validator: declared major families must have Validation and Holdout representation, and each family’s declared difficulty distribution is checked in both splits.
- Added deterministic coverage for stale Evidence, false success, approval-before-mutation, expected confirmation, sealed-path traversal, stratified coverage, and the production-grader dependency boundary.

## Isolation status

The runner resolves `sealed.graderRef` outside the fixture copied to the agent workspace and never projects grader material into the agent instruction. Windows host-level shell containment is not yet independently enforced by this Slice, so emitted V2 reports declare `unsupported_host_isolation`; they must not be represented as sealed public-benchmark execution until a process/container boundary is implemented.

## Migration cohort

The retained V1 pilot cohort is `HB-WORLD-001`, `NB-RETRY-001`, `NB-RECOVERY-001`, and `NB-SAFETY-001`. It preserves existing authority grading while formal V2 task contracts use the independent strict bundle.

## Verification

- `pnpm --filter @nexora/bench typecheck` passes.
- Eval Suite unit coverage passes.
- Two pre-existing telemetry integration scenarios currently fail because their deterministic Runs terminate with `NO_PROGRESS_DETECTED` after producing the requested file state. This is reported as a Runtime convergence failure rather than converted to an Eval pass. No Runtime behavior was changed in this Slice.
