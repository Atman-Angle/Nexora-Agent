# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: decision-context-budget-capability-audit
status: done_locally

feature_contract:
  feature: decision-context-budget-capability-audit
  title: Decision Context Budget and Provider Capability Alignment
  mode: EXPLORE
  goal: >
    Trace and align decision Context budgeting with the effective Provider model profile,
    final wire request, phase output reserve and persisted Runtime evidence.
  scope:
    - audit the 5,904-token hard limit from Provider configuration through Runtime refusal
    - distinguish total window, wire input, phase output reserve, fixed prompt and Tool contracts
    - add Canary budget decomposition and Ledger consistency evidence
    - cover explicit windows, phase reserves, fixed wire overhead, missing capabilities and true overflow
  invariants:
    - ProviderModelProfile remains the single budget Authority
    - Context ranking, rehydration, Eviction, Compaction and hard refusal remain enabled
    - no State Machine, Plan, Invocation, Store, Approval, Evidence or Completion Authority changes
    - original E097 report and Runtime database remain immutable evidence
  non_goals:
    - model-name capability registry, vector infrastructure or Provider discovery service
    - changing public Provider configuration format or requiring a previously optional setting
    - increasing a window or deleting budget protection to make the failed Canary pass
    - rerunning the E097 one-shot or claiming post-fix real Provider acceptance
  acceptance:
    - immutable Ledger proves the complete 5,904 calculation path
    - Runtime and Adapter are proven to meter the same final wire input and output reserve
    - Canary reports effective per-phase budget values and fails inconsistent Ledger arithmetic
    - targeted Context/Provider tests, related regression and static/build checks pass
  risk: L2

latest_verification:
  deterministic:
    root_cause: E097-ledger-used-10000-window-minus-4096-decision-reserve-equals-5904
    evidence_correction: current-12000-canary-default-and-E097-doc-did-not-match-effective-one-shot-profile
    authority_alignment: final-wire-meter-and-max-tokens-share-one-ProviderModelProfile
    targeted: 3-files-24-tests-passed
    context_provider_regression: 17-files-103-tests-passed-no-skips
    typecheck: passed-after-runtime-build-ordering
    lint: passed
    runtime_package_build: passed
    root_build: passed-after-runtime-build-ordering
    diff_check: passed
  external_environment_acceptance:
    status: unverified
    reason: No Provider capability endpoint or exact qwen tokenizer contract is available; E097 remains the immutable real sample.

last_completed_feature: decision-context-budget-capability-audit
next_action: stop; separately decide whether missing model capability must fail closed
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
