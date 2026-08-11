# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: memory-user-controls
status: done_locally

feature_contract:
  feature: memory-user-controls
  title: Auditable Memory User Controls
  mode: VERIFY
  goal: >
    Give Hosts one auditable, exact-scope control surface for users to inspect,
    correct, invalidate, delete, disable, clear and export their Memory state.
  scope:
    - expose MemoryControls over the existing Memory Store and lifecycle
    - persist idempotent mutation audit events without statement content
    - persist exact-scope recall enable/disable policy and enforce it in Context recall
    - support exact-scope inspection, correction, invalidation, deletion, clear and audit export
  invariants:
    - every user mutation requires actor, reason, time and an idempotent operationId
    - correction reuses candidate plus supersession and never edits statement/provenance in place
    - delete and clear audit tombstones never retain Memory statement content
    - every policy, record and audit read/write uses complete exact scope
    - disabled scopes publish no memoryCandidates and cannot rehydrate guessed Memory refs
  non_goals:
    - UI screens, authentication, authorization roles or remote APIs
    - cross-scope bulk administration or implicit parent/child scope inheritance
    - retention schedules, deletion propagation outside memory-v1.db or secure erase guarantees
    - changing runtime-v1.1.db, RunStore, Context candidate format or Execution Core Authority
  acceptance:
    - inspect explains source, lifecycle and current recall eligibility without cross-scope leakage
    - correction atomically activates a replacement and preserves supersession lineage plus audit
    - invalidate/delete/clear and scope recall policy are idempotent and survive restart
    - disabled scope has zero Context candidates; re-enable restores eligible recall
    - audit export is exact-scope, ordered and contains no deleted statement content
    - invalid input, wrong scope and reused operationId with different content reject without partial writes
    - targeted tests, Memory/Context regression, typecheck, lint and builds pass with no relevant skips
  risk: L2

latest_verification:
  deterministic:
    red_to_green: Store CRUD lacked actor-reason-operation audit, scope policy and Host user-control contract
    targeted: E094-1-file-7-tests-passed
    memory_regression: E091-E094-4-files-29-tests-passed
    context_quality_gate: 12-files-80-tests-passed
    inspection: exact-scope-source-lifecycle-eligibility-and-nondisclosure-passed
    correction: candidate-supersession-atomic-lineage-and-idempotency-passed
    deletion: invalidate-delete-clear-tombstone-no-statement-and-scope-isolation-passed
    policy: disable-restart-zero-candidates-reenable-recall-passed
    migration: memory-schema-v1-to-v2-passed
    audit: ordered-exact-scope-export-restart-and-command-conflict-passed
    full_regression: 65-files-294-tests-passed-no-skips-no-unhandled-errors
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    built_public_api: MemoryControls-command-event-inspection-and-factory-exported
    diff_check: passed
  external_environment_acceptance:
    status: not_applicable
    reason: This Feature is a local Host API and SQLite control surface with no external service.

last_completed_feature: memory-user-controls
next_action: stop; activate memory-security-privacy only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
