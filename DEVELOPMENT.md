# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-harness
current_feature: long-sequence-context-quality
status: done_locally

feature_contract:
  feature: long-sequence-context-quality
  title: Deterministic Long-sequence Context Quality Gate
  mode: EXPLORE
  goal: >
    Prove whether the layered Context Harness preserves representative current
    and historical facts through noisy long Runs, then make only the smallest
    deterministic correction supported by the fixed evaluation dataset.
  scope:
    - fixed deterministic scenarios for early constraints and later supersession
    - repeated-failure pressure and representative Session Archive navigation
    - false-recall, same-Run, restart and Branch-isolation quality evidence
    - bounded model-visible metadata and measured deterministic projection overhead
    - minimal Harness correction only when the baseline exposes a reproducible gap
  invariants:
    - Run/Input/Event/Invocation/Evidence/Artifact remain the only Authorities
    - TaskContract remains current semantic Authority for covered Inputs
    - Checkpoint, auto-rehydration and Session Archive keep distinct responsibilities
    - Session Archive remains a bounded, rebuildable navigation index
    - request_context never modifies Run state or bypasses existing budgets
  non_goals:
    - vector or semantic retrieval
    - cross-Run user memory or cross-Branch sharing
    - raw Provider transcript retention or historical Plan reconstruction
    - persistence migration, new model call, dependency or second Context Authority
  acceptance:
    - fixed scenarios distinguish current TaskContract facts from historical Inputs
    - noisy repeated failures cannot remove all representative navigation categories
    - exact recall never admits unavailable or cross-scope facts
    - restart and Branch isolation remain reproducible
    - metadata remains bounded and projection overhead is recorded, not assumed
    - targeted quality gate, system validation, full regression, typecheck, lint and builds pass
  risk: L3

latest_verification:
  deterministic:
    red_to_green: >
      A fixed noisy history proved that repeated high-priority failures crowded
      the latest Input and all other semantic categories out of the 16
      Milestones; representative anchors now preserve each present category
      before the existing priority fill.
    context_quality_gate: 7-files-65-tests-passed
    system_validation: 10-tests-passed
    full_regression: 56-files-249-tests-passed-no-skips
    long_sequence_guard: 10000-inputs-10000-events-under-16-milestones-and-8KiB
    same_run_refusal: passed
    restart_recovery: passed
    branch_isolation: passed
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: not_run
    reason: >
      The deterministic quality gate is the current Feature Core; a real
      Provider canary will be reported separately if configured and required.

last_completed_feature: long-sequence-context-quality
next_action: commit this Feature and stop; do not add semantic/vector retrieval without real recall failures
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
