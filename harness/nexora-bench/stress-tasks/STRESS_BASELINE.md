# Nexora Stress Eval Baseline

This baseline is calibrated from real executions, not from model self-reported success.

## Candidate calibration

The candidate pool contains 24 tasks. The first 16 are the existing NexoraBench tasks and were executed with the real OpenAI-compatible Provider on 2026-08-29. Eight additional candidates are specified for the next calibration pass and are intentionally marked `not-run`; they are not included in the measured success rates.

The retained core contains 10 tasks selected for long execution chains, partial success, interruption/recovery, completion traps, validation pressure, and attribution clarity. `HB-WORLD-001` was dropped as too short. `HB-WORKDIR-001` was dropped because its observed failure was dominated by environment/approval command form rather than strategy search.

## Runtime-direct evidence

Source: `reports/2026-08-29T05-19-11-743Z/report.json`, dataset `nexora-core-v1` v11, real Provider `qwen3.7-flash`.

- 16 executed candidates.
- Independent task grader: 10/16 (62.5%).
- Runtime validated success: 2/16 (12.5%).
- Authority false success: 0.
- 70 model calls, 61 persisted progress records.
- The clearest failure cluster is completion/convergence after workspace truth is already correct (`NB-CODE-001`, `HB-WORLD-001`, `QB-GCD-001`).
- `NB-LONG-001` and `NB-ARTIFACT-001` expose Provider/context pressure; `NB-CONVERGE-001` exposes tool-call budget pressure; `QB-MAXSUM-001` exposes validation/repair reasoning.

## Product-path evidence

The existing product regression executes the actual Electron renderer -> preload -> IPC -> Runtime worker -> DesktopRuntimeService path.

- Recovery scenario: `.tmp/desktop-recovery-uat.json` passed. It exercised blocked -> renderer follow-up -> continuation -> `filesystem.search` -> `filesystem.read` -> Evidence -> succeeded. Runtime-direct and Product-path children both succeeded; `firstBrokenBoundary` was null.
- Document scenario: `.tmp/desktop-document-uat.json` passed with a real renderer submission and continuation, four committed formats, and revision-2 preview.
- The current UAT driver is scenario-specific and does not yet parameterize arbitrary NexoraBench task fixtures/scenario factories. Therefore the 10-task core is marked `productPathStatus: partial`; uncovered product runs are reported as `PRODUCT_PATH`, never counted as passes.

## First broken boundary classification

Runtime-only classifications from the report are preserved: `COMPLETION`, `PROVIDER_EXTERNAL`, `TOOL_EXECUTION`, or null for expected cancellation/recovery terminals. A task with correct filesystem truth but non-succeeded Runtime status is not a validated success. Product-path failures cannot be claimed or attributed until that task has been driven through the real product runner.

## What this baseline proves

Internal Runtime success is insufficient evidence for a Desktop fix. The only currently demonstrated parity case is the recovery regression, where both paths produced authoritative progress and completion. The next required engineering step is product-runner parameterization for the retained core; no Runtime or recovery production changes are justified by this baseline alone.
