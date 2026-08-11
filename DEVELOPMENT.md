# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: runtime-owned-intent-compilation
current_feature: runtime-owned-intent-compilation
status: done

feature_contract:
  feature: runtime-owned-intent-compilation
  title: Reduce LLM Protocol Tax with Runtime-owned Intent Compilation
  mode: VERIFY
  goal: >
    Replace the Provider-facing Runtime Action DSL with a minimal semantic Intent contract while
    preserving the existing Run, Plan, Invocation, Approval, Evidence and Completion authorities.
  scope:
    - compile semantic plan, context, capability, input and finish intents into existing internal actions
    - remove Runtime-owned IDs, versions, bindings and execute_step wrappers from Provider output
    - classify validation issues into a finite Runtime-facing taxonomy
    - derive readable failure handoff from persisted Runtime authority without creating a second Result
    - migrate all in-repository Providers, tests, examples and public documentation to Contract v2
  invariants:
    - State Machine remains the only Run Status writer
    - Run-owned Structured Plan remains the only current Plan
    - Tool Invocation remains the side-effect and recovery authority
    - Approval, Evidence and Completion Gate cannot be bypassed
    - Runtime does not parse natural-language reasoning or invoke a translation LLM
  non_goals:
    - Provider-specific behavior in Core
    - pure-text action parsing
    - a second Plan, Evidence, Context or task-status authority
    - increasing iteration or model-call budgets to hide convergence failures
  acceptance:
    - Provider emits no Runtime-owned IDs, versions, Evidence IDs or execute_step wrapper
    - E107 Plan Schema, action hierarchy, missing context_ref, duplicate ref and finish convergence failures have deterministic regressions
    - invalid, unsafe or ambiguous intents fail closed without partial Tool execution
    - failed terminal Runs expose a deterministic readable handoff and never a success Result
    - L3 Core Regression and fixed local Runtime acceptance pass
  risk: L3

last_completed_feature: runtime-owned-intent-compilation
result: >
  Runtime now restores published Context/Memory before decisions, exposes one phase-directed Intent,
  executes active Tasks without replanning, and finishes directly from complete persisted Evidence.
validation: >
  L3 gates passed: 334/334 full regression, 80/80 context-quality tests, deterministic benchmark v2
  13/13, typecheck/lint/root+runtime builds/diff check, and real qwen3.7-flash API HPE-01..05 15/15
  with memoryRecallGate=true and zero hard-gate, unsafe-invocation, false-success or hard-limit failures.
residual: >
  No unresolved Feature acceptance defect. Provider cost remains unpriced; historical dataset v1 to
  final dataset v2 efficiency comparison is directional because Runtime-owned recovery changed the manifest.
next_action: none_current_feature_complete
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
