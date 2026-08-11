# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: provider-decision-validation-convergence
status: done_locally

feature_contract:
  feature: provider-decision-validation-convergence
  title: Provider Decision and Validation Repair Convergence
  mode: DIRECT
  goal: >
    Make a Provider converge after semantic validation rejects an incomplete summary, instead of
    repeatedly requesting Context refs that are already restored until the model-call budget expires.
  scope:
    - reject a request_context action whose complete ref set is already visible in rehydratedFacts
    - route the rejection through the existing bounded invalid-action repair path
    - instruct the Provider to correct the requested outcome directly after validation failure
    - distinguish Evidence metadata refs from the underlying Invocation or Artifact payload
  invariants:
    - semantic validation remains the only judge of proposed summary correctness
    - duplicate requests perform no Store read and create no second rehydration request
    - repair remains bounded by the existing Run retry budget
    - no new state source, Provider-specific branch or automatic result synthesis is introduced
  non_goals:
    - changing validation criteria or bypassing failed validation
    - automatically following Evidence refs to Invocation or Artifact payloads
    - fixing token estimation or redesigning the stress dataset
    - rerunning billed Provider evaluation
  acceptance:
    - one exact request restores facts and a duplicate request becomes actionable repair feedback
    - a corrected summary can pass using the same persisted Evidence without repeated Tool effects
    - a non-converging Provider fails through the retry boundary before model-call exhaustion
    - Provider contract, rehydration continuity and Context Harness regressions pass
  risk: L2

latest_verification:
  deterministic:
    e104_convergence: 2-of-2-passed
    relevant_suite: 30-of-30-passed-no-skips
    full_core_regression: 322-of-322-passed-no-skips
    context_memory_benchmark: 12-of-12-scenarios-and-39-of-39-supporting-tests
    typecheck: passed
    lint: passed
    root_build: passed
    runtime_package_build: passed
    diff_check: passed
    external_provider_calls: 0
    provider_cost_usd: 0

last_completed_feature: provider-decision-validation-convergence
next_action: provider-token-meter-calibration
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
