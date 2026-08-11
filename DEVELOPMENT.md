# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: context-memory-benchmark-v2-stress
status: done_locally

feature_contract:
  feature: context-memory-benchmark-v2-stress
  title: Calibrated 32K Context and Memory Stress Benchmark v2
  mode: DIRECT
  goal: >
    Add a versioned deterministic benchmark scenario proving that the real OpenAI-compatible qwen
    wire path triggers Context governance under the fixed 32K HPE-05 profile and still completes safely.
  scope:
    - preserve the v1 scenario manifest and reports unchanged
    - add a v2 benchmark ID and dataset version with one calibrated stress scenario
    - drive the real OpenAI-compatible Adapter through a deterministic local HTTP stub
    - require persisted Eviction, complete shard Evidence, bounded budget and validated completion
  invariants:
    - benchmark state and scripted Provider output never become Runtime Authority
    - the production Context Builder, Adapter, meter, Eviction and Completion paths are exercised unchanged
    - no external Provider call, credential or cost is required for deterministic v2
    - the historical E101 real Provider baseline remains immutable evidence
  non_goals:
    - rerunning or replacing the 15-run real Provider baseline
    - tuning Runtime policy to satisfy the benchmark
    - changing Provider calibration, Context ranking or Completion semantics
    - rerunning billed Provider evaluation
  acceptance:
    - v1 remains 12 scenarios and v2 contains exactly one additional stress scenario
    - the stress run records at least one evicted decision and zero hard-limit violations
    - all eight shard reads and required Memory restoration retain persisted Evidence
    - v2 evaluator fails closed for missing, failed or skipped stress evidence
  risk: L2

latest_verification:
  deterministic:
    e106_benchmark_v2: 2-of-2-passed
    relevant_suite: 37-of-37-passed-no-skips
    full_core_regression: 328-of-328-passed-no-skips
    context_memory_benchmark_v2: 13-of-13-scenarios-and-41-of-41-supporting-tests
    typecheck: passed
    lint: passed
    root_build: passed
    runtime_package_build: passed
    diff_check: passed
    external_provider_calls: 0
    provider_cost_usd: 0

last_completed_feature: context-memory-benchmark-v2-stress
next_action: await explicit authorization before a versioned real Provider revalidation of the E101 fixes
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
