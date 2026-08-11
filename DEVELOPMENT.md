# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: real-provider-harness-revalidation-post-fixes
status: done

feature_contract:
  feature: real-provider-harness-revalidation-post-fixes
  title: Fixed-dataset qwen Context and Memory Harness Revalidation
  mode: VERIFY
  goal: >
    Re-run the fixed 15-Run real qwen Provider dataset on the clean post-fix revision and record
    comparable task, safety, continuity, usage and latency evidence without tuning or replacement Runs.
  scope:
    - execute HPE-01 through HPE-05 exactly three times each
    - use the explicit model capability and the existing 32K HPE-05 override
    - compare the immutable E101 baseline with the new clean-revision report
    - retain every failed Run and diagnose it from persisted Runtime evidence
  invariants:
    - no prompt, Runtime, dataset or threshold changes occur during execution
    - no failed sample is replaced, retried outside Runtime policy or omitted
    - Provider usage remains ledger evidence and cost remains unpriced when no trusted pricing exists
    - the historical E101 report and the deterministic v2 report remain unchanged
  non_goals:
    - fixing newly observed convergence failures in the same Feature
    - claiming statistical significance from three repetitions
    - treating successful task output as a substitute for Eviction or Completion Evidence gates
  acceptance:
    - all 15 planned Runs execute once on a clean committed source revision
    - the aggregate report contains actual usage, latency, budget and per-Run failure evidence
    - old and new results are compared without weakening any hard gate
    - remaining failures are separated into production convergence and benchmark-pressure gaps
  risk: L2

latest_verification:
  real_provider:
    source_commit: a37e62fe6dc8e5b6add55ff79422b6456cfa3746
    source_dirty: false
    fixed_runs: 15-of-15-completed
    benchmark_result: failed-8-of-15-passed
    succeeded_validated: 11-of-15
    memory_recall_gate: passed
    hard_gate_failures: 0
    provider_calls: 112
    provider_usage_coverage: 100-percent
    provider_actual_tokens: 505903
    provider_cost: unpriced

last_completed_feature: real-provider-harness-revalidation-post-fixes
next_action: provider-context-ref-plan-convergence
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
