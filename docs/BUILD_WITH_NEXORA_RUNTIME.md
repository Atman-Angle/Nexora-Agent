# Build with Nexora Runtime

`@nexora/runtime` 是 Nexora 1.1 唯一的 Node.js/TypeScript 包入口。它不依赖 CLI 或 Electron；包调用方与 CLI 共享同一个持久化执行循环和安全边界。

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
  const result = await runtime.start({
    input: "读取 note.txt，修复内容，运行验证并确认通过"
  });
  console.log(result);
} finally {
  runtime.close();
}
```

`openAICompatibleProviderFromEnv()` 读取：

- `NEXORA_MODEL_PROVIDER=openai-compatible`；
- `NEXORA_MODEL_BASE_URL`；
- `NEXORA_MODEL_API_KEY`；
- `NEXORA_MODEL_NAME`；
- 可选 `NEXORA_MODEL_TIMEOUT_MS`。

也可调用 `createOpenAICompatibleProvider(options)` 显式传入连接配置或自定义 `fetch`。

## Runtime API

### `start`

```ts
const result = await runtime.start({
  input: "自然语言目标",
  budgets: {
    maxIterations: 50,
    maxModelCalls: 50,
    maxToolCalls: 50,
    maxRetries: 10,
    maxDurationMs: 300_000
  }
});
```

### `inspect`

```ts
const view = await runtime.inspect(result.runId);
console.log(view.snapshot, view.events, view.toolInvocations);
```

`snapshot` 是当前 Run 状态源；Event 只用于审计，不能反向覆盖状态。

### `resume`

批准精确的 Pending Tool Action：

```ts
const view = await runtime.inspect(runId);
const request = view.snapshot.pendingRequest;
if (request?.kind === "approval") {
  await runtime.resume({
    runId,
    approvalDecision: { requestId: request.id, approved: true }
  });
}
```

补充输入：

```ts
await runtime.resume({ runId, input: "只修改 src/value.ts" });
```

处理 unknown non-idempotent Invocation：

```ts
await runtime.resume({
  runId,
  recoveryDecision: {
    invocationId,
    outcome: "confirmed_succeeded",
    subjectRef: "external-system:item-123"
  }
});
```

### `close`

每个 Runtime 实例使用完毕后调用 `close()`，释放 SQLite 连接。Run 数据保留，可由使用相同 workspace/dataDir 的新实例恢复。

## 自定义 Provider

Provider 只实现两个方法：

```ts
import type { RuntimeProvider } from "@nexora/runtime";

const provider: RuntimeProvider = {
  async decide(context) {
    // 返回一个未信任 JSON；RuntimeActionSchema 仍会再次校验。
    return { type: "request_input", question: "需要哪个文件？", reason: "目标不明确" };
  },
  async validate(context) {
    // 只能审查 finish 已明确引证的 persisted Evidence/Invocation。
    return {
      passed: context.evidence.length > 0,
      issues: [],
      evidenceIds: context.evidence.map((item) => item.id)
    };
  }
};
```

Provider 不能直接写 Run、Plan、Invocation、Evidence 或成功状态。

## 自定义 Tool

```ts
import { z } from "zod";
import type { RuntimeTool } from "@nexora/runtime";

const inputSchema = z.object({ key: z.string().min(1) }).strict();

const lookup: RuntimeTool = {
  name: "example.lookup",
  description: "Read one value by key without modifying external state.",
  risk: "read",
  idempotent: true,
  inputSchema,
  inputExample: { key: "example" },
  async execute(input) {
    const parsed = inputSchema.parse(input);
    return {
      status: "success",
      subjectRef: `key:${parsed.key}`,
      output: { value: "result" }
    };
  }
};
```

规则：

- `inputExample` 必须是 JSON，并在 Runtime 构造时通过同一个 `inputSchema`；
- `description` 可选；提供时必须非空且最多 240 字符，Provider 在生成 Plan 前可用它选择 capability；
- `risk` 为 `write` 或 `execute` 时，Runtime 自动要求批准；
- Runtime 在 Approval 前使用 `inputSchema` 校验并展开默认值；Pending Action、批准后的 Invocation 和 Tool execute 使用同一 canonical JSON，resume 会重校验；
- Tool 只返回 success/failure，不得修改 Run；
- non-idempotent Tool 的结果未知时 Runtime 会 blocked，不能自动重试；
- Tool 必须自行实现与其风险匹配的幂等和恢复语义。

## 成功与证据 Contract

Structured Plan 的 required Check 绑定具体 Tool。成功 Tool Invocation 生成 persisted Evidence；`propose_finish` 必须明确引证覆盖全部 required Check 的 Evidence。Runtime 只把这组 cited Evidence 交给独立语义验证，并把同一组 ID 写入 Result 和成功 Event。

以下情况都不会成功：

- 空、重复、未知或只覆盖部分 required Check 的 finish Evidence IDs；
- failed/unknown Tool Invocation；
- 非零 `shell.execute`；
- 未完成 Plan Step；
- Provider 不可用或语义验证失败；
- 失效 Lease/Fencing Token。

唯一成功判断是 `result.status === "succeeded"`，并可由 `inspect` 中的 `validation.passed`、`run.succeeded`、Result、Evidence 和 Invocation 反查。

## 权威与持久化

- Structured Plan：`RunSnapshot.currentPlan`；
- Run Status：State Machine 写入的 `RunSnapshot.status`；
- Tool 副作用：`tool_invocations`；
- Evidence/Result：Run snapshot；
- 审计：只追加 `run_events`；
- 大内容：内容寻址 Artifact。

Runtime 默认创建 `<workspace>/.nexora/runtime-v1.1.db` 和 `<workspace>/.nexora/artifacts`。没有旧 Checkpoint、Ledger、Profile 或第二套 Runtime。
