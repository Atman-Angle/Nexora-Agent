# Build with Nexora Runtime

`@nexora/runtime` 是 Nexora 唯一受支持的 Node.js/TypeScript 包入口。1.2 当前黄金路径是 `createRuntime → runtime.run → RunHandle → result → close`；交互宿主在同一个 Handle 上使用 `subscribe/input/approve/deny/resume/cancel`。它不依赖 CLI、UI 框架或具体宿主应用；新 API、兼容 API 与 CLI 共享同一个持久化执行循环和安全边界。

## 安装

发布包：

```powershell
npm install @nexora/runtime
```

从当前仓库生成并安装本地候选：

```powershell
pnpm --filter @nexora/runtime pack --pack-destination D:\tmp\nexora-package
npm install D:\tmp\nexora-package\nexora-runtime-1.1.0.tgz
```

## 完整宿主示例

仓库提供两种只依赖打包产物公共出口的真实宿主形态：

- [`examples/runtime/worker.ts`](../examples/runtime/worker.ts)：一次性 Worker，发起 Run、订阅 Approval、读取可信终态并释放 Runtime；
- [`examples/runtime/http-host.ts`](../examples/runtime/http-host.ts)：长驻 HTTP/SSE Host，通过 Run ID 在每次请求中 `openRun()`，支持 inspect、Event cursor、input、approval、cancel、resume 和 result；
- [`examples/runtime/README.md`](../examples/runtime/README.md)：安装、启动、HTTP 路由和安全边界说明。

这些文件是包外应用示例，不属于 `@nexora/runtime` 的 package exports，也不是 Nexora 应用框架或远程 Runtime 协议。它们只演示宿主如何组合公开 API；Run、Pending Request、Event、Result 和完成判断仍由 Runtime 的持久化 Authority 提供。

## 最小调用

```ts
import {
  createBuiltInTools,
  createRuntime,
  openAICompatibleProviderFromEnv
} from "@nexora/runtime";

const runtime = createRuntime({
  workspace: "D:\\project",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools(),
  // 可选；默认 <workspace>/.nexora
  dataDir: "D:\\project\\.nexora"
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

`openAICompatibleProviderFromEnv()` 读取：

- `NEXORA_MODEL_PROVIDER=openai-compatible`；
- `NEXORA_MODEL_BASE_URL`；
- `NEXORA_MODEL_API_KEY`；
- `NEXORA_MODEL_NAME`；
- 可选 `NEXORA_MODEL_TIMEOUT_MS`；
- 可选 `NEXORA_MODEL_CONTEXT_WINDOW_TOKENS`（默认 `128000`）。

仓库 CLI 的 start/resume 会自动加载启动目录 `.env`；但 `@nexora/runtime` 不读取文件或修改环境。包调用方必须显式提供进程环境，或直接调用 `createOpenAICompatibleProvider(...)` 传入配置。

也可调用 `createOpenAICompatibleProvider(options)` 显式传入连接配置、自定义 `fetch`、`contextWindowTokens`、各 phase 的 `reservedOutputTokens`、`softLimitRatio`，以及能读取最终序列化 Provider Request 的 `tokenMeter`。未提供精确 Tokenizer 时，Adapter 使用标记为 `estimated` 的 UTF-8 字节估算，不会伪装成精确计量。

## Runtime API

### `run`

```ts
const run = runtime.run("自然语言目标", {
  budgets: {
    maxIterations: 50,
    maxModelCalls: 50,
    maxToolCalls: 50,
    maxRetries: 10,
    maxDurationMs: 300_000
  }
});

console.log(run.id);
const result = await run.result();
```

`run()` 返回前已经持久化 Run，因此 `run.id` 可立即保存。它随后进入现有唯一 Runtime Loop；Handle 不保存独立状态。

### `RunHandle.inspect`

```ts
const inspection = await run.inspect();
console.log(
  inspection.status,
  inspection.plan,
  inspection.invocations,
  inspection.evidence
);
```

`RunInspection` 每次从持久化 Run、Event 和 Tool Invocation 投影，并在类型与运行时都不可修改。它不包含 Store、fencing token 或内部 Pending Runtime Action。

### `RunHandle.wait` 与 `result`

```ts
const current = await run.wait();
if (
  current.status === "waiting_for_input"
  || current.status === "waiting_for_approval"
  || current.status === "blocked"
) {
  console.log("当前执行段已停止，但 Run 尚未完成");
}

const final = await run.result();
```

`wait()` 等待当前执行段并返回最新 Inspection。`result()` 只返回 State Machine 已确认的 `cancelled`、`failed` 或 `succeeded`；waiting、blocked、Provider 不可用、Tool success 或模型文本不会变成 Final。

### `openRun`

```ts
const reopened = runtime.openRun(savedRunId);
const inspection = await reopened.inspect();
```

`openRun()` 验证持久化 Run 存在但不自动恢复它。它既可从新 Runtime 实例读取已结束 Run，也可配合下面的 `resume()` 恢复 Provider-blocked 或 unknown-Invocation Run。

### `RunHandle.subscribe`

```ts
const subscription = run.subscribe(async (event) => {
  switch (event.type) {
    case "input.required":
      await run.input(await askUser(event.prompt), {
        requestId: event.requestId
      });
      break;
    case "approval.required":
      if (await askForApproval(event.request)) {
        await run.approve({ requestId: event.request.id });
      } else {
        await run.deny({
          requestId: event.request.id,
          reason: "用户拒绝"
        });
      }
      break;
    default:
      // Event union 可在后续 minor 增加 variant，宿主应保留 default。
      break;
  }
});

await subscription.closed;
```

公共 Event 固定携带 `schemaVersion: 1` 和 persisted `runId/sequence/occurredAt`。默认从 sequence 0 回放；重连时传 `{ afterSequence }` 只读取更大的 sequence。单个 listener 按 sequence 串行执行，可以安全地在 listener 内等待 Handle 控制。listener 失败只关闭该 subscription，不会失败或完成 Run；waiting/blocked 也不会关闭订阅，cancelled/failed/succeeded 事件交付后才自动结束。

Event 来自只追加的 `run_events`；timer/notification 只负责唤醒读取，不是 Event Authority。不要根据 Event 自行写状态或判断成功，最终状态仍读取 `inspect()`/`result()`。

### 输入、批准与拒绝

```ts
const inspection = await run.inspect();
const request = inspection.pendingRequest;

if (request?.kind === "input") {
  await run.input("只处理 src/value.ts", { requestId: request.id });
}

if (request?.kind === "approval") {
  console.log(request.toolName, request.stepId, request.input);
  await run.approve({ requestId: request.id });
  // 或：
  // await run.deny({ requestId: request.id, reason: "不允许修改该文件" });
}
```

`requestId` 可省略并绑定当前唯一请求，但异步 UI 应始终传入看到的 ID。过期、重复、类型不匹配或状态不允许的控制会抛出 `RunControlError`：

```ts
import { RunControlError } from "@nexora/runtime";

try {
  await run.approve({ requestId: clickedRequestId });
} catch (error) {
  if (error instanceof RunControlError) {
    if (error.code === "RUN_STATE_CONFLICT") {
      // UI 已过期或当前 Run 不接受该控制，重新 inspect。
    }
    if (error.code === "RUN_BUSY") {
      // 同一 Run 正由当前或另一 Runtime 实例控制。
    }
  }
}
```

公共 Approval 只暴露决策所需的 `toolName/stepId/input`，不暴露或接受内部 Runtime Action。

### 恢复

进程重启后只需保存 Run ID：

```ts
const run = runtime.openRun(savedRunId);
const inspection = await run.inspect();

if (inspection.status === "blocked" && inspection.recovery !== null) {
  await run.resume({
    recovery: {
      invocationId: inspection.recovery.invocationId,
      outcome: "confirmed_succeeded",
      subjectRef: "external:item-123"
    }
  });
} else {
  // Provider 暂时不可用或进程在安全边界中断时，回到同一执行循环。
  await run.resume();
}

const result = await run.result();
```

unknown non-idempotent Effect 必须绑定当前 `inspection.recovery.invocationId` 提供恢复决定；缺失或不匹配不会绕过现有 Invocation、Evidence 与 Completion 路径。

### 取消与 typed error

```ts
import { RuntimeError } from "@nexora/runtime";

try {
  await run.cancel("宿主请求停止");
  const result = await run.result();
  console.log(result.status); // cancelled
} catch (error) {
  if (error instanceof RuntimeError) {
    console.log(error.code, error.runId, error.retryable);
  }
}
```

取消 Provider、Validation、waiting 或尚未开始的 Tool 会由 State Machine 持久化为 `cancelled`，并产生 `run.cancelled`。已开始的幂等 Tool 先落盘明确 Invocation 结果；非幂等 Effect 的结果未知时保留 `unknown → blocked → Recovery`，`cancel()` 返回 `TOOL_RESULT_UNKNOWN`，不能伪装为已安全取消。

稳定错误码覆盖配置/输入错误、Run 不存在、busy/conflict、Provider 不可用、Runtime 已关闭、取消、未知 Tool 结果和内部资源释放失败。已经创建的 Run 的执行结果仍先持久化，再由 Inspection/Result 投影。

### 当前 major 的兼容 API

`start/resume/inspect` 当前仍保留，供已有调用方兼容使用：

```ts
const result = await runtime.start({ input: "自然语言目标" });
const view = await runtime.inspect(result.runId);
```

`start()` 委托 `run()` 所用的同一持久化创建和执行路径，不存在第二个 Runtime Loop。旧 `resume()` 与 Handle 控制共享同一 Lease、Pending Request、Recovery 和执行路径；旧 `inspect()` 返回审计级 `RunView`。新宿主应使用 `RunHandle` 的稳定公共投影和控制方法。CLI 的 start/resume/TTY continuation 已使用公共 Runtime/RunHandle；只有 CLI `inspect` 为保持当前 major 的审计 JSON 继续使用 legacy 只读 View。

### `close`

每个 Runtime 实例使用完毕后调用 `await runtime.close()` 或 `await runtime[Symbol.asyncDispose]()`。第一次 close 立即拒绝新操作，向本实例的活跃执行发送取消，关闭 subscriptions，等待 Run 到达 persisted terminal 或 unknown-Recovery 边界，再各调用一次 Tool/Provider `dispose()` 并关闭 SQLite。重复或并发 close 复用同一结果；关闭后公共操作返回 `RUNTIME_CLOSED`。Run 数据保留，可由使用相同 workspace/dataDir 的新实例打开。

## 自定义 Provider

普通 Provider 只实现一次 completion transport：

```ts
import { defineProviderAdapter } from "@nexora/runtime";

const provider = defineProviderAdapter({
  async complete(request, operation) {
    const response = await modelSdk.complete({
      system: request.system,
      input: request.input,
      responseFormat: request.responseFormat,
      signal: operation.signal
    });
    return response.text;
  },
  async dispose() {
    await modelSdk.close();
  }
});
```

`request.phase` 是 `"decision"` 或 `"validation"`，用于 transport 记录和模型参数选择。Adapter 负责 Nexora 的 prompt、bounded context、JSON parse、malformed response 和 validation failure 语义。Provider 不能直接写 Run、Plan、Invocation、Evidence 或成功状态；`operation.signal` 只通知当前 completion 停止，不是 Run 状态 Authority。

Decision Provider 接收 `ProjectedRunContext`，不是完整 `RunSnapshot`：

- `run.inputCount` 是持久化输入总数；
- `run.coveredInputCount` 是当前 Task Contract 已覆盖的输入数；
- `run.inputHistory` 只包含尚未覆盖的 `{ sequence, text }`；
- 已覆盖要求必须从 `run.taskContract` 读取；
- `toolObservations` 只包含 active Step/Check 和已完成前置 Evidence 所需的有界事实；
- `projection.digest` 是当前完整决策投影的稳定摘要，可用于缓存键、日志关联和确定性测试，不能作为 Evidence。

Provider 创建或修订 Task Contract 时必须把 `inputVersion` 设为 `run.inputCount`，不能使用 `run.inputHistory.length`。Semantic Validation 仍收到完整原始 inputs，因此 Decision Projection 不会降低最终完成校验范围。

需要完全控制 `decide/validate` 的高级调用方仍可实现完整 `RuntimeProvider`。两种写法最终都进入同一个生产 Provider port 和 Runtime Loop；Adapter 不创建 Session、Registry、fallback 或第二执行协议。内置 `createOpenAICompatibleProvider()` 也构建在同一个 Adapter 上。

## 自定义 Tool

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
  async execute(input, context) {
    context.signal.throwIfAborted();
    return {
      subjectRef: `key:${input.key}`,
      output: { value: "result" }
    };
  },
  async dispose() {
    // 可选；释放 Tool 自有资源。
  }
});
```

规则：

- Builder 返回现有完整 `RuntimeTool`，可和手写 `RuntimeTool` 放在同一个 `tools` 数组；
- `inputExample` 必须是 JSON，并在 Runtime 构造时通过同一个 `inputSchema`；
- Capability/Decision 文本必须完整且有界，Provider 只读取其选择投影；
- Effect kind 为 `write` 或 `execute` 时，Runtime 自动要求批准；
- Runtime 在 Approval 前使用 `inputSchema` 校验并展开默认值；Pending Action、批准后的 Invocation 和 Tool execute 使用同一 canonical JSON，resume 会重校验；
- Tool execute context 只提供 `workspace/idempotencyKey/signal`，不能读取 Run、Store、Plan、Approval 或 Completion Gate；
- `output` 必须通过 `outputSchema` 后才能成为 succeeded Invocation 和 Evidence；
- Tool 可选实现 `dispose()`，Runtime close 时恰好调用一次；
- non-idempotent Tool 的结果未知时 Runtime 会 blocked，不能自动重试；
- Tool 必须自行实现与其风险匹配的幂等和恢复语义。

需要显式 Tool failure code/retryable 的高级调用方仍可实现完整 `RuntimeTool`；它和 Builder 产物共享同一个 Schema、Approval、Invocation、Evidence、取消和 Recovery 路径。

## Runtime Testing Kit

测试辅助只从独立子路径导入：

```ts
import type { RuntimeEvent } from "@nexora/runtime";
import {
  assertEventSequence,
  assertSucceeded,
  createRuntimeHarness,
  createScriptedProvider,
  runtimeActions
} from "@nexora/runtime/testing";

const provider = createScriptedProvider({
  decisions: [
    runtimeActions.plan({
      goal: "读取一个值",
      acceptanceCriteria: ["存在可信 lookup Evidence"],
      steps: [{
        id: "lookup",
        objective: "读取值",
        checks: [{ id: "lookup-ok", toolName: "example.lookup" }]
      }]
    }),
    runtimeActions.tool({
      stepId: "lookup",
      checkIds: ["lookup-ok"],
      toolName: "example.lookup",
      input: { key: "example" }
    }),
    runtimeActions.finish({ summary: "读取完成", evidence: "all" })
  ],
  validations: [{ passed: true, issues: [] }]
});

await using harness = await createRuntimeHarness({
  provider,
  tools: [lookup]
});
const run = harness.runtime.run("读取 example");
const events: RuntimeEvent[] = [];
const subscription = run.subscribe((event) => {
  events.push(event);
});
assertSucceeded(await run.result());
await subscription.closed;
assertEventSequence(events);
```

Harness 使用生产 `createRuntime()`、真实临时 workspace 和 SQLite；close 后释放资源并删除目录。Testing Kit 不提供 Memory Store、Snapshot 写入、Runtime Action submit、Approval bypass 或 Completion shortcut，因此测试代码仍只能通过公开 Runtime/RunHandle 完成闭环。

## 成功与证据 Contract

Structured Plan 的 required Check 绑定具体 Tool。成功 Tool Invocation 生成 persisted Evidence；`propose_finish` 必须明确引证覆盖全部 required Check 的 Evidence。Runtime 只把这组 cited Evidence 交给独立语义验证，并把同一组 ID 写入 Result 和成功 Event。

以下情况都不会成功：

- 空、重复、未知或只覆盖部分 required Check 的 finish Evidence IDs；
- failed/unknown Tool Invocation；
- 非零 `shell.execute`；
- 未完成 Plan Step；
- Provider 不可用或语义验证失败；
- 失效 Lease/Fencing Token。

唯一成功判断是 `result.status === "succeeded"`，并可由 RunHandle Inspection 中的 Result、Evidence 和 Invocation，以及兼容审计 View 中的 validation/run.succeeded Event 反查。

## 权威与持久化

- Structured Plan：`RunSnapshot.currentPlan`；
- Run Status：State Machine 写入的 `RunSnapshot.status`；
- Tool 副作用：`tool_invocations`；
- Evidence/Result：Run snapshot；大型 Tool facts 的 Evidence 可绑定内容寻址 Artifact；
- 审计：只追加 `run_events`；
- 大内容：内容寻址 Artifact。
- 模型调用与 Token 审计：独立 `model_calls` Ledger；它不参与任务完成判断。

`runtime.inspect(runId).modelCalls` 按调用顺序返回 decision/validation 的 Provider、模型、projection digest、计量方法、软/硬预算决策、调用状态，以及 Provider 可用时返回的实际 input/output/total usage。硬上限拒绝不会调用 Provider，也不会消耗 `budgetsUsed.modelCalls`，但会持久化 `refused` Ledger 行用于审计。

Decision Context 中的 Tool Observation 使用确定性 Eviction：active Check、未解决错误和安全失败高于普通 predecessor；同 class 采用稳定的 Step/Invocation/ID tie-breaker。8 条是普通候选默认值，约 32 KiB 是保险丝，实际收缩会根据 Provider Token Meter 的 soft limit 反复重测。`payloadMode: "fragment"` 只含固定算法片段，`reference` 完全省略 payload；两者都不能推断成完整事实。大型 success/failure payload 会按 object key 规范化后的 canonical JSON digest 存入 Artifact，Invocation 保存 provenance；只有合法成功 Evidence 才引用同一 Artifact。此过程不调用 LLM，也不产生 Summary。

Runtime 默认创建 `<workspace>/.nexora/runtime-v1.1.db` 和 `<workspace>/.nexora/artifacts`。SQLite schema v3 在原有 Authority 表旁保留 `model_calls`，并为 `tool_invocations` 增加 payload digest/Artifact provenance，可从旧 schema 原地迁移；没有 Checkpoint、Summary、Context Store、Branch State、Profile Store 或第二套 Runtime。
