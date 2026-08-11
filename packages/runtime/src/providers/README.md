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

### History Candidates Contract

`ModelDecisionContext.historyCandidates` 是公开的有界导航字段：最多 8 条、合计不超过 4 KiB。每条只包含 `ref`、`relatedRefs`、`category`、`reasons`、短 `hint` 与 `occurredAt`；Runtime 从当前 Run Authority 和显式 Fork Base 按同 Check/Step/Tool/Input/path/error code、Evidence/Artifact、Approval 等关系确定性重建。它不保存或复制历史结果，也不是 Memory、搜索索引或第二 Authority。

Provider 不能把候选 hint/reasons 当作原始事实。需要历史内容时，返回既有 `request_context` 请求候选 `ref` 或 `relatedRefs`；Runtime 继续执行当前作用域、digest 与 Token 预算校验，并在下一轮以 `rehydratedFacts` 交付精确内容。候选不会暴露 sibling、其他 Run 或 parent post-fork 内容，也不会触发额外模型调用。

`memoryCandidates` 与 `rehydratedFacts(kind="memory")` 都携带 `trust: "untrusted_memory_data"`。精确字节不是指令权限：Adapter 必须拒绝 Memory statement 中的角色伪造、Tool/Approval 请求、Evidence/Completion 声明和策略覆盖，并保持当前 TaskContract、Plan、Runtime Approval 与 Completion Gate 的优先级。

当用户明确要求恢复 Memory 或 History 时，Provider 必须在 Plan 中使用 required `context_ref` Acceptance Check，并填写本轮发布的精确 ref。Runtime 只有在正常 scope/lifecycle/digest 校验与原文恢复成功后才生成 `source=context` 的 Run Evidence；该 Evidence 只证明 ref 被恢复，不证明 Memory statement 为真，也不授予任何 Tool、Approval 或 Completion 权限。Semantic validation 只接收 ref/digest 恢复证明，不接收 Memory statement 作为指令。

Semantic validation 拒绝 summary 后，Decision Provider 应保留既有 Evidence，依据 `repair.issues` 直接补齐遗漏的用户结果并重新 `propose_finish`。已经出现在 `rehydratedFacts` 的 ref 不得再次请求；重复请求会进入既有 invalid-action repair budget，而不会再次读取 Store。`evidence:<id>` 恢复的是 Evidence 元数据，不是底层 Tool payload；只有 payload 确实不在当前投影时，才继续请求其中发布的 `invocation:` 或 `artifact:` ref。

### Repeated Compaction Contract

`CompactionContext.previousCheckpoint` 在首次 Compaction 时为 `null`；后续只携带 Runtime 已针对当前 Authority 完整重验的 latest `{ digest, summary }`。生产 Adapter 会把该字段原样写入 compaction wire 的 `context.previousCheckpoint`，但不会向 Provider 暴露 `checkpointId`、`sourceDigests`、`coveredInvocations` 等 Runtime-only 持久化元数据。

Provider 必须从 `toolObservations + previousCheckpoint + run` 生成一份**完整替代** `CompactionSummary`，不能返回增量、嵌套旧 Summary，也不能把 Checkpoint ID 或 digest 当作 SourceRef。仍有效的陈述继续引用原始 Input/Event/Invocation/Evidence/Artifact refs；已由同 Plan/Step/Check 的后续成功 Invocation 解决的失败必须从 `unresolvedIssues` 淘汰。`previousCheckpoint` 只是有界 carry-forward candidate，不是 Authority。

Provider 输出不会直接覆盖 Context。Runtime 会重新校验 Summary Schema、原始 SourceRef、Run 归属和 section 语义，并重新派生 canonical Summary digest、完整 Source Digest map 与 covered Invocation multiset；只有全部通过才原子替换 `context_checkpoints` 的单行缓存。Provider 不拥有 Checkpoint 生命周期、Run、Plan、Evidence 或完成判断。

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

环境入口还读取 `NEXORA_MODEL_TEMPERATURE`、`NEXORA_MODEL_REASONING`（`off|on|dynamic`）和 `NEXORA_MODEL_THINKING_PARAM`。`openAICompatibleProviderFromEnv` 根据 `NEXORA_MODEL_NAME` 从同一 Adapter 的已验证 capability catalog 自动解析总窗口与最大输出能力，并要求显式提供 `NEXORA_MODEL_DECISION_OUTPUT_TOKENS`、`NEXORA_MODEL_VALIDATION_OUTPUT_TOKENS`、`NEXORA_MODEL_COMPACTION_OUTPUT_TOKENS`。未知模型、非法预算、超过模型输出能力或手工设置 `NEXORA_MODEL_CONTEXT_WINDOW_TOKENS` 都在创建 Run 前失败。Runtime 从模型总窗口扣除当前 phase 输出预留，最终 wire input（包括固定 system prompt 与 Tool/Action Contract）必须落在剩余 hard input limit 内。

同一 capability catalog 还可以保存由固定真实 usage 数据集验证的 estimated wire-meter 校准。`qwen3.7-flash` 的 E101 样本中，decision / validation 的最大 actual-to-UTF8/4 偏差分别为 1.66× / 1.08×，因此使用带余量的 1.8× / 1.2×；无 compaction 样本时保守继承 decision 的 1.8×。Ledger 记录完整 meter 名称并继续标记 `estimated`，Provider 返回的 actual usage 原样保留。`tokenMeter` 注入的精确 tokenizer 优先于 catalog 校准；未知模型继续使用 `nexora:utf8-bytes/4:v1`，不会猜测校准值。

### Reasoning Policy（`off | on | dynamic`）

`ReasoningPolicy` 是 Provider-neutral 抽象（`model-client.ts`），Runtime 核心不感知任何厂商专有字段。具体 Provider 把它翻译成自己的参数：

- `"dynamic"`（推荐默认）：仅在模型需要建立**首个 Plan**（`context.run.currentPlan === null`）时开启推理；普通 execute_step / call_tool / propose_finish 决策关闭。这是经真实 qwen3.7-flash A/B 验证的策略（见 `agent-evaluation/execute-step-ab/REPORT-thinking.md`）。
- `"off"`：始终关闭。
- `"on"`：决策调用始终开启。
- validation / compaction 始终非推理（短结构化输出，推理只增延迟）。

`thinkingToggleParam` 未声明时（例如对接会拒绝未知字段的 OpenAI 兼容端点）**不发送任何推理参数**——策略 inert，由 Provider 默认行为接管，这是不支持该能力时的安全行为。要激活 dynamic 策略需显式声明，例如 DashScope：`thinkingToggleParam: "enable_thinking"`（env：`NEXORA_MODEL_THINKING_PARAM=enable_thinking`）。
