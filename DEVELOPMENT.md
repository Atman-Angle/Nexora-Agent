# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: memory-performance-rebuild
status: done_locally

feature_contract:
  feature: memory-performance-rebuild
  title: Memory Performance Baseline and Derived-Index Rebuild
  mode: VERIFY
  goal: >
    Establish a reproducible bounded performance baseline for Memory-backed Context,
    and prove SQLite derived indexes can be rebuilt from authoritative Memory tables.
  scope:
    - benchmark exact-scope Memory list and complete Context build over a fixed persisted dataset
    - record p50, p95, max, dataset size, Context bytes, model calls and Provider cost
    - recreate missing SQLite performance indexes during normal Memory Store reopen
    - prove records and deterministic recall remain unchanged across index loss and rebuild
  invariants:
    - Memory records and control events remain the only Memory data Authority
    - indexes contain no independent facts and may be deleted without data loss
    - rebuild does not change schema version, public recall Contract or Run Authority
    - performance measurement uses zero model calls and therefore zero Provider cost
  non_goals:
    - vector or semantic retrieval, a second index service or a new cache Authority
    - real Provider latency, quality, token usage or billing measurement
    - automatic Memory extraction, conflict classification or ranking changes
    - changing Memory records, Context budgets, Approval or Completion behavior
  acceptance:
    - fixed dataset records Memory query and complete Context build p50, p95 and max
    - report includes record/scope/sample/database/Context sizes plus model calls and cost
    - deleting every declared derived index and reopening restores all indexes from existing tables
    - exact records, bounded candidates and query-plan index use survive the rebuild
    - targeted recovery/performance tests, Memory/Context regression and static/build checks pass
  risk: L2

latest_verification:
  deterministic:
    red_to_green: current-schema Memory Store skipped every missing derived index
    targeted_recovery_performance: E096-1-file-2-tests-passed
    dataset: 10-scopes-5000-records-20-samples-after-store-reopen
    memory_query_ms: p50-8.95-p95-18.10-max-24.31
    complete_context_build_ms: p50-22.45-p95-31.82-max-34.28
    bounded_output: context-max-4153-bytes-model-calls-0-provider-cost-usd-0
    rebuild: all-3-derived-indexes-restored-records-and-candidates-identical-query-plan-indexed
    memory_regression: E091-E096-6-files-35-tests-passed
    context_quality_gate: 12-files-80-tests-passed
    full_regression: 67-files-300-tests-passed-no-skips-no-unhandled-errors
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: deferred
    reason: Real Provider quality, token, latency and cost belong to the next Canary Feature.

last_completed_feature: memory-performance-rebuild
next_action: stop; activate real-provider-continuity-canary only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
