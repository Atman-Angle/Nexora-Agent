# E106 Context + Memory Harness Benchmark v2

日期：2026-08-11

状态：deterministic stress baseline passed

## 目标

E101 的真实 Provider 基线暴露了一个证据缺口：32K HPE-05 的原始 UTF8/4 estimate 没有越过 soft input limit，因此 0 次 Eviction 不能区分“治理链失效”和“负载实际未达到治理边界”。E105 已用固定 E101 usage ledger 为 `qwen3.7-flash` 建立分 phase 的 estimated meter 校准。本 Feature 在不修改 Runtime policy、不扩大载荷和不调用外部 Provider 的前提下，验证校准后的同一类 32K wire input 确实进入治理路径，并能安全完成任务。

## Dataset 与执行路径

- Benchmark ID：`context-memory-harness-v2`；dataset version：2；
- v1 的 12 个场景、ID 和 runner contract 保持不变；v2 只追加 HBE-13；
- HBE-13 使用 32,000 total context、16,384 decision reserve、0.8 soft ratio；对应 decision soft/hard input limits 为 12,492 / 15,616；
- 测试经过生产 `createOpenAICompatibleProvider`、真实 wire projection、`qwen3.7-flash` E101 calibrated meter、Runtime Context Builder、Eviction、Memory rehydration、Tool Invocation/Evidence 和 Completion Gate；
- HTTP 响应由进程内确定性 `fetch` stub 提供。它不读取凭据、不访问外部网络，也不代替 Provider 模型质量。

HBE-13 的硬证据要求：至少一次 evicted decision、0 hard-limit violation、目标 Memory 被请求并精确恢复、8/8 shard reads 成功且 Evidence 持久化、最终 `succeeded/VALIDATED`。Evaluator 对缺失、failed、pending、skip 或 todo 证据 fail closed。

运行：

```powershell
pnpm run benchmark:context-memory:v2
```

报告写入 `reports/context-memory-harness-v2/<timestamp>/report.json`。v1 继续通过 `pnpm run benchmark:context-memory` 独立运行。

## 首份结果

2026-08-11T12:11:15.044Z 的 dirty-worktree 验证报告：

- 13/13 固定场景通过，scenario pass rate 100%；
- supporting suite 41/41，通过且无 failed/pending/todo；
- continuity 7/7、retrieval 5/5、budget 5/5、authority 5/5、safety 5/5、recovery 2/2、efficiency 2/2；
- HBE-13 记录至少一次 Eviction、0 hard violation、Memory 已恢复、8/8 shard reads 与 `VALIDATED`；
- qwen decision meter identity 为 `nexora:qwen3.7-flash:utf8-bytes/4*x1.8:e101-v1`；
- external Provider calls 0，Provider cost USD 0；总 benchmark 耗时约 28.74 秒。

## 结论与剩余风险

v2 证明校准后的 qwen 32K 最终 wire 投影能够驱动现有 soft-limit Context 治理，并在 Eviction 后保留所需连续性与安全完成合同。它没有新增预算 Authority、向量检索、状态源或生产分支，也没有用更大的窗口替代 Context 治理。

该证据是确定性的 Harness 能力证据，不是新的真实 Provider 质量基线。E101 的 15 次真实调用、失败率、usage、延迟与费用记录保持不变。修复后的真实 qwen recall、Action convergence、validation summary 质量和实际 token deviation，仍需用户重新授权费用后用新的 versioned Provider Eval 复测。
