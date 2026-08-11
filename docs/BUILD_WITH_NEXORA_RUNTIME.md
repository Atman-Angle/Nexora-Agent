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

## Memory Store

`@nexora/runtime` 提供与 Run Store 分离的通用 Memory Contract。Host 必须显式提供稳定 scope identity 和存储目录；打开 Store 只创建 `<stateDir>/memory-v1.db`，不会创建或迁移 `runtime-v1.1.db`：

```ts
import { openMemoryStore } from "@nexora/runtime";

const memory = openMemoryStore({ stateDir: "D:\\agent-state" });
try {
  const candidate = memory.create({
    memoryId: "preferred-retrieval-v1",
    memoryType: "preference",
    statement: "Prefer deterministic retrieval before semantic search.",
    scope: {
      userId: "user-42",
      projectId: "nexora",
      workspaceId: "D:/Nexora"
    },
    source: {
      sourceRunId: "run-123",
      ref: "input:7",
      digest: `sha256:${"a".repeat(64)}`
    },
    verification: { state: "unverified" },
    status: "candidate",
    sensitivity: "normal",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  memory.promote({
    scope: candidate.scope,
    memoryId: candidate.memoryId,
    promotion: {
      mode: "explicit",
      promotedBy: "user-42",
      promotedAt: new Date().toISOString()
    }
  });
} finally {
  memory.close();
}
```

`create/get/list/setStatus/delete` 都通过公开 Schema，并按 user/project/workspace/可选 branch 的完整 scope 隔离。同 scope/ID/内容的 `create` 是幂等重试；相同 ID 的不同内容会抛出 `MemoryConflictError`。

不可信内容应以 `candidate` 创建。`promote` 接受带 actor/time 的 `explicit` 决定，或要求 Memory 已 verified 的 `verified` 决定；同 scope 的 type/statement/sensitivity 完全相同时只保留一个 active Memory。内容更新不能原地修改：先创建 replacement candidate，再调用 `supersede`，一个 predecessor 表示 update，多个表示 merge。Store 在一个事务中保存 replacement 的 `supersedesMemoryIds` 和 predecessor 的 `supersededByMemoryId`。`revalidate` 和 `expire` 分别处理重新验证与到期，通用 `setStatus` 只允许 `archived | invalidated`，不能绕过生命周期。

Runtime 不会自动从 Run 提取 Memory。要启用有界召回，Host 显式把共享 Store 和 exact scope 注入 Runtime；Runtime 不负责关闭该 Store：

```ts
const runtime = createRuntime({
  workspace,
  provider,
  tools,
  memory: {
    store: memory,
    scope: { userId: "user-1", projectId: "project-1", workspaceId: "workspace-1" }
  }
});
```

Decision Context 的 `memoryCandidates` 最多 6 条，并同时受 768 estimated tokens / 4 KiB 硬上限约束；只来自 exact scope 内 active、未过期、normal sensitivity 的记录。候选包含 ref、type、reasons、source、verification、lifecycle 和 record digest，但不包含 statement。Provider 必须返回 `request_context` 请求原样 `memory:<id>` ref，Runtime 才在下一轮重验 scope/lifecycle/expiry/sensitivity/digest 并以 `rehydratedFacts(kind="memory")` 交付完整 MemoryRecord。当前 Input、TaskContract、Plan、Progress 和 Evidence 永远优先。

面向用户的动作应使用 `MemoryControls`，不要把底层 CRUD 直接暴露成产品控制：

```ts
import { createMemoryControls } from "@nexora/runtime";

const controls = createMemoryControls(memory);
const view = controls.inspect({ scope, memoryId, asOf: new Date().toISOString() });

controls.setScopeRecall({
  action: "set_scope_recall",
  scope,
  operationId: "settings-2026-08-11",
  actor: "user-1",
  reason: "Pause long-term Memory for this project.",
  occurredAt: new Date().toISOString(),
  enabled: false
});

const audit = controls.exportAudit({ scope });
```

`correct` 要求 replacement 是同 scope 的 candidate，并在一个事务中复用 Supersession；`invalidate`、`delete`、`clearScope` 和 `setScopeRecall` 都要求 operationId/actor/reason/time。审计事件不复制 Memory statement。相同 operationId 与相同 command 可安全重试；相同 ID 的不同 command 抛出 `MemoryControlConflictError`。Scope recall 禁用会同时关闭候选发布与旧 Memory ref 的恢复，策略和 audit 在 Store 重启后仍保留。

Memory 对 Provider 的信任等级固定为 `untrusted_memory_data`。候选与恢复 Fact 都携带该标记；“精确恢复”仅表示 Store 中的原始字节和 digest 一致，不表示 statement 可以发出指令。Adapter 必须忽略 Memory 中伪造的 system/developer/user role、Tool 请求、Approval、Evidence、完成结论和策略覆盖，只把它作为需要与当前 Input/TaskContract/Plan/Evidence 核对的事实主张。Memory 永远不能绕过 Runtime 的 Tool Approval、State Machine 或 Completion Gate。未发布、跨 scope/branch、sensitive、删除、禁用和 digest drift 的 ref 都只返回 `REF_UNAVAILABLE`，不泄露对象是否存在。

Runtime 只负责应用 Host 提供的 exact scope；用户认证、租户授权和 scope 绑定属于 Host 安全边界。`memory-v1.db` 的磁盘加密、备份删除、密钥轮换和文件系统 secure erase 是部署发布门，不应由应用层删除结果冒充。

`memory-v1.db` 中的 scope/status/type/time 索引是派生性能结构。每次 `openMemoryStore` 都会幂等确认这些索引，即使数据库的 schema version 已经是当前版本；缺失索引会直接从 `memory_records` 和 `memory_control_events` 重建，不修改 Memory Record。部署恢复演练可以在备份副本上删除派生索引、重新打开 Store，并核对 Record、候选、索引列表与查询计划。不要删除 Authority 表来测试索引恢复。

真实 Context+Memory Canary 使用 `pnpm run canary:context-memory`。它读取现有 `NEXORA_MODEL_*` 配置，默认把测试窗口固定为 12,000 tokens，在 `agent-evaluation/runs/context-memory-continuity-v1/` 保存无密钥报告，并且只允许 read Tool 成功。可选设置 `NEXORA_CANARY_INPUT_USD_PER_MILLION_TOKENS` 与 `NEXORA_CANARY_OUTPUT_USD_PER_MILLION_TOKENS` 生成费用估算；未配置时报告必须写 `costStatus=unpriced`，不能用 0 冒充真实费用。Canary 是 one-shot：失败后只 inspect，不在同一版本追加提示或重跑。

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

### 分支（Context Branching / Fork）

从父 Run 的当前 revision 创建**隔离的探索分支**：子分支拥有独立的 Run（`child_run_id`）、独立的 workspace 目录快照、独立的 Checkpoint/Rehydration/执行历史，以及只读的 Fork Base 继承边界（fork 点之前的父 facts）。父 Run 的 Authority（revision/Plan/Evidence/Invocation/完成状态）永不被分支修改。

```ts
const branch = await runtime.fork(parentRunId);      // 也可能返回 null（快照不可靠）
const view = await branch.inspect();                  // { branch, forkBase, child }
await branch.run();                                   // 在隔离 workspace 上执行子 Run
runtime.listBranches(parentRunId);                    // BranchRecord[]
runtime.getBranch(branch.id);                         // BranchView | null

// 显式、受控的合并：只接受白名单内容（inputs / Plan proposal / Artifact refs / 摘要）。
const outcome = runtime.mergeBranch(branch.id, {
  decisions: {
    inputs: ["分支产生的输入提案"],
    planProposal: true,
    artifacts: ["sha256:..."],
    summary: true
  }
});
// outcome.rejected 恒为 { currentPlan: false, evidence: true, invocations: true, sideEffects: true }
// 父分支只产生一个新 revision（fencing + 乐观并发），不覆盖 currentPlan、不合并 Evidence/Invocation/副作用。

runtime.discardBranch(branch.id, "探索结束");         // 清理分支 workspace，父 Run 不变
```

边界语义：

- **Fork Base 继承闭包**：子分支通过 `branch_fork_base.inheritedRefs` 读取 fork 点之前的父 facts（evidence/invocation/artifact/input），通过 `inheritedFacts` 解析完成校验所需的父 fact 投影；fork 点之后父产生的任何内容对子分支不可见。
- **workspace 目录快照**：fork 时把父 workspace 复制到 `<dataDir>/branches/<branchId>`（staging → 原子重命名），拒绝 symlink 与硬链接 CoW；`creating → active` 状态 + 启动清理保证崩溃不留下半分支。
- **合并白名单**：Evidence / Invocations / 完成状态 / 副作用永不合并；`planProposal: true` 只是把分支 Plan 作为父 Harness 重新规划的提案，不直接覆盖父 `currentPlan`。
- **重启恢复**：分支与子 Run 持久化于 schema v5；重启后从同一 fork 状态恢复，workspace 重新登记到隔离快照。

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

`request.phase` 是 `"decision"`、`"validation"` 或 `"compaction"`，用于 transport 记录和模型参数选择。Adapter 负责 Nexora 的 prompt、bounded context、JSON parse、malformed response 和 validation failure 语义。Provider 不能直接写 Run、Plan、Invocation、Evidence 或成功状态；`operation.signal` 只通知当前 completion 停止，不是 Run 状态 Authority。

Decision Provider 接收 `ProjectedRunContext`，不是完整 `RunSnapshot`：

- `run.inputCount` 是持久化输入总数；
- `run.coveredInputCount` 是当前 Task Contract 已覆盖的输入数；
- `run.inputHistory` 只包含尚未覆盖的 `{ sequence, text }`；
- 已覆盖要求必须从 `run.taskContract` 读取；
- `toolObservations` 只包含 active Step/Check 和已完成前置 Evidence 所需的有界事实；
- `projection.digest` 是当前完整决策投影的稳定摘要，可用于缓存键、日志关联和确定性测试，不能作为 Evidence。

Provider 创建或修订 Task Contract 时必须把 `inputVersion` 设为 `run.inputCount`，不能使用 `run.inputHistory.length`。Semantic Validation 仍收到完整原始 inputs，因此 Decision Projection 不会降低最终完成校验范围。

Decision Context 的公开 `historyCandidates` 字段提供当前任务相关的历史导航。每条候选包含 `ref`、最多 4 个 `relatedRefs`、`category`、确定性 `reasons`、短 `hint` 和 `occurredAt`；全集最多 8 条且不超过 4 KiB。候选只来自当前 Run Authority 或 Branch 的显式 Fork Base，并按同 Check、Step、Tool、精确 Input、路径、错误码、Evidence/Artifact、Approval/Fork Base 关系排序。它不会复制 Tool 结果、错误正文或 Artifact 内容；Provider 必须返回 `request_context` 请求候选 ref，下一轮才会收到精确 `rehydratedFacts`。其他 Run、sibling Branch 与 parent post-fork ref 不会成为候选。

Compaction phase 接收 `CompactionContext.previousCheckpoint`：第一次为 `null`，之后为 Runtime 针对当前 Authority 完整重验过的 latest `{ digest, summary }`。Adapter 会把它放入真实 wire 的 `context.previousCheckpoint`，但不会公开 `checkpointId`、`sourceDigests` 或 `coveredInvocations`。Provider 必须生成一份完整替代 Summary；不能返回 delta、嵌套 previous Summary，或把 Checkpoint ID/digest 当作 SourceRef。旧 Summary 仍有效的内容只能通过原始 SourceRef 延续；同 Plan/Step/Check 后来已有成功 Invocation 时，旧失败必须从 `unresolvedIssues` 删除。该字段是可丢弃的连续性候选，不是事实或完成依据。

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

`runtime.inspect(runId).modelCalls` 按调用顺序返回 decision/validation/compaction 的 Provider、模型、projection digest、计量方法、软/硬预算决策、调用状态，以及 Provider 可用时返回的实际 input/output/total usage。硬上限拒绝不会调用 Provider，也不会消耗 `budgetsUsed.modelCalls`，但会持久化 `refused` Ledger 行用于审计。

Decision Context 中的 Tool Observation 使用确定性 Eviction：active Check、未解决错误和安全失败高于普通 predecessor；同 class 采用稳定的 Step/Invocation/ID tie-breaker。8 条是普通候选默认值，约 32 KiB 是保险丝，实际收缩会根据 Provider Token Meter 的 soft limit 反复重测。`payloadMode: "fragment"` 只含固定算法片段，`reference` 完全省略 payload；两者都不能推断成完整事实。大型 success/failure payload 会按 object key 规范化后的 canonical JSON digest 存入 Artifact，Invocation 保存 provenance；只有合法成功 Evidence 才引用同一 Artifact。Eviction 过程不调用 LLM，并且只改变 `toolObservations`：当前 Checkpoint、恢复事实、History Candidates、Session Archive 和 `repair` 在每次重建中保持不变并进入新 digest。

当 Eviction 耗尽且 Decision 上下文仍超过 Token 预算时，Runtime 调用 Provider 的可选 `compact(context)` 生成结构化 Summary。Provider 必须返回严格匹配 `CompactionSummarySchema` 的 JSON：`schemaVersion: 1`，包含 `goal`、`constraints`、`completedWork`、`keyDecisions`、`unresolvedIssues`、`relatedArtifacts`，每条 `statement` 都携带原始 `sourceRefs`（`input:<sequence>` / `invocation:<id>` / `evidence:<id>` / `event:<sequence>` / `artifact:sha256:<hex>`）。第一次调用没有历史缓存；以后只携带已完整重验的 latest previous Checkpoint，并要求 Provider 输出完整替代 Summary，而不是累积嵌套结构。

Runtime 在提交新 Summary 前严格校验 Schema、引用存在性与 Run 归属、Source Digest、section 与 Authority 的一致性：`completedWork` 必须引用已完成 Step 的 success Invocation；`unresolvedIssues` 只能引用仍未解决的 failed/unknown Invocation 或 safety 失败证据。若同一 Plan/Step/Check 后来已有成功 Invocation，旧失败已经 resolved，继续携带会被拒绝。下一次使用该缓存前，Runtime 会再次验证 `checkpoint.digest` 等于 canonical Summary digest，重新验证完整 Summary，并精确比较重新派生的 Source Digest map 与 covered Invocation multiset；修改 Summary、来源或 coverage 中任一部分都会使缓存失效。

全部校验通过后，Store 在单个事务内删除该 Run 的旧 Checkpoint 行并插入唯一新行。有效 Checkpoint 会替换被其 `coveredInvocations` 覆盖的 Observation，并把 `contextCheckpoint: { checkpointId, digest, summary }` 注入 Decision Context；重建后的上下文重新计量 Token。如果 Provider 输出无效，旧缓存不被替换，Decision 走既有安全回退；如果重建后仍超过 hard limit，Runtime 安全阻塞并写入 `refused` Ledger 行，Decision Provider 不会被调用。Checkpoint 是可删除的 Prompt 派生缓存，从不拥有 TaskContract、Plan、Invocation、Evidence、Approval、Run Status 或 Completion；删除全部 Checkpoint 后，同一 Run 的 Decision Projection 必须从 Authority 确定性重建。

Rehydration 是 Eviction/Compaction 之后的按需恢复层。模型可返回 Harness 控制动作 `{"type":"request_context","refs":["<source-ref>",...]}`，请求恢复已公开的原始内容；`request_context` 不是 Core RuntimeAction，不进 `RuntimeActionSchema` / State Machine / `#handleAction`。Runtime 构建本轮 `availableContextRefs`（`toolObservations.sourceRefs` ∪ `contextCheckpoint.summary` 的 refs ∪ `run.evidence` 的 refs ∪ 当前 Run 的 Input/Event sequence 范围 → digest），下一轮把恢复结果注入 `context.rehydratedFacts`（`ref` / `kind` / `digest` / `content` / `error`）。`context.sessionArchive` 以固定 first/last/count 范围和最多 16 条、每条最多 180 字符的 Milestone 发布同一 Run 的历史导航；首个目标 Input、最新 Input 和每种已出现的 Plan/Failure/Approval/Checkpoint/Branch 类别各保留一个代表，其余位置按安全优先级与时间填充，避免重复失败淹没其他入口。Milestone 不复制完整 Session，也不是 Authority。范围内的 `input:<sequence>` / `event:<sequence>` 可按需精确恢复。错误语义统一：`INVALID_REF`（格式错误）、`REF_UNAVAILABLE`（未公开 / 跨 Run / 不存在 / digest 漂移，不泄露对象真实性）、`REHYDRATION_BUDGET_EXCEEDED`（准入预算拒绝）。准入预算独立于整体模型预算：`maxRefsPerRequest=8`、`maxRehydratedTokensPerTurn=4096`、`maxSingleFactTokens=2048`，按优先级 `harness_required`（unresolved / safety / 当前错误 / required Evidence / active Check 必需）→ `model_request` → `harness_helpful`（一般 reference 历史）优先级准入，安全关键内容不被模型请求挤掉。请求通过 `context.rehydrate_requested` / `context.rehydrated` 事件对进行崩溃恢复（resume 时重建未消费请求），不新增权威表。生产 OpenAI-compatible Adapter 会把有界的 `contextCheckpoint` 和 `rehydratedFacts` 连同当前 `repair` 投影到最终 Decision user message；它只剥离 Runtime-only projection/retention provenance，不再剥离模型实际需要的连续性事实。

E090 在上述 `availableContextRefs` 并集中加入 `historyCandidates.ref` 与 `relatedRefs`。候选本身不进入 Rehydration 内容预算，也不会自动变成 `rehydratedFacts`；只有模型显式请求后才按相同作用域、digest 和 Token 规则读取。生产 OpenAI-compatible Adapter 同时投影 `historyCandidates`，Eviction 重建必须原样保留并纳入新的 projection digest。

Runtime 默认创建 `<workspace>/.nexora/runtime-v1.1.db` 和 `<workspace>/.nexora/artifacts`。SQLite schema v5 在原有 Authority 表旁保留 `model_calls`（phase 现支持 `decision` / `validation` / `compaction`），为 `tool_invocations` 增加 payload digest/Artifact provenance，新增 `context_checkpoints` 表持久化结构化 Summary，并新增 `branches` / `branch_fork_base` 表持久化 Context Branching 的 lineage、fork point 与只读继承边界（`inheritedRefs` + `inheritedFacts`）；旧 schema 可原地迁移，无 Summary、Context Store、Profile Store 或第二套 Runtime。
