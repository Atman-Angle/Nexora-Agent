# Nexora Autonomous Coding Execution v0.1

```yaml
feature: autonomous-coding-execution-v0.1
status: validated
mode: VERIFY
risk: L3

primary_scope:
  - Harness / Strategy Router
  - Coding Strategy
  - Prompt / Context Projection
  - Recovery / Convergence policy integration

runtime_authority_change: forbidden
new_agent_loop: forbidden
new_plan_state_machine: forbidden
new_completion_authority: forbidden
provider_specific_hack: forbidden
```

Implementation report: `docs/AUTONOMOUS_CODING_EXECUTION_V0.1_REPORT.md`. Primary real-provider acceptance passed and the completed 3x3 reliability sample passed acceptance (9/9 validated, false success 0), so the Feature is validated locally.

## 1. Outcome

Nexora 应当能够：

> 自动判断当前任务应使用 Coding Strategy 还是 General Strategy，并在 Coding 任务中以“短判断 → 动作 → 新事实 → 下一动作”的节奏持续推进；普通失败和暂时无进展由 Agent 自主恢复，不再轻易把任务停在 `blocked` 或要求用户决定是否继续。

本 Feature 解决当前真实暴露出的四类问题：

1. 用户无法确认当前 Run 实际使用的是 Coding 还是 General Strategy；
2. Coding Task 每轮 Prompt / Context / 模型反馈过长，明显动作前存在过度推理；
3. 简单任务会持续几十分钟甚至一小时，反复修改却没有形成新的有效进展；
4. `NO_PROGRESS_DETECTED`、普通 Tool / Validation / Plan failure 容易转化为用户驱动的 blocked / resume，而不是 Agent 自己换策略继续。

目标执行形态：

```text
User Goal
↓
Nexora Strategy Router
↓
Coding / General
↓
bounded decision context
↓
short decision
↓
high-value action
↓
authoritative observation
↓
continue / recover / validate / complete
```

而不是：

```text
巨大 Prompt
↓
长时间 reasoning
↓
完整重新规划
↓
一个 Tool
↓
巨大 Prompt
↓
再次长 reasoning
↓
反复修改
↓
NO_PROGRESS
↓
等待用户决定是否继续
```

---

## 2. First Principle

本 Feature 必须保持两条边界：

> **模型负责决定“下一步怎么做”。**  
> **Runtime 负责决定“是否允许继续、等待、失败或完成”。**

Strategy Router 只选择策略投影，不拥有 Run Authority。

Coding Strategy 只影响模型决策，不拥有 Plan、Tool、Evidence、Recovery、Validation 或 Completion。

---

## 3. Implementation Before Change: Real Repository Audit

实现前先检查当前真实仓库和最近真实 Run，不允许仅根据本 Spec 猜测现状。

必须先回答：

### Strategy

- 当前个人探索日志 / 个人存储记录 Run 实际使用的是 `coding` 还是 `general`？
- Strategy activation 的真实输入是什么？
- 是否存在 Session 级永久 Coding 标记？
- 是否存在 Coding Strategy 已激活但 Renderer / Trace 无法看见的情况？

### Prompt / Context

对一个真实长 Run，统计：

- 每次 model request input tokens；
- Coding projection tokens；
- static prompt tokens；
- dynamic prompt tokens；
- Tool / Evidence history tokens；
- RepoSketch tokens；
- controlState guidance tokens；
- 是否存在重复注入相同规则；
- 是否普通 Tool observation 后重新发送大量无变化上下文。

### Model cadence

统计：

- model call 数；
- 每次 model response / reasoning token；
- model call → first Tool latency；
- Tool → next model call latency；
- Tool calls / model call；
- Plan revisions；
- 同一文件重复 edit 次数；
- verifier calls；
- repeated strategy fingerprint；
- 首次 core requirement completion 时间；
- 首次全部 core requirement 满足时间；
- terminal 时间。

先定位真实 First Broken Boundary，再选择最小实现。

---

## 4. Strategy Router

Nexora 默认必须自己选择 Strategy。

用户正常产品路径不需要：

```text
Coding Mode
General Mode
```

这样的手工开关。

开发 / Eval 可以保留显式 override，例如：

```text
auto
coding
general
disabled
```

但产品默认必须是：

```text
auto
```

### Router Inputs

Strategy Router 只能使用当前已有或可派生事实，例如：

- current user intent；
- Host `taskMode`；
- workspace facts；
- repository indicators；
- current Session / Run facts；
- user-requested effect；
- current unfinished work。

### Router Output

至少：

```yaml
strategyProfile: coding | general
reason: <bounded machine-readable reason>
confidence: high | medium | low
codingTaskShape: greenfield | bug_fix | feature | refactor | null
```

这是 Harness 派生事实，不是 Runtime Authority。

### Routing Principle

高置信度软件工程执行任务：

```text
创建网页 / App / CLI / API
修改代码
修复 bug
实现 feature
重构
运行测试并修复
编译 / 构建 / 软件工程验证
```

→ Coding Strategy。

仅解释、总结、研究：

```text
解释代码
分析架构
总结 README
比较技术
写学习笔记
```

→ General Strategy。

### Empty Workspace

空 Workspace 不是 General 的理由。

例如：

```text
“从零做一个个人探索日志网页”
```

必须能够高置信度进入 Coding。

### Turn-level Routing

不要永久绑定整个 Session。

允许：

```text
Coding → Coding → General explanation → Coding
```

Strategy 应按当前 Turn / Run 的主要工作重新派生。

---

## 5. Strategy Observability

开发 Trace 必须能直接看到：

```yaml
strategyProfile: coding
activationReason: explicit_software_creation
confidence: high
codingTaskShape: greenfield
```

普通产品 UI 不必显示这些内部字段。

目标是：

> 出现 Coding 行为问题时，不再需要猜测“是不是还在跑 General”。

---

## 6. Action-First Coding Cadence

Coding Task 默认采用：

```text
minimum necessary reasoning
→ action
→ observation
→ next decision
```

对于明显、低风险、信息充分的操作，例如：

- list relevant files；
- read manifest；
- read named file；
- inspect existing tests；
- apply focused edit；
- run known focused verifier；

模型不应为了这些动作先生成长篇解释或重新分析整个任务。

### Desired behavior

```text
需要知道项目脚本
→ 读取 manifest

需要确认某个实现
→ 读取相关文件

已经知道最小修改
→ 修改

完成一个 meaningful slice
→ focused verification
```

而不是：

```text
重新解释整个目标
→ 重述 Plan
→ 长 reasoning
→ 再决定读取一个文件
```

---

## 7. Adaptive Reasoning

Reasoning 强度应与当前执行阶段和不确定性相关，而不是所有 Step 都保持同一深度。

复用现有 `controlState`。

推荐语义：

### INITIAL_PLANNING

允许中等推理：

- 理解目标；
- 确定 task shape；
- 建立最小 Outcome Plan；
- 获取必要 repo facts。

### EXECUTION

默认低推理、action-first。

只要：

- 当前 next action 明确；
- 没有关键冲突；
- 没有安全边界；

就优先执行。

### VALIDATION

默认低至中等：

- 选择最低成本且足够的 verifier；
- 读取第一条有效失败事实。

### FAILURE_REPAIR

允许提高推理：

- 当前策略已真实失败；
- failure observation 改变方案；
- 需要选择明显不同的新策略。

### COMPLETION

低推理：

- 对照核心要求和 Evidence；
- 不继续发明 optional improvement；
- 满足后提出 Completion。

如果 Provider 支持 request-level reasoning / thinking 配置，可以使用现有 Provider capability 做动态调整。

如果 Provider 不支持，不为了该功能引入 Provider-specific fork；通过 Strategy guidance 达到相同语义。

---

## 8. Prompt / Context Budget Discipline

当前 Coding Strategy 不应通过持续叠加 Prompt 规则来工作。

必须检查并压缩：

- 重复 Coding rules；
- 每轮重复的 static instructions；
- 已过时 Tool output；
- 大量 search/list output；
- 已被新 Observation 取代的 failure details；
- 与当前 unfinished outcome 无关的 RepoSketch 内容。

### Dynamic Context Priority

优先：

```text
Current user goal
Current required outcomes
Current controlState
Current unfinished outcome
Latest meaningful observation
Relevant code
Relevant repo instruction
Available focused verifier
```

降低优先级：

```text
已完成 outcome 的细节
重复文件列表
旧 compiler log
旧 search output
无关 code
optional feature
```

### No Prompt Accretion

新的 Coding Cadence guidance 不允许简单叠加第二套长 Prompt。

实现完成时必须审查：

```text
KEEP
MERGE
MOVE
DELETE
```

并证明 Prompt / dynamic projection 没有无边界增长。

---

## 9. Stable Outcome Plan

Coding Plan 应是低频、Outcome-level 的稳定骨架。

例如 Greenfield MVP：

```text
1. 建立最小可运行产品
2. 完成核心交互
3. 验证核心要求
```

普通 Tool result 不应自动导致 Plan revision。

只有以下事实发生时才值得 revision：

- 用户改变目标；
- 新事实使当前 outcome 不再成立；
- failure 证明原策略不可继续；
- required scope 真实变化。

不要把：

```text
read
write
test
read
write
```

变成反复 Plan maintenance。

### Goal

```text
Plan revisions << Tool actions
```

---

## 10. Core Requirement Tracking

Coding Strategy 必须持续区分：

```text
required core outcomes
optional enhancements
```

普通 Coding Run 的进展判断优先基于：

- required outcome 是否首次满足；
- 是否产生新代码 effect；
- 是否产生新的 verification evidence；
- 是否产生改变下一策略的 failure observation。

以下不算有效进展：

- 只改 Plan 文案；
- 重复读取相同事实；
- 同一 edit strategy 无变化地重试；
- 纯 cosmetic 修改但核心要求未推进；
- optional enhancement 增加；
- 重复验证相同事实且无新 Evidence。

---

## 11. Coding Convergence

Coding Task 不应允许长时间反复修改却没有新的 authoritative progress。

例如：

```text
edit app.js
→ edit styles.css
→ edit app.js
→ edit app.js
```

如果期间没有：

- 新 required outcome satisfied；
- 新 verifier evidence；
- 新 meaningful failure observation；

则当前 strategy 应被视为失效候选。

### Recovery Trigger

发生 bounded non-progress pattern 后：

```text
preserve completed work
↓
identify smallest unfinished required outcome
↓
drop optional work
↓
require a materially different strategy
↓
continue
```

不是：

```text
NO_PROGRESS_DETECTED
↓
blocked
↓
ask user to “换一个方向”
```

---

## 12. NO_PROGRESS Semantics

`NO_PROGRESS_DETECTED` 默认是：

> **当前 strategy exhausted**

不是：

> **整个任务 blocked**

Runtime / Harness 应优先进入自主 Recovery。

Recovery 必须：

- 保留已确认 effects；
- 保留 Evidence；
- 保留 completed outcomes；
- 不重复已知无效 strategy；
- 收缩 optional scope；
- 重新聚焦最小 required outcome；
- 要求模型选择 materially different next strategy。

只有所有合理 recovery path 都被有界耗尽，才进入 terminal failure。

---

## 13. Blocked Reduction

本 Feature 不新增第二套状态机，但要审查当前 `blocked` 进入条件。

以下情况默认不应直接进入用户驱动的 blocked：

- 单个 Tool failure；
- Validation failure；
- Plan failure；
- ordinary process error；
- recoverable provider failure；
- `NO_PROGRESS_DETECTED`；
- 可安全 reconcile 的重复副作用；
- 已知可替代的 Coding strategy failure。

这些应保持：

```text
running / recovering
```

并由 Agent 自主继续。

---

## 14. Legitimate Human Wait

只有真实的人类依赖才等待用户。

### `waiting_for_input`

仅当：

> 必要信息无法从 Workspace / Tool / Session / external capability 获得，并且只有用户能提供。

例如：

```text
存在两个无法区分的目标收件人
```

不是：

```text
不知道项目怎么启动
```

后者应自己查 manifest / README / scripts。

### `waiting_for_approval`

仅用于真实 Approval policy：

- 高风险副作用；
- destructive operation；
- 权限边界；
- production publish；
- 外部消息 / 财务等受控行为。

普通 Workspace Coding 修改不应因为“可能影响文件”就反复等待用户。

---

## 15. Unknown Side Effect

重复副作用不能简单转换为 blocked。

必须复用现有 Invocation / idempotency / effect facts。

语义：

```text
effect known succeeded
→ reconcile existing effect
→ continue

effect definitely not executed
→ retry / alternative strategy

effect unknown + idempotent / reconcilable
→ safe reconcile / retry

effect unknown + non-idempotent + not reconcilable
→ legitimate human / hard boundary
```

模型没有 Authority 因为“感觉危险”自行宣布 blocked。

---

## 16. Hard Boundary

如果 Agent 已经完成 bounded recovery，且存在真实不可恢复边界：

- 必要环境不存在；
- 必要 capability 不存在；
- Provider 在 bounded retry 后仍不可用；
- recovery / budget 已耗尽；
- unknown non-idempotent side effect 无法 reconcile；
- 必要事实客观无法获得；

则应该：

```text
failed
```

并清晰告诉用户：

- 已完成什么；
- 尝试过哪些不同策略；
- 最后的真实边界是什么；
- 如果用户能提供什么，新 Run 可以继续。

不要用模糊 `blocked` 代替明确 failure。

---

## 17. Live Model Feedback

本 Feature 不要求公开隐藏 Chain of Thought。

用户可见的 Live Work Feedback 只能来自真实公开/结构化事实，例如：

```text
正在检查项目
正在实现核心交互
正在运行验证
验证发现问题，正在调整
正在尝试新的解决方式
正在整理结果
```

中间模型反馈应简洁、action-oriented。

不要把长 reasoning 直接投影到 Conversation。

---

## 18. Non-goals

本 Feature 明确不做：

- 第二套 Coding Runtime；
- 第二套 Agent Loop；
- 第二套 Plan；
- 第二套 Recovery state machine；
- Coding-specific Completion Authority；
- 永久 `codingSession=true`；
- 用户手工选择 Coding / General 作为默认产品路径；
- 显示隐藏 Chain of Thought；
- 为了降低延迟强行跳过 Runtime Authority；
- Provider-specific forced tool choice hack；
- AST / LSP / semantic repo database；
- Coding v0.2 功能扩张；
- Activity 全面重做。

---

## 19. Primary Real-Run Acceptance

必须复用当前真实失败/超长的 Greenfield Coding 场景：

> 从零创建个人探索/个人存储记录网页。

保持：

- 同模型；
- 同 Runtime；
- 同 Built-in Tools；
- 同 Workspace 起点；
- 同用户 Prompt；
- 同 Context / Tool budget；
- 仅使用新的 Router / Coding Cadence / Recovery behavior。

### 必须记录

```text
strategyProfile
activation reason
task shape
model calls
tool calls
input tokens per model call
output / reasoning tokens per model call
time to first tool
time to first edit
time to first verification
plan revision count
same-file edit count
repeated strategy count
verification calls
first core outcome satisfied
all core outcomes satisfied
completion attempted
terminal time
NO_PROGRESS count
blocked count
false success
```

---

## 20. Diagnostic Interpretation

结果必须能回答：

### Case A

```text
strategyProfile = general
```

则 First Broken Boundary 是 Router。

### Case B

```text
strategyProfile = coding
大量时间没有 Tool
model reasoning / output 很长
```

则 First Broken Boundary 是 Reasoning / Action Cadence。

### Case C

```text
Coding active
Tool 很多
同文件反复改
没有新 Evidence
```

则 First Broken Boundary 是 Coding Convergence。

### Case D

```text
核心要求已经满足
仍继续 optional edit / validation
```

则 First Broken Boundary 是 Completion / Stop Discipline。

### Case E

```text
失败后直接 blocked
但仍存在安全 alternate strategy
```

则 First Broken Boundary 是 Recovery / Blocked semantics。

不得把这些不同问题混成一个“模型能力不足”。

---

## 21. Reliability Sample

主场景通过后，再做小样本验证。

建议：

```text
Greenfield × 3
Existing Feature × 3
Bug Fix × 3
```

不需要扩大成大型 benchmark。

关注：

- Completion rate；
- false success；
- strategy routing correctness；
- average time to first meaningful action；
- plan revision rate；
- repeated edit rate；
- effective Tool ratio；
- scope expansion；
- NO_PROGRESS recovery success；
- blocked rate。

---

## 22. Success Criteria

本 Feature 只有满足真实行为改进才算验证。

### Router

- 明确 Coding execution task 稳定进入 Coding；
- 明确解释 / 分析任务稳定使用 General；
- 空 Workspace 软件创建任务能进入 Coding；
- Session 可在 Coding / General 间按 Turn 切换；
- 开发 Trace 可直接看到激活原因。

### Cadence

- 普通 inspect / edit / verify 不再伴随明显长篇决策输出；
- time-to-first-tool / first-edit 明显下降；
- ordinary Tool observation 不再频繁触发 Plan revision；
- Context / Prompt 不持续膨胀。

### Convergence

- simple Coding task 不再长时间反复 edit 无新 Evidence；
- `NO_PROGRESS_DETECTED` 优先触发自主换策略；
- optional scope 能在 recovery 时被收缩；
- repeated ineffective strategy 明显下降。

### Blocked

- recoverable Coding failures 不再轻易进入 blocked；
- waiting_for_input 仅用于真实用户独占信息；
- waiting_for_approval 仅用于真实风险/权限边界；
- hard unrecoverable boundary 明确 terminal fail，而不是无限 Continue。

### Authority

- false success = 0；
- Task Contract 不变；
- Plan Authority 不变；
- Evidence 不变；
- Approval Authority 不变；
- Runtime Completion Gate 不变；
- no second state machine。

---

## 23. Completion Report

完成后必须输出：

### Architecture

- Strategy Router 接在真实仓库哪里；
- Coding / General 如何按 Turn 派生；
- Adaptive Reasoning 如何实现；
- Prompt / Context 如何减重；
- Plan revision 如何降频；
- NO_PROGRESS 如何转入自主 Recovery；
- blocked 语义哪些保留、哪些收紧。

### Before / After

必须给真实长 Run 对比：

```text
Before
strategy =
time =
model calls =
tool calls =
plan revisions =
repeated edits =
verification =
NO_PROGRESS =
blocked =
core completion =
false success =

After
...
```

### Verdict

只能给：

```text
AUTONOMOUS CODING EXECUTION V0.1: VALIDATED
```

或：

```text
AUTONOMOUS CODING EXECUTION V0.1: NOT VALIDATED
```

不能因为代码实现完成就判定成功。

---

## 24. Freeze Rule

如果满足：

- Router 行为正确；
- Coding Task action cadence 明显改善；
- NO_PROGRESS 可以自主恢复；
- recoverable blocked 明显减少；
- 9-run 小样本稳定；
- false success 仍为 0；
- 没有新的 Runtime Authority；

则冻结本 Feature。

不要继续加入更多 Coding Prompt、Patch Tool、AST、Repo Index 或新状态机。

下一步只有真实 Trace 指出新的 First Broken Boundary 时再立新 Feature。
