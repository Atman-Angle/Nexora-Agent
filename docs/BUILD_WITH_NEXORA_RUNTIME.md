# Build with Nexora Runtime

`@nexora/harness` 是 Agent 应用受支持的 Node.js/TypeScript 入口；它依赖只负责机械执行可靠性的 `@nexora/runtime`。当前黄金路径是 `createAgent → agent.run → RunHandle → result → close`；交互宿主在同一个 Handle 上使用 `subscribe/input/approve/deny/resume/cancel`。`createRuntime()` 只保留一个迁移版本，并直接调用 `createAgent()`，不存在旧 Agent Loop。

## 安装

发布包：

```powershell
npm install @nexora/harness
```

从当前仓库生成并安装本地候选：

```powershell
pnpm --filter @nexora/runtime pack --pack-destination D:\tmp\nexora-package
pnpm --filter @nexora/harness pack --pack-destination D:\tmp\nexora-package
npm install D:\tmp\nexora-package\nexora-runtime-0.1.0.tgz D:\tmp\nexora-package\nexora-harness-0.1.0.tgz
```

## 完整宿主示例

仓库提供两种只依赖打包产物公共出口的真实宿主形态：

- [`examples/runtime/worker.ts`](../examples/runtime/worker.ts)：一次性 Worker，发起 Run、订阅 Approval、读取可信终态并释放 Runtime；
- [`examples/runtime/http-host.ts`](../examples/runtime/http-host.ts)：长驻 HTTP/SSE Host，通过 Run ID 在每次请求中 `openRun()`，支持 inspect、Event cursor、input、approval、cancel、resume 和 result；
- [`examples/runtime/README.md`](../examples/runtime/README.md)：安装、启动、HTTP 路由和安全边界说明。

这些文件是包外应用示例，不属于 `@nexora/harness` 的 package exports，也不是 Nexora 应用框架或远程 Runtime 协议。它们只演示宿主如何组合公开 API；Run、Pending Request、Event 和 Result 仍由 Runtime 的持久化 Authority 提供，语义决策由 Harness 负责。

## 最小调用

```ts
import {
  createBuiltInTools,
  createAgent,
  openAICompatibleProviderFromEnv
} from "@nexora/harness";

const runtime = createAgent({
  workspace: "D:\\project",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools(),
  // 可选；默认 metadata。redacted 会保存确定性脱敏后的审计 Artifact。
  payloadCapturePolicy: "metadata",
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

## 有界 Multi-Agent

Host 通过一个真实执行的 `delegationPolicy` 开启或禁止 Parent → Worker delegation：

```ts
const runtime = createAgent({
  workspace,
  provider,
  tools,
  delegationPolicy: {
    mode: "allowed", // forbidden | allowed | required
    maxConcurrentWorkers: 2,
    allowedProfiles: ["researcher"],
    workerToolPolicies: { researcher: ["filesystem.read"] },
    childBudgets: { maxModelCalls: 8, maxToolCalls: 8, maxDurationMs: 120_000 }
  }
});
```

声明 profile 时，它必须同时存在于 `allowedProfiles` 和 `workerToolPolicies`，未知 profile fail closed。Worker profile 名称对 Runtime 是 opaque identifier；角色提示属于 Harness。Worker 使用真实持久化 Child Run 和隔离 Branch workspace，不能再委派，也不能直接写 Parent。blocked/waiting/unknown Child 可按原 childRunId 恢复。Executor 的隔离修改必须由 Parent 使用正常 Tool/Approval/Invocation/Evidence 路径明确采纳后，才能影响 Parent workspace 和完成判断。

`mode: "required"` 禁止 Parent 在没有 Worker batch 的情况下静默完成；若不能安全拆出至少两个独立目标，应请求缺失的用户输入。reopen 必须提供不宽于原 accepted delegation envelope 的 Policy。确定性验证使用 `pnpm test:supervisor-coordinator`。

`openAICompatibleProviderFromEnv()` 读取：

- `NEXORA_MODEL_PROVIDER=openai-compatible`；
- `NEXORA_MODEL_BASE_URL`；
- `NEXORA_MODEL_API_KEY`；
- `NEXORA_MODEL_NAME`；
- `NEXORA_MODEL_DECISION_OUTPUT_TOKENS`；
- 可选 `NEXORA_MODEL_TIMEOUT_MS`；未设置时通用模型为 60 秒，capability catalog 中的 `qwen3.7-flash` 为 180 秒；

decision 输出预算必须是正整数、小于模型总上下文，并且不超过模型最大输出能力。总上下文窗口由 Adapter 根据 `NEXORA_MODEL_NAME` 的已验证能力自动匹配，不接受生产环境手工覆盖；未知模型会在创建 Run 前失败，不能猜测窗口。

例如 qwen3.7-flash 的 1M 总窗口不应被写成 Canary 压力测试使用的 12K。模型声明的 128K 最大输出是能力上限，不代表每次请求都需要预留 128K；应按实际决策需要设置较小的请求输出预算，并为思考模式采用更低的最大输入边界。

仓库 CLI 的 start/resume 会自动加载启动目录 `.env`；但 `@nexora/harness` 和 `@nexora/runtime` 都不读取 `.env` 或修改环境。包调用方必须显式提供进程环境，或直接调用 `createOpenAICompatibleProvider(...)` 传入配置。

也可调用 `createOpenAICompatibleProvider(options)` 显式传入连接配置、自定义 `fetch`、`contextWindowTokens`、各 phase 的 `reservedOutputTokens`、`softLimitRatio`，以及能读取最终序列化 Provider Request 的 `tokenMeter`。该高级程序化入口用于自定义 Provider、测试夹具和显式 Canary 压力窗口；真实环境入口以模型能力目录为准。未提供精确 Tokenizer 时，Adapter 使用标记为 `estimated` 的 UTF-8 字节估算，不会伪装成精确计量。

## Memory Store

`@nexora/harness` 提供与 Run Store 分离的通用 Memory Contract。Host 必须显式提供稳定 scope identity 和存储目录；打开 Store 只创建 `<stateDir>/memory-v1.db`，不会创建或迁移 `runtime-v1.1.db`：

```ts
import { openMemoryStore } from "@nexora/harness";

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

Harness 不会自动从 Run 提取 Memory。要启用有界召回，Host 显式把共享 Store 和 exact scope 注入 Agent；Harness 和 Runtime 都不负责关闭该 Store：

```ts
const runtime = createAgent({
  workspace,
  provider,
  tools,
  memory: {
    store: memory,
    scope: { userId: "user-1", projectId: "project-1", workspaceId: "workspace-1" }
  }
});
```

Decision Context 的 `memoryCandidates` 最多 6 条，并同时受 768 estimated tokens / 4 KiB 硬上限约束；只来自 exact scope 内 active、未过期、normal sensitivity 的记录。候选包含 ref、type、reasons、source、verification、lifecycle 和 record digest，但不包含 statement。Harness 在 Provider 决策前自动选择最高相关候选，重验 scope/lifecycle/expiry/sensitivity/digest，并以 `rehydratedFacts(kind="memory")` 交付完整 MemoryRecord。当前 Input、TaskContract、Plan、Progress 和 Evidence 永远优先。

面向用户的动作应使用 `MemoryControls`，不要把底层 CRUD 直接暴露成产品控制：

```ts
import { createMemoryControls } from "@nexora/harness";

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

真实 Context+Memory Canary 使用 `pnpm run canary:context-memory`。它读取现有 `NEXORA_MODEL_*` 的真实模型能力；只有显式设置 `NEXORA_CANARY_CONTEXT_WINDOW_TOKENS` 才施加单独记录的 stress override，不再默认把 qwen3.7-flash 压成 12K。在 `agent-evaluation/runs/context-memory-continuity-v1/` 保存的报告无密钥，并且只允许 read Tool 成功。可选设置 `NEXORA_CANARY_INPUT_USD_PER_MILLION_TOKENS` 与 `NEXORA_CANARY_OUTPUT_USD_PER_MILLION_TOKENS` 生成费用估算；未配置时报告必须写 `costStatus=unpriced`，不能用 0 冒充真实费用。Canary 是 one-shot：失败后只 inspect，不在同一版本追加提示或重跑。

## Runtime API

### Supervisor / Coordinator multi-agent

The Harness exposes delegation as the single `nexora_delegate_workers` control
action inside the Parent Agent Loop. The Runtime accepts one exclusive batch of
two to eight assignments, creates durable Branch/Child Runs, waits for the
existing join condition, and returns derived Child observations to the Parent.
Child Runs inherit existing ForkBase/workspace/recovery authorities and cannot
delegate further.

### `run`

```ts
const run = runtime.run("自然语言目标", {
  completion: {
    evidence: "required",
    requiredToolNames: ["filesystem.read"]
  },
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

Host 拥有机械完成要求。默认 `completion.evidence` 为 `"auto"`：Harness 只有在回答完全基于当前权威 Context、且尚未开始 Plan 或 Tool 执行时，才可通过 `nexora_respond` 提议直接回复；Runtime 允许该回复不伪造 Evidence。普通最终文本仍按任务结果处理，`auto` 下必须由真实 Evidence 支撑。Host 可显式使用 `"optional"` 强制允许直接回答，或使用 `"required"` / `requiredToolNames` 收紧要求；模型不能降级 Host 要求。

### `RunHandle.inspect`

```ts
const inspection = await run.inspect();
console.log(
  inspection.status,
  inspection.plan,
  inspection.invocations,
  inspection.evidence,
  inspection.completion,
  inspection.budgets,
  inspection.budgetsUsed
);
```

`RunInspection` 每次从持久化 Run、Event 和 Tool Invocation 投影，并在类型与运行时都不可修改。它不包含 Store、fencing token 或内部 Pending Runtime Action。

### `RunHandle.history` 与完整性验证

```ts
const page = await run.history({
  afterSequence: 0,
  limit: 100,
  types: ["model.requested", "provider.attempt.failed"]
});
const record = await run.historyRecord(page.records[0]!.sequence);
const trace = await run.modelCallTrace(String(record?.payload.callId));
const integrity = await run.verifyHistory();
```

`limit` 默认 50、最大 200；只能读取单 Run，并可按已注册 record type 过滤。没有读取完整 Journal 的快捷方法。`modelCallTrace` 返回一个 logical call、Context Manifest 和其物理 Provider Attempts；legacy call 没有创建时不存在的数据时明确返回 `legacy_partial`。`verifyHistory` 同时校验 Event digest chain 与审计 Artifact 内容 digest。历史是只读审计数据，不能作为 Approval、Evidence、权限或完成结论。

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
import { RunControlError } from "@nexora/harness";

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
} else if (inspection.stopReason?.endsWith("_BUDGET_EXCEEDED")) {
  await run.resume({
    budgetExtension: {
      iterations: 10,
      modelCalls: 10,
      toolCalls: 5,
      retries: 2
    }
  });
} else {
  // Provider 暂时不可用或进程在安全边界中断时，回到同一执行循环。
  await run.resume();
}

const result = await run.result();
```

unknown non-idempotent Effect 必须绑定当前 `inspection.recovery.invocationId` 提供恢复决定；缺失或不匹配不会绕过现有 Invocation、Evidence 与 Completion 路径。

Iteration、Model-call、Tool-call 或 active-duration 预算耗尽会持久化为 `blocked/*_BUDGET_EXCEEDED`，不是终态失败。`budgetExtension` 只给现有绝对额度做正向累加，不重置 `budgetsUsed`，也不授权或重放已完成 Effect；duration 在每个 active execution segment 重新计时。

### 取消与 typed error

```ts
import { RuntimeError } from "@nexora/harness";

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

从父 Run 的当前 revision 创建**隔离的探索分支**：子分支拥有独立的 Run（`child_run_id`）、独立的 workspace 目录快照、独立的 Context/Rehydration/执行历史，以及只读的 Fork Base 继承边界（fork 点之前的父 facts）。父 Run 的 Authority（revision/Plan/Evidence/Invocation/完成状态）永不被分支修改。

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

每个 Agent 实例使用完毕后调用 `await runtime.close()` 或 `await runtime[Symbol.asyncDispose]()`。第一次 close 立即拒绝新操作，向活跃执行发送取消，关闭 subscriptions，等待 Run 到达 persisted terminal 或 unknown-Recovery 边界；Runtime 释放 Tool/SQLite，Harness driver 释放 Provider。重复或并发 close 复用同一结果；关闭后公共操作返回 `RUNTIME_CLOSED`。

## 自定义 Provider

普通 Provider 只实现一次 completion transport：

```ts
import { defineProviderAdapter } from "@nexora/harness";

const provider = defineProviderAdapter({
  transport: { kind: "native_tools" },
  async complete(request, operation) {
    const response = await modelSdk.complete({
      system: request.system,
      input: request.input,
      tools: request.tools,
      signal: operation.signal
    });
    return {
      text: response.text ?? null,
      toolCalls: response.toolCalls.map((call) => ({
        callId: call.id,
        name: call.name,
        arguments: call.arguments
      })),
      finishReason: response.finishReason ?? null
    };
  },
  async dispose() {
    await modelSdk.close();
  }
});
```

`request.phase` 固定为 `"decision"`，用于 transport 记录和模型参数选择。Adapter 负责 Nexora 的 prompt、bounded context、Provider Tool Call 归一化和 malformed response 语义。Provider 不能直接写 Run、Plan、Invocation、Evidence 或成功状态；`operation.signal` 只通知当前 completion 停止，不是 Run 状态 Authority。

Decision Provider 接收 Harness 构建的 `AgentWorkingContext`，不是完整 `RunSnapshot`：

- `providerContractVersion` 标识公开 Context 版本，输出边界是 `{ text, toolCalls, finishReason }` 的单一 `ModelResponse`；
- `run.inputCount` 是持久化输入总数；
- `run.coveredInputCount` 是当前 Task Contract 已覆盖的输入数；
- `run.inputHistory` 只包含尚未覆盖的 `{ sequence, text }`；
- 已覆盖要求必须从 `run.taskContract` 读取；
- `toolObservations` 只包含 active Step/Check 和已完成前置 Evidence 所需的有界事实；
- `projection.digest` 是当前完整决策投影的稳定摘要，可用于缓存键、日志关联和确定性测试，不能作为 Evidence。

Provider 通过 `nexora_update_plan` control 提交可选 `goal` 与有序 `{ objective }` Task；`tasks` 是当前仍有用的剩余工作快照，不是历史清单或完成证明。Harness 按等价 objective 复用 Plan/Step identity，Runtime 负责持久化、version/CAS 与机械完成前缀一致性。objective 默认没有 Acceptance Check，因此 Tool 成功不会自动把它或后续 objective 标记 completed；完成一个导航阶段后，Provider 用省略该阶段的新快照推进 active Step。Plan control 可与 Runtime Tool Calls 同轮出现，也可在没有 Plan 时调用已注册 Tool；任何内部 `set_plan/call_tool/execute_step/propose_finish` 名称都会在 Harness 边界拒绝。

Plan 是可选导航，不是执行许可或 Tool 白名单。已知工作跨多个文件/组件、包含相互依赖的实现与验证结果，或预计超过三次 Tool 调用时，应在首次 mutation 前以 2–7 个可独立验证的剩余 outcome 创建初始 Plan；范围未知时只做最小必要的只读探索，再在 mutation 前创建 Plan。直接回答、一次观察或一个明显的局部修改不需要 Plan。outcome 完成后立即从快照移除，因此后续快照可以只剩最后 1 项；冲突或新事实改变剩余工作时立即修订，不能把历史 Tool 调用清单当作 TODO。

生产 `ModelResponse` 不接受模型 Action。Harness 只按原生/strict-structured Tool Calls、`nexora_respond`、`nexora_update_plan`、`nexora_request_input` 和已有执行事实后的非空最终文本确定性路由。`nexora_respond` 在尚未执行 Plan/Tool 时是 direct response；若 Provider 在已有执行事实后误用它，同一文字按 evidence-gated task result 处理，不绕过 Completion Gate，也不额外请求模型修正控制名称。native mode 的普通 JSON content 永远不会被解析或执行；空响应、未知 Tool、非法 batch 和旧 Action envelope 都会整体拒绝。

`createAgent()` 还可接收 Host Policy、由 `createAgentProfileSnapshot()` 创建的版本化 Profile，以及 Host 授权的 Project Instructions。Prompt Compiler 以 Kernel/Transport/Host/Profile/Project/Tool 的稳定顺序编译请求，Profile 仅是 strategy-only 内容，不能改变 Tool、权限、Approval、Evidence、Completion Gate 或 Run Status。Provider Adapter 每个 Run 固定选择 `native_tools` 或 strict `structured_output`，并把实际 cache usage 按 Attempt 写入审计。

Decision Context 的公开 `historyCandidates` 字段提供当前任务相关的历史导航。候选只来自 Runtime 提供的当前 Run Authority 或 Branch Fork Base；Harness 负责排序、预算和精确 Rehydration。其他 Run、sibling Branch 与 parent post-fork ref 不会成为候选。

需要完全控制 `decide/validate` 的高级调用方仍可实现完整 `RuntimeProvider`。两种写法最终都进入同一个 Harness Provider port 和唯一 Agent Loop；Runtime 不持有也不调用 Provider。内置 `createOpenAICompatibleProvider()` 也构建在同一个 Adapter 上。

## 自定义 Tool

```ts
import { z } from "zod";
import { defineTool } from "@nexora/harness";

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
import type { RuntimeEvent } from "@nexora/harness";
import {
  assertEventSequence,
  assertSucceeded,
  createAgentHarness,
  createScriptedProvider,
  modelResponses
} from "@nexora/harness/testing";

const provider = createScriptedProvider({
  modelResponses: [
    modelResponses.plan({
      goal: "读取一个值",
      steps: [{
        objective: "读取值并基于可信事实确认结果"
      }]
    }),
    modelResponses.tool({
      toolName: "example.lookup",
      input: { key: "example" }
    }),
    modelResponses.finish({ summary: "读取完成" })
  ]
});

await using harness = await createAgentHarness({
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

Testing Kit 使用生产 `createAgent()`、真实临时 workspace 和 SQLite；close 后释放资源并删除目录。Testing Kit 不提供 Memory Store、Snapshot 写入、Runtime Action submit、Approval bypass 或 Completion shortcut，因此测试代码仍只能通过公开 Agent/RunHandle 完成闭环。

## 成功与证据 Contract

Provider Contract v6 只提交最终 text、可选 objective-only Plan、Tool name/arguments，或 human-input control；若 Host 显式创建 Run continuation，Harness 还会从 Runtime 验证的祖先 Authority 构建有界历史投影。Harness 从原始输入和 objective 派生 Runtime Task Contract，但不自动生成 Acceptance Check。Provider 的最终 `text` 只成为 summary；Runtime 从真实 Evidence、Invocation 和 Artifact 自动派生 provenance，并直接执行 deterministic Completion Gate。新生产路径没有同步 Validator。

以下情况都不会成功：

- Tool-enabled Run 在默认策略下没有合法 persisted Evidence；
- Host 指定的 required Tool 没有 digest-valid Tool Evidence；
- 任一 required Check 缺少合法 persisted Evidence；
- started/unknown Tool Invocation；
- 非零 `shell.execute`；
- 未满足的 required mechanical Check；
- Provider 不可用；
- 失效 Lease/Fencing Token。

唯一成功判断是 `result.status === "succeeded"` 且 `stopReason === "COMPLETED"`，并可由 RunHandle Inspection 中的 Result、Evidence、Invocation 和 `run.succeeded` Event 反查。旧 Run 的 validation Event 仍可只读审计，但不参与新完成判断。

## 权威与持久化

- Structured Plan：`RunSnapshot.currentPlan`；
- Run Status：State Machine 写入的 `RunSnapshot.status`；
- Tool 副作用：`tool_invocations`；
- Evidence/Result：Run snapshot；大型 Tool facts 的 Evidence 可绑定内容寻址 Artifact；
- 审计：只追加 `run_events`；
- 大内容：内容寻址 Artifact。
- 模型调用与 Token 审计：独立 `model_calls` Ledger；它不参与任务完成判断。

`runtime.inspect(runId).modelCalls` 按调用顺序返回 decision 的 Provider、模型、projection digest、计量方法、软/硬预算决策、调用状态，以及 Provider 可用时返回的实际 input/output/total usage。旧数据库中既有的 validation/compaction/refused Ledger 行仍可读取，但生产代码不再创建 validation 或 compaction 调用。Original Inputs、Task Contract、persisted Evidence 和当轮 required rehydrated facts 不会为满足 soft limit 被删除或截短；最小权威投影超过 hard limit 时，不发送 Provider 请求，Run 持久化为 `blocked/CONTEXT_CAPACITY_EXCEEDED`。

Decision Context 中的 Tool Observation 使用确定性 Eviction：候选先按 Tool/input/outcome 折叠，active Check、未解决错误、安全失败和当前文件链高于普通 predecessor；同 class 采用稳定的 Step/Invocation/ID tie-breaker。候选没有固定条数或单条正文上限，实际收缩只由 Provider Token Meter 的 soft limit 触发，并按测得的超额比例批量收缩后重测。`payloadMode: "fragment"` 只含固定算法片段，`reference` 完全省略 payload；两者都不能推断成完整事实。大型 success/failure payload 会按 object key 规范化后的 canonical JSON digest 存入 Artifact，Invocation 保存 provenance；只有合法成功 Evidence 才引用同一 Artifact。收缩过程不调用 LLM、不写 Checkpoint，只改变可重建投影；恢复事实、History Candidates、Session Archive 和 `repair` 在每次重建中按预算重新纳入 digest。可选 Tool decision hints 可在极窄窗口收缩，但不可变的 pre-contraction configuration digest 仍用于 Strategy continuity，真实 wire prefix digest 单独用于缓存审计。幂等 read 只有显式声明 `execution.readCache.mode="until_mutation"` 才能复用；mutation、Run reopen/resume 会使之前的复用资格失效。

`filesystem.list` 和 `filesystem.search` 通过稳定的 `offset/limit/nextOffset` 页面提供全部结果；2,000 和 100 分别只是单页上限。`filesystem.read` 对大文件提供 range continuation 或完整 Artifact。Shell/Git stdout 和 stderr 各保留最多 64 KiB inline，完整超限流以精确字节数和独立内容寻址 Artifact ref 发布；成功和失败输出都可从后续 Context 恢复。

Rehydration 由 Harness 在构建 Context 时完成，恢复结果随后与其他字段一起进入确定性收缩。Harness 从 Runtime port 读取 published Run refs，从独立 Memory Store 读取 exact-scope eligible Memory，并执行既有 digest/预算校验；最新 Input 点名的 ref、active `context_ref`、最高相关 Memory 与关键 Tool facts 可自动触发恢复。匹配 required Check 时请求 Runtime 生成 Run-owned Context Evidence。错误语义和预算值保持不变，生产 Adapter 只携带当前决策必要的事实和 ModelResponse Contract。

E090 在上述 `availableContextRefs` 并集中加入 `historyCandidates.ref` 与 `relatedRefs`。候选本身不进入 Rehydration 内容预算；只有最新 Input 明确点名或 active `context_ref` Check 要求的精确 ref 才自动读取，其他候选仍只是 Harness 内部导航。生产 OpenAI-compatible Adapter 不投影 `historyCandidates`、`memoryCandidates` 或 Session Archive；它们仍参与 Provider-neutral Context 的确定性构建、收缩和 digest。

Runtime 默认创建 `<workspace>/.nexora/runtime-v1.1.db` 和 `<workspace>/.nexora/artifacts`。SQLite schema v8 在原有 Authority 表旁保留 `model_calls`，以 `model_call_audits` 保存 Context Manifest/capture provenance，以 `provider_attempts` 保存物理请求；`run_events` 原位增加版本化 digest chain 和 completeness。`branches` / `branch_fork_base` 继续持久化 Context Branching lineage；v4 `context_checkpoints` 仅为旧数据库兼容保留。旧 Event 原位迁移为 `legacy_partial`，不补造旧 Provider Attempt、Plan revision 或 payload。
