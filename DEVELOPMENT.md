# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-harness
current_feature: run-local-episodic-recall
status: done_locally

feature_contract:
  feature: run-local-episodic-recall
  title: Run-local Session Archive and Exact Recall
  mode: VERIFY
  goal: >
    Let a long-running Run discover its persisted Input and Event history
    through a bounded Session Archive and restore exact Authority facts through
    the existing request_context path.
  scope:
    - bounded model-visible Session Archive metadata derived from the current Run
    - exact input:<sequence> and event:<sequence> recall under the existing budget
    - request_context availability when only archived Session facts exist
    - same-Run ownership, cross-Run refusal, restart and hard-limit regression coverage
  invariants:
    - Run/Input/Event/Invocation/Evidence/Artifact remain the only Authorities
    - Session Archive is a bounded derived index and can be rebuilt from the Store
    - request_context remains a Harness control action and cannot modify Run state
    - State Machine, Approval, Recovery and Completion Authorities remain unchanged
  non_goals:
    - raw Provider transcript retention
    - vector or semantic retrieval
    - cross-Run user memory or cross-Branch sharing
    - persistence migration, new model call or second Context Authority
  acceptance:
    - a covered early Input and an old Event remain discoverable and exactly rehydratable
    - Session Archive metadata stays bounded independent of Session content size
    - cross-Run and malformed refs remain REF_UNAVAILABLE or INVALID_REF without leakage
    - crash/restart rebuilds pending recall and no authoritative state changes
    - system validation, full Runtime regression, typecheck, lint and build pass
  risk: L3

latest_verification:
  deterministic:
    red_to_green: >
      e082 proves persisted input:1 and event:1 cannot currently be requested
      after the first Plan without the Archive; the same path now restores both
      exact facts and preserves Run state.
    targeted: 7-files-66-tests-passed
    system_validation: 10-tests-passed
    full_regression: 55-files-245-tests-passed
    same_run_isolation: passed
    restart_recovery: passed
    typecheck: passed
    lint: passed
    build: passed
    runtime_package_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: not_run
    reason: >
      No external Provider canary was required to prove the deterministic
      same-Run archive, Store resolution and recovery boundary.

last_completed_feature: run-local-episodic-recall
next_action: review and commit; do not begin semantic/vector retrieval without a recall-quality dataset
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
