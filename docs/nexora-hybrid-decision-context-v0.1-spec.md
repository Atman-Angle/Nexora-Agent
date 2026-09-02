# Nexora Hybrid Decision Context v0.1

```yaml
feature: hybrid-decision-context-v0.1
status: implementation_complete_not_validated
mode: VERIFY
risk: L3

primary_scope:
  - Harness decision context
  - Context projection
  - Recent trajectory continuity
  - Context prioritization / compaction
  - Prompt assembly
  - Context observability / eval

runtime_authority_change: forbidden
new_session_truth_source: forbidden
new_agent_loop: forbidden
new_plan_state_machine: forbidden
new_completion_authority: forbidden
raw_message_append_replacement: forbidden
hidden_chain_of_thought_persistence: forbidden
```

## 1. Background

当前审计已经确认：

```text
DECISION CONTEXT CONTINUITY: HEALTHY
```

当前 Nexora 每轮并不是简单把完整历史 `messages[]` 原样追加，而是：

```text
Runtime / Session authoritative facts
        ↓
buildDecisionContext()
        ↓
current-state projection
+ bounded continuation/history
+ tool observations
+ strategy guidance
        ↓
compilePrompt()
        ↓
Provider request
```

真实长 Run 也没有出现 Context 随轮次线性膨胀。

因此本 Feature **不以“修复失忆”为前提**，也不把 Fresh Projection 判定为错误。

当前需要优化的问题是：

> 在保持可追溯和权威状态投影的前提下，让模型每轮以更低成本、更加连续、更加聚焦于当前 execution frontier 的方式获得下一步决策信息。

---

# 2. Outcome

Nexora 的上下文体系最终明确区分四层：

```text
Durable History
    ↓
Authoritative Current State
    ↓
Recent Decision Trajectory
    ↓
Relevant Working Context
    ↓
Model Decision Context
```

其中：

### Durable History

回答：

> 过去发生过什么？

用于：

- audit；
- replay；
- resume；
- recovery；
- evidence；
- debugging。

### Authoritative Current State

回答：

> 现在任务处于什么状态？

包括：

- Goal；
- Task Contract；
- current Plan；
- completed outcomes；
- active outcome；
- unfinished outcomes；
- latest validation/failure；
- current tool/effect facts；
- completion eligibility。

### Recent Decision Trajectory

回答：

> 刚才为什么执行了这个动作，现在动作链走到哪里？

只保留最近一个小型：

```text
decision
→ action intent
→ tool call
→ tool result
→ validation / observation
```

不保存隐藏 Chain of Thought。

### Relevant Working Context

回答：

> 当前这一步真正需要哪些代码、文件、Repo facts、instructions？

按需投影，不等同于全部历史。

最终模型上下文应该更接近：

```text
Stable Policy
+
Current Authoritative State
+
Recent Decision Trajectory
+
Relevant Working Set
+
Latest User Input
```

而不是：

```text
大量旧历史
+
多套重复规则
+
每轮重新恢复“现在做到哪”
```

---

# 3. Core Invariants

## 3.1 Traceability != Prompt Replay

必须明确：

> 可追溯是 Runtime / Session 的持久化能力，不意味着每轮 Model Call 必须重新消费完整历史。

不得为了“可追溯”把 Durable History 直接等同于 Model Context。

---

## 3.2 History != State != Context != Trajectory

四者必须保持概念边界：

```text
History:
发生过什么

State:
现在是什么状态

Context:
模型当前做下一步需要知道什么

Trajectory:
最近一次决策—动作—结果链
```

不允许继续把它们混成一个无界 message stream。

---

## 3.3 Runtime Authority Remains Sole Truth

以下继续由 Runtime / existing authority 决定：

- Run status；
- Task Contract；
- accepted Plan；
- Tool Invocation；
- Evidence；
- Approval；
- Recovery facts；
- Validation；
- Completion。

Context 只是派生 Projection。

---

## 3.4 No Hidden Memory

不得新增：

```text
hiddenAssistantMemory
privateReasoningStore
invisibleScratchpadAuthority
```

模型上一轮隐藏 reasoning 不成为下一轮 Authority。

如需保持短期意图连续性，只保留：

- accepted structured decision；
- public concise rationale；
- action intent；
- accepted Plan change；
- Tool intent；
- authoritative result。

---

# 4. Target Architecture

```text
                 ┌─────────────────────┐
                 │ Durable Event Truth │
                 │ Run/Event/Tool/etc. │
                 └──────────┬──────────┘
                            │
                  reducer / projection
                            │
                 ┌──────────▼──────────┐
                 │ Current Run State   │
                 └──────────┬──────────┘
                            │
               ┌────────────┼────────────┐
               │            │            │
               ▼            ▼            ▼
       Current State   Recent Traj.   Working Set
        Projection      Projection     Projection
               │            │            │
               └────────────┼────────────┘
                            ▼
                   Context Orchestrator
                            │
                     budget / priority
                            │
                            ▼
                    Model Decision Context
```

不新增第二套 Runtime。

---

# 5. Current State Projection

每一轮 Model Call 必须稳定包含一个有界的 Current State Projection。

概念上至少可以回答：

```text
1. 用户最终目标是什么？
2. 当前必须完成什么？
3. 已经完成什么？
4. 当前正在做什么？
5. 还剩什么？
6. 刚刚发生了什么？
7. 当前有什么真实失败/验证事实？
8. 是否有等待/批准/硬边界？
```

建议的逻辑结构：

```yaml
currentState:
  goal: ...
  strategyProfile: coding | general
  taskShape: greenfield | bug_fix | feature | refactor | null

  contract:
    revision: ...
    requiredOutcomes: ...

  plan:
    revision: ...
    completed: [...]
    active: ...
    unfinished: [...]
    invalidated: [...]

  latestObservation:
    type: tool_result | validation_failure | recovery | ...
    summary: ...

  currentBoundary:
    type: execution | validation | failure_repair | completion
    summary: ...
```

不要求使用这一具体 Schema。

要求是：

> 模型不需要从长历史重新推断当前 execution frontier。

---

# 6. Recent Decision Trajectory

这是本 Feature 最重要的新增优化之一。

当前审计显示：

```text
Previous model decision:
部分持久化 / 部分可见
```

这不是直接缺陷，但可能导致短期 action chain 不够连续。

因此增加一个 **有界、派生、非 Authority** 的 Recent Trajectory Projection。

## 6.1 Scope

只保留最近一个或少数几个实际相关的 decision-action-observation 单元，例如：

```text
Model intent:
修复 search normalization

Tool:
read core.js

Observation:
normalization only applied on create, not query

Model intent:
patch search path

Tool:
write core.js

Observation:
write succeeded
```

下一轮不应需要重新考虑：

> “我刚才为什么读 core.js？”

---

## 6.2 What Can Enter

允许：

- structured action intent；
- accepted next-step summary；
- Tool call；
- Tool result summary；
- validation summary；
- recovery strategy switch；
- current active outcome。

禁止：

- hidden reasoning；
- full private chain of thought；
- unsupported inferred rationale；
- stale abandoned intent。

---

## 6.3 Boundedness

Recent Trajectory 必须很小。

推荐以：

```text
1–3 recent execution units
```

或等价 token budget 为界。

不是 Conversation History 的第二份副本。

---

# 7. Relevant Working Set

模型不应每轮重新扫描整个 Workspace。

Context Orchestrator 应派生当前 Working Set。

例如 Coding：

```yaml
workingSet:
  files:
    - app.js
    - core.js
  repoFacts:
    - npm test
    - vanilla JS
  instructions:
    - /AGENTS.md
  verifier:
    - node core.test.mjs
```

Working Set 来源必须是真实事实：

- user-named paths；
- active Tool resources；
- latest search results；
- current Plan outcome；
- current failure location；
- scoped repo instructions；
- recently modified files。

---

# 8. Working Set Retention

最近正在处理的资源应具有较高 retention priority。

例如：

```text
刚读取 app.js
↓
刚修改 app.js
↓
验证失败指向 app.js
```

则：

```text
app.js
```

不应在下一轮因为普通 Context 压缩突然退出 relevant working set。

但如果 active outcome 已转移：

```text
app.js completed
↓
now validating persistence in core.js
```

则旧文件可逐步降级。

---

# 9. Context Priority Model

Context 的优先级不按“最新文本”简单排序。

建议语义：

## P0 — Never silently lose

- User Goal；
- Task Contract；
- accepted Plan state；
- active/unfinished outcome；
- latest blocking validation/failure；
- required Evidence reference；
- current human wait / approval fact。

## P1 — Strong retention

- Recent Decision Trajectory；
- current Working Set；
- applicable AGENTS.md；
- current verifier；
- latest Tool observation。

## P2 — Compressible

- older Tool observations；
- completed outcome details；
- older code snippets；
- repo discovery facts；
- older plan rationale。

## P3 — Reference / retrieve only

- old search results；
- stale failures；
- unrelated files；
- old conversation detail；
- obsolete optional ideas。

---

# 10. Context Assembly

建议每轮按稳定顺序装配：

```text
[Stable Policy]

[Current User Goal / Latest User Input]

[Task Contract]

[Current State]
  completed
  active
  unfinished
  latest observation

[Strategy Guidance]
  only applicable current strategy/phase guidance

[Recent Decision Trajectory]

[Relevant Working Set]

[Tool Catalog / capabilities needed this turn]

[Bounded older references if required]
```

重点：

> current state 在旧历史之前。

---

# 11. Stable Policy vs Dynamic State

必须减少每轮重复的策略噪声。

审查：

- System kernel；
- Host policy；
- General strategy；
- Coding strategy；
- controlState guidance；
- Recovery guidance；
- Completion guidance；
- Tool descriptions。

对语义重复规则进行：

```text
KEEP
MERGE
MOVE
DELETE
```

目标：

```text
Stable policy:
短、稳定、通用

Dynamic context:
当前状态、当前策略、最新事实
```

不要通过继续添加更多 Prompt 来解决 Context 问题。

---

# 12. Phase-Specific Strategy Injection

只注入当前阶段真正需要的策略。

例如 Coding：

### INITIAL_PLANNING

保留：

- scope discipline；
- reconnaissance；
- MVP-first。

不需要同时注入大量 completion / repair prose。

### EXECUTION

保留：

- action-first；
- minimal change；
- working-set discipline。

### FAILURE_REPAIR

保留：

- first broken boundary；
- strategy switch；
- failure-specific guidance。

### VALIDATION

保留：

- verification ladder；
- evidence sufficiency。

### COMPLETION

保留：

- stop discipline；
- no optional expansion。

避免每轮把五个阶段全部重新解释。

---

# 13. Plan Stability

Current State Projection 应让 Plan 更像稳定状态，而不是 prompt decoration。

目标：

```text
Plan revisions << Model calls
```

ordinary：

- read；
- write；
- successful tool；
- expected observation；

不应自动需要 revision。

Plan revision 应只因：

- scope changed；
- user changed goal；
- failure invalidated current strategy；
- required outcome changed；
- material new fact。

---

# 14. Observation Projection

完整 Tool Result 保留在 Authority。

模型看到的是适合下一步决策的 projection。

例如：

```text
Tests:
37 passed
1 failed

Current failing boundary:
search normalization

Failure:
expected case-insensitive match
received no result
```

而不是默认 2000 行 log。

同时保留：

```text
reference -> complete tool/evidence fact
```

以支持 replay / debug / rehydration。

---

# 15. Rehydration

如果模型后续需要旧事实：

不要默认永久保留。

允许：

```text
reference
↓
rehydrate relevant fact
↓
temporarily enter working context
```

例如：

- earlier Tool result；
- old file content；
- ancestor Run fact；
- previous validation evidence。

Rehydration 必须可追溯：

```text
why rehydrated
source fact
scope
```

---

# 16. Compaction Semantics

Compaction 目标不是“尽量保留聊天内容”。

而是：

> 保持 functional continuity。

Compaction 后必须仍然能回答：

```text
what is the goal
what is completed
what is active
what remains
what just happened
what evidence matters
```

如果做不到，compaction 不合法。

---

# 17. Context Budget

不要只监控总 Token。

增加 Context quality metrics。

至少包括：

```text
total_input_tokens
stable_policy_tokens
current_state_tokens
recent_trajectory_tokens
working_set_tokens
old_history_tokens
tool_schema_tokens
```

并增加：

### Current State Ratio

```text
tokens directly describing current working state
/
total dynamic context
```

### Stale Context Ratio

```text
stale or superseded observations
/
total dynamic context
```

### Repeated Policy Ratio

```text
semantically repeated policy/guidance
/
total prompt
```

### Trajectory Continuity Coverage

最近一次：

```text
decision → action → result
```

是否完整可见。

---

# 18. Context Manifest

现有 Context Manifest 应扩展为足够诊断 Context composition 的结构，但不保存敏感 raw prompt 默认值。

至少开发 / Eval 可记录：

```yaml
contextManifest:
  strategy: coding
  controlState: EXECUTION

  sections:
    stablePolicy:
      bytes: ...
      tokens: ...
      digest: ...

    currentState:
      bytes: ...
      tokens: ...
      digest: ...

    recentTrajectory:
      bytes: ...
      tokens: ...
      digest: ...

    workingSet:
      bytes: ...
      tokens: ...
      digest: ...

    olderContext:
      bytes: ...
      tokens: ...
      digest: ...

  activeOutcome: ...
  planRevision: ...
  latestObservationKind: ...
```

支持相邻 Model Call 进行 section-level diff。

---

# 19. Capture Policy

默认产品运行不保存完整 Prompt。

开发 / Eval 可以：

```text
metadata
redacted
```

用于：

- section diff；
- token analysis；
- stale fact audit；
- trajectory continuity audit。

不得将敏感代码、secret、用户隐私作为长期诊断 artifact 无条件落盘。

---

# 20. Decision Context Diff

开发工具应能回答：

```text
Call N → Call N+1
```

### Added

什么新事实加入？

### Removed

什么被驱逐？

### Changed

current state 怎么变化？

### Repeated

哪些 static / semantic policy 重复？

### Stale

什么已经被新事实取代但仍在 Context？

---

# 21. Coding Acceptance Example

以个人探索日志 Greenfield 为例。

在完成 Add/Edit/Persistence 后，理想 Context 不需要模型重新阅读原始执行历史。

应能直接获得等价信息：

```yaml
goal:
  personal exploration log MVP

completed:
  - add
  - edit
  - persistence

active:
  search_and_filter

remaining:
  - search
  - category_filter
  - final_verification

latestObservation:
  search currently performs exact-case matching

recentTrajectory:
  - inspected core.js search implementation
  - identified missing normalization

workingSet:
  - core.js
  - app.js

decisionBoundary:
  finish remaining required behavior before optional improvements
```

---

# 22. General Task Acceptance

不能为了 Coding 优化污染 General。

例如：

> 分析这个项目架构，不修改代码。

应该：

- Strategy = General；
- 不注入 Coding Working Set 规则；
- 不创建 Coding task shape；
- 不强制 verifier；
- Context 仍然保持 current-state projection。

---

# 23. Long-Run Acceptance

选择一个真实 30+ Model Call 长任务。

必须验证：

- Context 不随历史线性增长；
- active outcome 始终可见；
- completed outcome 不反复失去；
- latest failure 不被 stale error 覆盖；
- Recent Trajectory 在相邻执行 Step 中连续；
- Working Set 不无意义漂移；
- old observations 可以降级为 reference；
- Plan revision 只有 material trigger；
- Resume / Recovery 后仍可恢复 execution frontier。

---

# 24. A/B

必须在同模型、同 Runtime、同 Tools、同 Prompt 下比较：

## A — Current Context

现有装配。

## B — Hybrid Context

```text
Authoritative Current State
+
Recent Decision Trajectory
+
Relevant Working Set
+
bounded older history
```

比较：

- total input tokens；
- time to first action；
- model latency；
- Plan revisions；
- repeated reads；
- repeated edits；
- repeated strategy；
- verifier efficiency；
- time to core completion；
- total runtime；
- NO_PROGRESS；
- false success。

---

# 25. Primary Success Criteria

不是“Prompt 更短”。

而是：

### Continuity

- 模型无需从旧历史恢复当前 execution frontier；
- 最新 action intent / Tool / observation 链连续；
- completed / active / unfinished 稳定。

### Efficiency

- repeated reads 降低；
- repeated edits 降低；
- unnecessary Plan revisions 降低；
- model call → action latency 下降；
- stale context ratio 下降。

### Reliability

- false success = 0；
- Resume / Replay 不退化；
- Evidence / Completion 不变；
- no hidden mutable memory。

### Context

- total token 不无边界增长；
- current-state useful ratio 提高；
- old history 默认 bounded/reference 化。

---

# 26. Non-goals

本 Feature 不做：

- 把 Nexora 改成纯 `messages.push()`；
- 无限保留全部 Conversation；
- 删除 Runtime / Event truth；
- 新增第二套 Session；
- 新增第二套 Plan；
- 保存隐藏 Chain of Thought；
- 新增 Vector DB 作为默认 Context truth；
- AST / semantic repo index；
- 改 Provider；
- 调 reasoning effort；
- 改 Coding Strategy 业务规则；
- 改 blocked / recovery semantics；
- 重做 Activity UI。

这些问题只有在本 Feature 验证后仍然成为 First Broken Boundary 时再独立处理。

---

# 27. Migration

本 Feature 应尽量是 projection-level migration。

不要求迁移历史 Runtime facts。

旧 Run 应仍然可以：

```text
existing events
↓
new projection logic
↓
new model context
```

如果必须新增 Event 字段：

需要证明现有事实无法派生。

默认不新增。

---

# 28. Implementation Order

严格分阶段。

## Phase 0 — Capture

先实现/启用：

- redacted section capture；
- context manifest；
- adjacent request diff。

不改变 Model Context behavior。

## Phase 1 — Recent Trajectory

加入 bounded recent decision-action-observation projection。

重新跑相同任务。

## Phase 2 — Current State Refinement

只有 evidence 证明当前 execution frontier 表达不够清晰时再调整。

## Phase 3 — Working Set

根据真实重复 read / context drift 再调整 retention。

## Phase 4 — Policy Deduplication

清理重复 static/dynamic guidance。

每 Phase 都必须独立 A/B。

不要一次重写整个 Context Harness。

---

# 29. Freeze Boundaries

以下保持冻结：

```text
Runtime Authority
Task Contract
Structured Plan Authority
Tool Invocation
Evidence
Approval
Validation
Recovery
Completion Gate
Provider
Coding Strategy semantics
```

本 Feature 只改变：

> model-visible context projection / orchestration。

---

# 30. Completion Report

本 spec 的实现状态与验证状态必须分开记录。当前实现已覆盖 projection-level 变更，但尚未满足真实长 Run 与 Provider A/B 的验收门槛。

最终报告必须回答：

## Architecture

- Durable History 与 Model Context 如何分离？
- Current State 从哪些 authority facts 派生？
- Recent Trajectory 保存什么、不保存什么？
- Working Set 如何选择？
- Compaction / eviction 优先级是什么？

## Evidence

给出真实：

```text
before / after
```

至少：

- context section size；
- repeated ratio；
- stale ratio；
- Plan revision；
- repeated read/edit；
- time-to-action；
- time-to-completion。

## Authority

证明：

- 没有新增隐藏状态；
- 没有丢失可追溯性；
- 没有将 model memory 变成 truth；
- Resume / Replay 仍来自 Runtime facts。

## Verdict

只能输出：

```text
HYBRID DECISION CONTEXT V0.1: VALIDATED
```

或：

```text
HYBRID DECISION CONTEXT V0.1: NOT VALIDATED
```

不能因为代码完成就宣布成功。

## 30.1 Current Evidence Record

截至 2026-08-31，仓库内已有以下可复现证据：

| Evidence | Result | Scope |
|---|---|---|
| Runtime build | PASS | `pnpm --filter @nexora/runtime build` |
| Harness build | PASS | `pnpm --filter @nexora/harness build`，在 Runtime build 之后执行 |
| E142 focused tests | PASS, 3/3 | bounded trajectory、working set、metadata-only manifest、adjacent section diff、deterministic OFF/ON paired projection |
| Adjacent E135-E142 focused set | 54/62 passed | E140/E141/E142 passed; 8 failures are existing Desktop/Office authority paths outside Hybrid Context scope |
| Diff check | PASS | `git diff --check`（本 spec、实现与 E142 测试文件） |
| Real Provider A/B | NOT RUN | 无同模型、同 Runtime、同 Tools 的对照结果 |
| 30+ Model Call long Run | BLOCKED | Two real complex Coding attempts reached only 2 Model Calls before `PROVIDER_UNAVAILABLE`; no natural 30+ evidence |
| Resume / Replay real evidence | Resume PASS; Replay unsupported | One real Qwen Run reconstructed from persisted Runtime facts after restart and continued; no formal Replay API exists |

The validation harness now exposes an eval-only `CreateAgentOptions.hybridContext` switch (`on` by default), propagated through every Gateway prompt recompilation path. `--hybrid off|on|both` is accepted by the real canary; `both` runs fresh-workspace OFF/ON samples with identical Provider, Runtime, Tools, budgets, prompt, approval policy and Coding Strategy. This switch changes only Hybrid dynamic projection fields; it is not a product setting and does not alter Runtime authority.

## 30.2 Validation Round Record (2026-08-31)

### Current-path real Provider sample

执行入口：`pnpm run canary:autonomous-coding-primary`，使用 `.env` 中的真实 OpenAI-compatible Provider。样本参数与既有 coding canary 一致：Qwen 3.8 Flash、`native_tools`、Runtime `createAgent`、Built-in Tools、32-call/24-tool budgets、fresh empty workspace。该入口当前走 Hybrid projection，但没有 Hybrid OFF baseline，因此不是合格的 paired A/B。

| Metric | Current Hybrid path | Evidence boundary |
|---|---:|---|
| Final status | `succeeded` | real Provider Run `cd9a50b1-5fc4-4e42-9c75-a274ac231408` |
| Stop reason | `COMPLETED` | Runtime terminal result |
| Total runtime | 333,386 ms | canary report |
| Model calls | 14 | below required 30+ long-run gate |
| Tool calls | 10 | 8 approvals granted, 0 denied |
| Input tokens | 312,484 Provider-reported | summed from the 14 retained per-call `actualInputTokens` values; not section-level tokens |
| Output tokens | 23,728 Provider-reported | summed from the 14 retained per-call `actualOutputTokens` values; reasoning tokens were not separately reported |
| Plan revisions | 1 | canary report |
| Repeated reads | not separately measured | report has tool names, no reliable repeated-read classifier |
| Repeated edits | 1 same-file edit | `app.js` edited twice |
| Verification calls | 3, useful 1 | canary report |
| Core outcomes | 6/6 | add/edit/delete/search/filter/persistence |
| NO_PROGRESS | 0 | canary report |
| blocked | 0 | canary report |
| False success | 0 | independent workspace grade + syntax check |

The Provider had one recoverable `PROVIDER_CONNECT_TIMEOUT` attempt on the first logical call. Runtime retry completed it; this is not attributed to Hybrid Context. One completion response was rejected for stale evidence and corrected before final completion, demonstrating Runtime completion authority remained active.

The report does not retain the run's per-call Context Manifest sections, so this sample cannot provide the required ten-call section bytes/tokens/digests or adjacent request diff. The `actualInputTokens` values are Provider-reported call totals, not section-level Hybrid Context measurements.

### Long-run, paired A/B, Resume and Replay gates

- Paired Hybrid OFF/ON with identical Qwen profile, Provider, Tools, budgets and prompt: **NOT RUN**. Existing coding-strategy A/B is not a valid Hybrid A/B because its differing input is Coding Strategy, not Context strategy.
- Natural `>=30` Model Call Run: **NOT RUN**. The real sample terminated at 14 calls and was not artificially prolonged.
- Real process/runtime Resume with continued Tool/Validation step: **NOT RUN**.
- Replay/reconstruction equivalence from persisted Runtime facts: **Resume PASS; Replay unsupported**. The restart probe reconstructed the execution frontier from persisted facts; no formal Replay API is exposed.

### Resume / Reconstruction Evidence Record (2026-08-31)

- Real Run `960ae13c-3275-473b-9b44-9e17ac2c485e` reached a persisted `blocked / ITERATION_BUDGET_EXCEEDED` checkpoint after 5 Model Calls, 3 Tool Invocations, two successful file writes, Plan revision 1, one active and three unfinished outcomes.
- A new Runtime reopened the same `dataDir`; the reconstructed Provider context contained the persisted task contract, Plan revision 1, active/unfinished frontier, latest `filesystem.write` observation, a 3-item Recent Trajectory and Working Set files `index.html`/`styles.css`.
- The reconstructed goal is the normalized Task Contract goal rather than byte-identical original input text; Plan, active step, unfinished steps, latest observation and required evidence references remained semantically equivalent.
- After restart, one budget extension and approval/resume path produced additional Tool and Evidence facts. The Run finished `succeeded`; final ledger: 13 Model Calls, 13 Tool Calls, 13 Evidence records, all required outcomes completed.
- No process-local context cache was used by the reconstruction probe; the context was captured from the reopened Runtime's Provider call. No hidden memory, private reasoning or second authority was introduced.
- Formal Replay capability is not present in the current public API: **REPLAY: unsupported**. This round validates existing restart/resume reconstruction only.

### Regression attribution

The eight E135-E138 failures in the selected 54/62 run are Office/Desktop authority-path failures. They are outside Hybrid Context's changed files and E140/E141/E142 pass independently. However, no Hybrid-OFF reproduction was run, so the strict attribution status is **PRE_EXISTING / UNCONFIRMED**, not `HYBRID_CAUSED`. They remain release debt and are not evidence for or against Hybrid behavior.

### First broken boundary

No Hybrid-specific first broken boundary was observed in the current-path sample. The validation blockers are evidence gaps: missing paired baseline, missing natural 30+ run, missing real Resume/Replay, and missing retained section-level trace. Do not change Hybrid production code or infer `PLAN_CADENCE`, `MODEL_REASONING_CADENCE`, or `CONVERGENCE` from this round.

已实现的代码边界：

- `projectHybridDecisionContext()` 从现有 `ModelDecisionContext` 派生 `currentState`、最近 3 个 observation 单元、working set 和 bounded older context。
- Prompt assembly 消费上述 projection；Runtime、Plan、Tool Invocation、Evidence、Approval 与 Completion authority 未迁移。
- Context Manifest 记录 section `bytes`、估算 `tokens`、`digest` 与 quality metrics；默认 capture policy 不落盘 raw prompt。
- `diffContextSections()` 支持相邻 Model Call 的 added/removed/changed/repeated 与 token delta 诊断。

未完成的验收项：

- 真实 Provider A/B（同模型、同 Runtime、同 Tools、同 Prompt）及其 before/after 指标；
- 至少一次 30+ Model Call 长 Run，覆盖 execution frontier、stale ratio、plan revision、重复读写与 bounded growth；
- 真实 Resume / Replay / Recovery 证据；
- 基于上述证据的 completion report 与 `VALIDATED` 判定。

因此当前唯一诚实结论为：

```text
HYBRID DECISION CONTEXT V0.1: NOT VALIDATED
```

---

# 31. Freeze Rule

如果真实 A/B 证明：

- Context continuity 不退化；
- Recent Trajectory 减少重复判断；
- Current State 更清晰；
- Plan revision / repeated action 有方向性改善；
- Context token 维持有界；
- false success 仍为 0；
- Resume / Replay 正常；

则冻结本 Feature。

不要继续把 Context Harness 扩成新的 Agent Framework。
