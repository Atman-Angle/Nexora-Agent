# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: runtime-memory-contract-store
status: done_locally

feature_contract:
  feature: runtime-memory-contract-store
  title: Runtime Memory Contract and Store
  mode: VERIFY
  goal: >
    Give every Nexora Host one Runtime-owned, independently persisted Memory
    contract without making Memory part of Run execution Authority.
  scope:
    - add packages/runtime/src/memory beside context and execution
    - expose strict MemoryRecord, scope, provenance, verification, status and sensitivity contracts
    - expose create/get/list/setStatus/delete/close through openMemoryStore({ stateDir })
    - persist only to <stateDir>/memory-v1.db using SQLite WAL
    - isolate exact user/project/workspace/optional-branch scopes
    - make repeated identical create idempotent and reject ID/content conflicts
  invariants:
    - Memory is a separate Runtime subsystem and never changes Run, Plan, Invocation, Evidence or Status
    - memory-v1.db is independent from runtime-v1.1.db and RunStore migrations
    - Host supplies stable scope identity and stateDir but does not implement another Memory lifecycle
    - Context may later consume a bounded Memory projection but does not own Memory storage
  non_goals:
    - Context recall integration, automatic candidate injection or request_context support
    - Memory extraction, promotion, supersession, conflict merging or forgetting policy
    - vector, embedding, full-text or semantic retrieval
    - provider calls, Research Agent-specific fields or a new public packages/memory package
  acceptance:
    - invalid scope, source ref, digest and verification records fail at the public boundary
    - create/get/list/status/delete work only in the exact supplied scope
    - guessing an ID through another scope returns null and never reveals existence
    - records survive close/reopen and branch scopes remain isolated
    - identical create returns the existing record while changed content for the same scoped ID fails
    - opening and using Memory creates memory-v1.db without creating or modifying runtime-v1.1.db
    - targeted tests, Runtime regression, typecheck, lint and builds pass with no relevant skips
  risk: L2

latest_verification:
  deterministic:
    red_to_green: 7 initial scenarios failed because the public Memory API did not exist
    targeted: 1-file-8-tests-passed
    persistence: create-get-list-status-delete-close-reopen-passed
    isolation: user-project-workspace-branch-and-guessed-id-passed
    database_boundary: memory-v1-created-runtime-v1.1-sentinel-unchanged
    newer_schema_rejection: passed-and-connection-released
    packed_public_api: memory-js-dts-and-built-root-import-passed
    full_regression: 62-files-273-tests-passed-no-skips
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    diff_check: passed
  external_environment_acceptance:
    status: not_applicable
    reason: This Feature has no Provider or external service path.

last_completed_feature: runtime-memory-contract-store
next_action: stop; activate memory-promotion-supersession only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
