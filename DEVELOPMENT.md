# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-harness
current_feature: multi-cycle-context-continuity
status: done_locally

feature_contract:
  feature: multi-cycle-context-continuity
  title: Multi-cycle Context Continuity
  mode: VERIFY
  goal: >
    Prove and preserve bounded, SourceRef-backed continuity across repeated
    Compactions, TaskContract revisions, Runtime restarts and sibling Branches
    in one versioned deterministic long-sequence evaluation.
  scope:
    - expose only the latest fully revalidated Checkpoint summary to the next Compaction
    - revalidate persisted summary digest, SourceRefs, derived source digests and coverage
    - invalidate an unresolved failure after a later success satisfies the same Check
    - fixed evaluation with 100+ decisions, 5+ Compactions, 3 restarts,
      2 sibling Branches, 4 TaskContract versions and 20+ real Tool failures
    - exact Input, Event, Invocation, Evidence and Artifact rehydration evidence
    - repeatable full Context build p50, p95 and max measurements
  invariants:
    - Run/Input/Event/Invocation/Evidence/Artifact remain the only Authorities
    - TaskContract remains current semantic Authority for covered Inputs
    - a prior Checkpoint is only a carry-forward candidate after full Authority revalidation
    - every replacement Summary re-resolves original SourceRefs and replaces one latest row
    - checkpoint IDs, internal source maps and covered lists never become model SourceRefs
    - Plan revision, source drift or resolved failure invalidates stale Checkpoint content
  non_goals:
    - deterministic history candidate expansion or cross-Run Memory
    - vector, embedding, full-text index or new persistence table
    - Runtime merging semantic statements without Provider judgment
    - real Provider credential use or final Canary
  acceptance:
    - first Compaction sees null and later Compactions see the latest valid prior Summary
    - five or more replacements preserve early valid refs without checkpoint chaining
    - tampered or stale persisted Checkpoints never enter CompactionContext
    - the versioned long scenario meets every declared count and isolation assertion
    - targeted tests, Context quality gate, system validation, full regression,
      typecheck, lint and builds pass with no relevant skips
  risk: L3

latest_verification:
  deterministic:
    red_to_green: >
      Repeated Compaction previously omitted the latest valid Summary, persisted
      Checkpoint derivatives were not fully revalidated, Event digests ignored
      payload, and a multi-Check failure was cleared after only one Check passed.
    targeted: 7-e089-tests-passed
    context_quality_gate: 11-files-75-tests-passed
    system_validation: 10-tests-passed
    full_regression: 60-files-260-tests-passed-no-skips
    long_scenario: 102-decisions-5-compactions-3-reopens-2-branches-20-failures
    exact_rehydration: input-event-invocation-evidence-artifact-passed
    performance: 1000-inputs-1000-events-p95-72.005ms-max-72.005ms-3478-bytes
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: not_run
    reason: Real Provider credential use requires separate authorization.

last_completed_feature: multi-cycle-context-continuity
next_action: stop; activate deterministic-history-candidates only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
