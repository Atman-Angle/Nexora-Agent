Nexora Coding Execution Cadence v0.1
feature: coding-execution-cadence-v0.1
status: validated
mode: VERIFY
risk: L3

depends_on:
  - coding-strategy-v0.1
  - hybrid-decision-context-v0.1

runtime_authority_change: forbidden
plan_authority_change: forbidden
completion_authority_change: forbidden
provider_change: forbidden
reasoning_policy_change: not_required
1. Background

当前 Hybrid Decision Context v0.1 已验证，Context continuity、Resume reconstruction、长程 boundedness 和 Runtime Authority 不再是当前主要问题。

真实 Coding Run 的时序审计显示：

prompt/context build      ≈ 0.03%
Provider                  ≈ 99.84%
response parse            ≈ 0%
approval                  ≈ 0.01%
tool execution            ≈ 0.01%

其中正常 Provider 调用下：

Call 3
14.8s Model Decision
→ filesystem.write
→ 13ms Tool Execution

Call 4
33.5s Model Decision
→ filesystem.write
→ 9ms Tool Execution

普通 Coding execution action 的平均 Model Decision 成本约：

24.2s

同时：

Plan revisions = 0
Hybrid Context = healthy
Tool execution = negligible
Approval overhead = negligible

因此已确认一个独立效率问题：

CONFIRMED INTERNAL EFFICIENCY ISSUE:
DECISION_CADENCE

这里不表示 Provider 本身没有延迟问题。

真实 Run 的 terminal failure 仍可能来自：

PROVIDER_EXTERNAL
PROVIDER_CONNECT_TIMEOUT
PROVIDER_UNAVAILABLE

本 Feature 只处理：

Provider 正常响应时，Nexora 是否为了连续简单 Coding 动作支付了过多不必要的 Model round trips。

2. Outcome

Coding Agent 在执行方向已经明确时，不应：

Model
→ simple tool
→ Model
→ simple tool
→ Model
→ simple tool

而应能够形成有界的短程执行：

Model Decision
→ Tool A
→ Tool B
→ Tool C
→ authoritative observations
→ next Model Decision

前提是这些动作：

属于同一个当前 outcome；
已由模型明确选择；
不跨越新的风险边界；
不需要根据中间结果重新决定策略；
Runtime 仍逐个检查每一个 Tool。

目标不是减少模型控制权。

目标是：

减少不必要的 Model round trip，同时保持模型负责策略、Runtime 负责执行 Authority。

3. Core Invariant

必须始终保持：

The model chooses the strategy and intended actions.
The Runtime decides whether each action may execute and whether the task may continue or complete.

Coding Execution Cadence 不得让 Runtime 自己生成下一步 Coding Strategy。

Runtime 不得因为：

模型刚才 write 了 index.html

就自行推断：

下一步应该 write styles.css

所有实际动作仍必须来自模型授权的 Tool Intent。

4. Target Behavior
4.1 Planning

任务初始阶段允许完整决策：

Goal
→ reconnaissance
→ scope
→ Plan
→ first execution intent

此阶段允许模型进行较完整任务级判断。

4.2 Stable Execution

当满足：

Plan stable
Current outcome known
No unresolved failure
No new user input
No approval boundary
No unexpected Tool result

模型应该优先产生：

有界、连续、属于同一 outcome 的 executable actions。

例如 Greenfield 页面：

Outcome:
建立基本页面骨架

Model decision:
- create index.html
- create styles.css
- create app.js

Runtime 可以依次执行。

不要求：

write index.html
→ 再调用模型
→ write styles.css
→ 再调用模型
→ write app.js
5. Execution Unit

新增的概念应当是：

Bounded Execution Unit

而不是新的 Plan、Workflow 或 Runtime State Machine。

一个 Execution Unit 表示：

模型在一次决策中明确授权的一小组连续 Tool Intent。

例如：

outcome: create_app_skeleton

actions:
  - filesystem.write(index.html)
  - filesystem.write(styles.css)
  - filesystem.write(app.js)

它不是新的 Authority。

它只是：

one model decision
→ multiple bounded tool intents
6. Boundedness

一次 Execution Unit 必须有明确边界。

不能变成：

模型一次生成 50 个 Tool
→ Runtime 一直跑

目标是 short horizon。

例如合理：

2–5 个简单 Tool actions

但具体边界应根据仓库现有 Tool budget、risk、native tool contract 和 Runtime 语义确定。

Spec 不强制固定数字。

要求：

一次 Unit 足够减少明显 round trip，但不能长到失去 observation feedback。

7. Observation Barrier

以下情况必须立即结束当前 Execution Unit，并重新进入 Model Decision：

Unexpected failure
Tool failed
Validation failed
Unexpected filesystem state
Process failed
New authoritative fact changes strategy

例如：

expected file absent
dependency incompatible
test reveals different root cause
Approval required

出现新的：

waiting_for_approval

不得跨过。

Unknown side effect

例如：

TOOL_RESULT_UNKNOWN

必须停止连续 execution。

User intervention

新 User Input 立即打断当前 Unit。

Outcome boundary

当前 required outcome 完成后，如果下一 outcome 需要新的策略判断，应重新请求模型。

8. Predictable Success

连续 Tool 的关键条件不是：

前一个 Tool 成功了。

而是：

前一个 Tool 的结果没有产生模型必须重新解释的新信息。

例如：

write index.html → succeeded

如果下一动作本来就是：

write styles.css

则可以继续。

但：

read package.json

返回：

项目实际是 Vue，而不是预期 Vanilla JS

即使 Tool 本身 succeeded，也应该触发新的 Model Decision。

因此需要区分：

tool success

和：

strategy-neutral observation
9. Tool Categories

不同 Tool 不应该具有相同 cadence。

Batch-friendly

通常可在稳定 outcome 内连续：

filesystem.write
filesystem.patch
filesystem.read of known required paths
filesystem.list of known scope
deterministic syntax checks

但仍取决于 observation 是否改变策略。

Observation-heavy

一般更容易形成 decision barrier：

filesystem.search
unknown-code inspection
test execution
build
browser/e2e
process logs
external service call

因为这些 Tool 的主要价值就是产生新信息。

10. Verification Barrier

Verification 不应该被无限批处理。

典型正确节奏：

Model
→ implement bounded unit
→ focused verifier
→ observation
→ Model

而不是：

Model
→ implement
→ test
→ guess fix
→ patch
→ test
→ guess again

如果 verification 产生 failure：

必须回到模型。

11. Failure Repair

FAILURE_REPAIR 仍然需要较强 Model Decision。

例如：

Validation failed
↓
Model analyzes First Broken Boundary
↓
new bounded repair unit
↓
execute
↓
verify

本 Feature 不尝试让 Runtime 自动修复。

12. Completion

当：

all required outcomes satisfied
+
required Evidence exists
+
verification obligations satisfied

应该尽快进入 completion。

不得因为还有 Execution Unit capacity 就继续：

美化；
增加 optional feature；
重构；
补 README；
扩大 scope。

Coding Strategy 的 stop discipline 继续有效。

13. Relation to Structured Plan

Structured Plan 仍然描述：

required outcomes。

Execution Unit 描述：

为当前 outcome 执行的短程动作。

关系：

Plan Outcome
    ↓
Model Decision
    ↓
Bounded Execution Unit
    ↓
Tool Invocation

不得出现：

Execution Unit
→ 第二套 Plan Authority

Plan revision 规则保持不变。

14. Relation to Hybrid Context

Hybrid Context 继续冻结。

每次真正需要 Model Decision 时，仍使用：

Authoritative Current State
+
Recent Decision Trajectory
+
Relevant Working Set
+
Bounded Older Context

Execution Unit 内部不要求每个 Tool 后重新完整请求模型。

但所有 Tool Result 仍然：

persist
→ Runtime facts
→ Context projection

下一次 Model Decision 必须看到执行期间产生的 authoritative observations。

15. Recent Trajectory

一个连续 Execution Unit 应被 Recent Trajectory 表达成：

Model intent
→ Tool A → result
→ Tool B → result
→ Tool C → result

而不是三个互相独立、没有共同 intent 的历史片段。

仍保持 bounded。

16. Approval

Runtime 对每一个 effectful Tool 的 Approval 判断继续独立存在。

例如模型一次产生：

write A
write B
execute command C

Runtime 仍然可以：

A allowed
B allowed
C requires approval

到 C 时停止 Unit 并进入 Approval。

不得因为动作来自同一 Unit 就绕过 Approval。

17. Tool Result Authority

每个 Tool 仍然产生独立：

Invocation
Result
Evidence
Event

不得把整个 Execution Unit 当成一个不可拆分的“大 Tool”。

这样继续保持：

audit；
idempotency；
recovery；
replay/reconstruction；
evidence；
side-effect safety。
18. Unknown Side Effects

如果一个 effectful Tool：

timeout
connection lost
process result unknown

且 Runtime 判定：

TOOL_RESULT_UNKNOWN

当前 Execution Unit 必须立即终止。

之后仍走现有：

reconcile
repair
request input
hard boundary

语义。

不得自动执行后面的 side effects。

19. General Agent Isolation

本 Feature 首版只针对：

strategyProfile = coding

General Agent 行为保持不变。

例如：

分析架构
总结文档
研究问题
解释代码

继续使用现有 decision cadence。

不要为了 Coding 优化改变整个 Harness。

20. Observability

必须能够观察：

modelDecisionId
executionUnitId
linkedToolInvocations
unitStart
unitEnd
stopReason

Unit stop reason 至少可以解释：

COMPLETED
OBSERVATION_BARRIER
VALIDATION_FAILURE
TOOL_FAILURE
APPROVAL_REQUIRED
USER_INPUT
OUTCOME_BOUNDARY
UNKNOWN_SIDE_EFFECT
BUDGET_BOUNDARY

这只是 telemetry / derived execution grouping。

不是新的 Runtime status。

21. Primary Metrics

Feature 的核心指标不是：

Tool Calls ↓

因为 Tool Calls 可能合理增加。

真正关注：

Model Calls / Task

应该下降。

Effective Tool Actions / Model Call

应该上升。

例如：

Before:
6 Tool / 8 Model = 0.75

After:
12 Tool / 5 Model = 2.4
Model Decision Time / Core Outcome

应该下降。

Provider Input Tokens / Completed Task

应该下降或保持合理。

Time to Core Completion

应该下降。

22. Safety Metrics

必须保持：

false success = 0
approval bypass = 0
unknown side-effect blind retry = 0
Runtime authority violation = 0

任何效率提升都不能用这些换取。

23. A/B Validation

使用相同：

Provider
Model
Runtime
Tools
Hybrid Context
Coding Strategy
Reasoning
Prompt
Budget

唯一变量：

Execution Cadence OFF
vs
Execution Cadence ON

至少测试：

greenfield
feature
bug_fix

首轮可以先用 Greenfield canary 判断方向。

24. Expected Greenfield Behavior

例如：

创建个人探索日志

当前可能：

Model
list

Model
write index

Model
write styles

Model
write app

Model
verify

Model
finish

目标形态：

Model
list

Model
write index
write styles
write app

Model
verify

Model
finish

如果中途：

write styles failed

则：

stop unit
→ Model repair
25. Acceptance Criteria

v0.1 至少需要证明：

Efficiency

相较 Cadence OFF：

Model Calls ↓
Provider decision time ↓
Model input tokens / task ↓ or neutral
Time to core completion ↓
Effective tools / model decision ↑

不要求每项都绝对改善，但必须出现清晰整体收益。

Reliability
same core completion
false success = 0
Approval preserved
Evidence preserved
Completion Gate preserved
Behavior

不得出现：

模型批量生成大量无关操作
一个早期错误导致后续一串错误 Tool 继续执行
跨 failure / approval / validation barrier
optional scope expansion
26. Failure Criteria

如果 Cadence ON 出现：

更多错误 Tool
错误后继续执行
更高重复编辑
更高 recovery 成本
false success
Approval bypass

则：

CODING EXECUTION CADENCE V0.1: NOT VALIDATED

不得用“Model Calls 下降”作为成功理由。

27. Non-goals

本 Feature 不做：

修改 Hybrid Context；
Adaptive Reasoning；
降低模型 reasoning effort；
Provider optimization；
Tool implementation optimization；
新 Plan；
新 Workflow Engine；
Multi-Agent；
speculative execution；
Runtime 自动 Coding；
hidden model memory；
Convergence 重写；
blocked/recovery 重写。
28. Implementation Boundary

允许修改的范围应该尽量限制在：

Harness Agent Loop
Model decision/action representation if necessary
Tool dispatch sequencing
Cadence telemetry

Runtime 核心只在现有 contract 无法表达必要事实时才允许最小调整。

默认：

Runtime schema migration: NO
29. First Validation

完成实现后不要直接跑大型 Benchmark。

先跑一个真实 Coding canary。

比较：

Cadence OFF
Cadence ON

重点输出：

Model Calls
Tool Calls
Effective Tool / Model
Provider time
Time to first edit
Time to verification
Time to core completion
Input tokens
Plan revisions
Repeated read/edit
NO_PROGRESS
blocked
false success

如果没有方向性改善：

不要继续扩大 Feature。

30. Final Verdict

只有真实 A/B 证明：

fewer unnecessary model round trips
+
same or better task completion
+
no authority/safety regression

才允许：

CODING EXECUTION CADENCE V0.1: VALIDATED

否则：

CODING EXECUTION CADENCE V0.1: NOT VALIDATED

Current evidence:

The real paired Qwen 3.8 Flash canary completed successfully for both Cadence OFF and ON. OFF used 8 model calls and ON used 6; both reached core completion 1.0. ON completed a bounded unit with 2 intended Tool calls and 2 linked independent Tool Invocations. The comparison improved all five recorded efficiency signals, preserved per-Tool approval and evidence, and reported no false success. Raw evidence: `docs/coding-execution-cadence-v0.1-ab-results.json`.

CODING EXECUTION CADENCE V0.1: VALIDATED
