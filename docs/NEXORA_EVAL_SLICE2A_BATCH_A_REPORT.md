# Nexora Eval Suite Slice 2A - Batch A Report

Date: 2026-09-03  
HEAD: `529eaa2e0f8e6239b05656b753c18de727765bc2`  
Dataset: `nexora-capability-pilot-batch-a` v1  
Dataset digest: `sha256:3cfad4675259dbddb1bb2becb28522bd6693c6a329cbc90951dff70be356c1e1`

## Final-Control Contradiction Check

Current `harness/nexora-bench/src/scenario.ts` uses `modelResponses.direct(...)`, which emits the provider-native `nexora_respond` final control. A current deterministic run of `HB-WORLD-001` and `NB-RETRY-001` passed with `taskResolvedRate=1`, `validatedSuccessRate=1`, and `falseSuccessCount=0`. Neither task currently triggers `FINAL_CONTROL_REQUIRED`. The contrary statement in the latest report was based on an older repository state or was an incorrect diagnosis; no compatibility code was changed in this Batch A work.

## Batch Contents

Exactly three V2 capability pilot task packages are declared by `pilot-batch-a.json`. All have fixture, scenario, sealed grader/reference/reset material, V2 contract and identity digests. `humanReviewRef` is part of the V2 contract, and the loader reads and validates each referenced `human-review.json` record with `reviewStatus: PENDING_HUMAN_REVIEW`; no task was approved.

### `cap-coding-pagination`

- User scenario: repair an inclusive end-offset pagination bug without changing the public API, then run the supplied fixture tests.
- Source: `sanitized_real_failure`
- Primary family: `coding_repository_change`
- Secondary coverage: `validation`, `side_effect`
- Fixture: isolated JavaScript pagination helper, package metadata, and independent Node tests. The initial implementation subtracts one from the end offset.
- Hidden grader: sealed grader checks the implementation exists, runs `node --test tests/verify.mjs`, and verifies `package.json` and the test file remain unchanged. The sealed reference contains no answer disclosure.
- Controls: deterministic filesystem discovery/read/patch plus approved test execution; reset and leakage rules are sealed.

### `cap-data-ordered-report`

- User scenario: read three independent fact shards, preserve source facts, write the requested ordered report, and validate it.
- Source: `real_workflow`
- Primary family: `file_data_transformation`
- Secondary coverage: `validation`, `artifact`
- Fixture: three fact shards with deterministic delayed reads, a pending report, and an independent verifier. Completion order differs from required output order.
- Hidden grader: sealed grader checks the exact ordered report (`ALPHA=17`, `BETA=29`, `GAMMA=43`, `TOTAL=89`), runs `node verify.mjs`, and checks every source shard and verifier are unchanged.
- Controls: deterministic delayed-read tool, write approval, verification approval, sealed reset and leakage rules.

### `cap-mixed-restart-aggregate`

- User scenario: derive and validate an aggregate from distributed facts while the host restarts during an approval wait, preserving progress and source files.
- Source: `sanitized_real_failure`
- Primary family: `complex_mixed_workflow`
- Secondary coverage: `long_horizon`, `restart`, `approval`, `validation`
- Fixture: distributed fact shards, a pending aggregate report, and an independent verifier.
- Hidden grader: sealed grader checks the exact aggregate, runs `node verify.mjs`, and verifies all source shards and verifier remain unchanged.
- Controls: approval driver records occurrence 1 as `approve` with `restartBeforeDecision=true`; a second approval is retained for the post-restart protected effect. Sealed reset and leakage rules apply.

## Automated Qualification

Command:

```text
pnpm exec tsx src/cli.ts run --manifest datasets/nexora-core-v1/pilot-batch-a.json --task cap-coding-pagination --task cap-data-ordered-report --task cap-mixed-restart-aggregate --output .tmp/batch-a-qualification-current
```

Result: **passed**. `taskResolvedRate=1`, `validatedSuccessRate=1`, `falseSuccessCount=0`. All three tasks terminated `succeeded`; task graders, runtime integrity, authority, safety, expected-outcome, evidence, approval, and no-duplicate-effect checks passed. Qualification evidence is `harness/nexora-bench/.tmp/batch-a-qualification-final/report.json`.

Evidence: `harness/nexora-bench/.tmp/batch-a-qualification-current/report.json`. Observed mixed-workflow telemetry reports `progressAcrossRestartCount=0` despite persisted approval/recovery evidence and successful completion. This is recorded as an observation for later investigation, not treated as a failure or removed from the task.

## Human Review

All three records remain `PENDING_HUMAN_REVIEW`. No automatic approval or promotion was performed.

## Required Changes

No qualification-blocking revision remains for Batch A. Human review is still required before promotion. The mixed-task restart telemetry observation should be reviewed separately; it does not change the current qualification result.

`BATCH_A_READY_FOR_HUMAN_REVIEW`
