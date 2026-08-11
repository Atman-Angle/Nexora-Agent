# E098 Decision Context Budget Audit

日期：2026-08-11

状态：done_locally

## 结论

真实 Canary 的 `5,904` 不是 Runtime 常量，也不是 qwen3.7-flash 的已知物理上限。原始 Runtime Ledger 记录该 Run 实际使用：

```text
contextWindowTokens  = 10,000
decision output reserve / max_tokens = 4,096
hardInputLimitTokens = 10,000 - 4,096 = 5,904
softInputLimitTokens = floor(5,904 * 0.8) = 4,723
measuredInputTokens  = 9,559
```

因此拒绝调用的算术和安全行为正确；不一致来自 Canary 文档/当前默认源码声称测试窗口为 12,000，而不可变的当次 Ledger 证明有效窗口是 10,000。若窗口真为 12,000，同一 decision reserve 下 hard input limit 应为 7,904。

## 完整调用路径与准确含义

1. `openAICompatibleProviderFromEnv` 从 `NEXORA_MODEL_CONTEXT_WINDOW_TOKENS` 读取显式窗口；缺失时 `createOpenAICompatibleProvider` 使用兼容默认值 128,000。
2. Adapter 建立唯一 `ProviderModelProfile`：模型总上下文窗口、decision/validation/compaction 输出预留，以及 soft ratio。
3. `defineProviderAdapter.measureTokens` 先构造最终 Provider request，再计量 `system + user input`。OpenAI-compatible decision 投影会移除 Runtime-only provenance，但保留 Task、Plan、Evidence、Context、Action Contract、Tool Catalog 和当前可调用 Tool Schema。
4. `assessContextBudget` 按 phase 计算 `hard input = total context window - reserved output`；`soft input = floor(hard input * soft ratio)`。
5. decision 超过 soft limit 就继续确定性 Eviction，并在需要时 Compaction；仍超过 hard limit 才在 Provider 调用前拒绝。validation 使用其独立输出预留和既有有界 facts 投影。
6. Adapter 把同一个 phase reserve 发送为 `max_tokens`。Ledger 持久化窗口、reserve、soft/hard limit、最终输入计量、meter、budget decision 和 Provider 返回的实际 usage。

这里的 `contextWindowTokens` 是单次请求的输入与最大输出共享的总窗口；`measuredInputTokens` 已包含固定 system prompt、序列化包络、Tool/Action Contract 和 Context，而不是只包含 Context Builder 的业务字段。输出预留不是额外安全余量，它同时是发送给 Provider 的最大输出预算。soft ratio 是治理触发线；hard limit 是调用安全线。多轮执行每轮重新构建并计量，历史不会把不同请求的 token 直接累加到一个物理窗口。

## 一致性与缺陷判断

- Context Builder 不自行声称 token 容量；它负责相关性排序、按需恢复、压缩与可确定重建的 Eviction。
- Runtime 计量的是 Adapter 最终 wire projection，避免 Builder JSON 与 Provider 实际输入口径分裂。
- Adapter 的 `max_tokens` 与 Runtime 扣除的 phase reserve 来自同一 profile，没有第二预算 Authority。
- 当前只支持通用 OpenAI-compatible Adapter，模型名是开放字符串；仓库没有可靠的厂商能力发现或模型目录。因此 128,000 fallback 只是兼容值，不能当作任意模型的真实能力。
- 5,904 对此次被人为缩小窗口的 Canary 并不过度保守。真正的设计风险是能力未配置时可能过度乐观，以及粗略 `utf8-bytes/4` meter 对不同 tokenizer 只有估算语义。
- Provider usage 显示该样本 5 次成功调用的实际 input 为 2,664–4,145 tokens，而估算为 2,962–4,340；样本中估算偏保守，但一个样本不能证明所有语言、Tool Schema 或模型都如此。

## 方案比较

| 方案 | 优点 | 代价/风险 | 结论 |
| --- | --- | --- | --- |
| 直接扩大 Canary/Runtime 常量 | 修改最少 | 掩盖配置来源，不证明模型支持，削弱 Eviction 压力测试 | 拒绝 |
| 按模型名维护内置能力表 | 自动化 | 易过期，OpenAI-compatible 同名模型可能由不同后端承载，形成第二能力 Authority | 拒绝 |
| 启动时探测 Provider 能力 | 可能接近真实部署 | OpenAI-compatible 无统一能力端点；引入网络失败、缓存和漂移语义 | 当前不做 |
| 继续使用 ProviderModelProfile，并显式配置真实窗口 | 单一 Authority、兼容现有架构 | 配置者必须核实能力；未知时的 fallback 仍有风险 | 采用 |
| 缺失能力时 fail closed | 最安全 | 改变现有公开兼容行为和部署配置要求 | 需单独授权 |

采用方案不改变 Context 治理：更大的真实窗口只增加可用输入上限，soft-limit Eviction、Compaction、按需恢复和 hard refusal 均保留。流式与非流式共享相同的请求前预算；当前 Adapter 不实现流式传输。工具调用仍是下一轮 Context 的 Authority fact，而非在同一调用中无限追加。成本随实际输入/输出增加，Ledger usage 继续作为度量依据；未知价格仍不得记为零。

## 本轮最小改动与验证

Canary 报告新增按 phase 的有效窗口、输出预留、soft/hard input limit、最大实测输入、measurement method 和 meter，并检查 `hard = window - reserve` 与持久化 budget decision；不一致会使 Canary 失败。原始 v1 报告和数据库不改写。

新增/加强测试覆盖：

- 12,000 decision 与 validation 使用不同输出预留，分别得到 7,904 与 10,976 hard limit；
- env 显式 32,000 窗口进入唯一 Provider profile；
- token meter 接收包含固定 system prompt、Action Contract 与 Tool Catalog 的最终 wire request；
- Provider profile 缺失时现有 1,000,000,000 fallback 被明确锁定为兼容行为；
- 真正超过 hard limit 仍在 Provider 调用前拒绝，恰好等于 hard limit 仍允许。

## 剩余风险

1. OpenAI-compatible 环境未显式配置窗口时，128,000 默认值以及 custom Provider 的 1,000,000,000 fallback 都不是已验证能力；改为强制配置属于兼容/安全行为变化，应单独决策。
2. 默认 meter 是可审计的估算器，不是 qwen tokenizer。高风险生产配置应由 Adapter 注入精确 tokenizer meter，或保留足够保守的能力配置。
3. 某些 Provider 把 reasoning token 计入 completion usage 的方式不同，甚至可能不严格遵守 `max_tokens`；应以厂商合同和真实 usage 校验显式输出预留。
4. 当前没有流式 Adapter；以后增加 streaming 时必须在发送前沿用同一 profile/hard limit，并在中断输出时记录实际 usage，不得新增预算 Authority。

后续 E099 已替代第 1 项兼容风险：真实环境入口现在按模型名解析已验证能力，qwen3.7-flash 自动使用 1M 总窗口；未知模型 fail closed，12K 仅保留为显式 Canary stress override。
