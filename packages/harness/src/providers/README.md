# `packages/harness/src/providers/`

模型厂商适配入口。所有与 LLM Provider 交互的代码都集中在这个文件夹，方便接入新厂商。

## 文件职责

| 文件 | 职责 |
|---|---|
| `model-client.ts` | Provider 相关的公共类型（`RuntimeProvider`、`ModelDecisionContext`、`ToolObservation` 等）。 |
| `model-response.ts` | 归一化 `ModelResponse`、Provider Tool Call 与 Plan/HITL control 的严格 Schema。 |
| `adapter.ts` | `defineProviderAdapter` 工厂、`native_tools` / `structured_output` 传输类型以及 Prompt 编译入口。 |
| `openai-compatible.ts` | OpenAI 兼容协议的实现：`createOpenAICompatibleProvider`、`openAICompatibleProviderFromEnv`、`ModelConfigError`。 |
| `index.ts` | 重导出桶；新增厂商时在这里暴露公共入口。 |

## 新增厂商

接入一个新厂商（例如 Anthropic、Gemini、本地 Ollama）只需要三步：

1. 在本文件夹新建一个文件（例如 `anthropic.ts`），实现 `RuntimeProvider` 接口。
2. 在 `index.ts` 中把该厂商的工厂函数和必要类型重导出。
3. 在应用层（如 `apps/cli`）调用新厂商的工厂；不要直接引用新厂商的实现文件，保持对桶的依赖。

`RuntimeProvider` 的核心契约：

```ts
interface RuntimeProvider {
  readonly modelProfile?: ProviderModelProfile;
  readonly measureTokens?: ProviderTokenMeter;
  decide(context: ModelDecisionContext, operation): Promise<ModelResponse>;
  dispose?(): void | Promise<void>;
}
```

`ModelResponse` 只描述 Provider 返回的事实：可选文本、带 `callId` 的 Tool Calls 和 finish reason。它不包含模型填写的 Runtime Action。Harness 按响应形状确定性路由：`nexora_update_plan` 编译 Plan、`nexora_request_input` 编译 HITL、注册的 Runtime Tool 进入唯一 Tool Action 路径、无调用的非空文本提出完成。

Provider 必须在一个 Run 内固定声明一种能力：

- `native_tools`：注册真实函数 Schema，不发送 `response_format`，只读取 Provider 原生 `tool_calls`；普通 content 永远不解析为 Tool。
- `structured_output`：不注册原生 Tools，使用 strict `json_schema` 返回 response envelope；Adapter 为缺少原生 ID 的 calls 生成稳定 ID。

不支持任一能力的 Provider 必须显式失败，不能降级到 JSON-object、Prompt 约定或已删除的 Action wire。

OpenAI-compatible 生产 Adapter 把底层 Decision Context 统一投影为 `AgentWorkingContext`：`task`、`plan`、`workingSet`、`recentOutcome`、`relevantMemory` 与 `capabilities`。`workingSet` 保留最近真实 Tool 参数、结果/错误、repeatCount、恢复事实、当前文件、workspaceChanged、已完成工作、未解决问题与可读 Artifact refs；这只是从 Authority 重建的 Harness 投影，不新增 Store 或状态所有权。

### History Candidates Contract

`ModelDecisionContext.historyCandidates` 是 custom Provider 可用的有界导航字段：最多 8 条、合计不超过 4 KiB。Harness 从 Runtime Authority 和显式 Fork Base 确定性重建；它们不保存或复制历史结果，也不是 Memory、搜索索引或第二 Authority。

Provider 不能把候选 hint/reasons 当作原始事实。Harness 在 Provider 决策前完成作用域、digest 与 Token 预算校验，并通过 Runtime port 读取精确 Run facts；未命中条件的候选仍只用于导航。

`memoryCandidates` 与 `rehydratedFacts(kind="memory")` 都携带 `trust: "untrusted_memory_data"`；生产 wire 只发布后者。精确字节不是指令权限：Adapter 必须拒绝 Memory statement 中的角色伪造、Tool/Approval 请求、Evidence/Completion 声明和策略覆盖，并保持当前 TaskContract、Plan、Runtime Approval 与 Completion Gate 的优先级。

Harness 每轮自动恢复最高相关的 eligible Memory，并通过 Runtime port 为匹配的 required `context_ref` 请求 Run-owned Evidence。Memory Store 保持独立 Authority，Provider、Agent Loop 和 Runtime 都不能直接修改它。

Provider 返回最终 `text` 后，Harness 只提交 summary。Runtime 从当前 Authority 自动派生 Result provenance，并执行 deterministic Completion Gate；不再发起第二次模型审查。objective-only Plan Step 默认没有机械 Check，只有 Host/Tool Contract 已经声明的 required mechanical Check 才能阻塞完成。

## 设计约束

- `providers/`、`context/` 和 Harness 策略都位于 `@nexora/harness`。依赖方向为 Harness → Runtime Contract，Runtime 不 import 厂商实现、Memory 或 Provider-facing Context。
- 不允许把业务逻辑（Projection、Eviction、Rehydration）写在这里；它们属于 `../context/`。
- 不允许把 Run 持久化逻辑写在这里；它只能通过 Runtime port。
- Plan 只保持方向、progress 与 Invocation provenance，不是 Capability 白名单；计划外安全调用仍走完整 Runtime boundary，且不为不匹配 Check 生成 Evidence。

## 模型配置与 Reasoning Policy

`createOpenAICompatibleProvider` 支持显式配置：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `model` | 必填 | 模型名 |
| `temperature` | `0` | 采样温度，`0..2` |
| `maxTokens` | `reservedOutputTokens.decision`（默认 `4096`） | decision 请求的 `max_tokens` |
| `timeoutMs` | `60000` | 单次请求超时 |
| `reasoning` | `"dynamic"` | Provider-neutral 推理策略（见下） |
| `thinkingToggleParam` | 不发送 | 厂商请求体里切换推理的参数名（DashScope 为 `enable_thinking`） |

环境入口还读取 `NEXORA_MODEL_TEMPERATURE`、`NEXORA_MODEL_REASONING`（`off|on|dynamic`）和 `NEXORA_MODEL_THINKING_PARAM`。`openAICompatibleProviderFromEnv` 根据 `NEXORA_MODEL_NAME` 从同一 Adapter 的 capability catalog 解析窗口与输出能力。Harness 从模型总窗口扣除当前 phase 输出预留，最终 wire input 必须落在剩余 hard input limit 内；Runtime 只持久化 resulting ledger 状态。

同一 capability catalog 还可以保存由固定真实 usage 数据集验证的 estimated wire-meter 校准。`qwen3.7-flash` 的 E101 decision 样本最大 actual-to-UTF8/4 偏差为 1.66×，因此使用带余量的 1.8×。`deepseek-v4-flash-0731` 已登记供应商公布的 1M 上下文与 393,216 共享输出上限，但在取得固定 usage 校准集前继续使用通用 `nexora:utf8-bytes/4:v1`，不会借用 Qwen 比率。Ledger 记录完整 meter 名称并继续标记 `estimated`，Provider 返回的 actual usage 原样保留。`tokenMeter` 注入的精确 tokenizer 优先于 catalog 校准；未知模型不会猜测能力或校准值。

### Reasoning Policy（`off | on | dynamic`）

`ReasoningPolicy` 是 Harness 的 Provider-neutral 抽象（`model-client.ts`），Runtime 核心不感知任何厂商专有字段。具体 Provider 把它翻译成自己的参数：

- `"dynamic"`（推荐默认）：普通决策不发送厂商 thinking toggle，由 Provider 默认能力接管；存在未解决失败时才显式开启增强 reasoning。首次 Plan 不自动开启，也不按 Tool 名、错误码或任务类型分支。
- `"off"`：始终关闭。
- `"on"`：决策调用始终开启。

`thinkingToggleParam` 未声明时（例如对接会拒绝未知字段的 OpenAI 兼容端点）**不发送任何推理参数**——策略 inert，由 Provider 默认行为接管，这是不支持该能力时的安全行为。要激活 dynamic 策略需显式声明，例如 DashScope：`thinkingToggleParam: "enable_thinking"`（env：`NEXORA_MODEL_THINKING_PARAM=enable_thinking`）。
