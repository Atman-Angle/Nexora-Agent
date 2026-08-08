# `packages/runtime/src/providers/`

模型厂商适配入口。所有与 LLM Provider 交互的代码都集中在这个文件夹，方便接入新厂商。

## 文件职责

| 文件 | 职责 |
|---|---|
| `model-client.ts` | Provider 相关的公共类型（`RuntimeProvider`、`ModelDecisionContext`、`CompactionSummary`、`ToolObservation` 等）以及 `SemanticValidationVerdictSchema`。 |
| `adapter.ts` | `defineProviderAdapter` 工厂、`ProviderCompletionRequest` / `ProviderCompletionOperation` 等传输类型、以及三个系统 Prompt 常量（`DECISION_SYSTEM_PROMPT` / `VALIDATION_SYSTEM_PROMPT` / `COMPACTION_SYSTEM_PROMPT`）。 |
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
  decide(context: ModelDecisionContext, operation): Promise<unknown>;
  validate(context: SemanticValidationContext, operation): Promise<unknown>;
  compact?(context: CompactionContext, operation): Promise<unknown>;
  dispose?(): void | Promise<void>;
}
```

`compact` 是可选方法。未实现的 Provider 会沿用 Slice 3 的 Eviction-only 行为（不写 Checkpoint）。

## 设计约束

- 这个文件夹**不依赖** Runtime 核心（`runtime.ts`、`run-store.ts`、`contracts.ts` 中的运行态实现）。只允许依赖 `contracts.ts` 的权威 schema 和 `runtime-error.ts`。
- 不允许把业务逻辑（Projection、Eviction、Compaction）写在这里；它们属于 `../context/`。
- 不允许把持久化逻辑写在这里；它们属于 `../store/`。

## 模型配置与 Reasoning Policy

`createOpenAICompatibleProvider` 支持显式配置：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `model` | 必填 | 模型名 |
| `temperature` | `0` | 采样温度，`0..2` |
| `maxTokens` | `reservedOutputTokens`（decision `4096` / validation `1024` / compaction 回退 decision） | 每个 phase 的 `max_tokens` 由 `reservedOutputTokens` 派生 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `reasoning` | `"dynamic"` | Provider-neutral 推理策略（见下） |
| `thinkingToggleParam` | 不发送 | 厂商请求体里切换推理的参数名（DashScope 为 `enable_thinking`） |

环境变量补充：`NEXORA_MODEL_TEMPERATURE`、`NEXORA_MODEL_REASONING`（`off|on|dynamic`）、`NEXORA_MODEL_THINKING_PARAM`。

### Reasoning Policy（`off | on | dynamic`）

`ReasoningPolicy` 是 Provider-neutral 抽象（`model-client.ts`），Runtime 核心不感知任何厂商专有字段。具体 Provider 把它翻译成自己的参数：

- `"dynamic"`（推荐默认）：仅在模型需要建立**首个 Plan**（`context.run.currentPlan === null`）时开启推理；普通 execute_step / call_tool / propose_finish 决策关闭。这是经真实 qwen3.7-flash A/B 验证的策略（见 `agent-evaluation/execute-step-ab/REPORT-thinking.md`）。
- `"off"`：始终关闭。
- `"on"`：决策调用始终开启。
- validation / compaction 始终非推理（短结构化输出，推理只增延迟）。

`thinkingToggleParam` 未声明时（例如对接会拒绝未知字段的 OpenAI 兼容端点）**不发送任何推理参数**——策略 inert，由 Provider 默认行为接管，这是不支持该能力时的安全行为。要激活 dynamic 策略需显式声明，例如 DashScope：`thinkingToggleParam: "enable_thinking"`（env：`NEXORA_MODEL_THINKING_PARAM=enable_thinking`）。
