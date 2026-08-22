# Nexora 1.1 当前用户指南

Nexora 1.1 当前有三个正式入口：Desktop Agent Workspace、接受自然语言目标的 CLI，以及可供 Node.js/TypeScript 程序调用的 `@nexora/harness`。三者共享同一个 Harness Agent Loop 和同一个持久化 Runtime；Runtime 不调用 Provider，Structured Plan、状态机、Tool Invocation、Evidence 和完成 hard gate 仍只有一份。

## 1. 安装与 Provider 配置

仓库开发方式：

```powershell
pnpm install
@'
NEXORA_MODEL_BASE_URL=https://your-provider.example/v1
NEXORA_MODEL_API_KEY=replace-me
NEXORA_MODEL_NAME=your-supported-model
NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096
NEXORA_MODEL_TOOL_TRANSPORT=native_tools
'@ | Set-Content -LiteralPath .env
```

CLI 的 start/resume 自动读取启动命令所在目录（`process.cwd()`）的 `.env`。显式 PowerShell/CI/系统环境变量优先于文件值；`--cwd` 指向的目标项目 `.env` 不会被读取，避免目标仓库注入 Provider 配置。`.env` 不存在时仍可使用显式环境变量；两者都没有时返回 `MODEL_CONFIG_ERROR`。`inspect` 不加载 `.env`。可选的 `NEXORA_MODEL_TIMEOUT_MS` 必须是正整数毫秒。

## 2. Desktop Agent Workspace

```powershell
pnpm desktop
```

开发版默认打开当前 Nexora 仓库；点击左上 Workspace 可切换目录，点击 **New Task** 创建 Session。左栏 Session 来自 Runtime 的持久 Run；中间 Conversation 显示目标、真实 Tool 活动、Validation 和终态 Result。Tool 可原地展开，Structured Plan 仅在 Runtime 实际存在时显示，Approval / Input Request / Recovery 统一进入底部 Composer。点击 **Activity** 会在同一主区域切换到完整持久 Trajectory。

Desktop 关闭或重启不会建立另一套 Session 状态；它通过公开 Runtime Contract 从 `<workspace>/.nexora` 恢复。详细启动、操作、测试和真实 Provider UAT 见 [Desktop 使用与验证指南](../apps/desktop/README.md)。

## 3. 自然语言 CLI

直接输入目标，不需要编写 Plan 或 JSON：

```powershell
pnpm nexora "读取 note.txt，把 before 改成 after，运行测试并确认通过" --cwd D:\project
```

未提供目标时，CLI 会提示 `What should Nexora do?`。在PowerShell等TTY终端中，带目标的CLI也会留在当前进程：遇到Approval时显示精确Action并询问，遇到Input Request时直接收集回答，直到终态。成功时`summary`直接包含经过验证的最终回答。管道、CI等非TTY环境保持一次调用返回`waiting`。

CLI 注册了工作区 Tool，因此默认完成要求至少一项合法 Evidence。纯问答任务必须由调用方显式声明：

```powershell
pnpm nexora "解释这段错误信息" --cwd D:\project --direct-answer
pnpm nexora "读取配置并确认内容" --cwd D:\project --require-tool filesystem.read
```

`--require-tool` 可重复；它只接受已注册 Tool。CLI 不通过关键词或额外模型调用猜测任务类型。

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
pnpm nexora resume <run-id> --cwd D:\project --deny <request-id> --reason "请改用兼容ES module的命令"
```

批准只对应 Pending Request 中持久化的精确 Tool Action。该 input 已在 Approval 前通过真实 Tool Schema 并展开默认值；批准前应核对 path、command、args、cwd 和 timeout 等字段。错误或过期的 Request ID 不会执行 Tool，resume 会重新校验 persisted Action 后才创建 Invocation。

交互拒绝时可以输入原因。非空原因会与`approval.denied`一起持久化，并作为新的`inputHistory`进入下一轮模型和 Task Contract。Run处于`waiting`期间的人工时间不计入`maxDurationMs`；每次start/resume活跃执行段仍受时长限制，模型/Tool/iteration/retry计数继续跨resume累计。

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

### 预算暂停与续跑

```powershell
pnpm nexora "完成工作区任务" --cwd D:\project --max-iterations 20 --max-model-calls 20 --max-tool-calls 10 --max-retries 4 --max-duration-ms 300000
pnpm nexora resume <run-id> --cwd D:\project --add-iterations 10 --add-model-calls 10 --add-tool-calls 5 --add-retries 2
```

预算耗尽返回 `blocked/*_BUDGET_EXCEEDED`。追加额度只提高原 Run 的绝对上限，累计用量不归零，已完成 Tool Invocation 不会重放。

## 4. CLI 退出码

| 退出码 | 含义 |
| ---: | --- |
| 0 | `succeeded`，唯一 deterministic Completion Gate 已通过 |
| 2 | `waiting`，需要输入或批准 |
| 3 | `blocked`，例如预算耗尽、Provider 不可用、Context 容量不足或 Tool 结果未知 |
| 4 | `failed` |
| 64 | CLI 参数或 Provider 配置错误 |

文本中出现“完成”不代表成功。唯一成功判断是持久化 `snapshot.status === "succeeded"`。

## 5. Node.js/TypeScript Runtime

```ts
import {
  createBuiltInTools,
  createAgent,
  openAICompatibleProviderFromEnv
} from "@nexora/harness";

const workspace = "D:\\project";
const runtime = createAgent({
  workspace,
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  let result = await runtime.start({
    input: "读取 note.txt，把 before 改成 after，运行测试并确认通过",
    completion: {
      evidence: "required",
      requiredToolNames: ["filesystem.patch"]
    }
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

`openAICompatibleProviderFromEnv()` 根据模型名自动匹配总上下文窗口，并要求显式设置 decision 请求输出预算。模型能力未知，或输出预算缺失、非法、超过模型最大输出能力时，Harness 会在创建 Run 前报告 Provider 配置错误。

Runtime API、Provider/Tool 扩展和恢复语义详见 [Build with Nexora Runtime](BUILD_WITH_NEXORA_RUNTIME.md)。

## 6. 内建 Tool

| Tool | 风险 | 行为 |
| --- | --- | --- |
| `filesystem.read` | read | 读取工作区文件；大内容进入 Artifact |
| `filesystem.list` | read | 以 offset/limit/nextOffset 稳定分页列出全部文件 |
| `filesystem.search` | read | 以 offset/limit/nextOffset 稳定分页搜索全部匹配 |
| `filesystem.write` | write | 原子创建/覆盖，必须批准 |
| `filesystem.patch` | write | 带 expected digest 的单点替换，必须批准 |
| `shell.execute` | execute | 直接执行可执行文件，必须批准；非零退出为 failure |
| `git.status/diff/show` | read | 只读 Git 信息 |

所有路径必须是 workspace-relative，越界和符号链接逃逸会失败。`shell.execute` 不接受 `cmd`、PowerShell、Bash 等交互式 Shell 入口。

每个 Tool 使用统一的 Identity→Capability→Decision→Execution→Evidence Contract。模型依据 Purpose、Non-goals、When to use、When not to use 和可产生的 Facts 选择是否调用；只有当前 active Tool 的输入示例会暴露给模型。Tool 返回 Facts 而不是最终回答，Runtime 在保存 Invocation/Evidence 前用该 Tool 的 Facts Schema 校验。

## 7. 持久化和成功证据

默认数据目录是 `<workspace>/.nexora`：

- `runtime-v1.1.db`：Run、Journal、Invocation、Model Call、Provider Attempt 和 Branch Authority；
- `artifacts/`：内容寻址的大内容和被拒绝原始 Provider Response。

成功链必须满足：

```text
ModelResponse.toolCalls = [] + 非空 ModelResponse.text
→ Harness 编译只含 summary 的 propose_finish
→ Runtime 从真实 Invocation / Evidence / Artifact 自动派生 provenance
→ required mechanical Checks + pending/unknown safety gate
→ deterministic Completion Gate passed
→ run.succeeded
```

完成阶段不再调用同步语义 Validator。Plan、TaskContract、Evidence/Invocation ID、digest、Fencing 和 Result provenance 都由 Runtime 确定性检查，不交给模型生成或判断。objective-only Plan Step 是导航，不自动产生 required Check；只有 Host/Tool Contract 明确声明的机械 Check 才能阻塞完成。

跨 Run 或 digest 不一致的 Evidence、started/unknown Invocation、未决 Approval、未满足的 required mechanical Check、非零命令和 Provider 失败均不能成为成功。历史 failed Invocation 本身不阻塞模型采用其他真实路径完成；未注册 Tool 的 Runtime 默认允许空 provenance，已注册 Tool 时只有 Host 显式选择 `evidence: "optional"` 才允许直接回答，任何路径都不能伪造 Evidence。

## 8. 当前限制

- 只有 OpenAI-compatible HTTP Provider；Transport 必须显式选择原生 Function Calling 或严格 Structured Output，没有自动探测或运行中降级。
- Desktop 当前从源码运行，尚无安装包、签名、自动更新或内置 Node 分发；仍没有 HTTP 服务、Python/Rust SDK、MCP 或 Workflow DSL。
- CLI 不提供单独的 `ask/read/patch/verify/agent/approve` 命令；这些属于已删除的旧实现。
- 新 1.1 Runtime 不迁移或恢复旧数据库。
- 历史运行证据不随公开源码发布，也不作为当前 API Contract；发布前应在隔离工作区重新运行本文件中的验证步骤。
- `filesystem.search` 使用随 Runtime 安装的 Ripgrep 二进制做大小写不敏感的字面量搜索；不接受自定义正则/参数，不搜索忽略目录、二进制或超过 256 KiB 的文件；每页最多返回 100 条，可通过 `nextOffset` 读取后续页面。

调试和恢复时先运行 `inspect`，不要直接修改 SQLite。
