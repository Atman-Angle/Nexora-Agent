# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: memory-promotion-supersession
status: done_locally

feature_contract:
  feature: memory-promotion-supersession
  title: Memory Promotion and Supersession
  mode: VERIFY
  goal: >
    Turn untrusted Memory candidates into auditable active Memory through one
    explicit lifecycle, preserving immutable provenance and replacement history.
  scope:
    - extend Memory status with candidate, superseded and expired lifecycle states
    - promote candidates explicitly or only after persisted verification
    - deterministically deduplicate exact scoped type/statement/sensitivity matches
    - atomically supersede one active Memory for update or multiple active Memories for merge
    - preserve predecessor records and bidirectional replacement lineage
    - expire due candidate/active records and explicitly revalidate eligible records
  invariants:
    - model-produced text is candidate data and never becomes active without promote or supersede
    - statement, source provenance, scope and memoryId are immutable after create
    - update and merge use the same atomic supersession path instead of in-place content mutation
    - predecessor Memory remains auditable and can never be active after successful replacement
    - every read and lifecycle write retains exact user/project/workspace/branch scope isolation
    - Memory never modifies Run Authority and Context still does not consume Memory
  non_goals:
    - automatic extraction from Provider output or automatic promotion policy
    - fuzzy/semantic conflict resolution, embeddings, full-text search or vector retrieval
    - Context recall/injection, user-facing controls or deletion propagation
    - restoring superseded/expired/invalidated records to active
    - changing runtime-v1.1.db, RunStore or Execution Core Authority
  acceptance:
    - explicit promotion activates an unverified candidate with actor/time provenance
    - verified promotion rejects unverified candidates and activates verified candidates
    - exact duplicate promotion leaves one active Memory and marks the duplicate candidate superseded
    - superseding one or many active records commits replacement and every lineage link atomically
    - missing, wrong-scope, non-active predecessor or unchanged replacement rejects with no partial writes
    - due candidates/active records become expired and revalidation updates only eligible records
    - every lifecycle and lineage survives close/reopen
    - targeted tests, Runtime regression, typecheck, lint and builds pass with no relevant skips
  risk: L2

latest_verification:
  deterministic:
    red_to_green: 8 scenarios failed because the old Contract rejected candidate status
    targeted: 1-file-8-tests-passed
    memory_regression: 2-files-16-tests-passed
    lifecycle: explicit-and-verified-promotion-dedupe-expire-revalidate-passed
    supersession: single-and-multi-predecessor-atomic-lineage-passed
    recovery: repeated-promotion-and-restart-supersession-idempotency-passed
    negative: missing-wrong-scope-non-active-unchanged-and-manual-bypass-passed
    full_regression: 63-files-281-tests-passed-no-skips
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    built_public_api: candidate-promote-active-and-error-export-passed
    diff_check: passed
  external_environment_acceptance:
    status: not_applicable
    reason: This Feature has no Provider, retrieval or external service path.

last_completed_feature: memory-promotion-supersession
next_action: stop; activate bounded-memory-recall only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
