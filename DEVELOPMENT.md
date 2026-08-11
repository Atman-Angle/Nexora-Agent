# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: explicit-provider-model-budget-profile
status: done_locally

feature_contract:
  feature: explicit-provider-model-budget-profile
  title: Explicit Provider Model Budget Profile
  mode: DIRECT
  goal: >
    Resolve real Provider context capacity from the selected model and require per-phase output budgets to be validated,
    while recording Canary overrides and Provider usage deviation without a second Authority.
  scope:
    - resolve a verified context window and maximum output capability from NEXORA_MODEL_NAME
    - reject unknown models, manual production window overrides and invalid output budgets before Run creation
    - record declared Profile, Canary context-window override and effective Profile
    - derive per-call measured-versus-actual usage deviations from the existing Model Call Ledger
  invariants:
    - ProviderModelProfile and Model Call Ledger remain the only budget and usage Authorities
    - Context ranking, rehydration, Eviction, Compaction and hard refusal remain unchanged
    - no State Machine, Plan, Invocation, Store, Approval, Evidence or Completion Authority changes
    - absent Provider usage remains unknown rather than being recorded as zero
  non_goals:
    - remote Provider capability discovery or automatic catalog updates
    - database migration, adaptive budget tuning or a second Profile cache
    - requiring production env configuration in custom/test RuntimeProvider implementations
    - real Provider Canary rerun, price discovery or release deployment
  acceptance:
    - unknown models and invalid env Profiles fail before Provider execution and Run creation
    - qwen3.7-flash automatically resolves to its verified 1M context capability
    - explicit phase outputs reach the existing ProviderModelProfile and wire max_tokens path
    - Canary distinguishes declared, override and effective Profiles and detects mismatch
    - usage deviations preserve unavailable, under-reserve and over-limit facts per logical call
    - targeted Provider/CLI/Canary tests, related L2 regression and static/build checks pass
  risk: L2

latest_verification:
  deterministic:
    model_capability_resolution: qwen3.7-flash-resolves-to-1000000-context-131072-max-output
    local_env_profile: decision-16384-validation-8192-compaction-8192-no-network-call
    canary_override_provenance: declared-override-effective-profiles-separated-and-checked
    usage_deviation: per-call-measured-actual-output-reserve-and-window-deviation-recorded
    targeted: 5-files-34-tests-passed
    provider_cli_context_regression: 19-files-113-tests-passed-no-skips
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: unverified
    reason: qwen3.7-flash capability is based on the provided Provider evidence; exact tokenizer behavior and real endpoint acceptance were not exercised.

last_completed_feature: explicit-provider-model-budget-profile
next_action: stop after independent commit
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
