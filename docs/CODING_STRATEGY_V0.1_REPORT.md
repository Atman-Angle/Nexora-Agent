# Coding Strategy v0.1 Implementation Report

```yaml
feature: coding-strategy-v0.1
mode: DIRECT -> VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed_7_of_7_feature_tests
integration_test_status: passed_147_of_153_selected_regressions
uat_status: passed_real_ab_and_browser_uat
runtime_status: runnable
security_status: verified_strategy_only_no_new_authority
external_dependency_status: clear_for_validation_sample
artifact_status: mixed_uncommitted_worktree
resolved_status: done_locally
```

## Architecture

Coding Strategy attaches in the existing Harness decision-context builder. It is a bounded, derived `coding` projection passed through the existing Prompt compiler. It does not own or modify Run status, Task Contract, Structured Plan, Tool Invocation, Evidence, Approval, Recovery, validation, or Completion.

Activation uses Host `taskMode`, user intent, and current workspace facts. Low-confidence and non-coding tasks omit the projection and continue through General Strategy. `codingStrategy: disabled` is a strategy-only A/B switch; `auto` is the product default.

RepoSketch reads a bounded top-level tree, known manifests, real package scripts, languages/frameworks, test locations, and paths already named by the user or Tool observations. It scans at most 500 files to depth 3 and does not persist an index. Root and applicable ancestor `AGENTS.md` files are loaded as bounded strategy data. They cannot override Host Policy or Runtime safety/authority.

The existing `controlState` remains the phase source. Coding Strategy only specializes its guidance for `INITIAL_PLANNING`, `EXECUTION`, `FAILURE_REPAIR`, `VALIDATION`, and `COMPLETION`. Search/list/command outputs are compacted only in the Coding decision projection; complete Tool/Evidence facts remain in the Runtime store.

## Ownership

| Existing logic | Previous owner | Action | Final owner |
|---|---|---|---|
| Coding reconnaissance | Scattered/general prompt behavior | MOVE / MERGE | Coding Strategy |
| Scope and greenfield MVP discipline | Not explicit | ADD | Coding Strategy |
| Task Contract and Plan authority | Runtime / General Harness | KEEP | Runtime / General Harness |
| Generic `controlState` phase semantics | General Harness | KEEP | General Harness |
| Verification authority | Runtime / Completion Gate | KEEP | Runtime |
| Coding verification ladder and command discovery | Not explicit | ADD | Coding Strategy |
| Generic failure non-repetition | General Harness / Recovery | KEEP | General Harness / Runtime |
| Coding failure specialization | Not explicit | ADD | Coding Strategy |
| Generic completion authority | Runtime Completion Gate | KEEP | Runtime |
| Stop after sufficient coding evidence | Scattered/general prompt behavior | MOVE / MERGE | Coding Strategy |

The General kernel retains universal authority, planning, Tool, recovery, and completion semantics. Coding-specific guidance exists only in `coding-strategy.ts`; General Tasks do not receive a `codingStrategy` dynamic prompt field. No second Runtime, Plan, state machine, recovery path, or completion authority was introduced.

## Implementation

- High-confidence activation with General fallback and a deterministic A/B disable switch.
- `greenfield`, `bug_fix`, `feature`, and `refactor` task-shape guidance.
- Scope discipline, greenfield MVP discipline, outcome-level Plan guidance, failure repair, verification ladder, and completion stopping rule.
- Bounded RepoSketch with real manifest scripts and scoped `AGENTS.md` discovery.
- Coding-only compaction for search results, large listings, and command/test output.
- Real-provider A/B canary using the same personal-exploration-log Prompt, Runtime, Built-in Tools, budgets, Qwen 3.8 Flash profile, native-tool transport, and empty Workspace; only the strategy switch differs.
- Eval-only scope expansion, verification efficiency, core completion, time-to-first-edit/verification, repeated-strategy, failure, and false-success metrics.

## Evidence

`E140` passed 7/7 tests covering activation, General fallback, the A/B switch, greenfield and bug-fix shape, RepoSketch, scripts, scoped `AGENTS.md`, phase guidance, failure specialization, Prompt isolation, observation compaction, and eval-only metric semantics.

The selected L2 regression run passed 147/153 tests. Plan Authority, Completion Integrity, Context Projection, deterministic eviction, structured compaction, Recovery Reducer, progressive execution, General Prompt Profile, bounded convergence, change-task Completion Authority, and all E140 tests passed.

Six selected tests failed in already modified native-tool/Desktop approval paths: one E121 pending-Approval expectation and five E130 approval/timing expectations. The failing prompts did not activate Coding Strategy, and E140 independently proves that General prompts omit the coding projection. These failures remain worktree regression debt and prevent a clean all-green release claim.

Harness package build and targeted ESLint passed. Repository-wide `tsc --noEmit` still reports three pre-existing errors in current uncommitted tests (`e120` and `e129`) outside this feature's additions.

## A/B

Raw evidence is in `docs/coding-strategy-v0.1-ab-results.json` and `docs/coding-strategy-v0.1-coding-diagnostic.json`.

| Metric | Spec baseline reference | General retry | Coding retry |
|---|---:|---:|---:|
| Final status | blocked | blocked | succeeded |
| Stop reason | NO_PROGRESS_DETECTED | NO_PROGRESS_DETECTED | COMPLETED |
| Time | 11m47s | 390,082 ms | 391,026 ms |
| Model calls | not recorded | 8 | 17 |
| Tool calls | not recorded | 2 | 20 |
| First Tool | files edited | `filesystem.list` | `filesystem.list` |
| Files written | 4 | 2 | 3 |
| Core completion | partial | 3/6 | 6/6 |
| False success | 0 required | 0 | 0 |

The paired samples were run with the same Prompt, Runtime, Tools, budgets, model profile, and fresh empty workspaces; only `codingStrategy` differed. General stopped on `NO_PROGRESS_DETECTED` after one file and 3/6 core requirements. Coding completed the full 6/6 core MVP, used a smaller four-outcome plan, reached its first edit sooner (71.9s vs 112.6s), reached verification (158.3s vs none), introduced only one optional outcome, and had zero false success. Raw total Tool calls were higher for Coding because it completed the task and performed verification; this metric is not claimed as an improvement. Browser UAT on the retained Coding artifact confirmed add, search, category filter, edit, refresh persistence, and delete.

## Verdict

```text
CODING STRATEGY V0.1: VALIDATED
```

Residual release gates remain the unrelated six native-tool/Desktop approval regressions and three repository-wide test type errors documented above; they are outside this feature's ownership.
