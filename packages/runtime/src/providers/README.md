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
