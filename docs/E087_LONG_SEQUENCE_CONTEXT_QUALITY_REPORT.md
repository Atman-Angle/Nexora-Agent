# E087 Long-sequence Context Quality Gate

日期：2026-08-10

分支：`context-episodic-recall`

状态：`done_locally`

生命周期：`EXPLORE → DIRECT → VERIFY`

## 目标

用固定、可重复的长序列场景验证 Context Harness 的当前事实、结构化压缩、自动恢复和 Session 历史兜底是否各守边界，并只修复评测实际暴露的最小缺口。

## 固定质量场景

- early-constraint-anchor：首个目标 Input 始终可发现。
- superseded-constraint-authority：已覆盖 Input 不重新进入当前输入投影，当前 TaskContract 保持语义 Authority。
- repeated-failure-navigation：大量同类失败不能挤掉最新用户修正和其他语义类别的导航入口。
- false-recall-refusal：非法、未公开和跨 Run ref 不进入事实投影。
- restart-recovery：未消费的精确恢复请求可从 Event 恢复。
- branch-isolation：子 Run 只读继承 Fork Base，不越过分支边界读取历史。
- bounded-overhead：10,000 个 Input 与 10,000 个 Event 的模型可见 Archive 仍不超过 16 个 Milestone 和 8 KiB。

`pnpm run test:context-quality` 固定执行覆盖这些场景的 7 个测试文件，避免只用单个单元测试宣称 Context 效果完成。

## RED

在首个目标、24 个用户 Input、Plan、Approval、Checkpoint、Branch 和随后 40 次重复失败的固定数据上，旧选择算法保留首个 Input 后，其余位置被高优先级 Failure 占满；最新用户修正及 Plan/Approval/Checkpoint/Branch 导航消失。

这证明精确恢复通道虽然正确，但候选发现会在高频同类事件下发生导航饥饿。

## 最小修正

Session Archive 仍保持 16 条上限和原有优先级，不增加存储、模型调用或检索系统。选择顺序调整为：

1. 保留首个目标 Input；
2. 保留最新 Input；
3. 对已出现的 Failure、Approval、Plan、Checkpoint、Branch 各保留最新代表；
4. 剩余位置继续按原有安全优先级、时间和稳定序号填充。

Milestone 仍只是导航提示，原始事实仍必须通过 SourceRef 从 Authority Store 恢复。

## 验证

- RED → GREEN：重复失败压力下仍同时保留 `input:1`、最新 Input 和全部已出现的语义类别。
- Context 质量门：7 files / 65 tests passed。
- 完整回归：56 files / 249 tests passed；无跳过测试。
- E087 在完整回归中共 4 tests / 79 ms。
- 10,000 Input + 10,000 Event 场景：最多 16 Milestone、序列化 Archive 小于 8 KiB、单次投影低于 2,000 ms 宽松守卫。
- Typecheck、Lint、Runtime package build、root build 通过。
- `git diff --check` 通过。

## 决策

当前证据支持确定性的代表性导航，不支持向量检索、跨 Run Memory、新表或新模型调用。真实 Provider 的自然语言召回质量仍属于外部环境验收；在出现可重复的语义漏召回数据前，不扩张检索架构。
