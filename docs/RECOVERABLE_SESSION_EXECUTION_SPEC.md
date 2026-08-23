# Recoverable Session Execution Spec

Status: Draft

Feature: `recoverable-session-execution`

Mode: `PLAN`

Risk: `L3`

Primary owners: Runtime, Harness, Desktop Host

Evidence baseline: `D:\Nexora testspace`, Session containing Runs `a8db8614-71fa-45b8-ac7e-b6f270a366ee`, `b992e967-82b2-4bf3-a82e-85e17508c895`, and `aabaab8e-5fc7-4fa3-9a9c-ab8372f21ee2`

## 1. Outcome

当一个普通任务进入重复 Tool 循环、Provider 连续失败或执行时长边界时，Nexora 必须让用户能够理解原因并以合适的方式继续，而不是把所有情况都显示为同一个 `Resume`。

目标体验：

```text
开始任务
→ Agent 观察、修改、验证
→ 如果没有进展：停止当前策略，保留事实
→ 如果 Provider 暂时失败：有限重试，必要时明确等待用户
→ 如果需要继续：使用轻量恢复 Context 或创建新的后续 Turn
→ 不重复已经完成的 Tool Effect
```

本 Feature 只修复恢复边界和恢复时的 Context 投影，不重做 Agent Loop。

## 2. Triggering evidence

### 2.1 No-progress 循环

`b992e967-82b2-4bf3-a82e-85e17508c895`：

- 29 次 Model Call；27 次 Tool Invocation；21 次读取；6 次写入/补丁；
- 同一 `solutions.html` 多次 read / patch；两次 `PATCH_CONFLICT`；
- 4 次 `NO_PROGRESS_DETECTED`；每次都通过 `explicit_no_progress_recovery` 原地恢复；
- 最终由 Desktop 取消，未产生完成结果。

当前 Runtime 已能识别重复 Invocation 和资源 churn，但 `blocked → running` 的 Resume 不改变执行策略，因而可能再次进入相同循环。

### 2.2 Provider 慢与失败

`aabaab8e-5fc7-4fa3-9a9c-ab8372f21ee2`：

- 输入只有“继续”，但继承了前序长 Session；
- 9 次 Model Call，实际输入约 395K–405K tokens/次；
- 5 次 `PROVIDER_ERROR`，多次 Provider Attempt 约 50–82 秒；
- 最终 `DURATION_BUDGET_EXCEEDED`，状态为 `blocked`。

当前 Attempt 主要只暴露 `PROVIDER_ERROR`，不足以判断是连接超时、响应空闲超时、Provider 错误响应还是格式错误。

### 2.3 Direct response 修复轮次

`a8db8614-71fa-45b8-ac7e-b6f270a366ee` 首次直接回答被 `COMPLETION_EVIDENCE_REQUIRED` 拒绝，第二次才通过。它最终成功，但说明“需要读取当前 Workspace 事实”和“允许直接回答”的决策边界仍会造成额外 Provider 轮次。

## 3. Existing authority and invariants

1. Run Snapshot 和 State Machine 继续唯一决定 Run Status。
2. Tool Invocation 继续是副作用、重复判断和恢复判断的唯一 Authority。
3. Evidence、Artifact 和 Completion Gate 不由 Harness 或 Desktop 伪造。
4. Session 仍只是多个用户可见 Run 的 Host 投影。
5. blocked Run 的历史事实不删除、不重写；恢复可以创建新 Run，但不能复制已成功 Effect。
6. Context 仍由 Harness 从 Runtime Authority 派生；Desktop 不拼接历史、不建立 Context 状态。
7. 不因恢复功能绕过 Approval、Schema、Idempotency、Recovery 或 Completion Gate。

## 4. Scope

### 4.1 分类恢复原因

Runtime/Host 对已有 stop reason 做最小分类：

| 分类 | 例子 | 恢复方式 |
| --- | --- | --- |
| `no_progress` | `NO_PROGRESS_DETECTED`、重复 Tool/资源 churn | 不允许无条件原地 Resume；先改变策略或创建新的后续 Turn |
| `provider_transient` | 连接、响应头、流式空闲等可重试失败 | 同一 logical call 使用有限 Attempt；耗尽后 blocked，展示可诊断原因 |
| `duration_boundary` | `DURATION_BUDGET_EXCEEDED` | 使用恢复 Context 后一次有界重试；不自动无限加预算 |
| `tool_recovery` | unknown non-idempotent Effect | 保持现有 Recovery Decision，必须用户确认真实结果 |
| `input_required` | Runtime 需要用户事实 | 保持现有 Input Request |

未知原因必须 fail closed，不能自动 Resume。

### 4.2 No-progress Recovery

当 Run 因 `no_progress` blocked：

1. `RunHandle.resume()` 不得直接再次执行相同 continuation；它只能生成一个明确的恢复错误或要求 Host 选择恢复操作。
2. Desktop 不再显示通用 `Resume`，而显示：
   - `重新规划并继续`：在同一 Session 创建新的后续 Run；
   - `结束任务`：保留 blocked Run 和事实，不再消耗 Provider。
3. “重新规划并继续”只向新 Run 提供有界恢复 Context：
   - 原始用户目标；
   - 最近一次用户输入；
   - 已成功的 Tool Facts / Evidence / Artifact 引用；
   - 最近失败及其原因；
   - no-progress 资源和重复次数；
   - 明确要求先验证当前状态，再选择一个不同的动作。
4. 新 Run 可以继续使用同一 Session，但不得重放成功 Invocation，也不得把旧 Provider reasoning 当作指令。
5. 同一 Session 连续两次因 `no_progress` blocked 后，默认停止自动继续，要求用户提供新的目标或结束任务。

这不是新的状态模型；blocked Run 仍由 Runtime Authority 保留，后续 Run 只是已有 Session continuation 关系。

### 4.3 Duration Recovery

当 Run 因 `duration_boundary` blocked：

1. 不直接复用完整长历史作为下一次 Provider 输入。
2. 优先使用现有 Context projection 机制，形成“恢复 View”，不新增 Context 表或摘要 Authority。
3. 恢复 View 只保留当前未完成目标、成功事实、未解决错误、最近 Tool/Plan 状态和必要引用。
4. 同一 Run 最多允许一次 Host 明确的 duration recovery；再次达到边界时必须 blocked 并要求新输入或新 Run。
5. Budget extension 只提高原 Run 的绝对预算，不重置已用量，不重放副作用。

### 4.4 Provider Attempt 诊断

在现有 `errorCode` 字符串 Contract 上增加稳定分类，不保存 Provider 原始敏感响应：

- `PROVIDER_CONNECT_TIMEOUT`
- `PROVIDER_IDLE_TIMEOUT`
- `PROVIDER_HTTP_ERROR`
- `PROVIDER_RESPONSE_INVALID`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_CANCELLED`

若无法分类，使用 `PROVIDER_ERROR`。每个 Attempt 至少在 Activity 中显示：分类、Attempt 序号、耗时、是否可重试和最终恢复建议。原始响应进入现有受保护 Artifact/审计策略，不进入 Conversation。

### 4.5 Direct response boundary

当用户问题涉及当前 Workspace、文件、路由或运行结果时，Harness 应在第一次决策中优先选择最小只读 Tool；只有已有权威事实足够时才允许 direct response。

Completion Gate 仍是最终 Authority。本 Feature 不放宽 `COMPLETION_EVIDENCE_REQUIRED`，只减少模型先给无依据答案再被拒绝的额外轮次。

## 5. Minimal implementation shape

只允许复用现有路径：

1. Runtime：在现有 blocked/Resume 分支增加恢复分类和 no-progress 的策略保护。
2. Harness：复用现有 continuation projection、repair context 和 Tool/Evidence 事实，增加 bounded recovery View。
3. Desktop Host：根据 stop reason 投影不同恢复操作，不在 Renderer 自行判断风险或拼接 Context。
4. Provider Adapter：将已知 timeout/HTTP/格式错误归一化为稳定 `errorCode`，不新增 Provider 特例。
5. Store：优先使用现有 Event、Model Call、Provider Attempt 和 Artifact；只有现有字段无法保存分类时才做最小兼容迁移。

## 6. Non-goals

- 不新增 Workflow Engine、Scheduler、Supervisor 或第二套 Recovery 状态机；
- 不新增 Context 数据库、向量检索、Embedding 或 LLM summarizer；
- 不把“继续”当成无限预算授权；
- 不自动批准高风险 Tool；
- 不自动重放 unknown non-idempotent Effect；
- 不通过命令关键词或模型分数判断安全性；
- 不改变 Session 的产品定义；
- 不把 Provider 私有 reasoning 作为恢复指令；
- 不要求一次性重做整个 Context Continuity Feature。

## 7. Acceptance criteria

### No-progress

1. 一个重复读写同一文件的确定性 Run 首次 `NO_PROGRESS_DETECTED` 后，不能通过通用 Resume 直接再次执行原 continuation。
2. Desktop 显示“重新规划并继续”与“结束任务”，不显示无语义的单一 Resume。
3. 重新规划后的 Run 至少能看到原目标、成功事实、失败原因和当前资源，不重放已成功 Invocation。
4. 连续第二次 no-progress 后不再自动继续。

### Duration / Provider

5. Provider transient failure 在 logical call 内最多进行既定有限 Attempt，耗尽后产生可理解的 blocked 原因。
6. Provider 错误至少能区分 timeout、HTTP、invalid response、unavailable、cancelled 或 unknown。
7. Duration recovery 不把完整长 Session 原样重新发送给 Provider。

### Compatibility / safety

8. Approval、Tool Schema、Invocation、Evidence、Completion Gate 和 unknown Effect Recovery 回归测试通过。
9. CLI、Desktop 和 `@nexora/harness` 均继续使用同一个 Runtime Authority。
10. 重启 Runtime 后，blocked Run、恢复原因和后续 Run lineage 保持一致。

## 8. Verification plan

最小测试集：

- Runtime：no-progress blocked 后禁止原地 Resume；恢复 Run 的 Context 只含有界事实；
- Runtime：同一成功 Invocation 不因恢复重复执行；
- Harness：恢复 View 的 digest 在重启前后一致；
- Provider：timeout、HTTP error、invalid response 的归一化测试；
- Desktop：不同 blocked 原因显示对应操作；
- Integration：复现 `b992...` 的 read/patch 循环，验证第二次 no-progress 后停止；
- Integration：复现 `aabaab...` 的连续 Provider failure，验证有限重试和明确终态；
- Regression：Approval、Input、Recovery、Completion、Context compaction 和 Session continuation。

真实 Provider Canary 不是本地 Feature Core 的必要条件，但发布前必须使用授权的 Qwen Provider 验证一次超时分类和恢复体验。

## 9. Rollback and delivery

实现必须先在现有 Runtime Event/Model Call/Attempt 路径上完成，不做破坏性迁移。若 Provider 错误分类或恢复 View 影响现有 Run，优先关闭新恢复策略并保留原始 blocked Run 数据；不得删除历史事实。

完成条件：实现、重点回归、复现用例、Desktop 确定性 UAT 和文档状态一致后，才能将 Feature 标记为 `done_locally`。在此之前状态为 `draft` 或 `in_progress`，不能仅凭 Spec 宣称完成。
