# ARCHITECTURE.md — Nexora 1.1 可信执行内核

## 1. 当前生产结构

```text
Natural-language CLI          External Node.js / TypeScript caller
          \                              /
           \                            /
                    @nexora/runtime
                           ↓
                    RuntimeEngine
              single start/resume loop
             /          |          \
 RuntimeProvider   RuntimeTool[]   Validation
             \          |          /
                 RunStore + State Machine
                           ↓
       SQLite: runs / run_events / tool_invocations
       Artifact: .nexora/artifacts
       Workspace: Filesystem / Git
```

1.1 没有 Desktop、Server、Runtime Gateway、RPC 或第二执行内核。CLI 与包外调用方进入同一个 `RuntimeEngine`；CLI 只是输入、交互和输出适配器。

## 2. 核心 Authority

| Authority | 负责 | 不负责 |
| --- | --- | --- |
| `RunSnapshot` in `runs` | 输入历史、Task Contract、唯一当前 Structured Plan、Step Progress、Pending Request、Evidence、Result | 记录 Tool Effect 的执行状态 |
| State Machine | 唯一决定 Run Status 合法转换与成功前置条件 | 调用 Provider 或 Tool |
| `tool_invocations` | Tool Intent、canonical input、结果、错误、unknown 状态、幂等与恢复判断 | 宣布 Run 完成 |
| `run_events` | 只追加审计时间线 | 反推或覆盖当前状态 |
| Artifact Store | 内容寻址的大内容与被拒绝原始 Action | 改变 Run 或 Evidence |
| Filesystem / Git | 工作区当前文件事实 | 保存 Run 生命周期 |

不存在独立 Progress Ledger、Checkpoint Store、Execution Record Store、Task Store 或第二 Evidence Store。恢复位置由当前 Run Snapshot 与未决 Invocation 共同决定。

## 3. 活动模块

| 模块 | 职责 | 可写 Authority |
| --- | --- | --- |
| `contracts.ts` | Run、Plan、Action、Evidence、Invocation 的 Zod Contract 与合法 Action 示例 | 无 |
| `state-machine.ts` | 五状态转换与成功硬门 | Run Status |
| `runtime.ts` | 单一有界循环、上下文投影、Action 路由、Approval、恢复和完成编排 | 只通过 State Machine / RunStore 提交 |
| `run-store.ts` | 三表 SQLite、Revision CAS、Lease/Fencing、原子事务 | 持久化记录 |
| `model-client.ts` / Provider | 读取 Runtime 投影并提出 Action 或语义 Verdict | 无 |
| `tool-runtime/*` | 工作区边界与真实 Effect | Invocation Result，经 Runtime 持久化 |
| `validation.ts` | cited Evidence 的确定性覆盖检查 | 无独立状态 |
| `artifacts.ts` | SHA-256 内容寻址文件 | Artifact |

Runtime 不依赖 CLI、Electron、Web 框架或宿主应用。宿主不能直接写 SQLite 或绕过 Runtime 的 Approval、Evidence 与 Completion Gate。

## 4. 单一 Run Loop

```text
Load persisted Run
→ check active-segment budgets
→ project state-valid Action examples, Tool capabilities and bounded observations
→ call RuntimeProvider.decide
→ parse one RuntimeAction with Zod
→ set_plan | request_input | call_tool | propose_finish
→ atomically persist Run / Event / Invocation changes
→ continue, wait, block, fail or succeed
```

Provider Context 是每轮从 Run、Tool Contract 和 completed Invocation 重建的只读投影，不持久化为第二状态。

## 5. Action 与 Approval

模型每轮只能提出一个：

```text
set_plan
call_tool
request_input
propose_finish
```

- `set_plan` 提议 Task Contract 和 Steps；Runtime 生成 version 与 goal digest。
- `call_tool` 必须绑定 active Step 与 Check，并先通过该 Tool 的真实 input Schema。
- `request_input` 只用于必须由用户提供的信息或决定。
- `propose_finish` 必须明确引用 persisted Evidence。

模型没有 `request_approval`、`final`、`fail` 或 `create_artifact` Action。Approval 由 Runtime 根据 Tool `execution.effect.kind` 确定：read 可直接执行，write/execute 保存 canonical Pending Action 后进入 waiting。批准必须绑定 Pending Request ID，resume 会重新校验同一持久化 Action。

## 6. Tool Contract 与结果

每个 `RuntimeTool` 使用五层 Contract：

```text
Identity
→ Capability
→ Decision
→ Execution(effect / idempotency / inputSchema / inputExample)
→ Evidence(produces / factsSchema)
```

Provider 只看到选择所需信息和 active Tool 的 `inputExample`。Runtime 才读取 Schema、Effect、幂等与 Facts Schema。Tool 返回 typed Facts；Facts 校验通过后才能写 succeeded Invocation 和 Evidence。

## 7. 三表与事务

SQLite WAL 只有：

```text
runs
run_events
tool_invocations
```

普通 Run 修改使用 Revision CAS 并追加 Event。Tool Effect 分为两个事务边界：

```text
Intent + Run + Event commit
→ real Effect
→ Invocation Result + Evidence + Run + Event commit
```

因此进程中断后可以区分未开始、结果明确与结果未知。Event 和孤立 Artifact 都不能改变 Run 状态。

## 8. Completion Gate

```text
propose_finish cites Evidence IDs
→ required Check coverage and Invocation integrity
→ independent semantic validation over all user inputs, summary and cited Tool facts
→ persist Result + validation.passed
→ State Machine transition to succeeded
→ run.succeeded
```

空、重复、未知或部分 Evidence；failed/unknown Invocation；非零命令；未完成 Step；Provider 或语义验证失败，都不能产生成功 Result。

## 9. Resume、Lease 与副作用安全

- start/resume 获取跨进程 Lease 与新 Fencing Token；并发 owner 在写入前失败为 `RUN_BUSY`。
- 长 Provider/Tool 调用期间续租；过期 Fencing Token 不能提交。
- Provider 调用最多三次同一无副作用请求；耗尽后 Run 为 `blocked/PROVIDER_UNAVAILABLE`。
- `PROVIDER_UNAVAILABLE` resume 经 State Machine 回到同一 loop；已成功 Tool 仍由 persisted Invocation/Evidence 表示，不重复 Effect。
- started 幂等 Invocation 以原 ID 和 input 恢复。
- started 非幂等 Invocation 转为 `unknown/TOOL_RESULT_UNKNOWN`，禁止自动重试。
- unknown 只能接受绑定 Invocation 的 `confirmed_succeeded`、`confirmed_failed` 或 `abandon_run`。
- denied Tool 不创建 Invocation；Run 等待新的显式输入。

## 10. 安全边界

- 所有外部输入经过 Zod；
- Tool 路径必须是 workspace-relative，并检查 `..`、绝对路径和 symlink escape；
- 写目标不能是 symlink；
- `shell.execute` 只启动明确 executable + args，不接受 cmd、PowerShell、Bash 等 shell 入口；
- Tool 有 timeout、输出上限和子进程树清理；
- write/execute 必须 Approval；
- Provider secret 只存在于启动进程环境，不进入 Run、Event、Invocation 或 Artifact；
- 大内容进入内容寻址 Artifact。

## 11. 当前仓库边界

```text
apps/cli
packages/runtime
tests/runtime
scripts/runtime-1.1-release-uat.mjs
```

目录按真实 Feature 生长。Desktop、Server、MCP、Skill、Context/Recovery 子服务或其他未来模块不能以空壳、旁路或兼容层提前加入。历史 `specs/` 和 `reports/` 只提供路线与审计背景，不是当前运行 Authority。
