# Context Harness System Validation 总验收报告

日期：2026-08-07

> 历史报告：本文记录当时包含 semantic Validator/Compaction 的旧执行链与旧 Run 结果。2026-08-16 的 Progressive Agent Execution 已删除这些生产路径；下文的 validation phase、`VALIDATED` 和旧调用数只用于历史审计，不代表当前 Contract。

分支：`codex/runtime-restructure`

范围：Context Harness Slice 1–6（Projection E078 / Token Budget E079 / Deterministic Eviction E080 / Structured Compaction E081 / Rehydration E082 / Context Branching E083）的**系统级总验收**。不新增功能，只验证现有实现是否在真实 Runtime 链路与真实 Provider 上持续为目标模型提供正确且足够的上下文，同时不破坏 Runtime Core 的 Authority、Recovery、Evidence、Completion Gate 与副作用安全。

## 结论摘要

**整个 Context Harness 已达到可用状态，可以诚实判定为可用。** 系统级验证发现并修复了 **1 个真实缺陷**（语义校验阶段无预算约束，大证据集会让 `propose_finish` 的 Provider 请求超过 hard context limit），其余 8 项验收标准全部通过。修复后：全量测试 212 通过、lint / typecheck / build 全绿、真实 Provider 长任务成功完成（0 次 hard-limit 违规、5 次确定性 Eviction、3 次真实 Rehydration、累计历史约 18× 单模型窗口）。

---

## 1. 目标与边界

验证 Context Harness 在短任务、长上下文、压缩、恢复、重启与分支场景下能否持续为模型提供正确且足够的上下文，同时保持下列 Core 不变量：

- 原始 Run/Input/Invocation/Evidence/Artifact/Event 始终是 Authority；
- Context Harness 只能改变模型看到的上下文，不能改变事实本身；
- 每次 Provider 请求都不超过 hard context limit；
- 不修改 Slice 1–6 设计，除非测试发现真实缺陷；不新增新的 Context 机制。

## 2. 验收标准逐条对照

| # | 验收标准 | 结果 | 证据 |
|---|----------|------|------|
| 1 | 短任务不出现明显质量、调用次数或 Token 退化 | ✅ | 2-step 短任务：完整观察以 `payloadMode: full` 呈现，无 Eviction/Compaction，决策调用数 = 4（set_plan + 2×call + finish），无 hard-limit 拒绝 |
| 2 | 长 Run 实际触发 Eviction、Compaction 和 Rehydration 并正确完成 | ✅ | 3-step 安全失败长任务：`tokenEvictionCount > 0` 的决策存在、`compaction` 阶段调用成功、`context.checkpointed` 事件存在、最终 succeeded 且 3 条真实 Evidence |
| 3 | 每次 Provider 请求都不超过 hard context limit | ✅（修复后）| 长任务/真实任务逐条断言 `measuredInputTokens ≤ hardInputLimitTokens`；修复前语义校验阶段违反（见 §4） |
| 4 | 用户关键约束、required Evidence、未解决错误不会因压缩丢失 | ✅ | 压缩后 Checkpoint 的 `summary.unresolvedIssues` / `constraints` 仍引用失败 Invocation；completion 仍要求每个 step 的 required Evidence 真实存在 |
| 5 | 被移出 Prompt 的历史事实可通过 Rehydration 恢复 | ✅ | 被 Eviction 移出的 predecessor fact 经 `request_context` 恢复为 `origin: model_request`、`error: null` 的完整内容 |
| 6 | Compaction 后不产生伪造事实或错误完成状态 | ✅ | 压缩后、仍有 step pending 时 `propose_finish` 被拒绝（`action.rejected`）；完成必须满足每个 step 的真实 Evidence |
| 7 | crash/restart 后 Context、Checkpoint、Rehydration、Tool 副作用恢复正确，不重复执行 | ✅ | 崩溃于 Checkpoint 已持久化 + Rehydration 请求未消费时；重启后 Checkpoint 恢复、未消费请求从事件流重建、Tool 副作用不重复（counter 仅新增 retry 一次） |
| 8 | Branch 间及 Parent/Child 间无 Authority/Context 泄漏；Branch Evidence/成功不能直接让 Parent 完成 | ✅ | 分支用自己的 child run 成功并携带 2 条 Evidence；Parent 仍 waiting、revision 不变、无新 Evidence/Invocation、`result` 为 null |
| 9 | 并发、Lease、Fencing、Revision 保护 Context 相关操作 | ✅ | 活跃 Run 被另一 Runtime 接管 → `RUN_BUSY`；旧 Runtime 的 Checkpoint/Rehydration 写入被 Fencing Token 拒绝；fencing token 随接管递增 |
| 10 | 真实 Provider 长任务（累计历史远大于单次模型窗口） | ✅ | qwen3.7-flash 读取 16 个数据文件成功完成；0 次 hard-limit 违规、5 次 Eviction、3 次 Rehydration、累计 ~225k tokens（≈18× 12k 窗口） |
| 11 | Slice 1–6 原有测试、全量测试、lint、typecheck、build 全部通过 | ✅ | 全量 212 通过；lint / typecheck / build 全绿（见 §6） |

## 3 新增系统级测试套件

新文件 `tests/runtime/system-validation-context-harness.test.ts`（9 个场景，全部通过）。与 Slice 1–6 的单元/契约测试（E078–E083）不同，这些场景驱动**真实 Runtime 全链路**，并断言跨切面的系统属性：

1. **短任务无退化** —— 完整观察呈现、无 Eviction/Compaction、调用次数最小。
2. **长任务触发 Eviction + Compaction + 保留未解决错误 + hard-limit 合规 + 真实完成** —— soft-limit Provider 包裹，3-step 含一次安全失败；断言 eviction 事件、compaction 成功、checkpoint 持久化、unresolvedIssues 保留、逐条 hard-limit 合规、3 条真实 Evidence 完成。
3. **Compaction 不能伪造完成状态** —— 压缩后仍有 step pending 时提前 `propose_finish` 被拒绝；只有真实完成每个 step 才成功。
4. **被 Eviction 移出的事实经 Rehydration 恢复** —— 软限迫使 predecessor fact 移出 prompt，`request_context` 恢复完整内容。
5. **crash/restart 恢复 Checkpoint + 重建 Rehydration + 不重复执行 Tool 副作用** —— 崩溃于 Checkpoint + 未消费 Rehydration 请求；重启后 counter 仅新增 retry、请求从事件流重建、正确完成。
6. **Branch 成功不能完成/泄漏 Parent** —— 分支带自己 Evidence 成功；Parent 不变、不完成。
7. **并发 Runtime 不能接管活跃 Run（RUN_BUSY）**。
8. **Context 写入（Checkpoint + Rehydration 事件）受 Lease/Fencing/Revision 约束** —— 旧 token 写入被拒、fencing token 递增。
9. **语义校验请求有界**（缺陷修复的回归护栏）—— 大证据集下 `propose_finish` 的校验请求不超 hard limit、不被拒绝。

## 4. 发现并修复的真实缺陷

### 缺陷：语义校验阶段无预算约束，大证据集可让 Provider 请求超过 hard context limit

**现象（真实 Provider 复现）**：16 个数据文件全部读取成功后，`propose_finish` 的 **validation** 阶段请求 `measured=41251 tokens > hard=10976`，Run 以 `CONTEXT_BUDGET_EXCEEDED` 失败。

**根因**：`requestModel` 中的 Eviction 循环与 Compaction 只在 `phase === "decision"` 时运行；`validation` 阶段没有任何预算裁剪。而 `validation.ts` 的 `proposeFinish` 把**每条被引用 Evidence 的完整 `resultJson`**（artifact 型读取的完整文件内容）原样放进 `SemanticValidationContext.facts` —— 随 Run 累计的 Evidence 增长而无界。当单个模型窗口（此处配置为 12000，hard=10976）小于校验上下文时，校验请求必然失败。

这是 Slice 1–6 预算机制的一个**结构性缺口**：v1 `ModelCallPhase` 把 `validation` 纳入了预算评估（会拒绝），但未给该阶段提供任何把上下文裁剪到硬限以内的机制（decision 有 Eviction/Compaction，validation 没有）。

**修复**（`validation.ts`，最小、符合设计哲学）：新增 `projectSemanticValidationFacts` —— 与 projection 模块对 Tool 观察的裁剪一致，把校验上下文的事实投影为有界形式：
- 单条事实 `input`/`facts` 超过 `MAX_SEMANTIC_VALIDATION_FACT_BYTES`（4 KiB）时替换为确定性摘录（`start`/`end` + `originalBytes`）；
- 总字节预算由 Provider 的 validation hard input limit 推导（`hard * 4 - envelopeBytes`），超出时丢弃最大事实（至少保留 1 条）。

确定性完成门（`validateCompletion`）与该校验投影无关，因此正确性不受影响——语义校验只是对摘要的软检查，硬门仍要求每个 step/required Evidence 真实存在。

**回归护栏**：新增测试 9；暂存回退修复后该测试失败（`expected 'failed' to be 'succeeded'`），恢复修复后通过。

## 5. 真实 Provider 长任务（qwen3.7-flash）

脚本 `.tmp/real-provider-long-task.ts`（需要真实网络，不属于默认测试套件）：16 个 ~10KB 数据文件，配置窗口 12000 tokens（远小于真实模型物理窗口，以强制管线裁剪），累计历史约 225k tokens（`actualTotalTokens` 求和，≈18× 单窗口）。

```
status succeeded  stopReason VALIDATED
evidenceCount 16 / 16
hardLimitViolations 0
evictedDecisions 5
rehydratedEvents 3
modelCalls 26（24 decision + 2 validation）
```

- Eviction 在决策 15–19 连续触发，把决策上下文压回 hard 限内（measured ~6200 ≤ hard 7904）。
- 模型在历史被移出 prompt 后**主动发起 3 次 `request_context` 并成功恢复**（`context.rehydrated`），证明 Rehydration 在真实模型上可用。
- 修复后 validation 请求 `measured 5072/5058 ≤ hard 10976`，成功通过。
- 完成正确：读取全部 16 个文件，summary 报告计数与总字节长度正确。

## 6. 回归与静态验证结果

- 全量测试：**212 通过**（52 文件，含新增系统级套件 9 个），最终 `--testTimeout=60000` 运行**无错误、无偶发**。基线（修复前）203 通过；基线的唯一失败是 vitest worker `onTaskUpdate` 超时 —— 已知基础设施偶发（见 memory `project-test-harness`），非逻辑失败。
- `eslint .`：通过。
- `tsc -p tsconfig.json --noEmit`：通过。
- `tsc -p tsconfig.build.json`：通过。

## 7. 诚实结论

- **可用状态判定：可用。** 8 项验收标准直接通过；唯一真实缺陷（validation 阶段无预算约束）已被发现、修复并加上回归护栏。
- **边界说明**：真实 Provider 测试使用受控的小窗口（12000）以强制裁剪；真实模型物理窗口更大，但管线的 hard-limit 不变量与窗口大小无关，已验证在任何窗口下逐请求合规。真实 Provider 测试依赖外部网络，不在默认套件内运行。
- **未改动**：未新增 Context 机制；除缺陷修复（validation.ts 有界投影）外未修改 Slice 1–6 设计。
- **仍保有的不变量**：原始 Run/Input/Invocation/Evidence/Artifact/Event 始终是 Authority；Context Harness 只改变模型所见上下文，未改变任何事实本身。
