# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-harness
current_feature: deterministic-history-candidates
status: done_locally

feature_contract:
  feature: deterministic-history-candidates
  title: Deterministic History Candidates
  mode: VERIFY
  goal: >
    Publish a small deterministic set of explainable historical sourceRef
    candidates related to the current task without injecting their content.
  scope:
    - add the authorized public ModelDecisionContext.historyCandidates field
    - derive candidates from current Run Authority and explicit Fork Base only
    - rank same Check, Step, Tool, Input, path and error-code relations deterministically
    - link candidate Invocation, Evidence, Artifact and Approval refs with reasons
    - publish candidate refs to the existing request_context manifest
    - cap the projection at 8 candidates and 4 KiB
  invariants:
    - Run/Input/Event/Invocation/Evidence/Artifact remain the only Authorities
    - candidates are navigation metadata and never claim historical content
    - exact content is restored only by existing request_context scope and digest checks
    - sibling Branch, unrelated Run and parent post-fork facts remain invisible
    - current TaskContract, Plan, Progress and Evidence always outrank candidates
  non_goals:
    - vector, embedding, full-text index or fuzzy semantic search
    - cross-Run Memory, Memory promotion or a new Store/table
    - automatic candidate content injection or new model calls
    - real Provider credential use
  acceptance:
    - repeated builds emit byte-identical ordering and reasons
    - no more than 8 candidates and serialized candidates remain below 4 KiB
    - candidates reach the production Provider Wire and survive Eviction rebuilds
    - requesting a candidate ref restores exact Authority content on the next turn
    - current Run and explicit Fork Base candidates are visible while all other scopes are absent
    - targeted tests, Context quality gate, system validation, full regression,
      typecheck, lint and builds pass with no relevant skips
  risk: L2

latest_verification:
  deterministic:
    red_to_green: >
      The Runtime previously had no relationship-based history candidate
      projection; E090 now publishes bounded refs and restores exact content
      only after request_context.
    targeted: 1-file-5-tests-passed
    related_context_branch_wire: 7-files-61-tests-passed
    context_quality_gate: 12-files-80-tests-passed
    system_validation: 10-tests-passed
    full_regression: 61-files-265-tests-passed-no-skips
    scale: 10001-invocations-8-candidates-2297-bytes-51.084ms
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: not_run
    reason: Real Provider credential use requires separate authorization.

last_completed_feature: deterministic-history-candidates
next_action: stop; activate host-owned-memory-contract-store only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
