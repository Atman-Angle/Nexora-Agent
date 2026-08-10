# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: fix-prompt

current_capability: model-input-boundary
current_feature: fix-prompt-model-input-layering
status: done_locally

feature_contract:
  feature: fix-prompt-model-input-layering
  title: Decision Prompt Layering and Model Wire Noise Reduction
  mode: DIRECT
  goal: >
    Separate the decision prompt into Runtime Policy, Phase, Task, Context,
    Tool and Repair layers; expose structured repair feedback; and remove
    Runtime-only provenance from the OpenAI decision wire payload.
  scope:
    - named decision prompt layers composed into one system message
    - structured context.repair for actionable Runtime feedback
    - remove projection digest from the model-visible OpenAI decision payload
    - project Tool Observations to decision facts, payload mode, and source refs only
    - enable DashScope dynamic reasoning locally and sample a fixed Qwen A/B
  invariants:
    - State Machine, Tool Invocation, Evidence, and Completion Authorities remain unchanged
    - internal projection digest remains available to the Model Call Ledger
    - sourceRefs remain available for rehydration
    - public RuntimeProvider and persisted schemas do not change
  non_goals:
    - a production-wide performance claim or rollout of a lower output limit
    - persistence migration, new model call, or new Runtime Authority
  acceptance:
    - OpenAI wire payload excludes projection and Tool Observation provenance metadata
    - model-visible Observation retains facts, payloadMode, and sourceRefs
    - repair is explicit in the decision context without exposing rejected raw Action JSON
    - typecheck, lint, build, and the full Runtime regression suite pass
  risk: L2

latest_verification:
  deterministic:
    tests: 52-files-231-tests-passed
    typecheck: passed
    lint: passed
    build: passed
    diff_check: passed
  external_environment_acceptance:
    status: sampled
    reason: >
      qwen3.7-flash A/B (4096 versus 1536) completed eight read-only Runs;
      all succeeded, dynamic thinking was observed, but the sample does not
      justify lowering the default. See docs/QWEN_DECISION_TOKEN_AB_2026-08-09.md.

last_completed_feature: fix-prompt-model-input-layering
next_action: review and commit; retain 4096, then begin Harness development
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
