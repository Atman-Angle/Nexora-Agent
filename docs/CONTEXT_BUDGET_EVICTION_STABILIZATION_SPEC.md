# Context Budget And Eviction Stabilization Spec

```yaml
feature: context-budget-eviction-stabilization
mode: EXPLORE
risk: L3
spec_status: approved_by_development_instruction
target_status: done_locally
```

## Goal

用一个 Feature 收敛 E080/E106：Provider meter 必须能观察每个可恢复的 Context 降级层级，
同时 versioned stress gate 必须声明一个与最小权威 wire 和输出预留自洽的唯一容量合同。

## Reproduced Baseline

- E080：`full=70` 超过 soft limit，`reference=55` 已可进入预算，但旧批量逻辑在同一轮继续
  删除刚生成的 reference；
- E106：Memory 已恢复、8/8 shard reads 已成功、0 hard violation，但测试入口使用 25K、
  scenario metadata 使用 24,384、原始报告使用 32K；25K 在预留 16,384 output 后只剩
  8,616 input hard limit，最小权威 wire 实测为 9,616 tokens。

E080 是生产收缩语义缺陷；E106 是后续 Prompt/Harness 增长后未同步的 benchmark 合同冲突，
二者共享 Context release gates，但不伪装为同一个根因。

## Invariants

- Provider meter 是输入预算 Authority；JSON byte ratio 只选择候选；
- 原始输入、required Evidence、Invocation provenance 和 Completion Gate 不被删除或弱化；
- 不扩大窗口掩盖生产缺陷，不伪造 token 计量，不创建第二 Context/State Authority；
- Runtime、Harness 保持 Provider-neutral，不增加 qwen/E080/E106 生产特判；
- hard limit 仍在 Provider 请求前 fail closed。

## Development Order

### Phase A — E080

1. 保持目标测试 RED；
2. 删除同一批次 `full -> reference -> drop` 的旧链式路径；
3. 单轮批处理至少保留一个刚生成的非关键 reference，再由 Provider meter 重测；批处理中可把
   该保留位轮换到更高价值候选，避免为每个 Observation 单独增加一次 Provider 测量；
4. 若 reference 仍超限，后续轮次仍可继续收缩或安全阻塞。

### Phase B — E106 exploration

从最终 Provider wire 记录字段级容量账本：Kernel、Transport、Tool catalog、Input/Task Contract、
Plan/Progress/Evidence、Observation/Memory/Repair。比较版本化文档、scenario metadata、测试入口和
实际 output reserve，决定是生产投影缺陷还是 benchmark 配置不自洽。

### Phase C — E106 convergence

优先删除重复派生投影或收缩非 Authority 控制描述；只有容量账本证明配置本身不可能满足合同时，
才把 benchmark 恢复到一个既能触发 Eviction、又能容纳最小权威投影的历史 versioned contract。
所有 test/scenario/report 数值和成功语义必须一致。

## Acceptance

- E080 13/13，reference 可见且 70→55 meter evidence 保留；
- E106 Memory requested/restored、8/8 reads、至少一次 Eviction、0 hard violation，最终
  `succeeded/COMPLETED`；
- E106 test、scenario metadata、报告只声明一个 context window；
- E089 100+ decision continuity 不出现新的容量或性能失败；
- `test:context-quality`、`test:runtime-harness-release`、build、typecheck、lint 和完整回归通过；
- 不保留旧链式收缩兼容分支，不增加公开 Contract 或迁移。

真实 Provider 复测属于单独授权的 External Acceptance，不以 deterministic fetch stub 替代。
