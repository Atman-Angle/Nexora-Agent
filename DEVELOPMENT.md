# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: real-provider-continuity-canary
status: verification_blocked

feature_contract:
  feature: real-provider-continuity-canary
  title: Real Provider Context and Memory Continuity Canary
  mode: VERIFY
  goal: >
    Prove the complete Context and Memory Harness works with the configured real Provider
    on a fixed long read-only task, with measurable quality, safety, tokens, latency and cost status.
  scope:
    - run one fixed eight-shard task through the production OpenAI-compatible Provider Adapter
    - seed relevant, distracting, sensitive and cross-project Memory records
    - require exact target Memory request/rehydration and eight persisted read Evidence
    - record success, wrong recall, tokens, model calls, latency, cost status and failure samples
  invariants:
    - Canary is one-shot and never repairs results with extra user input or a second Run
    - only read Tools are permitted; write or execute requests fail the Canary without approval
    - Runtime Ledger, Events, Invocations and Evidence are the measurement Authority
    - reports never contain API keys, authorization headers or Provider response internals
  non_goals:
    - tuning prompts or retrying until a passing sample is obtained
    - production deployment, vendor billing reconciliation or universal model comparison
    - changing Memory ranking, Context budgets, Core Authority or Tool permissions
    - claiming multi-run statistical confidence from a one-run release Canary
  acceptance:
    - production Provider requests and restores the one relevant exact-scope Memory and no wrong Memory
    - Run succeeds as VALIDATED with successful filesystem.read Evidence for all eight shards
    - at least one decision uses deterministic Eviction and no call violates the hard Context limit
    - report records actual usage coverage, token totals, per-phase latency and priced/unpriced cost status
    - any unsafe Tool, missing read, wrong recall, wait, failure or blocked state is retained as a failed sample
    - deterministic contract tests and relevant/full regression plus static/build checks pass
  risk: L3

latest_verification:
  deterministic:
    red_to_green: harness-helpful-rehydrated-facts-were-not-provider-budget-evictable
    deterministic_canary_contract: E097-1-file-3-tests-passed
    real_provider_canary: failed-one-shot-run-ca7d788a-context-budget-exceeded
    real_provider_partial_success: target-memory-restored-wrong-recall-0-8-of-8-reads-no-unsafe-tools
    real_provider_usage: 6-calls-5-with-usage-16215-input-11775-output-27990-total
    real_provider_latency_ms: decision-p50-27019.22-p95-35943.07-max-35943.07-run-96546.21
    real_provider_cost: unpriced-no-token-rates-configured
    post_failure_fix: evict-rebuildable-harness-helpful-facts-before-tool-observations
    context_memory_regression: 12-files-76-tests-passed
    context_quality_gate: 12-files-80-tests-passed
    full_regression: 68-files-303-tests-passed-no-skips-no-unhandled-errors
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: failed
    reason: First real one-shot exposed a fixed Context budget defect; post-fix real Provider rerun is intentionally unavailable in E097.

last_completed_feature: memory-performance-rebuild
next_action: stop; authorize a new versioned post-fix Canary instead of rerunning E097
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
