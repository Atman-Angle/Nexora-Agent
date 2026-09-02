# Nexora Coding Strategy v0.1

```yaml
feature: coding-strategy-v0.1
status: implementation_complete
mode: VERIFY
risk: L2-L3

primary_scope:
  - Harness / Strategy
  - Context Projection
  - Coding-specific guidance

runtime_change: not_expected
new_runtime_authority: forbidden
new_agent_loop: forbidden
new_plan_state_machine: forbidden
validation: passed_real_coding_mvp_ab_and_browser_uat
verdict: VALIDATED
```

## 1. Outcome

Nexora 在识别为 Coding Task 后，不再仅使用通用 Agent 策略，而获得一层 **Coding-specific execution strategy**。

目标不是让 Runtime “懂 Coding”，而是：

> 让模型在现有 Nexora Runtime Authority 之上，以更接近成熟 Coding Agent 的方式工作。

重点改善：

```text
先理解仓库
→ 控制任务范围
→ 尽快形成最小可运行结果
→ 小步修改
→ 使用最低成本的充分验证
→ 根据第一个真实失败边界修复
→ 满足用户要求后停止
```

最终要求：

> 同样的模型、同样的 Runtime、同样的 Tool、同样的用户 Prompt，Coding Strategy 应显著降低 Scope 膨胀、无效 Tool 调用和 NO_PROGRESS，并提高 Coding Task 的完成率与速度。

---

## 2. 当前问题

以真实「个人探索日志」0→1 Run 为代表。

用户实际核心需求：

- 添加；
- 编辑；
- 删除；
- 搜索；
- 类别筛选；
- 本地持久化；
- 基本可用 UI。

模型却自行扩大成：

- 三种视图；
- 时间线；
- 矩阵；
- 详情抽屉；
- 关联记录；
- Undo；
- Import / Export；
- Keyboard shortcuts；
- 自建 server；
- 自动化测试；
- Headless Browser；
- 更多验证流程。

结果：

```text
Scope expansion
↓
Plan expansion
↓
Tool / Model calls increase
↓
Verification cost increases
↓
unfinished work grows
↓
NO_PROGRESS_DETECTED
```

Runtime 正确地没有 False Success。

当前主要缺陷已经从：

> Runtime reliability

转移到：

> Coding execution strategy。

---

## 3. Architecture Boundary

必须保持：

```text
                  Nexora Runtime
       Authority / Evidence / Recovery
        Completion / Approval / Context
                        │
                        │
               Strategy / Harness
                        │
           ┌────────────┴────────────┐
           │                         │
     General Strategy         Coding Strategy
                                     │
                              Coding Context
                                     │
                                   Model
```

Coding Strategy：

- 不是 Authority；
- 不拥有 Plan；
- 不拥有 Tool state；
- 不拥有 Completion；
- 不建立第二套 Run；
- 不建立第二套 Recovery；
- 不直接决定任务成功。

它只影响：

> 模型如何选择下一步行动。

---

## 4. Activation

第一版不要开发复杂 Coding Classifier。

优先复用仓库已有：

- task mode；
- workspace facts；
- user intent；
- existing Harness routing；

在现有架构允许的情况下判断任务是否明显属于：

- 创建代码；
- 修改代码；
- 修复 Bug；
- 重构；
- 编译 / 测试；
- 软件工程任务。

如果无法高置信度判断：

使用 General Strategy。

不要让 Coding Strategy 成为所有任务默认路径。

---

## 5. Coding Task Shape

Coding Strategy 至少区分四种任务形态。

### `greenfield`

空项目或从 0 创建。

策略目标：

```text
核心需求
→ 最小技术方案
→ 最小可运行骨架
→ 核心 vertical slice
→ 验证
→ 完成
```

重点：

> 第一版禁止主动产品膨胀。

### `bug_fix`

```text
复现
→ First Broken Boundary
→ 最相关代码
→ 最小修复
→ focused verification
→ completion
```

### `feature`

已有项目新增能力：

```text
理解现有模式
→ 找到相关实现
→ 最小影响面
→ 修改
→ focused validation
→ broader validation if needed
```

### `refactor`

```text
确认行为基线
→ 保持 externally visible behavior
→ 小步修改
→ 每阶段验证
```

不要求创建新的 Runtime Task 类型。

这只是 Coding Strategy 中的派生 guidance。

---

## 6. Coding Profile

增加一个 Coding-specific behavioral profile。

它至少包含以下原则。

### Reconnaissance

修改已有 Repo 前：

> 先获得足以正确修改的仓库事实，再实施。

但不能无限浏览。

优先：

```text
manifest
relevant tree
relevant files
existing analogous implementation
tests/scripts
repo instructions
```

不要默认读取整个仓库。

### Scope Discipline

这是 v0.1 最重要的规则。

原则：

> Accepted work should contain the smallest coherent set of outcomes required to satisfy the user's explicit goal.

模型自己想到的：

- nice-to-have；
- future enhancement；
- extra UX；
- additional view；
- import/export；
- undo；
- unrelated refactor；

默认不得自动成为本轮 required outcome。

用户说：

> “其他细节你自己判断”

应解释为：

> 补足完成核心体验所必需的细节。

不是：

> 自由扩大产品范围。

---

## 7. Greenfield MVP Discipline

对于 Greenfield Task，默认优先：

> 最小完整产品，而不是最大功能集合。

例如：

```text
用户：
做个人探索日志，支持 CRUD / 搜索 / 筛选 / 持久化

正确：
一个完整可用页面
+
这些核心能力
+
合理 UI

错误：
再主动加入
多视图 / 矩阵 / Undo / Import / Export / 复杂 E2E
```

非必要增强可以记录为：

`optionalEnhancements`

但不能进入当前 accepted work。

如果现有 Plan contract 不支持该字段：

不要为了它修改 Runtime contract。

直接不加入 Plan。

---

## 8. Plan Discipline

不要让 Coding Strategy 为所有 Coding Task 制造复杂 Plan。

### 简单 Bug

可能只需要：

```text
复现 → 修复 → 验证
```

### 小 Feature

可能：

```text
理解现状 → 实现 → 验证
```

### Greenfield MVP

可能：

```text
建立可运行骨架
→ 实现核心体验
→ 验证核心需求
```

目标：

> Plan 描述 Outcome，而不是把每一次 Tool Call 变成 Plan Step。

不要强制固定 Step 数。

但第一版 Coding guidance 应明显抑制不必要的 Plan expansion。

---

## 9. RepoSketch

为 Coding Task 增加一个轻量、派生的 Repository Context。

概念：

```text
Repository
├─ package.json
├─ src/
├─ tests/
└─ README.md

Detected:
- TypeScript
- React
- Electron

Scripts:
- build
- test
- typecheck

Relevant:
- app.ts
- runtime-worker.ts
- styles.css
```

RepoSketch 应优先包含：

- 顶层目录结构；
- manifest；
- package manager；
- framework / language；
- available scripts；
- test locations；
- relevant files；
- 少量重要 symbols，如当前已有可靠来源。

不要生成大型完整 Repository Index。

---

## 10. Context Harness Integration

RepoSketch 必须作为：

> Coding Context Projection

进入现有 Context Harness。

不能成为新的持久化真源。

Context budget 紧张时：

优先保留：

```text
User Goal
Task Contract
Current Plan
Current controlState
Relevant code
Failure observation
Repo instructions
```

优先驱逐：

- 已经过时的大量 search output；
- 重复 file listings；
- 完整 compiler logs；
- 无关文件内容。

---

## 11. AGENTS.md Compatibility

Coding Strategy 应支持发现并加载：

```text
AGENTS.md
```

包括适用范围内的目录级 instructions。

例如：

```text
/AGENTS.md
/apps/desktop/AGENTS.md
```

修改：

```text
apps/desktop/src/renderer/app.ts
```

时应用对应 scope 中的规则。

原则：

- repository instructions 影响 Coding Strategy；
- 不成为 Runtime Authority；
- 不允许覆盖 Nexora 的安全 / Approval / Completion 规则。

不要第一版再发明 `NEXORA.md`。

---

## 12. Verification Ladder

这是 v0.1 第二个最高价值能力。

Coding Strategy 不应默认选择最重验证。

建立：

```text
Level 0
syntax / immediate validation

Level 1
focused test / affected module

Level 2
project build / test / typecheck

Level 3
integration / browser / Electron / E2E
```

原则：

> Use the cheapest verifier that can provide sufficient evidence for the user's requested outcome.

只有较低层无法证明目标时，才升级验证。

---

## 13. Greenfield Verification

对于简单 Web MVP：

不要默认自行创建：

- test framework；
- custom server；
- headless browser infrastructure；

除非用户需求或已有项目结构确实要求。

优先复用：

- 已有 scripts；
- lightweight syntax/build；
- focused behavior checks；
- 已存在的 browser/E2E infrastructure。

避免出现：

```text
为了验证 5 个简单功能
→ 再开发一套测试系统
```

---

## 14. Verification Discovery

Coding Context 应向模型暴露现有可用验证方式，例如：

```text
Available project commands:

build:
  npm run build

test:
  npm test

typecheck:
  npm run typecheck
```

来源必须是真实 manifest / repo facts。

Runtime 不自动执行这些命令。

只是让模型不需要猜：

```text
npm test?
pnpm test?
yarn test?
```

---

## 15. Coding Failure Repair

Coding Strategy 根据已有真实 failure observation 给模型提供领域 guidance。

### Compile failure

优先解决第一条真实 compiler error。

### Test failure

优先定位第一个有解释力的 failing assertion。

### Tool / patch failure

重新读取目标附近事实。

不要原样重复相同修改策略。

### Command failure

先检查已有 scripts / executable facts。

不要持续猜命令。

### Browser / E2E failure

先判断：

```text
product failure
vs
test harness failure
```

再决定下一步。

### NO_PROGRESS

优先：

```text
保留已验证结果
↓
重新识别最小未完成核心要求
↓
收缩非必要 scope
↓
尝试新的最小策略
```

不要重新扩张整个任务。

---

## 16. controlState Integration

复用现有：

- `INITIAL_PLANNING`
- `EXECUTION`
- `FAILURE_REPAIR`
- `VALIDATION`
- `COMPLETION`

Coding Strategy 根据阶段提供不同 Guidance。

### INITIAL_PLANNING

强调：

- inspect enough before editing；
- minimal required scope；
- existing patterns；
- MVP first。

### EXECUTION

强调：

- smallest meaningful change；
- short feedback loop；
- avoid unrelated refactor。

### FAILURE_REPAIR

强调：

- first broken coding boundary；
- do not repeat unchanged strategy。

### VALIDATION

强调：

- verification ladder；
- cheapest sufficient verifier。

### COMPLETION

强调：

- do not add optional improvements；
- if explicit requirements have sufficient evidence, propose completion。

---

## 17. Observation Compaction

这是 v0.1 第三个高价值能力。

对模型看到的 Coding Tool output 做有界整理。

例如测试输出：

不要默认把 2000 行全部塞给模型。

优先投影：

```text
Tests:
37 passed
1 failed

First failure:
tests/foo.test.ts:83

Expected:
...

Received:
...
```

完整原始结果仍保留在现有 Tool/Evidence 事实中。

Coding Context 只使用 compact projection。

---

## 18. Search Result Compaction

搜索结果优先：

```text
file
line
small relevant snippet
```

不要一个搜索就投影几十个大段代码。

目标模式：

```text
Search
→ Locate
→ Read relevant range
```

---

## 19. Completion Discipline

Coding Strategy 只负责判断：

> 什么时候应该向 Runtime 提议完成。

Runtime 仍负责判断：

> 是否真的允许成功。

模型在以下情况下不应继续扩展：

- 用户显式要求已经完成；
- 必要验证已有证据；
- 剩余内容只是 optional improvements。

不要因为还有 token / tool budget 就继续开发。

---


## 20. Legacy Strategy Consolidation

Coding Strategy v0.1 不能简单叠加在现有 Harness / Prompt 之上。

在实施前，必须先审查当前真实仓库中所有会影响 Coding 行为的既有逻辑，并明确它们的 ownership。

重点检查：

- System / Harness prompt 中已有的 Coding-specific guidance；
- `controlState` guidance；
- TaskContract / Plan guidance；
- Tool descriptions；
- Validation / Recovery / Completion guidance；
- 任何已有的 Coding task hints、仓库阅读规则、验证规则或失败修复规则。

对每一项现有逻辑标记：

```text
KEEP
MOVE_TO_CODING_STRATEGY
MERGE
DELETE
```

### 必须保留

以下属于 Nexora 通用执行基础或 Authority，不因 Coding Strategy 删除：

- Runtime Agent Loop；
- TaskContract；
- Structured Plan / ProgressLedger Authority；
- `controlState` 事实与通用阶段语义；
- Context Harness；
- Tool Invocation；
- Approval；
- Evidence；
- Validation Authority；
- Recovery / Convergence；
- Completion Gate；
- Provider / native tool transport；
- General Strategy 的通用执行规则。

### 应迁移、合并或删除

如果现有 Harness / Prompt 已经包含类似：

```text
修改代码前先检查文件
运行测试
检查项目结构
失败后换方案
完成后验证
不要继续做无关优化
```

并且这些职责已经由 Coding Strategy 明确拥有，则不能继续保留第二套重复规则。

最终目标是：

```text
General Strategy
│
├─ 通用 planning semantics
├─ authority semantics
├─ tool semantics
├─ generic recovery semantics
└─ generic completion semantics

Coding Strategy
│
├─ reconnaissance
├─ scope discipline
├─ coding task shape
├─ verification ladder
├─ coding failure repair
└─ coding completion discipline
```

一个规则应只有一个主要 owner。

### 通用不变量与 Coding 领域策略的关系

不要因为 Coding Strategy 有更具体的规则，就删除底层通用不变量。

例如：

```text
General / Runtime invariant:
失败后不能原样重复无效 strategy

Coding Strategy specialization:
compiler failure 时优先处理第一条真实 compiler error
```

前者仍然保留，后者是领域具体化。

### 冲突检查

实现完成前，必须检查是否存在类似冲突：

```text
旧规则：
计划必须覆盖全部剩余工作

新规则：
只把满足用户核心目标所必须的 outcome 纳入当前 scope
```

或：

```text
旧规则：
失败后必须追加更多验证

新规则：
使用最低成本但足够的 verifier，满足证据后停止
```

如果存在冲突，优先明确 ownership 并删除/合并旧的 Coding-specific guidance，而不是继续叠加更多 Prompt。

### 交付要求

最终报告必须给出一份简洁 ownership 表，至少包含：

| Existing logic | Current owner | Action | Final owner |
|---|---|---|---|
| coding reconnaissance guidance | Harness | MOVE / MERGE / KEEP / DELETE | Coding Strategy / General |
| verification guidance | Harness / controlState | ... | ... |
| failure repair guidance | Harness / controlState | ... | ... |
| completion discipline | Harness | ... | ... |

必须证明：

- 没有形成两套 Coding Strategy；
- 没有删除 Runtime Authority；
- 没有让 General Task 继承不必要的 Coding-specific rules；
- Prompt / guidance 总量没有因为 v0.1 单纯叠加而无边界增长。

---

## 21. Non-goals

v0.1 明确不做：

- 第二套 Coding Runtime；
- 第二套 Plan；
- Coding-specific state machine；
- Architect + Editor 双模型；
- AST editor；
- language server integration；
- 完整 Repo semantic index；
- 多种 diff format；
- 新 Workflow Engine；
- 自动写大量测试；
- Runtime 自动选择测试策略；
- Coding-specific Completion Authority。

---

## 22. Patch Tool

**不属于 v0.1。**

先观察 Coding Strategy + RepoSketch + Verification Ladder 后，Edit Interface 是否成为新的 First Broken Boundary。

只有真实 Trace 证明：

```text
filesystem.write / current editing protocol
```

是主要失败来源时，才立：

`coding-patch-edit`

Feature。

---

## 23. User-visible Behavior

用户不需要看到：

```text
Coding Strategy v0.1 enabled
```

正常使用方式保持：

```text
选择 Workspace
→ 输入 Coding Goal
→ Nexora 工作
```

用户应该只感觉：

- 更快开始有效修改；
- Plan 更克制；
- 少做无关功能；
- 更少重复 Tool；
- 更快进入验证；
- 验证不过度；
- 更容易完成。

---

## 24. 关键 Demo Acceptance

必须使用之前真实失败的「个人探索日志」作为回归任务。

保持：

- Qwen 3.8 Flash；
- 同 Runtime；
- 同 Tools；
- 同 context budget；
- 空 Workspace；
- 同用户 Prompt。

不要为了让结果好看给 Coding 版本额外提示。

---

## 25. A/B

### A — Baseline

现有 General Strategy。

已有参考：

```text
11m47s
→ 4 files edited
→ large scope expansion
→ NO_PROGRESS_DETECTED
```

### B — Coding Strategy

运行相同任务。

比较：

| Metric | General | Coding |
|---|---:|---:|
| Final status | blocked | |
| Time | 11m47s | |
| Model calls | | |
| Tool calls | | |
| Plan outcomes | | |
| Optional outcomes introduced | | |
| Time to first edit | | |
| Time to first verification | | |
| Failed tools | | |
| Verification calls | | |
| Repeated strategy | | |
| NO_PROGRESS | yes | |
| Core requirements satisfied | partial | |

---

## 26. Coding-specific metrics

增加 Eval-only 指标，不进入 Runtime。

### Scope Expansion Rate

```text
model-introduced non-required outcomes
/
total accepted outcomes
```

目标：

显著下降。

### Verification Efficiency

```text
verifier calls producing new useful evidence
/
total verifier calls
```

目标：

提高。

### Core Completion

只判断用户明确要求：

- Add
- Edit
- Delete
- Search
- Filter
- Persistence

不要因为没有：

- Undo
- Import
- Matrix
- Advanced views

判失败。

---

## 27. Success Criteria

v0.1 不要求立刻成为 Codex。

本次 A/B 满足以下大部分行为与可靠性条件，证明 v0.1 方向成立：

### Behavior

- 不再明显自行扩张 5+ 个非必要功能；
- 初始 Plan 明显更小；
- 更早形成可运行结果；
- 更早进入验证；
- 不自行创建无必要的重型验证基础设施；
- Failure 后优先收缩 / 修复，而不是继续扩张。

### Reliability

- false success = 0；
- 不破坏现有 Task Contract；
- 不破坏 Plan Authority；
- 不破坏 Evidence；
- 不破坏 Completion；
- 不破坏 Recovery。

### Demo

最好达到：

```text
个人探索日志
→ core MVP succeeded
```

而不是再次：

```text
NO_PROGRESS_DETECTED
```

---

## 28. Regression

至少确认现有：

- deterministic Runtime tests；
- controlState；
- Recovery；
- Completion Authority；
- Task Contract；
- Desktop Coding path；

不因 Coding Strategy 产生回归。

General Task 不应该被 Coding Profile 影响。

---

## 29. Completion

本 Feature 最终报告必须回答：

### Architecture

- Coding Strategy 接在哪里；
- 为什么没有形成第二套 Runtime；
- RepoSketch 如何派生；
- AGENTS.md 如何 scoped；
- Verification Ladder 如何进入 Guidance。

### Behavior

- Baseline 为什么 Scope 膨胀；
- Coding Strategy 是否抑制；
- 模型 Tool 行为发生了什么变化；
- Verification 是否更克制；
- Completion 是否更快。

### Evidence

给出 A/B。

本次真实 A/B 与浏览器 UAT 已满足核心验收，最终判断：

```text
CODING STRATEGY V0.1: VALIDATED
```

不能因为代码实现完成就判断成功；本次判断由真实 A/B 和浏览器 UAT 证据支持。

---

## 当前最高优先级

如果要最快获得明显效果，优先保证：

1. **Scope Discipline**  
   解决模型把 MVP 自己扩成大项目。

2. **Verification Ladder**  
   解决简单任务最后发展成复杂 E2E 工程。

3. **controlState-aware Coding Profile**  
   让 INITIAL / EXECUTION / FAILURE / VALIDATION / COMPLETION 使用不同 Coding 领域策略。

RepoSketch / AGENTS.md 可以一起做，但不要演变成复杂 Repository Index。

第一轮完成后，重新跑「个人探索日志」A/B。只有 Trace 证明 Editing Interface 已经成为新的 First Broken Boundary 时，再考虑 Patch Tool。
