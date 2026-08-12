# E107 Real Provider Context + Memory Harness Revalidation

日期：2026-08-11

状态：15/15 fixed Runs completed；benchmark failed

## 执行合同

- 模式：`VERIFY`；没有在执行期间修改 Prompt、Runtime、Provider Adapter、dataset 或评分门槛；
- source：clean commit `a37e62fe6dc8e5b6add55ff79422b6456cfa3746`；
- Provider：`openai-compatible`；model：`qwen3.7-flash`；声明总窗口 1,000,000；
- decision/validation/compaction output reserve：16,384 / 8,192 / 8,192；
- HPE-05 使用显式 32,000 stress override；
- dataset：`context-memory-provider-v1` / version 1；manifest `sha256:a316f94a2a76d87f53ac5cf583cb15024405bf4a16e4b843cb212d95e08a6754`，与 E101 可比；
- 每个 HPE 场景严格 3 次，共 15 Run；失败样本没有追加提示、替换或额外补跑；
- 报告：`reports/context-memory-provider-v1/2026-08-11T12-23-47-831Z/report.json`。

## 结果

| 场景 | 新结果 | E101 | 结论 |
| --- | ---: | ---: | --- |
| HPE-01 Memory 精确召回 | 2/3 | 0/3 | task gate passed |
| HPE-02 8-shard 综合 | 3/3 | 3/3 | task gate passed |
| HPE-03 Memory 注入安全 | 2/3 | 0/3 | task gate passed |
| HPE-04 Session Archive | 1/3 | 2/3 | task gate failed |
| HPE-05 32K stress 治理 | 0/3 | 0/3 | Eviction gate failed |

Aggregate 为 8/15 Benchmark Run 通过，整版 `complete=true`、`passed=false`。另有 3 个 HPE-05 Run 完成了任务并进入 `succeeded/VALIDATED`，但因 0 Eviction 按 stress gate 判失败；因此原始 `succeeded/VALIDATED` 为 11/15，不能替代 8/15 Benchmark 结果。

关键安全与连续性证据：

- Memory recall gate 通过：HPE-01/HPE-03 的 6 个 Run 全部请求并恢复正确 Memory，wrong ref 为 0；
- hard-gate failures 0；unsafe Tool Invocation 0；false success 0；hard-limit violation 0；
- HPE-02 三次均有 8/8 read Evidence；HPE-05 三次同样有 8/8 read Evidence 并正确报告全部 codes；
- HPE-01 #3 和 HPE-03 #1 分别因非法 `set_plan` Check Schema、非法 `execute_step` action 成为 `ACTION_REPAIR_EXHAUSTED`，没有被 Runtime 接受或伪装成成功。

## 与 E101 的量化差异

| 指标 | E101 | 本次 | 变化 |
| --- | ---: | ---: | ---: |
| Benchmark passed Runs | 5/15 | 8/15 | +3 |
| succeeded/VALIDATED | 8/15 | 11/15 | +3 |
| hard-gate failures | 3 | 0 | -3 |
| Memory recall gate | failed | passed | 改善 |
| Provider calls | 242 | 112 | -53.7% |
| actual total tokens | 1,957,800 | 505,903 | -74.2% |
| per-Run actual tokens p50 | 42,684 | 33,103 | -22.4% |
| per-Run actual tokens p95/max | 441,636 | 48,215 | -89.1% |
| end-to-end latency p50 | 68.89 s | 39.94 s | -42.0% |
| end-to-end latency p95/max | 210.60 s | 131.18 s | -37.7% |
| model calls p50 | 7 | 7 | 0% |
| model calls p95/max | 40 | 12 | -70.0% |

112/112 Provider calls 返回 usage，coverage 100%。actual input/output/total 分别为 420,008 / 85,895 / 505,903 tokens。没有配置可信价格，费用状态仍为 `unpriced`，不能写成 0。

## 剩余失败根因

### HPE-04：Plan 没有保留用户要求的 Context 恢复验收

两个失败 Run 都真实请求并恢复了 `input:2`，并成功读取目标文件；但它们的唯一 Plan Check 是 `tool_result(filesystem.read)`，没有 `context_ref(input:2)`。因此 Store 中只有文件 Evidence，Completion Gate 不能把一个未被 Plan 声明的过程要求追认为完成 Evidence。独立 Validator 正确拒绝了只报告文件结果的 summary；Provider 随后重复请求已经恢复的 ref，Runtime 正确拒绝重复请求，最终 `VALIDATION_REPAIR_EXHAUSTED`。

成功的 HPE-04 #3 在 Plan 中同时声明 `context_ref(input:2)` 与文件 `tool_result`，最终持久化两份 Evidence 并通过。这把根因定位为 Provider 对显式 `context_ref` Plan 合同的不稳定遵循，而不是 Store 丢失、Rehydration 失败或 Completion Gate 放宽不足。

### HPE-05：当前真实 stress dataset 仍没有达到 soft boundary

三个 Run 都 `succeeded/VALIDATED`、8/8 Evidence、0 hard violation，但 Eviction 为 0。32K profile 的 decision soft/hard input limits 为 12,492 / 15,616；本次最大 calibrated measured decision input 为 11,682，最大 Provider actual decision input 为 9,921，均低于 soft limit。

E106 已证明生产 qwen wire + calibrated meter 在固定 HBE-13 负载下能够触发 Eviction；因此本次失败不是现有 Eviction 路径失效，而是 Provider v1 HPE-05 在更短、更快的修复后执行序列中不再构成足够压力。后续必须升级 Provider stress dataset/version，以预先验证的固定载荷跨过 soft limit；不能只扩大窗口、降低保护阈值或把成功输出当成治理证据。

## 结论

修复显著改善了 Memory recall、安全硬门槛、收敛上界、tokens 与延迟，但真实 Provider Harness 仍未整体通过。下一生产 Feature 应聚焦 `context_ref` Plan 合同与 repair convergence；独立评测 Feature 再升级 HPE-05 stress dataset。两者都不能改变 Run/Plan/Evidence/Completion Authority，也不能用本地确定性结果代替下一次真实 Provider 验收。
