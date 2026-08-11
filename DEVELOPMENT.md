# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: provider-token-meter-calibration
status: done_locally

feature_contract:
  feature: provider-token-meter-calibration
  title: Evidence-calibrated Provider Token Meter
  mode: EXPLORE
  goal: >
    Calibrate estimated OpenAI-compatible wire token measurements for verified models so Context
    governance reacts to Provider-scale input usage instead of systematically low UTF-8/4 estimates.
  scope:
    - derive qwen3.7-flash phase multipliers from the fixed E101 Provider usage ledger
    - apply calibration to the final projected wire request before budget assessment
    - keep the measurement marked estimated and record the calibrated meter identity
    - preserve caller-provided token meters as the higher-confidence authority
  invariants:
    - declared model context windows and output reserves remain unchanged
    - actual Provider usage remains immutable ledger evidence and is never rewritten
    - unknown models retain the documented compatibility fallback
    - no tokenizer dependency, online mutable calibration state or second budget authority is introduced
  non_goals:
    - claiming exact tokenizer counts
    - redesigning the benchmark v2 stress dataset
    - changing Context ranking, Eviction, Compaction or rehydration policy
    - rerunning billed Provider evaluation
  acceptance:
    - the known qwen meter covers every observed E101 phase deviation with explicit safety margin
    - the former 32K HPE-05 decision profile crosses the soft governance boundary deterministically
    - custom exact meters override calibration and unknown models keep UTF-8/4 fallback
    - budget, Provider configuration, Canary and Context Harness regressions pass
  risk: L2

latest_verification:
  deterministic:
    e105_calibration: 4-of-4-passed
    relevant_suite: 45-of-45-passed-no-skips
    full_core_regression: 326-of-326-passed-no-skips
    context_memory_benchmark: 12-of-12-scenarios-and-39-of-39-supporting-tests
    typecheck: passed
    lint: passed
    root_build: passed
    runtime_package_build: passed
    diff_check: passed
    external_provider_calls: 0
    provider_cost_usd: 0

last_completed_feature: provider-token-meter-calibration
next_action: context-memory-benchmark-v2-stress
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
