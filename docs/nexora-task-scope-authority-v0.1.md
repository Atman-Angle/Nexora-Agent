# Nexora Task Scope Authority v0.1

```yaml
feature: task-scope-authority-v0.1
status: in_progress
mode: PLAN
risk: L3
applies_to: coding
task_shapes: [greenfield, feature, bug_fix, refactor]

runtime_authority_change: forbidden
plan_authority_change: forbidden
completion_authority_change: forbidden
new_state_machine: forbidden
```

## 1. Problem

Nexora 对明确的 Feature、Spec、开发要求通常能够正常 Plan、执行、Replan 并收敛。

但对宽泛目标，Agent 容易在执行中持续重新解释“用户还可能想要什么”，通过 Plan revision 增加新的页面、功能、交互或 optional work，导致：

```text
Broad User Intent
→ Initial Plan
→ Execute
→ New Fact / Failure
→ Replan
→ Add New Outcome
→ More Work
→ Replan
→ More Scope
→ Hard to Converge
```

真正的问题不是 Replan，而是：

> **Replan 既能改变 HOW，也可能隐式改变 WHAT。**

当前仓库已有 Runtime Authority、Plan CAS、Evidence、Completion Gate、Convergence 等能力，但缺少一个稳定、持久、可验证的 Task Scope 来约束后续 Plan。

---

## 2. Core Goal

第一次进入复杂 Coding 执行前，Nexora 应明确并持久保存：

- 用户最终想得到什么；
- 哪些结果必须完成；
- 哪些是 Agent 为执行选择的合理默认值；
- 哪些明显属于本轮非目标；
- 做到什么程度就应该停止。

之后整个 Run 中：

> **Replan may change how the task is completed, but may not silently expand what the user asked to receive.**

同时：

> **Information may expand. Scope does not automatically expand.**

---

## 3. Generality in Coding

这套机制在 Coding 环节内应是通用机制，适用于：

- `greenfield`
- `feature`
- `bug_fix`
- `refactor`

通用的是：

```text
Task Scope = WHAT
Structured Plan = HOW
```

以及：

```text
New Evidence
→ Replan HOW

New User Requirement
→ Scope Revision
```

不同 Task Shape 只改变 Scope 表达重点。

### Greenfield

强调：

- required capabilities
- reasonable defaults
- excluded optional scope
- completion boundary

主要防止 feature creep。

### Feature

强调：

- new capability
- integration boundary
- compatibility
- non-goals
- acceptance

主要防止局部 Feature 扩成系统级重构或额外产品能力。

### Bug Fix

强调：

- incorrect behavior
- desired behavior
- preserved behavior
- verification

允许不断发现新的 root cause、改多个文件、补 migration 和 regression test。

### Refactor

强调：

- behavior invariants
- structural target
- allowed internal changes
- verification

允许内部变化，但不能静默改变用户可观察行为。

因此：

> **机制通用，Task Scope 模板按 task shape 轻量适配。**

---

## 4. Target Flow

```text
User Input
    ↓
Direct or Planned Task?
    ↓
Planned Coding Task
    ↓
First Planning Decision
    │
    ├─ Resolve Task Scope   ← WHAT
    └─ Initial Plan         ← HOW
    ↓
Persist Task Scope
    ↓
Execute
    ↓
Failure / New Fact
    ↓
Replan HOW
    ↓
Scope Boundary Check
    ↓
Execute
    ↓
Evidence / Validation
    ↓
Completion against Scope
```

v0.1 不需要独立 ETC 微服务，也不需要额外 Planner。

优先复用现有第一次 Planning Model Call：

```text
Before:
User → Model → TaskContract + Plan

After:
User → Model → Resolved Task Scope + Plan
```

---

## 5. Task Scope

Task Scope 表达目标和交付边界，不表达实现步骤。

概念上：

```yaml
goal: string

requiredOutcomes:
  - id
  - description
  - source

assumptions:
  - description
  - source

excludedScope:
  - description

completionCriteria:
  - description

resolutionMode:
  pass_through | normalize | shape
```

`source` 至少应能区分：

```text
user_explicit
agent_inferred
workspace_fact
```

目的是防止“用户明确要求”和“模型自己补充”在后续执行中变成同等级授权。

---

## 6. Input Resolution

### PASS_THROUGH

适用于：

- 完整 Spec
- 明确 Feature
- 详细 Goal / Constraints / Acceptance
- 详细开发方案

原则：

> **Specificity must never decrease.**

不得把详细 Spec 总结成缩水版后再执行。

原始输入继续保存在 `inputHistory`，Task Scope 只做结构化映射或引用。

### NORMALIZE

适用于已经较清晰，但有少量执行空白的任务。

允许：

- 结构化要求；
- 补必要 completion boundary；
- 补少量合理默认。

不做大规模产品设计。

### SHAPE

适用于宽泛目标。

例如：

> 做一个个人探索日志，像档案馆，其他你判断。

可以一次性收敛成：

```yaml
goal:
  创建可实际使用的个人探索日志网页

required:
  - 城市、书籍、项目、想体验的事情
  - 时间、类别、状态组织
  - 添加、编辑、删除、筛选
  - 刷新后数据保留
  - 杂志 / 档案馆视觉方向
  - 运行验证

assumptions:
  - 单页应用
  - localStorage
  - 档案卡片作为主要组织方式

excluded:
  - 登录
  - 云同步
  - 导入导出
  - Undo
  - 复杂关系图谱
  - 多页面扩张
  - 非必要动画
```

形成以后，普通 Replan 不再重新进行产品需求发散。

核心原则：

> **明确输入保真，模糊输入收敛。**

---

## 7. Scope Is Not Initial Plan

修改代码时，一开始不可能知道全部错误和全部实现步骤。

因此 Scope 不能写成：

```text
修改 auth.ts
修改 middleware.ts
增加 test.ts
```

而应写 Outcome：

```yaml
goal:
  修复登录后异常掉线

required:
  - 原问题不再复现
  - 正常 session 行为保持
  - regression verification 通过

constraints:
  - 不改变现有登录交互
```

Plan 才负责：

```text
查什么
改哪些文件
采用什么方案
跑哪些测试
```

这保证 Bug Fix / Feature 修改可以随着新信息持续 Replan。

---

## 8. Replan Semantics

Replan 必须继续允许：

- 替换失败 Step；
- 拆分或合并 Step；
- 改变技术实现；
- 改变文件；
- 根据新仓库事实调整路径；
- 增加完成已有目标所必需的 supporting work；
- 补测试和验证；
- 删除无效步骤；
- 改变执行顺序。

例如：

```text
Initial assumption:
bug in refresh token

New evidence:
bug actually in middleware

→ Replan
→ inspect middleware
→ fix middleware
→ regression test
```

Scope 不需要改变。

---

## 9. Three Types of New Information

### A. New Evidence

例如：

- 项目实际是 React 而不是 Vue；
- root cause 在另一个模块；
- 测试暴露新的 edge case。

处理：

```text
New Evidence
→ Replan HOW
```

Scope 不变。

### B. Newly Discovered Supporting Work

例如为了完成原目标，后来发现必须：

- 修改 schema；
- 增加 migration；
- 修改 serializer；
- 更新 fixture；
- 增加 regression test。

处理：

```text
New Evidence
→ Supporting Work
→ Plan Revision
```

Scope 仍然不变。

判断原则：

> 如果不做这项工作，现有 Scope Outcome 是否无法完成？

如果是，则可以作为 supporting work。

### C. New User-facing Outcome

例如：

- JSON 导出；
- Undo；
- Dashboard；
- 第二套 Timeline；
- 设备管理。

如果不是完成现有 Scope 所必需：

```text
→ SCOPE_EXPANSION
```

普通 Replan 不应静默接受。

---

## 10. Plan–Scope Relationship

Plan Outcome 必须能够说明为什么属于当前 Scope。

概念关系：

```text
Task Scope Requirement
        ↑
        │ supports
        │
Plan Outcome
```

例如：

```yaml
outcome:
  修复 localStorage schema

kind: supporting

supports:
  - persistence_requirement
```

具体字段和类型应基于当前仓库已有 `StructuredPlan` / objective / acceptance 结构做最小改动，不预设一定新增某个字段。

关键 invariant：

> **新增 Plan Outcome 必须属于已有 Task Scope，或是完成已有 Scope 所必需的 supporting work。**

---

## 11. Runtime Responsibility

Runtime 不应硬编码产品语义，例如：

```text
Undo = expansion
CSS = supporting
```

Harness / Model 负责语义解释。

Runtime 负责结构性 Authority：

- Task Scope 被持久化；
- Plan revision 有版本约束；
- 普通 Replan 不能静默修改 Scope；
- 新 Outcome 必须有合法 Scope 关系；
- 已完成事实不能被重写；
- Completion 仍由 Runtime Gate 决定。

---

## 12. Scope Revision vs Plan Revision

必须区分：

```text
Plan Revision
= HOW changed

Scope Revision
= WHAT changed
```

以下情况通常只改变 Plan：

- Tool failure
- Validation failure
- New repository fact
- Root cause discovery
- Strategy failure

真正主要允许 Scope Revision 的边界：

```text
New User Input
```

例如：

```text
Task Scope v1
↓
User: 再加 JSON 导出
↓
Task Scope v2
  + JSON export
↓
Plan Revision
```

v0.1 不一定要完整区分“纠正 / 补充 / 扩展 / 新任务”，但至少保证：

> **没有新的用户授权时，不允许静默增加新的用户成果。**

---

## 13. Completion

Completion 应基于：

```text
Task Scope
↓
Required Outcomes
↓
Evidence / Verification
↓
Completion Gate
↓
STOP
```

Plan 是当前实现路线，不是可以无限扩张的完成清单。

当：

```text
all required scope outcomes satisfied
+
required evidence exists
+
verification obligations satisfied
```

应该进入 Completion。

模型自行想到的 optional enhancement 不应继续拖延完成。

---

## 14. Convergence

职责分离：

```text
Task Scope Authority
→ 防止任务越做越大

Convergence
→ 防止完成同一任务时重复失败、重复策略、无进展
```

不要通过继续堆 `NO_PROGRESS`、Tool repetition 或 strategy fingerprint 来修 Scope Expansion。

因为新增页面、功能、文件都可能产生“新事实”，Convergence 反而会认为仍在 progress。

---

## 15. Persistence

不新增 Scope Store。

优先复用现有 Runtime-owned：

```text
inputHistory
taskContract
currentPlan
completionRequirements
```

Task Contract 升级为：

> **Runtime-owned resolved user intent / task scope**

Resume / Recovery 后应恢复：

```text
Original User Input
Resolved Task Scope
Current Plan
Evidence
Latest Observation
```

不能依赖 process-local model memory。

---

## 16. Minimal Implementation Slices

### Slice 1 — Scope Formation

首次复杂 Coding Planning：

```text
explicit input → preserve
broad input → bounded shape
```

形成持久化 Task Scope。

### Slice 2 — Scope-bound Replan

Plan/Replan 新增 Outcome 时必须属于：

```text
existing Scope
or
necessary supporting work
```

阻止 silent user-facing expansion。

### Slice 3 — Scope-based Completion

Completion 以 required Scope 为交付边界。

Plan 自我扩张不能无限推迟 Completion。

### Slice 4 — Explicit Scope Revision

新的用户输入可以触发 Scope revision。

Plan Revision 与 Scope Revision 分开。

---

## 17. Validation

至少验证四类任务。

### Broad Greenfield

宽泛自然 Prompt。

验证：

- Scope 被合理收敛；
- 多次 Replan 后 Scope 不膨胀；
- 最终 Completion。

### Precise Spec

完整 Feature / Spec。

验证：

- 显式要求不丢失；
- 不被过度总结；
- 不擅自简化边界。

### Bug Fix Discovery

首次 Plan 基于错误 root cause。

执行中暴露新事实。

验证：

- Plan 可以多次变化；
- supporting work 可以增加；
- Scope 不需要改变；
- 最终修复成功。

### Scope Expansion Negative Test

Replan 尝试增加未授权的：

```text
Undo
Export
Dashboard
```

验证不能静默成为正式用户成果。

---

## 18. Non-goals

v0.1 不做：

- 独立 ETC 微服务；
- 第二套 Planner；
- 第二套 Scope Store；
- 复杂 Intent taxonomy；
- 每轮额外调用模型判断 Scope；
- 大改 Convergence；
- 大改 Recovery；
- Workflow Engine；
- 自动 PRD 系统。

---

## 19. Final Principle

Nexora Coding 应允许：

```text
开始只知道一部分
↓
读取代码
↓
发现更多事实
↓
修改
↓
测试
↓
继续发现
↓
Replan
↓
最终完成
```

但不允许：

```text
知道得越来越多
↓
想做的东西也越来越多
↓
任务永远没有终点
```

最终原则：

> **Knowledge can grow without scope growing.**

> **Task Scope defines the destination. Plan and Replan may keep changing the route.**

> **明确输入保真，模糊输入收敛；执行阶段可以持续发现和修正，但不能静默重新发明用户需求。**
