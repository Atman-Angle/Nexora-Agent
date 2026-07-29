# Nexora

Nexora 是一个可嵌入 Node.js / TypeScript 应用的可信 Agent Runtime。

你的应用提供目标、模型和工具；Nexora 负责把一次 Agent 执行变成可持久化、可观察、可批准、可恢复且可验证的 Run。它不是聊天 UI、工作流框架或另一套 SDK，也不要求宿主复制 CLI 的执行循环。

> 当前分支完成了 Nexora 1.2 Developer Runtime API 的本地验收。它尚未 npm 发布；真实 Provider 环境验收仍单独跟踪。

## 你只需要理解四个概念

| 概念 | 宿主负责什么 | Nexora 保证什么 |
| --- | --- | --- |
| `Runtime` | 配置 workspace、Provider、Tools 和生命周期 | 持久化、并发、资源释放和唯一执行路径 |
| `RunHandle` | 观察 Run、响应输入或批准、读取结果 | 合法状态转换、事件、冲突检测与恢复 |
| `Provider` | 完成一次模型调用 | 不允许模型直接改变 Run、Tool 或成功状态 |
| `Tool` | 声明领域能力并执行实际工作 | Schema、Approval、Invocation、Evidence、取消和 Recovery |

```text
你的应用
  → createRuntime(...)
  → runtime.run(goal)
  → RunHandle 观察和控制
  → 已验证的终态 Result
  → runtime.close()
```

Run、State Machine、Structured Plan、Tool Invocation、Evidence、Validation 和 Completion Gate 始终由 Runtime 的持久化内核拥有。宿主不能直接写状态、提交内部 Action，或自行把 Tool 成功解释为任务成功。

## 最短接入

安装已发布版本时使用包名；在本仓库验证候选包时，先打包再安装：

```powershell
pnpm --filter @nexora/runtime pack --pack-destination D:\tmp\nexora-package
npm install D:\tmp\nexora-package\nexora-runtime-1.1.0.tgz
```

```ts
import {
  createBuiltInTools,
  createRuntime,
  openAICompatibleProviderFromEnv
} from "@nexora/runtime";

const runtime = createRuntime({
  workspace: "D:\\project",
  dataDir: "D:\\project\\.nexora",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  const run = runtime.run("读取 note.txt 并总结内容");
  const result = await run.result();

  if (result.status === "succeeded") {
    console.log(result.summary);
  }
} finally {
  await runtime.close();
}
```

`result()` 只返回 State Machine 已确认的 `succeeded`、`failed` 或 `cancelled` 终态。模型文本、单个 Tool 成功、Plan 结束、`waiting` 和 `blocked` 都不会被误报为成功。

## 处理交互

交互宿主订阅同一个 `RunHandle`。异步 UI 应带上看到的 `requestId`；过期、重复、并发或状态不允许的操作会抛出可程序化处理的 `RunControlError`。

```ts
const subscription = run.subscribe(async (event) => {
  if (event.type === "input.required") {
    await run.input(await askUser(event.prompt), {
      requestId: event.requestId
    });
  }

  if (event.type === "approval.required") {
    await run.approve({ requestId: event.request.id });
  }
});

const result = await run.result();
await subscription.closed;
```

进程重启后，只保存 Run ID 即可重新打开同一持久化 Run：

```ts
const run = runtime.openRun(savedRunId);
const inspection = await run.inspect();

if (inspection.status === "blocked") {
  await run.resume();
}
```

完整的 input、deny、cancel、unknown side effect Recovery、SSE cursor 和 typed error 用法见 [Runtime 集成指南](docs/BUILD_WITH_NEXORA_RUNTIME.md)。

## 接入自定义模型和工具

普通模型接入只实现一次 completion transport：

```ts
import { defineProviderAdapter } from "@nexora/runtime";

const provider = defineProviderAdapter({
  async complete(request, operation) {
    const response = await modelSdk.complete({
      input: request.input,
      signal: operation.signal
    });
    return response.text;
  }
});
```

Tool 使用 `defineTool()` 声明名称、输入/输出 Schema、Effect 类型和 `execute()`。Runtime 自动处理输入校验、Approval、Invocation、Evidence、取消和 Recovery；Tool 不会得到 Run、Store、State Machine 或 Completion Gate。

```ts
import { z } from "zod";
import { defineTool } from "@nexora/runtime";

const lookup = defineTool({
  name: "example.lookup",
  description: "Read one value by key.",
  useWhen: ["A persisted value is required as evidence."],
  avoidWhen: ["The request requires a mutation."],
  effect: "read",
  idempotent: true,
  inputSchema: z.object({ key: z.string().min(1) }).strict(),
  inputExample: { key: "example" },
  outputSchema: z.object({ value: z.string() }).strict(),
  produces: ["key value"],
  async execute(input) {
    return { subjectRef: `key:${input.key}`, output: { value: "result" } };
  }
});
```

测试时从 `@nexora/runtime/testing` 导入 Harness、scripted Provider 与断言工具。Testing Kit 使用生产 Runtime、临时 workspace 和 SQLite，不提供 Memory Store、Approval bypass 或 Completion shortcut。

## 两种真实宿主示例

- [一次性 Worker](examples/runtime/worker.ts)：发起 Run、订阅 Approval、读取可信结果并关闭 Runtime。
- [HTTP/SSE Host](examples/runtime/http-host.ts)：以 Run ID 提供 inspect、events、input、approval、cancel、resume 和 result；每次请求均从持久化 Authority `openRun()`，不保存第二套 Run 状态。
- [示例说明](examples/runtime/README.md)：安装、路由和运行方式。

它们只依赖 `@nexora/runtime` 根出口和 Node 内置模块，不依赖 CLI、内部源码或 Store。

## 验证状态

Nexora 1.2 Feature Core 已在本地验证：同一个 `pnpm pack` 产物被安装到独立 Worker 与 HTTP Host 项目，二者都完成 `read → Approval → patch → verification → succeeded` 的可信闭环。HTTP Host 额外覆盖并发控制、SSE Event cursor、进程重启恢复、取消和资源退出。

- 38 个测试文件、126 项测试通过
- typecheck、lint、根构建、Runtime 构建、package contents 与 diff check 通过
- public exports 仅为 `@nexora/runtime` 与 `@nexora/runtime/testing`
- 当前工作树尚未 commit、push 或发布
- 真实 Provider External Acceptance 仍为 `verification_blocked`，不以确定性测试替代

证据、限制与命令记录在 [Nexora 1.2 验证报告](docs/audit/nexora-1.2-validation-report.md)。

## 文档

- [Runtime 集成指南](docs/BUILD_WITH_NEXORA_RUNTIME.md)：完整 API、生命周期、错误、恢复、Provider、Tool 与 Testing Kit
- [当前目标](docs/audit/current-goals.md) 与 [当前架构](docs/audit/current-architecture.md)
- [开发状态](DEVELOPMENT.md) 与 [产品路线](PROJECT.md)
- [文档索引](docs/README.md)

## CLI

CLI 是同一 Runtime 的直接使用和调试入口，并非宿主集成前提：

```powershell
pnpm nexora "检查项目，修复问题，补充测试并确认通过" --cwd D:\project
pnpm nexora inspect <run-id> --cwd D:\project --json
pnpm nexora resume <run-id> --cwd D:\project --approve <request-id>
```

CLI 在启动目录读取 `.env`；Runtime 包本身不读取文件或修改环境。Provider 配置、环境变量与 CLI 行为见 [Runtime 集成指南](docs/BUILD_WITH_NEXORA_RUNTIME.md)。
