# DEVELOPMENT.md — Current Development State

本文件保存当前开发状态。历史 Feature、Canary 和详细验证报告保留在 Git 历史或对应的 `reports/` 文档中。

## Current

```yaml
workspace: D:\Nexora-1.1
branch: context-episodic-recall

current_capability: context-memory-harness
current_feature: memory-security-privacy
status: done_locally

feature_contract:
  feature: memory-security-privacy
  title: Memory Security and Privacy Boundaries
  mode: VERIFY
  goal: >
    Make Memory safe to expose to a decision model as untrusted scoped data,
    while preserving Core Approval, current-task authority and deletion boundaries.
  scope:
    - mark Memory candidates and restored Memory facts as untrusted data
    - add production Provider policy that Memory content is never an instruction or authority override
    - close deterministic scope, sensitivity, guessed-ref and post-delete restoration paths
    - prove Memory content cannot bypass Tool Approval or Core state transitions
  invariants:
    - Memory is persisted user data, never system/developer/user instruction to the Provider
    - latest Input, TaskContract, Plan, Progress and Evidence always outrank Memory
    - only exact-scope active unexpired normal Memory can be published or restored
    - unpublished, guessed, deleted, disabled, sensitive or drifted refs share REF_UNAVAILABLE
    - Memory never grants Tool permission, Approval, Evidence, completion or Run status
  non_goals:
    - Host authentication/authorization, tenant provisioning or remote API policy
    - cryptographic encryption-at-rest, key management or filesystem secure erase guarantees
    - heuristic prompt-injection classifiers, model-based filters or content censorship
    - changing Approval, State Machine, RunStore or Execution Core Authority
  acceptance:
    - production Wire labels candidate and restored Memory as untrusted data and carries explicit policy
    - instruction-like Memory never appears in candidate metadata and cannot replace current task authority
    - cross-scope, branch, guessed and sensitive refs are unavailable without existence disclosure
    - deletion after publication revokes the pending ref and removes statement from live Record/Audit projections
    - malicious Memory followed by a write Tool action still stops at the normal Approval Gate
    - restart and scope disable preserve all security decisions
    - targeted attack tests, Memory/Context regression, typecheck, lint and builds pass with no relevant skips
  risk: L3

latest_verification:
  deterministic:
    red_to_green: exact Memory facts lacked an explicit untrusted-data contract and injection policy
    targeted_attack_suite: E095-1-file-4-tests-passed
    memory_regression: E091-E095-5-files-33-tests-passed
    context_quality_gate: 12-files-80-tests-passed
    prompt_injection: production-wire-trust-policy-current-task-authority-passed
    scope_privacy: cross-project-branch-sensitive-and-guessed-ref-unavailable-passed
    deletion: published-ref-revoked-and-no-statement-in-live-audit-projection-passed
    approval: malicious-memory-write-stopped-before-tool-effect-passed
    ref_encoding: special-and-unicode-memory-id-no-alias-passed
    restart_disable: covered-by-E094-memory-regression
    full_regression: 66-files-298-tests-passed-no-skips-no-unhandled-errors
    typecheck: passed
    lint: passed
    runtime_package_build: passed
    root_build: passed
    built_public_api: trust-markers-exported-in-MemoryCandidate-and-RehydratedFact
    diff_check: passed
  release_gates:
    security_status: release_gate
    open:
      - Host authentication, tenant authorization and exact-scope binding
      - encryption-at-rest, backup deletion, key management and filesystem secure erase
      - real-Provider prompt-injection red-team and measurable attack success threshold
  external_environment_acceptance:
    status: deferred
    reason: Deployment security and real-model red-team require Host infrastructure and Provider execution.

last_completed_feature: memory-security-privacy
next_action: stop; activate memory-performance-rebuild only as a separate Feature
```

## Update Rules

每个 Feature 完成后只更新：

- 当前 Feature 和状态；
- 一句话结果；
- 验证级别与关键证据；
- 已确认的遗留问题；
- 下一步。

不要在本文件长期堆积完整测试输出、长篇根因分析、Run ID 列表或历史 Feature 细节；这些内容应进入 `reports/` 或保留在 Git 历史中。
