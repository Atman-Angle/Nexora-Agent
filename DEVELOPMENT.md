# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: context-ref-acceptance-evidence
status: done_locally

feature_contract:
  feature: context-ref-acceptance-evidence
  title: Run-owned Context Ref Acceptance Evidence
  mode: DIRECT
  goal: >
    Make an explicit Memory or History restoration requirement deterministically verifiable by the
    existing Plan, Evidence and Completion Gate instead of relying on final text or benchmark logic.
  scope:
    - add the authorized context_ref Acceptance Check to the public Plan Contract
    - record source=context and kind=context_ref Evidence after exact ref restoration succeeds
    - bind Context Evidence to the active Plan version, Step and Check and recompute Step Progress
    - project restoration proof, but not untrusted Memory content, into semantic validation
    - require Provider plans and validation to preserve explicit Memory or History restoration requirements
  invariants:
    - Run-owned Plan and Evidence remain the only Completion Authority
    - Context Evidence proves only exact restoration, never that Memory content is true or trusted
    - invalid, cross-scope, expired, sensitive or digest-drifted refs cannot create Evidence
    - no Benchmark state, second Evidence Store or new database table participates in completion
  non_goals:
    - inferring arbitrary natural-language Context requirements inside Core
    - changing Memory ranking, trust, lifecycle, Store Authority or Compaction policy
    - fixing Provider token estimation or redesigning the stress dataset
    - rerunning billed Provider evaluation
  acceptance:
    - exact scoped Memory restoration creates one persisted Context Evidence record
    - Tool Evidence cannot satisfy a required context_ref Check or permit premature finish
    - semantic validation receives restoration metadata without Memory statement content
    - public Contract, Memory security, Canary and Context Harness regressions pass
  risk: L3

latest_verification:
  deterministic:
    e103_contract: 2-of-2-passed
    provider_prompt_contract: 7-of-7-passed
    relevant_suite: 40-of-40-passed-no-skips
    full_core_regression: 320-of-320-passed-no-skips
    context_memory_benchmark: 12-of-12-scenarios-and-39-of-39-supporting-tests
    typecheck: passed
    lint: passed
    root_build: passed
    runtime_package_build: passed
    diff_check: passed
    external_provider_calls: 0
    provider_cost_usd: 0

last_completed_feature: context-ref-acceptance-evidence
next_action: provider-decision-validation-convergence
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
