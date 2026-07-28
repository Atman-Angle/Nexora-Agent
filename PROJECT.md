# PROJECT.md — Nexora 产品目标与 1.1 范围

## 1. 产品定义

Nexora 的长期产品目标不变：

> 可直接使用的通用桌面 Agent，同时也是可被其他 AI 应用复用的 Agent Runtime。

Nexora 1.1 当前交付的是这套产品的可信执行内核：

```text
自然语言 CLI
Node.js / TypeScript @nexora/runtime
```

Desktop、Server 和跨语言接入尚未实现，不是 1.1 的生产入口。它们未来必须复用同一 Runtime，不能建立旁路状态、执行或完成机制。

## 2. 核心结果

同一 Runtime 必须可靠完成：

```text
接收自然语言目标
→ 持久化输入与 Run
→ 生成并维护 Run-owned Structured Plan
→ 选择并调用真实 Tool
→ 在写入或执行前等待批准
→ 持久化 Invocation、结果与 Evidence
→ 经过确定性完成检查和独立语义验证
→ 由 State Machine 写入成功
→ 中断后依据持久化事实恢复
```

第一阶段最重要的六件事仍是：

```text
目标不丢
状态不乱
上下文不漂
动作可执行
结果可验证
中断可恢复
```

## 3. 任务形态

简单回答、少量 Tool 操作和多步骤 Agent 任务是不同复杂度的任务形态，不是三套 Runtime 模式。1.1 全部走同一个 `RuntimeEngine`、Run Loop、State Machine、Store、Approval 和 Completion Gate。

## 4. 成功定义

必须区分：

```text
Tool 执行成功
Invocation 结果持久化
Evidence 满足 Plan Check
确定性完成检查通过
语义验证通过
Run 成功
```

模型、Tool、CLI 或宿主应用都不能自行宣布成功。只有持久化 `RunSnapshot.status === "succeeded"`，并能反查 Result、Evidence、succeeded Invocation、`validation.passed` 和 `run.succeeded`，才是成功。

## 5. 1.1 唯一真值

| 数据 | 唯一 Authority |
| --- | --- |
| 原始与追加输入、Task Contract、当前 Plan、Step Progress、Pending Request、Evidence、Result | `runs.snapshot_json` 中的 `RunSnapshot` |
| Run Status | State Machine；持久化到 `runs.status` 与同一 snapshot |
| Tool 副作用、结果与恢复判断 | `tool_invocations` |
| 过程审计顺序 | 只追加 `run_events`；不能反向覆盖状态 |
| 大内容和被拒绝原始 Action | 内容寻址 `.nexora/artifacts` |
| 工作区最新文件事实 | Filesystem / Git |

1.1 没有独立 Task Store、Progress Ledger、Checkpoint Store、Execution Record Store 或第二 Evidence Store。恢复位置由 Run Snapshot 与未决 Tool Invocation 共同确定。

## 6. 可复用边界

1.1 已实现的扩展与调用边界只有：

- `createRuntime` / `RuntimeEngine` 公共 API；
- `RuntimeProvider`；
- 五层 Contract 的 `RuntimeTool`；
- Runtime observer；
- CLI 或其他 Node.js/TypeScript 宿主。

宿主可以提供 Provider、Tool、输入和恢复决定，但不得绕过 Run Store、State Machine、Approval、Evidence、Validation 或 Completion Gate。未来的 Agent Definition、Skill、MCP、Renderer 或 Adapter 必须遵守同一边界，当前不作为已实现能力。

## 7. 1.1 非目标

- Desktop / Electron UI；
- HTTP Server、RPC 和跨语言 SDK；
- 固定多 Agent 链；
- Workflow 编辑器；
- Skill 市场与 MCP；
- Cron / Channel / Remote Node；
- 云端多租户；
- 自动生产发布；
- 自我修改；
- 默认向量数据库；
- 全 Rust 重写；
- 迁移或恢复 1.1 之前的数据库。
