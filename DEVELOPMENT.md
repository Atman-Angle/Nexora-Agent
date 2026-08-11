# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: rehydration-action-continuity
status: done_locally

feature_contract:
  feature: rehydration-action-continuity
  title: Rehydrated Fact Action Continuity
  mode: DIRECT
  goal: >
    Keep an exact rehydrated fact available until the Provider produces an accepted follow-up action,
    without duplicate Store work or losing repair context after an invalid action or failed validation.
  scope:
    - consume a pending rehydration request only after an accepted non-finish action or successful finish
    - keep the same exact fact across duplicate request_context, invalid Action and validation repair turns
    - merge newly requested refs without orphaning the previous persisted request
    - tell Provider adapters that request_context is a top-level control action, never a Tool name
  invariants:
    - Run Store remains the Authority for original facts and rehydration audit Events
    - request_context remains a Harness control action outside the Core State Machine
    - repeated requests do not create duplicate rehydration Events or Tool Effects
    - invalid actions and failed validation cannot consume facts needed for repair
  non_goals:
    - adding context_ref Acceptance Checks or changing Completion Evidence in this Feature
    - changing Context ranking, Memory recall, Store Authority or Compaction policy
    - rerunning billed Provider evaluation
  acceptance:
    - exact input or invocation facts remain visible after duplicate request and invalid action
    - successful Tool work consumes the pending request exactly once
    - validation failure retains the restored fact until a validated finish succeeds
    - rehydration and Context Harness regressions, static checks and builds pass
  risk: L2

latest_verification:
  deterministic:
    e102_contract: 2-of-2-passed
    rehydration_and_system_suite: 29-of-29-passed-no-skips
    typecheck: passed
    lint: passed
    root_build: passed
    runtime_package_build: passed
    diff_check: passed
    external_provider_calls: 0
    provider_cost_usd: 0

last_completed_feature: rehydration-action-continuity
next_action: begin the authorized Run-owned context_ref Acceptance Evidence Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
