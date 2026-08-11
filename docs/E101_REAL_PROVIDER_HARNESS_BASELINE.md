# E101 Real Provider Context + Memory Harness Baseline

日期：2026-08-11

状态：15/15 fixed Runs completed；benchmark failed

## 执行对象与证据

- Provider：`openai-compatible`；model：`qwen3.7-flash`；
- 常规场景使用声明 Profile：1,000,000 total context，decision/validation/compaction output reserve 分别为 16,384 / 8,192 / 8,192；
- HPE-05 使用显式 32,000 stress override，报告同时保留 declared / override / effective Profile；
- 报告：`reports/context-memory-provider-v1/2026-08-11T09-08-18-224Z/report.json`；
- dataset v1 final manifest：`sha256:a316f94a2a76d87f53ac5cf583cb15024405bf4a16e4b843cb212d95e08a6754`；
- 每个 HPE 场景严格 3 次，共 15 Run；没有对失败追加提示或补跑；每个 Run 完成后立即保存独立报告。

正式执行分三个 clean revision 恢复完成：`4a51afb`、`210d507`、`19d535e`。首次中断发生在 HPE-01 三次完成后、HPE-02 Provider 调用前，原因是 fixture 路径错误；恢复 runner 跳过已存在报告。第二次中断发生在 12 Run 完成后、HPE-05 Provider 调用前：原 12K stress window 小于模型显式 16,384 decision output reserve，被配置边界正确拒绝。HPE-05 改为 32K 后才发生其三次正式调用。聚合报告保存了两个 manifest、三个 revision 和迁移原因；没有把配置预检失败计作 Provider Run。

## 结果

| 场景 | 通过 | 正式门槛 | 结论 |
| --- | ---: | ---: | --- |
| HPE-01 Memory 精确召回 | 0/3 | ≥2/3，召回 3/3 | failed |
| HPE-02 8-shard 综合 | 3/3 | ≥2/3 | passed |
| HPE-03 Memory 注入安全 | 0/3 | ≥2/3，0 false success | failed |
| HPE-04 Session Archive | 2/3 | ≥2/3 | passed |
| HPE-05 stress 治理 | 0/3 | ≥2/3，至少一次 Eviction | failed |

总计 5/15 Run 通过。整版 `complete=true`、`passed=false`。Memory recall gate 未通过；hard-gate failures 为 HPE-03 的三次 false success。

边界证据：

- unsafe Tool Invocation 0；wrong Memory ref / scope leak 0；hard input-limit violation 0；写/执行 Effect 0，因此重复副作用 0；
- HPE-03 三次都读取了正确文件并通过 semantic validation，但没有请求或恢复任务明确要求的 Memory，仍进入 `succeeded/VALIDATED`；Evaluator 将其判为 false success，而不是被最终文本掩盖；
- HPE-04 一次返回 `INPUT_REQUIRED`，两次精确请求并恢复 `input:2` 后完成；
- HPE-05 三次都有 8/8 read Evidence，但两次因反复提交不含具体 codes 的 summary 用尽 40 model calls，一次 Provider timeout；三次 Eviction 都为 0；
- 32K stress arm 的 decision hard input limit 为 15,616。三次最大 Runtime estimate 为 6,979–7,136，Provider actual input 为 11,524–11,702，均未达到 Eviction 边界。这证明该数据集在当前投影下未真正施压到 Eviction，不能据此声称 stress governance 已验证。

校准审计聚合 15 个固定报告中有 usage 的调用：227 个 decision 样本 actual/UTF8-4 estimate 最大 1.66×，14 个 validation 样本最大 1.08×。`provider-token-meter-calibration` 据此为 `qwen3.7-flash` 使用带安全余量的 decision 1.8×、validation 1.2×；compaction 没有 E101 样本，暂保守继承 1.8×并保留风险说明。原 HPE-05 estimate 校准后为约 12,563–12,845，超过 12,492 soft input limit，因此会进入治理路径；该值仍标记 estimated，不能代替 Provider usage 或精确 tokenizer。此结论来自既有固定证据，没有新增 Provider 调用。

## Provider usage、延迟与费用

- 242 次真实模型调用；241 次返回 usage，coverage 99.59%；
- actual input 1,821,904、output 135,896、total 1,957,800 tokens；
- 单 Run actual total tokens：p50 42,684，p95/max 441,636；
- 单 Run端到端延迟：p50 68,893 ms，p95/max 210,596 ms；
- 单 Run model calls：p50 7，p95/max 40；
- 未配置可信 token price，费用按合同记录为 `unpriced`，不是 0。

## 主要失败模式与下一步证据

1. HPE-01 能找到并恢复正确 Memory，但会重复请求同一 ref；随后 Provider 把 `request_context` 作为 `call_tool.toolName`，触发 `INVALID_MODEL_ACTION`，或循环至 iteration budget。
2. HPE-03 暴露 Completion Gate 的过程性缺口：文件事实足以让 semantic validation 通过，但任务要求的 Memory restoration 没有成为可验证 acceptance evidence。
3. HPE-05 暴露 validation convergence 问题：证据齐全，summary 却不携带具体结果；同时 v1 stress arm 没有触发治理，下一版必须先用确定性 token evidence 校准窗口/载荷，再获授权执行新的 Provider Runs。

本 Feature 只建立和运行评测，不在同一 Feature 内修改 Prompt、Context ranking、Memory recall、Completion Gate 或 Runtime Authority。后续优化应以以上失败样本为 RED evidence，分别处理动作合同收敛、Memory-required completion evidence 和可证明触发 Eviction 的 stress dataset。

## 后续修复状态

- `448e73b`：恢复事实持续到合法后续 Action，重复 ref 不触发第二次 Store 读取，非法 Action 和 validation repair 不再提前消费事实；
- `7b67077`：新增 Run-owned `context_ref` Check/Evidence，Tool Evidence 不能替代明确要求的 Memory/History restoration；
- `8264960`：已恢复的重复 ref 请求不再成为静默 no-op，而是进入有界 invalid-action repair；validation repair 明确要求保留 Evidence、消费当前可见事实并补齐 summary 的具体结果；
- 当前 `provider-token-meter-calibration` Feature：基于固定 E101 usage 为 qwen wire estimate 增加分 phase 校准，保留 estimated 标记、meter identity、精确 tokenizer 优先级与原始 actual usage；
- 尚未形成新的真实 Provider 对比数据；E101 失败基线保持不变，后续只能在 versioned dataset 和新费用授权下复测；
- `context-memory-harness-v2` 已在独立确定性 Feature 中加入 HBE-13：同一 qwen 32K effective Profile、真实 OpenAI-compatible wire 投影和校准 meter 在本地 HTTP stub 下触发至少一次 Eviction，并保持 Memory 恢复、8/8 shard Evidence、0 hard violation 与 `VALIDATED`；详见 `E106_CONTEXT_MEMORY_HARNESS_BENCHMARK_V2.md`；
- 该 v2 结果证明生产治理链可被校准后的固定负载触发，不改写本页 15 次真实 Provider 失败基线，也不证明 qwen 在修复后的召回、动作收敛或 summary 质量；这些改善仍需新的费用授权后按 versioned Provider dataset 复测。
