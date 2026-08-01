# ARCHITECTURE.md — Nexora 核心架构

本文件同时描述长期产品边界和当前 1.1 Runtime 实现。第 1–8 节定义必须长期保持的架构方向与 Authority；第 9 节记录当前真实仓库结构。尚未出现真实调用方的 Context Provider、MCP、Skill 等能力不是当前已实现模块；Desktop 已由 `PROJECT.md` 明确排除在产品方向之外。

## 1. 总体结构

```text
Host Application / CLI / Service
              ↓
       Runtime Gateway
          ↓
Execution Kernel
    ├── Context Intelligence
    ├── Model Gateway
    ├── Action Runtime
    ├── Evidence & Verification
    └── Invocation Recovery
          ↓
State / Event / Artifact / Workspace
```

## 2. 六个核心域

六个核心域是能力边界，不要求一域对应一个 package。当前 1.1 将已实现能力收敛在单一 `@nexora/runtime` 包内；未实现能力不得用空目录、Stub 或第二套状态提前占位。

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
Fresh External Facts
```

上下文不是完整聊天历史，而是每轮从权威事实构建的有界决策输入。Working Set、Retrieval、Compaction 和 Rehydration 只是未来候选方向；只有真实应用或可重复实验暴露有界上下文问题，并由独立 Feature Contract 授权后才进入实现。

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

当前 1.1 每轮只允许一个主 Action：

```text
set_plan
call_tool
request_input
propose_finish
```

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
│           ├── runtime-execution.ts
│           ├── validation.ts
│           ├── runtime-types.ts
│           ├── runtime-helpers.ts
│           ├── contracts.ts
│           ├── run-store.ts
│           ├── state-machine.ts
│           ├── model-client.ts
│           ├── openai-compatible-provider.ts
│           ├── artifacts.ts
│           └── tool-runtime/
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
