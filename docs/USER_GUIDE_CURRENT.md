# Nexora 1.1 当前用户指南

Nexora 1.1 当前只有两个正式入口：接受自然语言目标的 CLI，以及可供 Node.js/TypeScript 程序调用的 `@nexora/runtime`。两者共享同一个持久化 Runtime、Structured Plan、状态机、Tool Invocation、Evidence 和完成门。

## 1. 安装与 Provider 配置

仓库开发方式：

```powershell
pnpm install
Copy-Item -LiteralPath .env.example -Destination .env
# 编辑 .env，填写 NEXORA_MODEL_BASE_URL、NEXORA_MODEL_API_KEY 和 NEXORA_MODEL_NAME
```

CLI 的 start/resume 自动读取启动命令所在目录（`process.cwd()`）的 `.env`。显式 PowerShell/CI/系统环境变量优先于文件值；`--cwd` 指向的目标项目 `.env` 不会被读取，避免目标仓库注入 Provider 配置。`.env` 不存在时仍可使用显式环境变量；两者都没有时返回 `MODEL_CONFIG_ERROR`。`inspect` 不加载 `.env`。可选的 `NEXORA_MODEL_TIMEOUT_MS` 必须是正整数毫秒。

## 2. 自然语言 CLI

直接输入目标，不需要编写 Plan 或 JSON：

```powershell
pnpm nexora "读取 note.txt，把 before 改成 after，运行测试并确认通过" --cwd D:\project
```

未提供目标时，CLI 会提示 `What should Nexora do?`，并在同一进程中交互处理后续输入或批准。提供目标时，CLI 输出一个 `RunResult` JSON 后退出；成功时`summary`直接包含经过验证的最终回答，尚未产生Result时为`null`；若需要批准或输入，状态为 `waiting`。

### 查看 Run

```powershell
pnpm nexora inspect <run-id> --cwd D:\project --json
```

输出包含：

- `snapshot`：当前 Run、Task Contract、Structured Plan、Step、Evidence、Pending Request 和 Result；
- `events`：按 sequence 排序的只追加时间线；
- `toolInvocations`：真实 Tool 意图、输入、结果、错误和恢复状态。

### 批准或拒绝写入/执行

`filesystem.write`、`filesystem.patch` 和 `shell.execute` 都必须先停在 `waiting/APPROVAL_REQUIRED`。从 `inspect` 读取 `snapshot.pendingRequest.id`：

```powershell
pnpm nexora resume <run-id> --cwd D:\project --approve <request-id>
pnpm nexora resume <run-id> --cwd D:\project --deny <request-id>
```

批准只对应 Pending Request 中持久化的精确 Tool Action。该 input 已在 Approval 前通过真实 Tool Schema 并展开默认值；批准前应核对 path、command、args、cwd 和 timeout 等字段。错误或过期的 Request ID 不会执行 Tool，resume 会重新校验 persisted Action 后才创建 Invocation。

### 回复模型请求的补充输入

```powershell
pnpm nexora resume <run-id> --cwd D:\project --input "只修改 src/value.ts"
```

补充输入只追加到 `inputHistory`；下一版 Task Contract 和 Plan 必须覆盖完整输入历史。

### 未知 Tool 结果恢复

```powershell
pnpm nexora resume <run-id> --cwd D:\project --confirm-succeeded <invocation-id> <subject-ref>
pnpm nexora resume <run-id> --cwd D:\project --confirm-failed <invocation-id>
pnpm nexora resume <run-id> --cwd D:\project --abandon <invocation-id>
```

只有 non-idempotent Tool 的结果未知时才使用这些参数，且 Invocation ID 必须匹配持久化的 unknown Invocation。

## 3. CLI 退出码

| 退出码 | 含义 |
| ---: | --- |
| 0 | `succeeded`，两个完成门都已通过 |
| 2 | `waiting`，需要输入或批准 |
| 3 | `blocked`，例如 Provider 不可用或 Tool 结果未知 |
| 4 | `failed` |
| 64 | CLI 参数或 Provider 配置错误 |

文本中出现“完成”不代表成功。唯一成功判断是持久化 `snapshot.status === "succeeded"`。

## 4. Node.js/TypeScript Runtime

```ts
import {
  createBuiltInTools,
  createRuntime,
  openAICompatibleProviderFromEnv
} from "@nexora/runtime";

const workspace = "D:\\project";
const runtime = createRuntime({
  workspace,
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  let result = await runtime.start({
    input: "读取 note.txt，把 before 改成 after，运行测试并确认通过"
  });

  while (result.status === "waiting") {
    const view = await runtime.inspect(result.runId);
    const request = view.snapshot.pendingRequest;
    if (request?.kind === "approval") {
      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: request.id, approved: true }
      });
    } else {
      break;
    }
  }

  if (result.status !== "succeeded") {
    throw new Error(`Run did not succeed: ${result.status}`);
  }
} finally {
  runtime.close();
}
```

Runtime API、Provider/Tool 扩展和恢复语义详见 [Build with Nexora Runtime](BUILD_WITH_NEXORA_RUNTIME.md)。

## 5. 内建 Tool

| Tool | 风险 | 行为 |
| --- | --- | --- |
| `filesystem.read` | read | 读取工作区文件；大内容进入 Artifact |
| `filesystem.list` | read | 有界列出文件 |
| `filesystem.search` | read | 有界文本搜索 |
| `filesystem.write` | write | 原子创建/覆盖，必须批准 |
| `filesystem.patch` | write | 带 expected digest 的单点替换，必须批准 |
| `shell.execute` | execute | 直接执行可执行文件，必须批准；非零退出为 failure |
| `git.status/diff/show` | read | 只读 Git 信息 |

所有路径必须是 workspace-relative，越界和符号链接逃逸会失败。`shell.execute` 不接受 `cmd`、PowerShell、Bash 等交互式 Shell 入口。

每个 Tool 使用统一的 Identity→Capability→Decision→Execution→Evidence Contract。模型依据 Purpose、Non-goals、When to use、When not to use 和可产生的 Facts 选择是否调用；只有当前 active Tool 的输入示例会暴露给模型。Tool 返回 Facts 而不是最终回答，Runtime 在保存 Invocation/Evidence 前用该 Tool 的 Facts Schema 校验。

## 6. 持久化和成功证据

默认数据目录是 `<workspace>/.nexora`：

- `runtime-v1.1.db`：`runs`、`run_events`、`tool_invocations` 三张表；
- `artifacts/`：内容寻址的大内容和被拒绝原始 Action。

成功链必须满足：

```text
currentPlan required Checks
→ succeeded Tool Invocations
→ persisted Evidence
→ propose_finish 明确引证全部 required Evidence
→ deterministic completion passed
→ independent semantic validation passed
→ validation.passed
→ run.succeeded
```

最终semantic validation只接收全部用户输入、候选summary和已引用Tool的输入/输出事实；Plan、TaskContract、Evidence/Invocation ID、digest、Fencing等执行元数据由Runtime确定性检查，不交给模型作语义推断。

空/部分/未知 Evidence 引证、非零命令、failed/unknown Invocation、Provider 失败或未完成 Step 均不能成为成功。

## 7. 当前限制

- 只有 OpenAI-compatible HTTP Provider；没有 Provider 自动探测或 Function Calling 旁路。
- 没有 Desktop、HTTP 服务、Python/Rust SDK、MCP、Workflow DSL 或领域 Agent。
- CLI 不提供单独的 `ask/read/patch/verify/agent/approve` 命令；这些属于已删除的旧实现。
- 新 1.1 Runtime 不迁移或恢复旧数据库。
- E053 已通过确定性闭环和唯一真实 Provider canary；E048/E049/E052 的历史失败 Run 只供审计，不恢复或重跑。
- E054 已通过 CLI subprocess + 本机 HTTP Provider 验证：启动目录 `.env` 自动加载，显式环境优先，目标 workspace 隔离，secret 不进入输出。
- `filesystem.search` 使用随 Runtime 安装的 Ripgrep 二进制做大小写不敏感的字面量搜索；不接受自定义正则/参数，不搜索忽略目录、二进制或超过 256 KiB 的文件，最多返回 100 条稳定结果。

调试和恢复时先运行 `inspect`，不要直接修改 SQLite。
