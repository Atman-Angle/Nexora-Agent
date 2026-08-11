# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: bounded-memory-recall
status: done_locally

feature_contract:
  feature: bounded-memory-recall
  title: Bounded Memory Recall
  mode: VERIFY
  goal: >
    Let a Runtime discover a small, relevant set of active scoped Memories and
    restore an exact Memory only after request_context, without weakening current Run Authority.
  scope:
    - add deterministic lexical recall over an explicitly injected Memory Store and exact scope
    - publish bounded Memory navigation metadata in ModelDecisionContext
    - restore exact MemoryRecord content only through request_context(memory:<id>)
    - preserve Memory candidates through eviction and production Provider wire projection
  invariants:
    - current TaskContract, Plan, Progress and Evidence remain authoritative and unchanged
    - only exact-scope active, unexpired and normal-sensitivity Memory is discoverable
    - candidates never copy the Memory statement and exact content requires request_context
    - rehydration rechecks scope, lifecycle, expiry and record digest and otherwise returns REF_UNAVAILABLE
    - Runtime does not own or close the Host-provided Memory Store
  non_goals:
    - automatic extraction, promotion, conflict resolution or deletion propagation
    - embeddings, vector retrieval, full-text indexes or additional model calls
    - automatic statement injection, sensitive Memory recall or cross-scope fallback
    - changing runtime-v1.1.db, RunStore or Execution Core Authority
  acceptance:
    - relevant English and Chinese tasks produce deterministic explainable candidates
    - zero deterministic relevance produces no candidate
    - candidate count, estimated tokens and serialized bytes stay within hard limits
    - wrong-scope, non-active, expired and sensitive Memory never becomes visible
    - request_context restores the exact record; deletion, status or digest drift is unavailable
    - restart, eviction and production wire preserve the supported flow
    - targeted tests, Context/Memory regression, typecheck, lint and builds pass with no relevant skips
  risk: L2

latest_verification:
  deterministic:
    red_to_green: public Context and Runtime lacked Memory candidates, injection and exact restoration
    targeted: E093-1-file-6-tests-passed
    memory_regression: E091-E093-3-files-22-tests-passed
    context_quality_gate: 12-files-80-tests-passed
    relevance: deterministic-English-Chinese-zero-relevance-and-hard-bounds-passed
    isolation: exact-scope-active-expiry-sensitivity-and-no-statement-passed
    rehydration: exact-record-digest-drift-ref-unavailable-and-restart-passed
    production_projection: HTTP-wire-eviction-and-projection-digest-passed
    full_regression: 64-files-287-tests-passed-no-skips-no-unhandled-errors
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    built_public_api: RuntimeMemoryOptions-MemoryCandidate-and-memoryCandidates-exported
    diff_check: passed
  external_environment_acceptance:
    status: deferred
    reason: Real Provider recall quality is the later real-provider-continuity-canary release gate.

last_completed_feature: bounded-memory-recall
next_action: stop; activate memory-user-controls only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
