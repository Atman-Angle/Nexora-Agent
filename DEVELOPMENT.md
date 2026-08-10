# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-harness
current_feature: decision-continuity-projection
status: done_locally

feature_contract:
  feature: decision-continuity-projection
  title: Decision Continuity Projection
  mode: DIRECT
  goal: >
    Ensure an active Context Checkpoint, exact rehydrated facts and current
    Repair guidance survive every Context projection layer and reach the real
    OpenAI-compatible decision request.
  scope:
    - project active contextCheckpoint and rehydratedFacts onto the OpenAI-compatible wire
    - preserve repair while deterministic Eviction rebuilds ModelDecisionContext
    - prove both paths with direct deterministic request and contraction tests
  invariants:
    - Run/Input/Event/Invocation/Evidence/Artifact remain the only Authorities
    - TaskContract remains current semantic Authority for covered Inputs
    - Checkpoint and rehydratedFacts remain bounded derived Context, never Authority
    - wire projection omits Runtime-only provenance but preserves decision-bearing facts
    - Eviction changes only Tool Observation payload retention
  non_goals:
    - Memory Contract, Store, lifecycle, promotion, recall or Context injection
    - automatic historical candidate discovery, vector search or embedding
    - persistence migration, new model call, dependency or public Contract change
    - real Provider credential use or final long-sequence Canary
  acceptance:
    - captured OpenAI-compatible HTTP user message contains the active Checkpoint
    - captured OpenAI-compatible HTTP user message contains exact rehydrated facts
    - Runtime-only projection provenance remains absent from the wire
    - every deterministic Eviction contraction preserves current Repair and hashes it
    - targeted tests, Context quality gate, system validation, full regression,
      typecheck, lint and builds pass with no relevant skips
  risk: L3

latest_verification:
  deterministic:
    red_to_green: >
      The captured OpenAI-compatible wire omitted contextCheckpoint and
      rehydratedFacts, while the first Eviction rebuild dropped repair; E088
      now proves all three survive the production projection path.
    targeted: 3-files-21-tests-passed
    context_quality_gate: 8-files-68-tests-passed
    system_validation: 10-tests-passed
    full_regression: 57-files-252-tests-passed-no-skips
    wire_projection: checkpoint-and-exact-rehydrated-fact-present
    eviction_repair: 2-of-2-contraction-rebuilds-preserved-and-digested
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: not_run
    reason: Real Provider credential use requires separate authorization.

last_completed_feature: decision-continuity-projection
next_action: stop; activate multi-cycle-context-continuity only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
