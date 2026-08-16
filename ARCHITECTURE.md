# ARCHITECTURE.md — Nexora 核心架构

本文件同时描述长期产品边界和当前 1.1 Runtime 实现。第 1–8 节定义必须长期保持的架构方向与 Authority；第 9 节记录当前真实仓库结构。尚未出现真实调用方的 Context Provider、MCP、Skill 等能力不是当前已实现模块；Desktop 已由 `PROJECT.md` 明确排除在产品方向之外。

## 1. 总体结构

```text
Host Application / CLI / Service
              ↓
            Harness
   Agent Loop / Prompt Compiler / Context / Memory
   Profile / Planning / Provider Transport
              ↓
     Reliable Effect Runtime
   State Machine / Schema / Approval
   Invocation / Recovery / Evidence / Hard Gate
              ↓
State / Event / Artifact / Workspace
```

Harness 与 Runtime 已物理拆为 `@nexora/harness` 和 `@nexora/runtime`。生产依赖只有 `Harness → Runtime`：Harness 负责全部 Provider/LLM 调用和模型可见的语义工作；Runtime 不导入 Harness、Provider、Context 或 Memory，只固定持久化、并发、安全、恢复和机械完成不变量。Bench 只观察两层并做外部评分，不参与生产决策。

## 2. 七个核心域

七个核心域是能力边界，不要求一域对应一个 package。当前语义域位于 `@nexora/harness`，机械执行域位于 `@nexora/runtime`；未实现能力不得用空目录、Stub 或第二套状态提前占位。

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
Evidence
Result
```

### Execution Kernel

包含：

```text
Run Manager
State Machine
Budget
Cancellation
Lease / Fencing
Recovery
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

上下文不是完整聊天历史，而是每轮从权威事实构建的有界决策输入。当前 Context Projection 不再把完整 `RunSnapshot` 交给 Provider，但会持续投影全部原始用户输入；Task Contract 只是工作表示，不能覆盖或隐藏输入。Tool Observation 由 active Check、未解决错误、安全失败和已完成 predecessor Evidence 投影。确定性 Eviction 先按 retention class，再按 `stepOrder → invocationSequence → invocationId` 排序；大型 critical payload 保留固定片段与精确引用，普通大 payload 转为引用。8 条是普通候选默认值，32 KiB 是序列化保险丝，最终收缩由 Provider-aware Token Meter 的 soft/hard limit 驱动。每份最终投影带稳定 digest，但 digest 不拥有 Run 状态。

Session Archive 是同一 Run 的有界历史索引，不是第二个 Memory Store。它只发布已持久化 Input/Event 的 sequence 范围，以及最多 16 条由 Input、Plan 修订、失败、拒绝和 Branch Event 确定性派生的 Milestone；首个目标 Input、最新 Input 和每种已出现的 Event 类别各保留一个代表，其余位置再按既有安全优先级与时间填充，避免重复失败淹没其他导航入口。标签最长 180 字符，只用于导航。最新 Input 明确包含范围内的 `input:<sequence>` / `event:<sequence>` 时，Harness 在 Provider 决策前通过 Runtime port 从 Run/Input/Event Authority 精确恢复原始内容。删除 Archive 投影不影响任何事实，下一轮可从 Store 重建。

`historyCandidates` 是与当前任务相关的有界关系导航，不是全文、向量或 Memory 检索。Harness 只从 Runtime 提供的当前 Run Authority 与显式 Fork Base 确定性派生最多 8 条、合计不超过 4 KiB 的候选，关系包括同 Check、Step、Tool、精确 Input、路径、错误码，以及已关联的 Evidence、Artifact、Approval 和 Fork Base。每条只携带 `ref`、少量 `relatedRefs`、category、reasons、hint 与 occurredAt，不复制历史事实；最新 Input 明确点名候选 ref 或 active `context_ref` Check 要求该 ref 时才自动读取原始内容。候选 ref 进入同一 digest/作用域 manifest，sibling、其他 Run 和 parent post-fork 内容不可见。删除候选投影不会删除事实，也不新增表、索引、模型调用或 Authority。

每次 decision 调用前，Harness 根据 Provider 声明的模型容量、输出预留、软阈值和 Token Meter 评估最终 wire 投影。soft/hard 判定驱动确定性 Context 收缩；收缩结束后 Harness 仍通过唯一 Provider 路径发送最小投影，并通过 Runtime port 把最终判定写入持久化 Model Call Ledger。Context 预算判定不直接修改 Run Status；若 Provider 拒绝容量或不可用，则作为真实 Provider 失败处理。Provider 返回 usage 时同时保留实测值；Ledger 中的 actual usage 不被校准值改写，只拥有调用审计，不拥有任务事实、Plan、Evidence 或 Run Status。

Context 收缩只有一条确定性路径：Harness 先移除内部导航候选和可重建 helpful facts，再按保留等级将 Tool payload 从 full 降为 fragment、reference 或省略，必要时继续缩减其余可重建字段，并在每次变化后按 Provider Token Meter 重新计量，直到进入 hard limit 或没有合法收缩动作。这个过程不调用 LLM、不生成 Summary、不保存 Checkpoint，也不改变 Runtime Authority；即使最小投影的估算仍高于 hard limit，也由 Provider 调用返回真实结果，而不是由 Context 协议直接终止 Run。原始 Input、Invocation、Evidence、Event 与 Artifact 仍保留在 Authority 中。

Provider-neutral Context 到生产 Wire 还有最后一层有界投影。OpenAI-compatible Adapter 每轮只投影当前任务、计划、工作集、最近结果、必要恢复事实和可用 Tool；`historyCandidates`、`memoryCandidates` 与 Session Archive 只供 Harness 选择精确事实，不进入生产 wire。空的可选集合直接省略。Adapter 还移除 workspace、内部 ID/version、Evidence、Plan/Step/Check 结构、`projection` digest 和 Observation provenance。所有实际可见字段仍纳入 Provider-neutral projection digest。该投影不保存 Provider transcript，也不产生第二套 Context 状态。

### Memory

Memory 是 Harness 的独立 Store Authority，不是 Runtime 的 Run Authority。Host 通过 Harness 公开 Contract 提供稳定的 user/project/workspace/可选 branch identity 与 `stateDir`；Memory Store 在独立 `<stateDir>/memory-v1.db` 中保存严格 `MemoryRecord`、来源 `{sourceRunId, ref, digest}`、verification、status 和 sensitivity。Provider、Agent Loop 和 Runtime 都不能直接修改 Memory Record；所有变更只通过 Memory Store/Controls Contract。

Memory 生命周期只有一条内容变更路径：模型或其他不可信来源先形成 `candidate`；Host 再以带 actor/time 的 explicit promotion，或在 Memory 已携带 persisted verification 后以 verified promotion 转为 `active`。Promotion 对同 scope 的 type/statement/sensitivity 做精确确定性去重；重复候选保留为 `superseded` 并指向既有 active Memory。内容不原地更新：新 candidate 替换一个 active predecessor 表示 update，替换多个表示 merge；同一事务把 replacement 激活、把全部 predecessor 标为 superseded，并保存双向 lineage。到期 candidate/active 通过显式 `expire` 转为 `expired`，重新验证只更新 eligible candidate/active 的 verification。生命周期操作支持相同请求安全重试，不能用通用 `setStatus` 绕过 promotion 或 supersession。

Memory 与 `context/` 同属 Harness，但保持独立 Store Authority；它不能写入 `runtime-v1.1.db`，也不能修改 RunSnapshot、TaskContract、Plan、Invocation、Evidence、Approval、Result 或 Run Status。Host 可在 `createAgent.memory` 显式注入共享 Memory Store 与 exact scope；Agent 不拥有或关闭该 Store。Harness 只确定性扫描 exact-scope 的 active、未过期、normal Memory，投影最多 6 条、768 estimated tokens / 4 KiB 的 `memoryCandidates`，并在 Provider 决策前重新校验 scope、lifecycle、expiry、sensitivity 与 digest。

`MemoryControls` 是 Host 面向用户动作的审计化入口，复用同一个 Memory Store，不成为第二数据 Authority。Inspect 返回 exact-scope Record、Source 与当前召回资格；Correct 必须创建 candidate 并走原子 Supersession；Invalidate、Delete、Clear Scope 和 Scope Recall Policy 都要求 operationId、actor、reason 与 occurredAt。每个 mutation 与无正文 audit tombstone 在同一 SQLite 事务提交，operationId 在 exact scope 内幂等且内容冲突拒绝。Scope disable 持久化在 `memory-v1.db` 并由 Context 与 Rehydration 同时执行。底层 Store CRUD 保留为数据所有者原语；Host 的用户操作应走 Controls。

Memory 的安全信任边界是“精确但不可信的数据”。`memoryCandidates` 和恢复后的 Memory Fact 都显式携带 `trust: untrusted_memory_data`；statement 中的 system/developer/user 角色声明、工具请求、Approval、Evidence、完成结论或策略覆盖均没有执行语义。生产 Provider Policy 必须把它们当作待与当前 Run Authority 核对的事实主张，不能当指令。未发布、猜测、跨 scope/branch、sensitive、deleted、disabled 或 digest drift 的 Memory ref 统一 `REF_UNAVAILABLE`。Memory 不进入 Tool permission、Approval 或 State Machine，也不能证明 statement 为真；当 Plan 显式声明 required `context_ref` Check 时，Runtime 可在 scope/lifecycle/digest 校验和精确恢复成功后生成 Run-owned `context_ref` Evidence，它只证明该 ref 被恢复，用于 Completion Gate 验证用户要求的恢复过程。Host 仍负责认证和 scope 绑定；磁盘加密、密钥管理与文件系统 secure erase 是部署发布门，不由 Runtime 伪造保证。

Memory 的 SQLite scope/status/type/time 索引和 control-event time 索引都是可丢弃的派生性能结构，不保存独立事实。`MemoryStore` 每次打开都会在既有 Authority 表上幂等确认这些索引；即使 schema version 已是当前版本，缺失索引也会从 `memory_records` 与 `memory_control_events` 重建。重建不迁移 Record、不改变 schema version，也不创建第二数据 Authority。

Provider-aware Context Eviction 同时覆盖可重建的 `rehydratedFacts(origin=harness_helpful)`。该类 Fact 的优先级低于 Tool Observation，应先移除；由最新 Input 明确 ref、最高相关 Memory 或 active `context_ref` Check 触发的 `harness_required` Fact 不在此路径删除。这样 helpful 原文不会在小窗口下形成不可收缩的第二预算池，原始 Invocation/Evidence/Artifact 仍留在 Authority Store 并可再次精确恢复。

Context + Memory Harness 的确定性 Benchmark 按 dataset version 固定场景与 Evidence Contract。v1 保留原有 12 个通用能力场景；v2 追加一个受限 24,384-token qwen calibrated-wire stress 场景，通过真实 OpenAI-compatible Adapter 和本地 HTTP stub 验证 soft-limit 治理、Eviction、Memory 恢复、Tool Evidence 与 Completion Gate 的完整链。Benchmark runner 和 scripted response 只产生测试证据，不进入生产 Runtime，也不成为 Context、Memory、Run 或 Provider Authority；本地结果不能替代真实 Provider 质量评测。

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
Model / Harness proposes Final
→ deterministic Completion hard gate
→ derive Result provenance from current Invocation / Evidence / Artifact Authority
→ all required mechanical Checks satisfied: State Machine succeeds
→ otherwise return a bounded, field-specific repair to the Harness loop
```

Production objective-only Model Plan 不自动生成 Acceptance Check。Plan 只提供导航；只有 Host/Tool Contract 已经声明的 required mechanical Check 才参与完成门。无 Plan 的直接回答可以在没有 Tool/Evidence 时完成，但不能伪造 provenance；一旦存在真实 Tool/Artifact，Runtime 自动把合法当前事实纳入 Result。started/unknown Invocation、虚假或损坏 Evidence、未满足的机械 Check、Pending Approval 和非法状态转换都不能绕过 hard gate。新生产路径没有同步语义 Validator。

### Invocation Recovery

必须区分：

```text
只读 Tool
幂等写 Tool
非幂等且状态明确
非幂等且状态未知
```

未知副作用不得自动重试。

### Durable Run Journal

`run_events` 是唯一 Run 时间线。v7 为每条新记录增加稳定的 schema version、actor、causation/correlation ref、payload digest、前序 digest、record digest 和 completeness；迁移前记录原位保留并标记 `legacy_partial`，不得补造当时不存在的 Provider Attempt、Context Manifest 或 Plan 正文。

`model_calls` 仍是 logical call Authority；`model_call_audits` 只保存该调用的 Context Manifest、capture policy 和 payload provenance，`provider_attempts` 只保存其下的物理请求 Attempt。Harness 构造 Manifest、脱敏 payload 并决定机械重试，Runtime 通过专用 port 原子持久化；具体 Provider Adapter 每次调用只执行一个物理请求。三者都不拥有 Run Status、Plan、Tool Effect、Evidence 或 Result。

公共审计读取只支持单 Run、sequence cursor、有限 type filter 和最多 200 条记录；没有读取全部 Journal 的快捷路径。`RunHandle.modelCallTrace` 可按 logical call 精确读取 Manifest 和 Attempts。Journal/Artifact digest 校验失败后，Runtime 在新的 Provider 或 Tool Effect 前失败。默认 `metadata` 不保存正文；Host 显式选择 `redacted` 时也只保存 Harness 确定性脱敏后的白名单数据，Authorization、Cookie、secret 及 reasoning/thinking 字段不得进入审计 Artifact。

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
→ Parse Semantic Intent
→ Compile Runtime Action
→ Validate / Authorize
→ Execute
→ Normalize Result
→ Verify
→ Update Plan Step Progress and Evidence
→ Append Event
→ Persist Run and Invocation State
→ Continue / Wait / Finish
```

## 5. Prompt、ModelTurn 与内部 Action 规则

Harness 使用固定通用 Kernel 和确定性 Prompt Compiler。稳定前缀按 `Kernel → Transport → Host Policy → Agent Profile → Project Policy → canonical Tool Contract` 组成；Run/Plan/Observation/Repair/最新输入全部位于动态边界之后。Agent Profile 是版本化 strategy-only snapshot，只能影响模型如何工作和表达，不能注册 Tool、授权 Effect、提供事实、批准操作或满足 Completion Gate。每次 Model Call 的 kernel/compiler/Profile/Policy/Tool/Transport/payload/cache digest 进入 Context Manifest；Runtime 只把它当作不透明审计 JSON。

Provider Adapter 每个请求只选择 `native_tools` 或 `json_actions` 一种 Transport。Tool descriptor 的 `inputSchema` 由真实 Zod Schema 编译为 canonical JSON Schema，不从 `inputExample` 推断。Provider Prompt Cache 可为 `disabled`、`automatic` 或由具体 Adapter 明确实现的 breakpoint 模式；缓存命中不复用模型响应，也不跳过 Agent Loop、Runtime 或 Completion Gate。

生产 wire 每轮只接受一个 `ModelTurn`：

```text
{ action: "continue", plan?: { goal?, tasks: [{ objective }] }, toolCalls?: [{ name, arguments }] }
| { action: "request_input", question, reason }
| { action: "finish", text }
```

Provider 只决定可选目标、按顺序排列的 objective-only Task、Tool 与业务参数、澄清问题或最终文本，不提供 Task Contract、Requirement、Plan/Step/Check/Invocation/Evidence ID、version、binding、Approval 或完成状态。Harness 是唯一语义编译器：它从原始输入与 objective-only Plan 派生 Runtime Task Contract，并确定性生成内部 `set_plan`、`call_tool`/`execute_step`、`request_input` 或 `propose_finish`；Runtime 只校验并执行这些机械命令。

Harness 在调用 Provider 前自动恢复最新 Input 明确点名的已发布 ref、最高相关 Memory，以及 active Task 未满足的 `context_ref` Check；成功恢复通过 Runtime port 生成真实 Run-owned Context Evidence，失败仍遵守统一 scope/digest/预算错误。Provider 不需要也不能提交恢复协议命令。

Plan 是可选方向与 provenance，不是 Tool 白名单。Harness 把每个 objective 编译为没有虚假机械 Check 的导航 Step；已注册的安全 Tool 可在没有 Plan 时执行，成功调用始终生成绑定 Invocation 的 Evidence，无 Plan 时使用 `run-unplanned` provenance 而不伪造 Plan Check。Runtime 不从 Tool 调用反推、插入、替换或扩展 Plan。跨轮已确定失败的调用不因 Tool 名或参数相同而被封禁；同批完全重复的幂等读只执行一次，已成功读不会阻塞同批新读；同 Run 中相同非读 Tool/canonical input 的未失败 Invocation 跨 Plan/Step 拒绝重复，非幂等 unknown Effect 永不自动重放。

`repair` 是最近错误及与其精确关联的失败/unknown Invocation 的有界投影，不是策略 Authority。它不携带行为禁令、进度事件白名单或独立 retry counter；Agent Loop 由既有 iteration/model-call/duration 预算约束，`maxRetries` 与 `budgetsUsed.retries` 只计 Tool/Provider 等机械重试。字段级 ModelTurn 错误只丢弃非法字段，已成功的 batch sibling、Plan、Invocation 和 Evidence 保持不变。

Harness 按“已有事实 → Tool 探寻 → 有依据的重试或换路径 → 最后询问用户”引导决策。无 Plan、零 Tool 且存在可用 Tool 时，第一次 `request_input` 不暂停 Run，而作为结构化 repair 返回同一循环；再次明确请求同一类用户专属信息时才进入 waiting。Approval 始终是独立 Runtime 边界，不能与澄清输入合并。

Approval 不是 ModelTurn 权限，而是 Runtime 对受保护内部 Tool Action 的确定性执行边界。Harness 提交的 finish proposal 只含 summary；Runtime 从当前 Run 自动派生 Invocation/Evidence/Artifact provenance，再执行同一个确定性 Completion Gate。无 Plan、无 Tool 的直接答案可以成功；存在 Tool 时只能引用真实、同 Run、digest 一致的成功事实。内部失败仍只通过 State Machine 进入 `failed`，所有终态和外部阻塞都持久化用户可读 Delivery。

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
- Evidence 与通过 Completion Gate 的 Run Result 是完成依据；
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
│   ├── harness/
│   │   └── src/
│   │       ├── agent.ts / agent-loop.ts
│   │       ├── prompt.ts / planning.ts / reasoning-policy.ts
│   │       └── context/ / memory/ / providers/
│   └── runtime/
│       └── src/
│           ├── runtime.ts / agent-runtime-port.ts
│           ├── execution/ / store/
│           ├── completion-gate.ts / state-machine.ts
│           └── contracts.ts / runtime-types.ts
├── tests/
│   └── runtime/
├── docs/
├── examples/
└── assets/
```

当前包职责：

| 文件 | 负责 | 不负责 |
| --- | --- | --- |
| `harness/agent.ts` | `createAgent()` 组合入口和 deprecated `createRuntime()` 单路径 façade | Store、State Machine、Tool Effect |
| `harness/agent-loop.ts` | 唯一 Agent Loop、Provider Decision 校验与调度 | 直接修改 Runtime/Memory Authority |
| `harness/prompt.ts`、`profile.ts` | 通用 Kernel、Profile/Policy snapshot、canonical Prompt 与 cache-stable manifest | 权限、Evidence、Completion 或 Run Status |
| `harness/context/`、`memory/`、`providers/` | Context 收缩/Rehydration、Memory Store/Policy、单一 Provider Transport | Run Status、Invocation、Effect |
| `harness/planning.ts` | ModelTurn 的字段级解析与 Runtime Action 编译 | 生成 Runtime-owned ID、证明或状态 |
| `runtime/runtime.ts`、`agent-runtime-port.ts` | RunHandle、Lease、Plan CAS、机械命令 port、driver 委托 | Provider/LLM、Prompt、Context、Memory 策略 |
| `runtime/execution/` | Tool Schema、Approval、Invocation、Effect、Recovery、Evidence | 语义规划或完成判断 |
| `runtime/store/`、`state-machine.ts` | SQLite Authority、version/CAS、Event、合法状态迁移 | Provider 或 Harness 策略 |
| `runtime/completion-gate.ts` | 机械完成不变量与 Result provenance | 调用 Provider 或判断用户语义目标 |

`@nexora/harness` 只通过 `@nexora/runtime`/`@nexora/runtime/internal` ports 依赖 Runtime；Runtime package 的源代码和依赖清单禁止反向引用 Harness、Provider、Memory 或 Provider-facing Context。`createRuntime()` 只保留一个迁移版本并直接返回 `createAgent(options)`，不保留旧循环。Plan 与首批 read 的组合协议继续关闭，避免在本次边界重构中改变模型调用策略。

后续不因文件行数继续拆分；只有第二个真实调用方、稳定 Provider 证据或性能测量证明需要时才重新打开上述 gate。

新增目录继续遵循：

```text
当前 Feature 有真实需求和调用方 → 创建
仅存在未来设想或架构图位置 → 不创建
```
