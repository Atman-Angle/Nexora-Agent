# ARCHITECTURE.md — Nexora 核心架构

本文件同时描述长期产品边界和当前 1.1 Runtime 实现。第 1–8 节定义必须长期保持的架构方向与 Authority；第 9 节记录当前真实仓库结构。尚未出现真实调用方的 Context Provider、MCP、Skill 等能力不是当前已实现模块；Desktop 已由 `PROJECT.md` 明确排除在产品方向之外。

## 1. 总体结构

```text
Host Application / CLI / Service
              ↓
       Runtime Gateway
          ├── Execution Kernel
          │   ├── Context Intelligence
          │   ├── Model Gateway
          │   ├── Action Runtime
          │   ├── Evidence & Verification
          │   └── Invocation Recovery
          └── Memory
          ↓
State / Event / Artifact / Workspace
```

## 2. 七个核心域

七个核心域是能力边界，不要求一域对应一个 package。当前已实现能力收敛在单一 `@nexora/runtime` 包内；未实现能力不得用空目录、Stub 或第二套状态提前占位。

### Core Contracts

统一定义：

```text
TaskContract
Run
RuntimeAction
StructuredPlan
RuntimeTool
ToolInvocation
Event
Artifact
Approval
ValidationResult
Evidence
Result
```

### Execution Kernel

包含：

```text
Run Manager
State Machine
Agent Loop
Budget
No-progress
Cancellation
```

### Context Intelligence

包含：

```text
Input History
Task Contract
Structured Plan
Tool Observations
Session Archive
Fresh External Facts
```

上下文不是完整聊天历史，而是每轮从权威事实构建的有界决策输入。当前 Context Projection 不再把完整 `RunSnapshot` 交给 Provider：`TaskContract.inputVersion` 之前的输入由当前 Task Contract 覆盖，模型只接收尚未覆盖的新输入；Tool Observation 由 active Check、未解决错误、安全失败和已完成 predecessor Evidence 投影。确定性 Eviction 先按 retention class，再按 `stepOrder → invocationSequence → invocationId` 排序；大型 critical payload 保留固定片段与精确引用，普通大 payload 转为引用。8 条是普通候选默认值，32 KiB 是序列化保险丝，最终收缩由 Provider-aware Token Meter 的 soft/hard limit 驱动。每份最终投影带稳定 digest，但 digest 不拥有 Run 状态。

Session Archive 是同一 Run 的有界历史索引，不是第二个 Memory Store。它只发布已持久化 Input/Event 的 sequence 范围，以及最多 16 条由 Input、Plan 修订、失败、拒绝、Checkpoint 和 Branch Event 确定性派生的 Milestone；首个目标 Input、最新 Input 和每种已出现的 Event 类别各保留一个代表，其余位置再按既有安全优先级与时间填充，避免重复失败淹没其他导航入口。标签最长 180 字符，只用于导航。模型可对范围内的 `input:<sequence>` / `event:<sequence>` 使用既有 `request_context`，Runtime 再从 Run/Input/Event Authority 精确恢复原始内容。删除 Archive 投影不影响任何事实，下一轮可从 Store 重建。

`historyCandidates` 是与当前任务相关的有界关系导航，不是全文、向量或 Memory 检索。Runtime 只从当前 Run Authority 与显式 Fork Base 确定性派生最多 8 条、合计不超过 4 KiB 的候选，关系包括同 Check、Step、Tool、精确 Input、路径、错误码，以及已关联的 Evidence、Artifact、Approval 和 Fork Base。每条只携带 `ref`、少量 `relatedRefs`、category、reasons、hint 与 occurredAt，不复制历史事实；模型必须通过 `request_context` 才能读取原始内容。候选 ref 进入同一 digest/作用域 manifest，sibling、其他 Run 和 parent post-fork 内容不可见。删除候选投影不会删除事实，也不新增表、索引、模型调用或 Authority。

每次 decision/validation 调用前，Runtime 由 Provider 自己声明的模型容量、输出预留、软阈值和 Token Meter 评估投影。硬上限拒绝发生在 Provider 调用前，软上限允许调用但进入持久化 Model Call Ledger；Provider 返回 usage 时同时保留实测值。Ledger 只拥有模型调用与计费审计，不拥有任务事实、Plan、Evidence 或 Run Status。

Structured Compaction 是 Eviction 之后的第二层收缩：当 Eviction 耗尽且 Decision 上下文仍超过 Token 预算时，Runtime 调用 Provider 生成结构化 Summary（目标/约束、已完成工作、关键决策、未解决问题、相关 Artifact），每条陈述必须携带可解析到 Input、Invocation、Evidence、Event 或 Artifact 的 sourceRefs。首次 Compaction 的 `previousCheckpoint` 为 `null`；重复 Compaction 只向 Provider 发布 latest Checkpoint 的 `{ digest, summary }`，且该 Checkpoint 已先针对当前 Authority 完整重验。Checkpoint ID、Source Digest map 与 covered Invocation list 不进入 Provider Contract。Provider 必须返回一份完整替代 Summary，而不是增量或嵌套 Summary；Checkpoint ID/digest 不能作为 SourceRef，陈述仍必须追溯到原始 Authority ref。

新 Summary 写入前必须通过 Schema、引用存在性、Run 归属、Source Digest 与 section 一致性校验。后续复用 Checkpoint 时，Runtime 还会重新计算 canonical Summary digest，重新解析并验证全部原始 SourceRef，精确比较重新派生的 Source Digest map 和 covered Invocation multiset；任一项不一致就使缓存失效。`unresolvedIssues` 中的 failed/unknown Invocation 如果已有同 Plan、同 Step 且覆盖同一 Check 的后续成功 Invocation，就不再是 unresolved，不能被下一轮 Summary 继续携带。验证通过后，Store 在一个事务中删除旧行并写入唯一新行；失败或拒绝的 Summary 不替换现有有效缓存，决策沿用安全回退路径。Checkpoint 始终是 Prompt 派生缓存，不拥有 TaskContract、Plan、Invocation、Evidence、Run Status 或 Completion Authority；删除全部 Checkpoint 后 Runtime 必须从 Authority 确定性重建 Decision Projection。

Provider-neutral Context 到生产 Wire 还有最后一层有界投影。OpenAI-compatible Adapter 必须把 `contextCheckpoint`、`rehydratedFacts`、`historyCandidates` 和当前 `repair` 交给 Decision 模型，同时继续移除 `projection` digest 元数据和 Tool Observation 的 Runtime-only provenance。Eviction 只允许改变 `toolObservations` 的 payload retention；重建 Context 时必须原样保留 Checkpoint、Rehydrated Facts、History Candidates、Session Archive 和 Repair，并把这些实际可见字段纳入新的 projection digest。该投影不保存 Provider transcript，也不产生第二套 Context 状态。

### Memory

Memory 是 Runtime 的通用连续性子系统，但不是 Execution Core 的 Run Authority。Host 通过公开 Contract 提供稳定的 user/project/workspace/可选 branch identity 与 `stateDir`；Runtime 在独立 `<stateDir>/memory-v1.db` 中保存严格 `MemoryRecord`、来源 `{sourceRunId, ref, digest}`、verification、status 和 sensitivity。相同 scope 内相同 ID/内容的创建可安全重试，不同内容冲突必须拒绝；所有读取、状态修改和删除都要求完整精确 scope，错误 scope 返回不存在而不泄露记录。

Memory 生命周期只有一条内容变更路径：模型或其他不可信来源先形成 `candidate`；Host 再以带 actor/time 的 explicit promotion，或在 Memory 已携带 persisted verification 后以 verified promotion 转为 `active`。Promotion 对同 scope 的 type/statement/sensitivity 做精确确定性去重；重复候选保留为 `superseded` 并指向既有 active Memory。内容不原地更新：新 candidate 替换一个 active predecessor 表示 update，替换多个表示 merge；同一事务把 replacement 激活、把全部 predecessor 标为 superseded，并保存双向 lineage。到期 candidate/active 通过显式 `expire` 转为 `expired`，重新验证只更新 eligible candidate/active 的 verification。生命周期操作支持相同请求安全重试，不能用通用 `setStatus` 绕过 promotion 或 supersession。

Memory 与 `context/`、`execution/` 平级，不能写入 `runtime-v1.1.db`，也不能修改 RunSnapshot、TaskContract、Plan、Invocation、Evidence、Approval、Result 或 Run Status。Host 可在 `createRuntime.memory` 显式注入共享 Memory Store 与 exact scope；Runtime 不拥有或关闭该 Store。Context 只确定性扫描 exact-scope 的 active、未过期、normal Memory，投影最多 6 条、768 estimated tokens / 4 KiB 的 `memoryCandidates`。候选不复制 statement；模型必须用候选的 `memory:<id>` 调用 `request_context`，下一轮重新校验 scope、lifecycle、expiry、sensitivity 与 record digest 后才恢复完整 MemoryRecord。当前 Input、TaskContract、Plan、Progress 与 Evidence 始终优先。

`MemoryControls` 是 Host 面向用户动作的审计化入口，复用同一个 Memory Store，不成为第二数据 Authority。Inspect 返回 exact-scope Record、Source 与当前召回资格；Correct 必须创建 candidate 并走原子 Supersession；Invalidate、Delete、Clear Scope 和 Scope Recall Policy 都要求 operationId、actor、reason 与 occurredAt。每个 mutation 与无正文 audit tombstone 在同一 SQLite 事务提交，operationId 在 exact scope 内幂等且内容冲突拒绝。Scope disable 持久化在 `memory-v1.db` 并由 Context 与 Rehydration 同时执行。底层 Store CRUD 保留为数据所有者原语；Host 的用户操作应走 Controls。

Memory 的安全信任边界是“精确但不可信的数据”。`memoryCandidates` 和恢复后的 Memory Fact 都显式携带 `trust: untrusted_memory_data`；statement 中的 system/developer/user 角色声明、工具请求、Approval、Evidence、完成结论或策略覆盖均没有执行语义。生产 Provider Policy 必须把它们当作待与当前 Run Authority 核对的事实主张，不能当指令。未发布、猜测、跨 scope/branch、sensitive、deleted、disabled 或 digest drift 的 Memory ref 统一 `REF_UNAVAILABLE`。Memory 不进入 Tool permission、Approval 或 State Machine，也不能证明 statement 为真；当 Plan 显式声明 required `context_ref` Check 时，Runtime 可在 scope/lifecycle/digest 校验和精确恢复成功后生成 Run-owned `context_ref` Evidence，它只证明该 ref 被恢复，用于 Completion Gate 验证用户要求的恢复过程。Host 仍负责认证和 scope 绑定；磁盘加密、密钥管理与文件系统 secure erase 是部署发布门，不由 Runtime 伪造保证。

Memory 的 SQLite scope/status/type/time 索引和 control-event time 索引都是可丢弃的派生性能结构，不保存独立事实。`MemoryStore` 每次打开都会在既有 Authority 表上幂等确认这些索引；即使 schema version 已是当前版本，缺失索引也会从 `memory_records` 与 `memory_control_events` 重建。重建不迁移 Record、不改变 schema version，也不创建第二数据 Authority。

Provider-aware Context Eviction 同时覆盖可重建的 `rehydratedFacts(origin=harness_helpful)`。该类 Fact 的优先级低于 Tool Observation，应先移除；`harness_required` 与模型显式 `request_context` 恢复的 Fact 不在此路径删除。这样自动 helpful 原文不会在小窗口下形成不可收缩的第二预算池，原始 Invocation/Evidence/Artifact 仍留在 Authority Store 并可再次精确恢复。

### Action Runtime

完整执行管线：

```text
Action
→ Schema
→ Permission
→ Risk
→ Approval
→ Tool Invocation Intent
→ Worker
→ Timeout / Cancel
→ Normalize Result
```

### Evidence & Verification

```text
Model proposes Final
→ Validators
→ Evidence
→ Completion Gate
→ succeeded / return to loop
```

### Invocation Recovery

必须区分：

```text
只读 Tool
幂等写 Tool
非幂等且状态明确
非幂等且状态未知
```

未知副作用不得自动重试。

## 3. 技术边界

长期产品边界：

- 可嵌入的 Node.js/TypeScript Runtime；
- 宿主应用通过公开 Runtime Contract 集成；
- SQLite WAL；
- 本地 Artifact 文件；
- OS Secure Storage；
- Event Stream；
- Rust 只用于测量后确认的热点。

Core 不依赖具体 UI、Web 框架、CLI 或宿主应用。宿主不能直接写 Core Store、Run Status、Tool Invocation 或 Evidence，也不能绕过 Runtime 的权限、Approval 和完成门。

## 4. 每轮 Agent Loop

```text
Load Run
→ Load Input History and Current Plan
→ Project Completed Tool Observations
→ Rehydrate Required Fresh Facts
→ Assemble Bounded Decision Context
→ Call Model
→ Parse Action
→ Validate / Authorize
→ Execute
→ Normalize Result
→ Verify
→ Update Plan Step Progress and Evidence
→ Append Event
→ Persist Run and Invocation State
→ Continue / Wait / Finish
```

## 5. Action 规则

当前 1.1 每轮只允许一个主 Action。Core Runtime Action 仍为四种：

```text
set_plan
call_tool
request_input
propose_finish
```

此外 Harness 控制动作 `request_context` 属于模型可选的第五种动作，但它不是 Core Runtime Action：不进入 `RuntimeActionSchema`、不进入 State Machine、不进入 Core `#handleAction`。模型返回 `request_context` 时，Harness 识别并由 Context 子系统（Rehydration）处理——校验 refs、恢复原始内容、重新投影并继续循环，Run 状态不变。Core 的四种 Action 仍由 `#handleAction` 走状态机。

Approval 不是模型 Action，而是 Runtime 对受保护 `call_tool` 的确定性执行边界。Runtime 内部失败通过 State Machine 进入 `failed`，不是模型可直接选择的成功旁路。

## 6. 数据传输

```text
进程内部 → 强类型对象
跨边界 → JSON Schema
核心状态 → 结构化数据库字段
大内容 → Artifact 引用
实时过程 → Event Stream
```

不要把大型文件、完整日志和代码仓库塞进 JSON。

## 7. 状态所有权

- State Machine 唯一修改 Run Status；
- Run-owned Structured Plan 是唯一当前计划；
- Tool Invocation 是副作用意图、输入、结果和恢复判断的唯一 Authority；
- Evidence 与 validated Run Result 是完成依据；
- Tool 不直接修改 Run；
- Host Application 不直接写 Core Store；
- Model 不直接写状态；
- FileSystem / Git 是工作区最新事实。

## 8. 安全

- Workspace Path Boundary；
- Symlink Escape 防护；
- Command Risk；
- Approval；
- Secret 脱敏；
- Timeout；
- Child Process Cleanup；
- Host Boundary Isolation；
- Skill/MCP 不得绕过权限。


## 9. Repository Structure

Nexora 当前使用轻量 Monorepo，真实生产入口和 Runtime 结构为：

```text
nexora/
├── apps/
│   └── cli/
├── packages/
│   └── runtime/
│       └── src/
│           ├── runtime.ts
│           ├── context/
│           ├── execution/
│           ├── memory/
│           ├── store/
│           ├── validation.ts
│           ├── runtime-types.ts
│           ├── runtime-helpers.ts
│           ├── contracts.ts
│           ├── state-machine.ts
│           └── providers/
├── tests/
│   └── runtime/
├── docs/
├── examples/
└── assets/
```

当前五个 Runtime 内部职责：

| 文件 | 负责 | 不负责 |
| --- | --- | --- |
| `runtime.ts` | start/resume、单一 Run Loop、Plan、Context、Lease 与协调 | Tool Effect、第二套状态 |
| `runtime-execution.ts` | Approval、Invocation、Effect、Evidence 与 Recovery | 宣布 Run 成功 |
| `validation.ts` | Evidence 引证、确定性/语义验证、成功提交 | 创建缺失 Evidence |
| `runtime-types.ts` | Runtime 类型、Tool Result Schema 和内部依赖类型 | 保存运行状态 |
| `runtime-helpers.ts` | Action、Step、Observation、Workspace 和错误纯函数 | Store、Provider 或外部副作用 |

该结构已冻结。后续不因文件行数继续拆分，也不为 MCP、Skill、插件 Registry 或未来宿主预建模块；只有真实调用方、失败证据或性能测量证明需要时才改变边界。

新增目录继续遵循：

```text
当前 Feature 有真实需求和调用方 → 创建
仅存在未来设想或架构图位置 → 不创建
```
