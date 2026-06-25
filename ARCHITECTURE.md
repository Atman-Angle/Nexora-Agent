# ARCHITECTURE.md — Nexora 核心架构

## 1. 总体结构

```text
Desktop / CLI / Server
          ↓
Runtime Gateway
          ↓
Execution Kernel
    ├── Context Intelligence
    ├── Model Gateway
    ├── Action Runtime
    ├── Evidence & Verification
    └── Checkpoint & Recovery
          ↓
State / Event / Artifact / Workspace
```

## 2. 六个核心域

### Core Contracts

统一定义：

```text
Task
Run
Action
ToolCall
ToolResult
Event
Artifact
Approval
ValidationResult
Checkpoint
Ledger
ExecutionRecord
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
Task Anchor
Progress Ledger
Working Set
Retrieval
Compaction
Rehydration
Workspace Memory
```

上下文不是完整聊天历史，而是为下一步动态构建的工作集。

### Action Runtime

完整执行管线：

```text
Action
→ Schema
→ Permission
→ Risk
→ Approval
→ Execution Record
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

### Checkpoint & Recovery

必须区分：

```text
只读 Tool
幂等写 Tool
非幂等且状态明确
非幂等且状态未知
```

未知副作用不得自动重试。

## 3. 技术边界

第一阶段推荐：

- Electron + React + TypeScript + Vite；
- 独立 Node.js/TypeScript Runtime；
- SQLite WAL；
- 本地 Artifact 文件；
- OS Secure Storage；
- Local JSON-RPC / pipe / socket；
- Event Stream；
- Rust 只用于测量后确认的热点。

Core 不依赖 Electron。

Renderer 不访问：

- Node；
- 文件系统；
- SQLite；
- Shell；
- Secret；
- Model Provider。

## 4. 每轮 Agent Loop

```text
Load Run
→ Load Task Anchor
→ Load Ledger
→ Build Working Set
→ Rehydrate Fresh Facts
→ Assemble Context
→ Call Model
→ Parse Action
→ Validate / Authorize
→ Execute
→ Normalize Result
→ Verify
→ Update Ledger
→ Append Event
→ Save Checkpoint
→ Continue / Wait / Finish
```

## 5. Action 规则

第一版每轮只允许一个主 Action：

```text
tool_call
update_plan
ask_user
request_approval
create_artifact
final
fail
```

只读操作可有限并发，写操作进入单一 Mutation Lane。

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
- Ledger Reducer 唯一修改 Progress Ledger；
- Tool 不直接修改 Run；
- UI 不直接写 Core Store；
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
- Renderer Isolation；
- Skill/MCP 不得绕过权限。


## 9. Repository Structure

Nexora 使用轻量 Monorepo。

推荐总体结构：

```text
nexora/
├── apps/
│   ├── cli/
│   └── desktop/
├── packages/
│   ├── contracts/
│   ├── core/
│   ├── storage/
│   ├── model-gateway/
│   ├── tool-runtime/
│   ├── context/
│   ├── verification/
│   ├── recovery/
│   └── testkit/
├── tests/
│   ├── integration/
│   ├── regression/
│   └── fixtures/
├── specs/
├── docs/
└── .agents/
```

但目录必须按 Feature 逐步创建。

第一原则：

```text
当前 Feature 需要什么
→ 创建什么

当前 Feature 不需要什么
→ 不提前创建空目录、空接口和 Stub
```

F001 阶段只允许建立：

```text
apps/cli
packages/contracts
packages/core
packages/storage
packages/model-gateway
packages/testkit
tests/integration
tests/regression
```

当前禁止提前创建：

```text
apps/desktop
packages/tool-runtime
packages/context
packages/verification
packages/recovery
packages/mcp
packages/skills
packages/commerce
```

目录结构必须服务于真实端到端链路，而不是提前复制完整架构图。
