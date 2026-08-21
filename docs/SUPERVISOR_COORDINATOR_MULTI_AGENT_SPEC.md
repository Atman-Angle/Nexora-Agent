# Supervisor / Coordinator Multi-Agent Completion Spec

```yaml
feature: harness-supervisor-coordinator
spec_version: completion-review-v1
spec_status: awaiting_user_review
development_authorization: paused_until_spec_approved
mode_after_approval: CONTINUE
risk: L3
target_status: done_locally
```

本文不是从零设计 Multi-Agent。当前工作区已经存在可运行的 Parent → Child delegation 主干；本文只规定尚未完善的部分、必须保留的既有行为，以及把 Feature 诚实收尾到 `done_locally` 所需的证据。

审核通过前不修改实现或测试。审核通过后先保留已完成主路径，只填本文列出的缺口；不得重写 Agent Loop、Branch、Run、Tool Invocation、Evidence、Recovery 或 Completion Gate。

## 1. 当前结论

Multi-Agent 的核心 vertical slice 已经实现，但还不能诚实标记完成。

```yaml
feature: harness-supervisor-coordinator
mode: CONTINUE
scope_status: stable
spec_status: draft
implementation_status: substantial
migration_status: not_applicable
unit_test_status: failed
integration_test_status: failed
uat_status: real_read_only_provider_passed_historically
runtime_status: runnable
security_status: partially_verified
external_dependency_status: qwen_read_only_verified_historically
artifact_status: mixed
resolved_status: verification_blocked
```

阻塞完成的不是“没有 Multi-Agent”，而是以下事实：

- 一部分公开 Policy/Role/Decision Contract 只存在于类型和测试，没有接入真实 Parent Loop；
- accepted batch 在 partial-spawn crash 后缺少足够的恢复输入；
- recoverable Child 可能被当成 discarded 并清理 Branch workspace；
- max concurrency 和 Child Budget 尚未机械接入 delegation path；
- 当前真实 coding canary 没有使用 Worker delegation；
- 定向测试在当前工作区曾因 package `dist` 入口解析失败而未收集；
- Feature 文件仍是 mixed/untracked Git delivery。

## 2. 已完成且必须保留

下列能力已经出现在真实执行路径中。后续开发只能修正缺陷，不得另建第二条路径。

| ID | 已有能力 | 当前代码/测试事实 |
|---|---|---|
| I-01 | delegation 是 Parent Agent Loop 的 semantic control | `nexora_delegate_workers` 经 Harness 编译为 Runtime Action |
| I-02 | delegation 与普通 Tool 互斥 | mixed response 在创建 Child 和 Tool Effect 前拒绝 |
| I-03 | assignments 数量有界 | schema 固定为 2–8 |
| I-04 | Child 是真实持久化 Run | 复用 Branch、ForkBase、Run、Lease、Plan、Invocation、Evidence、Delivery |
| I-05 | Worker objective 隔离 | delegated Child input 只保留 assignment objective，不复制 Parent input history |
| I-06 | Runtime 生成机械身份 | delegationId、assignmentId、branchId、childRunId 写入 Event/lineage |
| I-07 | exact accepted command replay 去重 | 相同 commandRef + assignment fingerprints 复用已创建 Branch |
| I-08 | Worker 不能继续委派 | Child 不暴露 control，Runtime 同时拒绝 forged delegation |
| I-09 | Worker Tool allowlist 双重执行 | Provider projection 与 Runtime dispatch 都使用过滤后的 Tool Catalog |
| I-10 | Child 并发运行并回流 Parent | `Promise.all` 执行 Branch，Parent 通过派生 WorkerObservation 继续 |
| I-11 | Worker Observation 不成为第二 Authority | Observation 从 Branch + Child Run 即时派生 |
| I-12 | active Worker 阻止 Parent 完成 | Completion 前检查仍在执行的 delegated Child |
| I-13 | Child Provider failure 可交付 | Child blocked/failed Delivery 可进入 Parent Observation |
| I-14 | 未处理 Driver error 被封装 | Run 进入现有 failed + Delivery，而不是 silent termination |
| I-15 | Parent 综合质量 guidance 已存在 | finalDeliverable/contribution 编译进 Child objective，join 后要求 Parent 综合 |
| I-16 | 真实只读 Multi-Agent 已跑通 | Qwen 双 researcher、两个 Branch/Child、只用 filesystem.read、Parent join 后综合 |

这些项目在最终验收中仍需从 clean checkout 重跑，但不属于待重新设计的能力。

## 3. 本次收尾范围

只处理 G-01 至 G-10：

```text
G-01  收敛并接入真实 Delegation Policy
G-02  收敛未使用的 Role/Decision/Worker Contract
G-03  修复 partial-spawn crash recovery
G-04  保留 recoverable Child 与 Branch workspace
G-05  机械执行 Worker 并发和 Child Budget
G-06  补全 cancellation / lease / unknown-effect containment
G-07  有界、按 batch 相关的 Worker Observation
G-08  完成真正的 Multi-Agent isolated coding path
G-09  clean-checkout 测试、包外 Consumer 与真实 canary
G-10  API/SOP/状态/Git delivery 对齐
```

明确不增加：

- DAG、Workflow DSL、`dependsOn`；
- Worker-to-Worker message bus；
- 任意深度 Agent tree；
- `any`、quorum、race 或 `best_effort` join；
- 固定 Planner → Executor → Reviewer → Validator pipeline；
- 第二套 Worker/Delegation 状态机；
- WorkerOutcome Store；
- 自动 patch merge；
- 跨机器 Worker scheduler；
- Token/Cost shared ledger；
- GUI、任务看板、插件市场；
- Validator 模型作为 Completion Authority。

## 4. 审核决策

审核本 Completion Spec 等于确认：

1. 保留现有 Parent → Child、单层、每批 2–8 Worker 的架构。
2. V1 只有 `all` join；现有未接入的 `best_effort` Contract 删除或改为非公开候选，不实现。
3. Policy 收敛为 Host/Harness 的三态 `forbidden | allowed | required`，Runtime 不理解自然语言偏好。
4. accepted delegation 必须持久化足够的 assignment 恢复材料，使 partial spawn 可在不再次询问模型的情况下继续。
5. blocked/waiting/unknown Child 保持可恢复，不得被自动当成 discarded 并清理 workspace。
6. “完成 Multi-Agent”必须包含一次真实 Worker 隔离写入、验证和 Parent-controlled adoption；现有单 Agent coding canary 不计入该证据。

任一决策不认可时只修改本文，不开始开发。

## 5. 必须保持的不变量

- State Machine 是 Run Status 的唯一写入者。
- Parent Run-owned Structured Plan 是唯一 Parent 当前计划。
- Child 拥有自己的 Plan、Invocation、Evidence、Result 和 Delivery。
- Tool Invocation 是副作用和恢复判断的唯一 Authority。
- Parent Completion Gate 是 Parent 成功的唯一 Authority。
- Worker 不能委派、写 Parent Store、写 Parent workspace 或宣布 Parent 成功。
- Child Evidence 保持 Child ownership，只能作为 Parent verification input。
- WorkerObservation 是可重建投影，不单独持久化。
- 非幂等且结果 unknown 的 Effect 不自动重试。
- Runtime 不维护 researcher/executor 等业务角色枚举。
- 大 assignment、结果和日志进入 Artifact，不扩张 Event 控制面。

## 6. G-01：接入真实 Delegation Policy

### 当前缺口

`SupervisorStartPolicySchema`、`DelegationIntentSchema` 和 `evaluateDelegationIntent()` 已存在并导出，但没有控制真实 Parent Prompt/Action/Runtime。Parent 默认能看到 delegation control；`enabled`、显式 opt-in 和 max concurrency 没有执行效果。

### 完成要求

收敛为一个实际被 `createAgent()` 消费的 Harness Contract：

```ts
type DelegationPolicy = {
  mode: "forbidden" | "allowed" | "required";
  maxConcurrentWorkers: number; // 2..8
  allowedProfiles?: readonly string[];
  workerToolPolicies?: Readonly<Record<string, readonly string[]>>;
  childBudgets?: Partial<RuntimeBudgets>;
};
```

- `forbidden`：Parent Prompt 不包含 delegation control；forged action 在 Runtime 被拒绝；0 Child。
- `allowed`：至少两个独立目标且存在 context/permission/verification/parallel benefit 时可委派。
- `required`：安全条件满足时必须委派；不满足时请求输入或 blocked，不能静默 Parent-only。
- Worker profile 必须同时存在于 `allowedProfiles` 和 `workerToolPolicies`；未知 profile fail closed。
- reopen 时 Host 必须重新提供不宽于原执行 envelope 的 Policy；不能因重启扩大 Tool 或 Worker 权限。

自然语言用户要求仍保留在原始 Input，但机械 opt-in/opt-out 由 Host Policy 表达。V1 不增加 Multi-Agent 专属字段到 Core Run。

### 验收

- MA-P01 forbidden 隐藏 control，伪造拒绝，0 Child；
- MA-P02 allowed + 单一目标不委派；
- MA-P03 allowed + 两个独立目标可以委派；
- MA-P04 required + 条件不足不静默退化；
- MA-P05 reopen 使用更宽 Policy 被拒绝或按原 envelope 收窄。

## 7. G-02：收敛未接入 Contract

### 当前缺口

`WorkerPolicySchema`、`WorkerAssignmentSchema`、`SupervisorDecisionSchema`、多种 Role、workspaceMode、verification 和 `best_effort` 描述了比真实执行路径更大的公共表面积。除 prompt rendering 和少量测试外，大部分字段没有下游消费者。

### 完成要求

- 只保留至少一个真实调用方正在使用的公开 Contract。
- `profileRef` 对 Runtime 保持 opaque；Role → Tool/Workspace/Budget 的编译留在 Harness。
- V1 canonical helper 只需要 `researcher | planner | executor | reviewer | validator`；alias 由 Host 映射，不扩大 Runtime。
- 删除未执行的 `best_effort`、`review` SupervisorDecision、`recovery` Worker role 等公开承诺，或明确标记为内部/实验且不从 package export 暴露。
- Prompt 中的 workspace/verification 声明必须有真实 Runtime enforcement；无法执行的字段删除，不能只留文案。

### 验收

- 每个公开字段都有发送方、Schema、消费者和测试；
- package-external TypeScript consumer 只能看到已支持 Contract；
- 删除字段不留下第二条兼容路径。

## 8. G-03：partial-spawn crash recovery

### 当前缺口

Runtime 先持久化 `workers.delegation.accepted`，再逐个创建 Child。accepted Event 只保存 assignmentId、objectiveDigest 和 profileRef，不保存可恢复 objective。若进程在创建部分 Child 后崩溃，恢复只能依赖模型再次返回相同 commandRef 和原 assignment 文本；这不是确定性恢复。

### 完成要求

accepted batch 必须保存足够的有界恢复材料：

```text
delegationId
commandRef
assignmentId
ordinal
objectiveDigest
profileRef
objectiveArtifactRef or bounded objective
compiled policy digest
```

- 大 objective 进入 content-addressed Artifact，Event 保存 ref/digest。
- accepted identity 与恢复材料必须先于第一个 Child 创建。
- Recovery 根据 accepted assignments 与 Branch lineage 的差集补齐未创建 Child。
- 已创建 Child 按 assignmentId 复用；不得依赖新的模型决策。
- 相同 commandRef + 不同 fingerprint 返回 typed conflict。
- spawn 失败必须留下可恢复或终态 Delivery，不能停在无解释的 running。

不新增 Delegation table 或第二状态机；优先使用现有 Event、Artifact、Branch、Run、Lease/Fencing。

### 验收

- MA-R01 accepted 后、0 Child 时 crash/restart；
- MA-R02 创建 1/N Child 后 crash/restart；
- MA-R03 全部 Child 创建后、join 前 crash/restart；
- MA-R04 duplicate resume 不重复 Child；
- MA-R05 assignment Artifact 缺失/损坏时 fail closed 并产生 Delivery。

## 9. G-04：保留 recoverable Child

### 当前缺口

当前 delegated `branch.run()` 返回后，只要 Child 不是 succeeded 就把 Branch 标记为 discarded 并清理 Branch workspace。`blocked`、`waiting` 或 unknown-effect Child 仍可能需要原 workspace 和原 childRunId 恢复，不能等同于不可恢复失败。

### 完成要求

- 只有明确 terminal 且无需继续的 Child 才能 close Branch。
- `blocked`、`waiting`、unknown Effect、pending Approval/Input 保持 Branch active 和 workspace durable。
- Parent Observation 明确投影 pending/blocked 原因。
- Parent 可以通过原 childRunId 恢复；不得创建替代 Worker。
- Parent 不得在 recoverable Child 尚未解决时通过 Completion Gate。
- 用户/Host 显式放弃后才 discard，并保留 Event/Delivery/Artifact 历史。

### 验收

- MA-R06 Child Provider blocked 后 workspace 与 Branch 可恢复；
- MA-R07 Child Approval waiting 后重启并批准；
- MA-R08 unknown non-idempotent Effect 不重放；
- MA-R09 显式 discard 后不再恢复执行，但历史可 inspect。

## 10. G-05：机械执行并发与 Child Budget

### 当前缺口

assignments 有 2–8 schema 上限，但 `SupervisorStartPolicy.maxConcurrentWorkers` 和 `WorkerPolicy.budget` 未接入真实 delegation。Child 从 Parent snapshot 继承完整 Budget，多个 Child 可能各自使用完整额度；active Branch 数也未在 accepted 前按 Host Policy 拒绝。

### 完成要求

- accepted 前检查 `activeChildren + newAssignments <= maxConcurrentWorkers`。
- 每个 Child 使用由 Host Policy 编译的明确 RuntimeBudgets，不直接复制 Parent 全额预算。
- Child Budget 不能为 0，不能超过 Parent/Host 允许的硬上限。
- Parent 必须保留至少一次 join 后 decision 的迭代/模型调用余量。
- restart 后 active count 从 Branch + Child Run Authority 重建。
- budget exceed 使用现有 blocked/failed/Delivery，不增加共享 budget state machine。

V1 不实现动态 token/cost allocator；Provider usage 继续只做 audit/telemetry。

### 验收

- MA-B01 超过 max workers 时 0 新 Child；
- MA-B02 每个 Child 使用配置后的预算；
- MA-B03 一个 Child budget exceeded 不造成 Parent silent termination；
- MA-B04 restart 后不能通过重复 command 超卖 slot；
- MA-B05 Parent 保留 join 后综合预算。

## 11. G-06：failure、cancellation 与 lease containment

### 当前缺口

已有 Driver error、Child Provider failure 和手工 Branch restart 测试，但尚未覆盖 delegated batch 的 cancellation propagation、partial spawn lease loss、Child unknown Effect、Observation projection error 和 Parent join 后 Provider failure。

### 完成要求

- Parent cancellation 停止尚未开始的新 Child，并向正在运行的 Child 传播 cancellation 请求。
- 每个 Child 由自己的 State Machine 进入合法状态并产生 Delivery。
- Lease/Fencing conflict 不能重复 spawn、Tool Effect 或 Branch close。
- Child unknown Effect 保持 blocked；Parent Observation 保留该事实。
- Observation projection failure 不丢失 Child Authority；Parent 可重建或如实 blocked。
- join 后 Parent Provider failure 保留全部 Child observations，并可 reopen。

### 验收

- MA-F01 cancel before spawn；
- MA-F02 cancel with multiple running Child；
- MA-F03 lease loss during partial spawn；
- MA-F04 unknown Child Tool Effect；
- MA-F05 projection failure；
- MA-F06 Parent Provider failure after join。

## 12. G-07：有界 Worker Observation

### 当前缺口

`listWorkerObservations(parentRunId)` 当前返回 Parent 所有 Branch 的 observations。随着多轮 delegation 增长，Parent Context 可能重复注入旧 Worker summary；Observation 也没有明确当前 batch/相关性和 Artifact refs 的完整边界。

### 完成要求

- Observation 按 delegationId/assignmentId 可分组和稳定排序。
- Parent 当前 decision 优先投影最新未综合 batch；历史 batch 只作为有界候选/ref。
- 同一 Child outcome 不在连续 Parent turns 重复占用全文上下文。
- summary、Delivery、Evidence refs 和 result Artifact 保持有界；完整内容通过 ref rehydrate。
- Observation 仍从 Child Authority 派生，不新增 WorkerOutcome persistence。
- 冲突、blocked、failed 和 unknown Effect 的事实优先于普通成功摘要，不能被 eviction 静默删除。

### 验收

- MA-O01 两轮 delegation 不重复注入第一轮全文；
- MA-O02 restart 前后 ordering/digest 相同；
- MA-O03 大 Worker result 进入 Artifact/ref；
- MA-O04 blocked/conflict 在预算压力下仍可见；
- MA-O05 sibling Child 不能读取彼此未授权内容。

## 13. G-08：真正的 Multi-Agent coding path

### 当前缺口

`supervisor-real-coding.ts` 目前是单 Agent 直接修改 Parent workspace，没有调用 `nexora_delegate_workers`，因此不能证明 Executor Branch、Reviewer/Validator、Parent adoption 或写入隔离。

### 完成要求

真实 coding canary 必须至少包含：

```text
Parent read-only analysis
→ Executor Worker writes isolated Branch workspace
→ Validator or Parent runs real verification against Branch result
→ Parent inspects patch/artifact and conflicts
→ explicit Parent Approval
→ Parent uses existing Tool path to adopt
→ Parent-owned verification Evidence
→ Parent Completion Gate
```

- Executor 不能写 Parent workspace。
- Child Approval 不批准 Parent adoption。
- Child Evidence 不能直接满足 Parent CompletionRequirements。
- Parent 原文件未涉及字段必须保留。
- 冲突 patch 不自动合并；Parent 修复、请求用户或 blocked。
- 不固定 Worker 数量或强制完整角色流水线；只要求真实隔离写路径和独立验证。

### 验收

- MA-W01 approval 前 Parent workspace 未变化；
- MA-W02 Executor 只在 Branch 中写入；
- MA-W03 verification 真实执行且 exit 0；
- MA-W04 Parent adoption 产生 Parent Invocation/Evidence；
- MA-W05 conflict 时无范围外覆盖和 false success；
- MA-W06 restart 后从原 Branch/Child 继续。

## 14. G-09：可复现验证

### 当前缺口

当前目标测试曾在收集阶段无法解析 `@nexora/runtime` package entry。历史报告声称 16 tests 和真实 Qwen canary 通过，但当前 clean-checkout 可重复性尚未证明。

### 完成要求

建立一个正式目标命令，例如：

```json
{
  "test:supervisor-coordinator": "vitest run <multi-agent suites> --no-file-parallelism"
}
```

必须从 clean checkout 依次证明：

1. install；
2. build/typecheck/lint；
3. Multi-Agent deterministic suites；
4. 受影响 Core Regression；
5. packed external consumer；
6. 真实只读 Qwen canary；
7. 真实 isolated coding canary；
8. reverse inspect；
9. secret scan；
10. Git diff/track 状态。

测试不能依赖先前命令残留的 package-local `dist`。真实 Provider check 缺少凭据时必须明确 `blocked/skipped`，不能把 deterministic pass 写成真实 UAT pass。

## 15. G-10：Contract、文档与 Git delivery

### 完成要求

- `ARCHITECTURE.md`：记录 Parent/Child Authority 与依赖方向，不描述角色业务逻辑。
- `DATA_FLOW.md`：增加 accepted → spawn → child outcomes → observation → Parent verification 流。
- `SYSTEM_SOP.md`：增加正向 delegation 与逆向 Parent/Child 审计流程。
- `docs/BUILD_WITH_NEXORA_RUNTIME.md`：只记录真实公开 API、Policy 和限制。
- `DEVELOPMENT.md`：使用标准 state matrix，不使用自定义 optimistic status。
- 当前全部 Feature 文件 tracked，形成单一可审查 commit 边界。
- 不把 E080/E106 伪装成 Multi-Agent 已通过；若证明无共同根因，作为独立 platform release gate 记录。

## 16. 最终 Acceptance Matrix

| 维度 | 必须通过 |
|---|---|
| Existing vertical slice | I-01 至 I-16 clean-checkout 回归通过 |
| Policy | MA-P01 至 MA-P05 |
| Spawn recovery | MA-R01 至 MA-R09 |
| Budget/concurrency | MA-B01 至 MA-B05 |
| Failure containment | MA-F01 至 MA-F06 |
| Observation/context | MA-O01 至 MA-O05 |
| Isolated write path | MA-W01 至 MA-W06 |
| Public delivery | packed consumer、public inspect、docs/SOP/Git 对齐 |
| Real Provider | read-only Multi-Agent + isolated coding Multi-Agent |

任何相关测试未执行或 skip，Feature 最高只能是 `verification_blocked`。

## 17. Feature Core DoD

只有以下全部成立才能标记 `done_locally`：

- 已完成主路径 I-01 至 I-16 未被回退；
- G-01 至 G-10 全部关闭；
- deterministic acceptance 无 skip；
- partial spawn、recoverable Child、unknown Effect、cancellation 和 restart 可重复；
- Worker Tool、Workspace、Budget 和 depth 在 Runtime 边界执行；
- 真实只读和真实 isolated coding Multi-Agent canary 通过；
- Parent Completion、Evidence ownership 和 Invocation Authority 未被旁路；
- clean checkout 与 packed consumer 通过；
- API、架构、数据流、SOP、开发状态与实现一致；
- Feature 文件 tracked 并形成可审查 Git delivery。

以下不属于本 Feature Core：

- 跨机器 Worker；
- 长期 Workflow；
- GUI；
- MCP；
- OTel exporter；
- 多租户/RBAC；
- 通用 Agent plugin system；
- 生产吞吐、成本或质量优于其他 Agent 的声明。

## 18. 审核通过后的开发顺序

### Phase A — Contract Reconciliation

关闭 G-01、G-02。先让公开 Contract 与真实执行一致，不改变 delegation 主干。

### Phase B — Durable Recovery and Bounds

关闭 G-03、G-04、G-05、G-06。优先写 RED failure-injection tests，再修现有 Runtime path。

### Phase C — Context and Write Completion

关闭 G-07、G-08。完成有界 Observation 和真实 isolated coding path。

### Phase D — Verification and Delivery

关闭 G-09、G-10。运行 clean-checkout、packed consumer、真实 canaries、逆向审计并整理 Git delivery。

每个 Phase 只处理列出的缺口。出现新 persisted table、Run Status、第二 Completion Authority、新重量级依赖或连续三次同根因失败时必须暂停。

## 19. 回滚

若缺口无法在现有 Authority 内修复：

1. 通过 Harness Policy 禁用 delegation control；
2. 保留单 Agent 主路径；
3. 保持既有 Parent/Child/Branch/Event 历史可读；
4. 不删除或改写 Invocation、Evidence、Delivery；
5. 将 Feature 标记为 `blocked`，重新审核新的最小 Contract。

## 20. 当前唯一下一步

用户审核 G-01 至 G-10 和第 4 节六项决策。审核通过后从 Phase A 继续现有实现；不重做 I-01 至 I-16。
