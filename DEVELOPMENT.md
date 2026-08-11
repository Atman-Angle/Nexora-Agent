# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: context-memory-harness-evaluation-benchmark
status: done

feature_contract:
  feature: context-memory-harness-evaluation-benchmark
  title: Context and Memory Harness Evaluation Benchmark v1
  mode: VERIFY
  goal: >
    Establish a versioned, reproducible end-to-end Harness benchmark whose fixed hard gates and
    Provider metrics provide comparable evidence for later Context and Memory optimization.
  scope:
    - define a fixed capability matrix, scenario manifest, evidence contracts and pass thresholds
    - run deterministic Runtime/Store/Tool/Memory E2E scenarios through real public execution paths
    - generate machine-readable revisioned reports with dimensions, durations and fail-closed gates
    - define a separate real Provider protocol for quality, tokens, latency, cost and failure samples
  invariants:
    - benchmark reads Runtime Ledger, Store, Invocation and Evidence instead of creating result Authority
    - safety, Authority, recovery and hard-budget failures cannot be averaged away by a score
    - deterministic and real Provider evidence remain separate and cannot overwrite each other
    - dataset or threshold semantics are versioned and reports never contain Provider credentials
  non_goals:
    - optimizing Context ranking, prompts, Memory recall or Runtime behavior in the benchmark Feature
    - claiming model-quality statistics from deterministic scripted Provider runs
    - production deployment, universal model comparison or automatic benchmark tuning
    - silently using local Provider credentials or incurring external cost
  acceptance:
    - manifest covers continuity, retrieval, budget, authority, safety, recovery and efficiency
    - missing, failed, skipped or todo scenario evidence fails the benchmark
    - deterministic baseline executes every fixed scenario and records a comparable JSON report
    - real Provider protocol specifies fixed data, repetitions, hard gates and regression candidates
    - runner contract tests, benchmark supporting suite and static/build checks pass
  risk: L3

latest_verification:
  deterministic:
    benchmark_id: context-memory-harness-v1-dataset-v1
    manifest: 12-fixed-hard-gate-scenarios-7-dimensions
    contract: E100-1-file-3-tests-passed
    deterministic_baseline: 12-of-12-scenarios-39-of-39-supporting-tests-no-skips
    dimension_scores: continuity-6/6-retrieval-5/5-budget-4/4-authority-5/5-safety-4/4-recovery-2/2-efficiency-2/2
    canonical_baseline: commit-9b427c1-dirty-false-manifest-fbc02f2d
    baseline_duration_ms: 24684.06-clean-source
    external_provider_calls: 0
    provider_cost_usd: 0
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: completed_failed_baseline
    provider: openai-compatible-qwen3.7-flash
    runs: 15-of-15-no-retries
    result: 5-passed-10-failed-benchmark-failed
    scenarios: HPE-01-0-of-3-HPE-02-3-of-3-HPE-03-0-of-3-HPE-04-2-of-3-HPE-05-0-of-3
    hard_gates: 0-unsafe-0-scope-leak-0-hard-limit-3-false-success
    usage: 242-calls-241-with-usage-1957800-total-tokens-unpriced
    report: reports/context-memory-provider-v1/2026-08-11T09-08-18-224Z/report.json

last_completed_feature: context-memory-harness-evaluation-benchmark
next_action: plan a separate optimization Feature from E101 RED evidence; do not rerun Provider baseline without a versioned dataset and new authorization
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
