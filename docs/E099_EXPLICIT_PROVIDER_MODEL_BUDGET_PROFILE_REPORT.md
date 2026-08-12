# E099 Explicit Provider Model Budget Profile

日期：2026-08-11

状态：done_locally

## 目标

真实 OpenAI-compatible 环境入口不再用通用默认值或人工窗口猜测模型能力。总上下文窗口按模型名从 Provider capability catalog 自动匹配，decision、validation、compaction 输出预算由部署者显式提供并受模型最大输出能力约束，最终继续汇总到唯一的 `ProviderModelProfile`。Canary 记录声明能力、压力 override、最终有效 Profile，以及 Provider usage 相对请求前计量的逐调用偏差。

## 配置合同

`openAICompatibleProviderFromEnv` 新增三个必填环境变量：

```text
NEXORA_MODEL_DECISION_OUTPUT_TOKENS
NEXORA_MODEL_VALIDATION_OUTPUT_TOKENS
NEXORA_MODEL_COMPACTION_OUTPUT_TOKENS
```

三项都必须是正整数、小于自动解析的模型总窗口，且不超过模型最大输出能力。`NEXORA_MODEL_CONTEXT_WINDOW_TOKENS` 不再是生产配置，设置它会失败；未知模型也 fail closed。连接、reasoning、temperature 和 timeout 保持原语义。高级 `createOpenAICompatibleProvider(options)` 与自定义 `RuntimeProvider` 保留程序化能力，用于自定义端点和测试夹具。

## Canary 证据

Canary 报告新增：

- `budgetConfiguration.declaredProfile`：未施加压力窗口前、由真实部署环境解析出的能力；
- `budgetConfiguration.override`：`NEXORA_CANARY_CONTEXT_WINDOW_TOKENS` 的名称和值；
- `budgetConfiguration.effectiveProfile`：实际进入 Runtime 和 Ledger 的唯一 Profile；
- `budgetConfiguration.issues`：声明、override 与有效 Profile 不一致时的失败原因；
- `modelCalls.usageDeviation[]`：每个 logical call 的 phase/status、estimated/exact meter、measured/actual input 差值与比例、输出预留差值、是否超过输出预留，以及 actual total 是否超过声明窗口。

没有 Provider usage 的 refused/failed call 保持 `null`，不伪造为零。所有偏差由已有 Model Call Ledger 派生，不新增数据库列、缓存或第二状态源。Canary 的原始 Runtime Ledger 仍是 Authority。

`NEXORA_CANARY_CONTEXT_WINDOW_TOKENS` 现在只在显式提供时生效。未设置时 Canary 使用声明的真实 Provider Profile，且不把“必须发生 Eviction”作为真实大窗口验收条件；小窗口 Eviction 继续由确定性测试或显式 stress override 验证。12,000 是历史 E097 的压力配置，不是 qwen3.7-flash 能力，也不再是 Canary 隐式默认值。

用户提供的 Provider 能力截图显示 qwen3.7-flash 总上下文为 1M、普通最大输入约 991K、思考模式约 983K、最大输出能力 128K。本地真实 Provider Profile 因此配置为总窗口 `1,000,000`；decision 预留 `16,384` 以覆盖 dynamic thinking 的较低输入边界，validation/compaction 各预留 `8,192`。128K 是模型输出能力上限，不等于 Nexora 每次调用都应请求的输出预算。

## 边界

- 本 Feature 不提供模型名能力表，也不调用非标准 Provider discovery API。
- 不修改 Context 排序、Eviction、Compaction、Rehydration 或 hard refusal。
- 不根据少量 usage 样本自动调整下一轮预算。
- 当前没有真实 Provider rerun；新增模型进入 capability catalog 前仍需依据 Provider 文档或可审计证据核实能力。

## 验证

- 目标 Provider/CLI/Canary：5 files / 34 tests passed；
- 相关 L2 Context/Provider/CLI 回归：19 files / 113 tests passed，无 skip；
- Runtime build、typecheck、lint、root build 通过；
- 使用仓库真实 `.env` 只解析配置、不发送网络请求，得到 qwen3.7-flash：`contextWindowTokens=1,000,000`，decision/validation/compaction 输出预算为 `16,384 / 8,192 / 8,192`。
