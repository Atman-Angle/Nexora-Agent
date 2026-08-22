# Nexora Session Context Continuity — Feature Spec

状态：`IMPLEMENTED / DONE LOCALLY`

Feature：`session-context-continuity`

Owner：`@nexora/runtime` 提供通用 Run continuation lineage；`@nexora/harness` 拥有模型可见 Context 的构建、收缩与恢复；Host 只声明 Run 之间的连续关系

风险等级：`L3`

文档日期：2026-08-22

## 1. Outcome

同一个产品 Session 下的全部已持久化任务历史都必须属于 Harness 可访问的逻辑 Context。后续 Run 不再只收到上一 Run 的一段 Host 拼接摘要，而是由 Harness 从 Runtime Authority 中重建整个 continuation chain，并继续使用 Nexora 已有的 Provider-aware Token Meter、确定性收缩、Artifact、Rehydration 和引用策略生成本次真实 Model Call 的有界 Context。

这里的“整个上下文”有两个不同层次：

1. **完整 Session History**：同一 continuation chain 中全部 Run 的 Input、Event、Invocation、Evidence、Artifact、Result、Delivery 和 Recovery 事实持续保留、可审计、可按引用恢复；
2. **当前 Model Context**：Harness 在每次调用前，从上述完整历史构建的有界投影。它可以把旧内容降为摘要事实、片段或引用，但不得让历史从 Harness 的可访问范围中消失，也不得把压缩投影变成新的事实 Authority。

目标用户体验：用户在同一个 Desktop 对话框继续输入时，Agent 能延续此前的需求、决定、文件修改、验证结果、失败和未完成事项；窗口接近上限时自动压缩旧内容，同时保持最近 Turn 和当前工作不失真。

## 2. Current reality and defect

Desktop Session 当前是 Host 保存的有序 Run 引用。继续 Session 时，Host：

1. 只打开紧邻的上一 Run；
2. 读取 `result.summary`、`delivery.summary` 或状态文本；
3. 截断到 4,000 字符；
4. 把摘要和新用户输入拼成一个新的 goal；
5. 创建完全独立的新 Run。

Harness 的 `ContextSource` 只读取当前 Run；只有正式 Fork Child 可以读取受 Fork Base 限制的 Parent。现有 `sessionArchive` 也只索引同一 Run 的 Input/Event，因此名称不能被理解为 Desktop Session 的跨 Run 历史。

这造成以下真实缺口：

- GUI Conversation 显示多个 Run，不代表 Provider 收到了这些 Run；
- 更早用户要求、Tool 结果、Evidence、Artifact 和失败事实不会自动进入新 Run；
- Host 生成的自然语言 continuation goal 混合了“新输入”和“历史提示”，破坏原始 Input 的清晰 provenance；
- Context Meter 本身读取最近一次真实 Model Call，数值没有把多个 Project 或 Session 相加；问题是该 Model Call 当前缺少正式的跨 Run Context；
- 重启后只能恢复 Host 的 Session→Run 导航关系，Harness 无法从 Runtime 自己验证这些 Run 是否属于同一连续任务。

## 3. External implementation research

本设计核对了以下公开实现，链接固定到调研时的 commit：

### OpenAI Codex

- [`compact.rs`](https://github.com/openai/codex/blob/343074d4207d572809bd8cea15f4be1d09d98e0b/codex-rs/core/src/compact.rs) 将线程历史替换为保留的用户输入和一个压缩摘要；用户消息有独立 Token 上限，按最近优先保留，最老的边界消息允许有界截断；
- [`history.rs`](https://github.com/openai/codex/blob/343074d4207d572809bd8cea15f4be1d09d98e0b/codex-rs/core/src/context_manager/history.rs) 在进入 Provider 前规范化历史，确保 Tool Call 和 Output 配对，并在删除旧项时同时删除配对项；Tool Output 在记录时已经按策略截断；
- [`context_window.rs`](https://github.com/openai/codex/blob/343074d4207d572809bd8cea15f4be1d09d98e0b/codex-rs/core/src/session/context_window.rs) 区分完整活动 Context、自动压缩计量范围和模型硬窗口，不把历史累计消费量当作当前 Context 占用。

可采用原则：线程是连续 Context；压缩替换的是模型 View，不是用户可见历史；最近输入优先；Tool 协议对必须保持完整；Context 指标表示当前活动窗口。

### OpenHands Software Agent SDK

- [`condenser/README.md`](https://github.com/OpenHands/software-agent-sdk/blob/88afa9af5706a63a9d6c9ad862a968e4c154106b/openhands-sdk/openhands/sdk/context/condenser/README.md) 以 append-only Event Log 保存完整历史，用 `Condensation` 事件生成面向 LLM 的 View；默认压缩前半段并保持后半段原样；
- [`llm_summarizing_condenser.py`](https://github.com/OpenHands/software-agent-sdk/blob/88afa9af5706a63a9d6c9ad862a968e4c154106b/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py) 同时支持 Token/Event 阈值、软压缩和无法继续时的硬恢复；
- [`test_view_condensation_batch_atomicity.py`](https://github.com/OpenHands/software-agent-sdk/blob/88afa9af5706a63a9d6c9ad862a968e4c154106b/tests/sdk/context/view/test_view_condensation_batch_atomicity.py) 明确验证同一模型响应中的 Tool batch 必须原子保留或整体移除，避免孤立 Tool Call/Result。

可采用原则：完整历史与 LLM View 分离；压缩是可审计投影；近期历史不动；Tool batch 必须原子；软阈值与硬窗口分开。

### Cline

- [`auto-compact.mdx`](https://github.com/cline/cline/blob/1de61b178aec844e0aa362474274ccbf6acf9403/docs/features/auto-compact.mdx) 在接近窗口限制时生成 continuation summary，再继续同一任务；
- [`basic-compaction.ts`](https://github.com/cline/cline/blob/1de61b178aec844e0aa362474274ccbf6acf9403/sdk/packages/core/src/extensions/context/basic-compaction.ts) 的无模型压缩保留全部 typed user prompts，优先保留最新 Turn，旧 Turn 尽量保留最终 Agent 输出，并把被移除的 Read/Edit/Command 活动变成紧凑事实；旧附件会删除，最新附件保留；
- [`compaction-shared.ts`](https://github.com/cline/cline/blob/1de61b178aec844e0aa362474274ccbf6acf9403/sdk/packages/core/src/extensions/context/compaction-shared.ts) 只在安全 Turn 边界切割，显式避免拆开 Tool Use/Result，并把已读文件、已改文件和命令作为压缩摘要的重要组成。

可采用原则：用户输入优先级高于旧 Tool payload；保留最新 Turn 原文；旧 Tool 工作压缩为文件、命令和结果事实；附件/大内容不应长期 inline；重复压缩不能反复改写已经压缩的历史。

### Aider

- [`history.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/history.py) 将较旧的 head 总结，同时保留约一半预算给近期 tail；若 summary + tail 仍超限则递归压缩；
- [`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py) 把已完成历史和当前消息分开，并异步总结旧历史。

可采用原则：旧历史和近期工作使用不同保留策略；不能把全部预算分给旧摘要；压缩失败时必须有明确行为。Aider 的简单 User/Assistant 摘要没有 Nexora 的 Invocation/Evidence Authority，因此不能直接照搬。

### Research conclusion

成熟实现的共同点不是“无限重放全部聊天文本”，而是：

```text
完整、可恢复的会话历史
→ 有界的当前 Context View
→ 最近内容原样保留
→ 旧内容压缩或引用化
→ Tool 协议和关键状态保持完整
→ 真实 Token 使用驱动压缩
```

Nexora 首版采用该共同结构，但不新增 LLM summarizer。已有 Runtime Result/Delivery、Invocation、Evidence、Artifact 和确定性 Context projection 已足以形成可验证的第一版；只有评测证明确定性压缩无法维持语义连续性时，才单独设计带 provenance 的语义摘要 Feature。

## 4. Terminology and authority

### Product Session

Desktop Session 仍是 Host 的导航概念：一个 Workspace 下有序展示多个 Run。它不拥有 Run Status、Plan、Invocation、Evidence、Result 或 Context 内容。

### Run Continuation

Runtime 新增通用、不可变的 Run lineage：新 Run 可以声明自己延续同一 Store 中的一个终态 Parent Run。Runtime 不引入 Desktop Session ID，也不理解聊天 UI。

建议的公开调用形状：

```ts
runtime.run(input, {
  continuation: { parentRunId }
});
```

最终命名可在实现审查时调整，但语义必须唯一，不得同时保留 Host 拼接 goal 和正式 continuation 两条生产路径。

### Session Context

Harness 通过当前 Run 的 continuation lineage 访问的完整逻辑历史。它是从 Runtime Authority 派生的只读集合，不是新的 Store。

### Active Model Context

一次 Provider 调用实际收到的最终 wire。Context Meter 只报告这次调用的真实或测量 Input Token，不累计历史调用消费。

### Memory

Memory 继续表示跨 Session 的长期偏好或稳定事实。Session continuity 不写入 Memory，不借用 `branchId` 模拟 Session，也不要求用户 promote 每轮对话。

## 5. Runtime contract

### 5.1 Minimal persisted lineage

新 Run 创建时可携带：

```ts
type RunContinuation = {
  readonly parentRunId: string;
  readonly parentRevision: number;
  readonly parentLastEventSequence: number;
};
```

该关系可以作为 `RunSnapshot` 的可选、不可变字段持久化，并进入 `run.created` Journal payload。旧 Snapshot 缺少字段时表示没有 Runtime-verifiable continuation。

不新增 Session 表、Conversation 表或 Context 数据库。现有 `runs.snapshot_json`、Journal 和 Authority 表足以保存 lineage；实现必须验证后再决定是否需要 SQLite schema version 变化，不能预先增加表。

### 5.2 Creation rules

Runtime 在创建 Child 前必须验证：

- Parent 存在于同一个 Runtime Store / Workspace；
- Parent 已是 `succeeded | failed | cancelled` 终态；
- Parent 没有未知、未解决的副作用；
- `parentRevision` 和 `parentLastEventSequence` 与创建时事实一致；
- lineage 不成环；
- Child 的新用户输入仍作为 `inputHistory[0]` 原样保存，不与历史摘要拼接。

用户在 running Run 中发送新输入时，Host 仍先安全取消旧 Run；只有取消闭环且无 unknown Effect 后，才以旧 Run 为 Parent 创建 continuation Child。

### 5.3 Runtime internal read boundary

Runtime 的 Harness port 应提供经过 lineage 校验的只读 continuation source。Harness 只能读取当前 Run 的祖先链，不能按任意 Run ID 浏览 sibling、其他 Session 或其他 Workspace。

Runtime 只负责：

- 验证 lineage；
- 返回原始持久化 Authority；
- 限定可见 Run 范围；
- 提供 namespaced source refs 的精确读取。

Runtime 不决定历史重要性、不生成摘要、不计算相关性，也不修改 Parent Authority。

## 6. Harness Context model

### 6.1 Source set

一次决策的逻辑 Context Source 为：

```text
Current Run Authority
+ verified continuation ancestors, newest → oldest
+ exact-scope Memory（若 Host 已显式启用）
+ Fork Base（仅当前 Run 本身是正式 Branch Child 时）
```

Continuation ancestor 的可用事实包括：

- 原始用户 Input；
- Run 终态和 Stop Reason；
- Result / Delivery / Failure Handoff；
- Structured Plan 的最终状态；
- Tool Invocation 的输入、结果、错误和耗时；
- Evidence、Validation 和 Approval/Recovery Event；
- Artifact ref；
- 从成功 write/edit Tool 确定性派生的文件变更；
- 从 read/search/command Tool 确定性派生的历史工作事实。

不包括：

- Provider 临时 reasoning delta；
- 失败 Attempt 未被 Runtime 接受的流式文字；
- Renderer 折叠状态或 Conversation View Model；
- Host 自己编写的“之前做了什么”摘要；
- 未持久化、无法校验 digest 的内容。

### 6.2 Provider-neutral projection

在现有 `AgentWorkingContext` 中增加一个有界 continuation 部分，概念形状为：

```ts
type ContinuationTurn = {
  readonly sourceRunId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly inputs: readonly SourceFact[];
  readonly outcome: SourceFact | null;
  readonly changedFiles: readonly SourceFact[];
  readonly unresolved: readonly SourceFact[];
  readonly relatedRefs: readonly string[];
  readonly occurredAt: string;
  readonly payloadMode: "full" | "compact" | "reference";
};
```

这里的类型只锁定语义，不要求照抄字段名。所有内容必须能追溯到 `sourceRunId + ref + digest`。`compact` 只允许由已有 Authority 确定性派生，例如：

- 用户输入原文；
- persisted Result/Delivery；
- Failure Handoff；
- 已读、已修改的路径；
- 执行过的命令及成功/失败；
- Evidence / Artifact 精确引用。

不得由 Harness 自行声称“任务完成”“验证通过”或补写不存在的决定。

### 6.3 Cross-Run refs

当前 `input:<sequence>`、`event:<sequence>` 等 ref 在跨 Run 后会冲突。Continuation source ref 必须带 Run namespace，例如：

```text
run:<runId>/input:<sequence>
run:<runId>/event:<sequence>
run:<runId>/invocation:<invocationId>
run:<runId>/evidence:<evidenceId>
artifact:<sha256>
```

Harness 发布 ref 前由 Runtime 验证它属于当前 continuation chain。Rehydration 再次校验 lineage、digest 和 Artifact 存在性。Provider 不能通过猜测 Run ID 读取不相关历史。

### 6.4 Existing same-Run archive

现有 `sessionArchive` 仍只是同一 Run 的 Input/Event index。首版不做破坏性字段重命名，但文档和注释必须统一称它为 **Run-local Session Archive**，避免把它当作跨 Run continuation。跨 Run 使用独立的 continuation projection；两者共享 Rehydration 和 Token Budget，不共享状态。

## 7. Deterministic compaction policy

### 7.1 Core invariant

完整历史始终保存在 Runtime Authority。Harness 每次从 Authority 和 lineage 重建 View；删除、重启或改变压缩结果不删除任何 Input、Invocation、Evidence、Event 或 Artifact。

首版不持久化“当前压缩后的 Context”，不新增 Context Checkpoint Authority，也不调用额外 LLM 生成摘要。

### 7.2 Retention order

从高到低：

1. 当前 Run 的最新 Input、Task Contract、active Plan/Step、Pending Request、unknown Effect、未解决错误和 required Evidence；
2. 当前 Run 已有的 critical Tool Observation、当前文件链和 Provider-native Tool continuation；
3. 直接 Parent 的全部用户 Input、正式 Outcome、Failure Handoff、变更文件和未完成事项；
4. 更早 ancestor 的用户 Input 与正式 Outcome，新的 Turn 优先；
5. ancestor 的 distinct write/execute/validation facts 和 Artifact refs；
6. ancestor 的 read/search facts；
7. 重复成功、旧附件正文、旧 Tool 大 payload、导航候选和可重建 helpful facts；
8. exact-scope Memory candidates。

Memory 的最终位置仍需服从当前 Input、TaskContract、Plan、Progress 和 Evidence 永远优先的现有规则；本表不改变 Memory 信任等级。

### 7.3 Compression stages

Harness 在最终 Provider wire 上计量，并依次尝试：

```text
full
→ 删除纯导航候选和重复事实
→ 旧 Tool payload full → fragment → reference
→ 旧 Turn full → compact
→ 更旧 Turn compact → reference
→ 移除最低相关 reference，仅保留有界 continuation archive
→ 执行现有 current-Run 最后收缩路径
```

要求：

- 最近一个完整用户 Turn 尽量原样保留；
- 直接 Parent 的新输入和正式 Outcome 不应在普通 soft-limit 压缩中消失；
- 所有用户输入都进入 Harness 的完整 source set；在 Provider window 无法容纳时，较旧输入可以退出 active wire，但必须仍可通过 continuation archive/ref 恢复；
- Tool Call/Result、Native Tool batch、Approval Request/Decision 不得只保留一半；若投影为语义事实，则不重放伪造的 Provider Tool transcript；
- 大文件、长 stdout/stderr 和附件只保留 Artifact/ref 与必要片段；
- 重复读取和相同 Tool/input/outcome 继续使用现有确定性折叠；
- Context 超硬窗口时必须明确失败或执行既有最小投影，不能静默丢失当前输入。

### 7.4 Trigger

继续使用 Provider Model Profile 的：

- `contextWindowTokens`；
- decision output reserve；
- soft/hard input limit；
- calibrated Provider-aware Token Meter；
- Provider 返回的 actual usage。

不得按 Session 历史累计 token 触发。触发依据始终是“本次准备发送的 active Model Context”。

## 8. Desktop and Host behavior

Desktop：

- Session 仍保存有序 Run 引用用于导航和 Conversation 组合；
- 创建后续 Run 时只提交精确 `parentRunId` 和新用户输入；
- 删除现有 `continuationGoal` 字符串拼接路径；
- 不读取 SQLite、`.nexora` 或 Harness 内部 Context；
- 不保存压缩摘要或 token 估算；
- Context UI 显示最新真实 Model Call 的占用，可标记为 `Context`；
- Activity 可以显示 `continued from <Run>` 和 Context compression audit，但不常驻暴露内部 JSON。

CLI 或其他 Host 也可以使用同一 continuation Contract；它不是 Desktop 特例。

## 9. Failure and recovery

- Parent 不存在、跨 Workspace、非终态、revision/event boundary 不匹配或 lineage 成环：新 Run 创建前以 `INVALID_CONTINUATION` 失败；
- ancestor 数据 digest drift 或审计完整性失败：Harness 不使用该历史，当前 Run 进入明确的 Context/Integrity failure，不静默继续；
- legacy Desktop Session 没有 Runtime lineage：显示为 `legacy_partial`，不得根据 Host 数组倒推并补造历史关系；用户下一次继续时只能从可验证的直接 Parent 开始建立新 lineage；
- Context ref 不可用：统一返回 `REF_UNAVAILABLE`，不泄漏 sibling 或其他 Workspace 是否存在；
- 压缩后仍超过硬窗口：保持当前 Run Authority，并通过既有 Provider/Context 错误边界失败；不得修改 Run 为成功或丢弃最新用户输入重试。

## 10. Security and privacy

- Runtime 只允许读取 continuation ancestor，不允许任意 Run lookup；
- Artifact 和 Memory 保持原有 scope/sensitivity/digest 规则；
- Provider reasoning 不进入 continuation；
- 被 capture policy 隐藏的 payload 不因跨 Run Context 重新暴露；
- Summary、Delivery 和 Memory 中的自然语言都不能发出 Tool、Approval、Evidence 或 Completion 指令；
- Renderer 不接收 Provider secret、Artifact 物理路径或未脱敏内部 payload。

## 11. Acceptance

### Deterministic contract tests

1. `Run B` 以 `Run A` 为 Parent 创建后，lineage 在关闭并重开 Runtime 后保持；
2. `Run C` 的 Harness source set 包含 A、B、C 的可验证 Authority，且不包含 sibling Run；
3. Child 的 `inputHistory[0]` 只包含用户原始新输入，不包含 Host continuation prompt；
4. 跨 Workspace、非终态 Parent、成环和 boundary mismatch 创建失败；
5. namespaced input/event/invocation/evidence/artifact ref 能精确恢复，错误 scope 统一不可用；
6. Tool Call/Result 和同批 Tool Calls 在所有压缩阶段保持协议完整；
7. Provider reasoning、失败 Attempt delta 和 Renderer state 不进入 continuation；
8. 重启前后相同 Authority、模型 Profile 和预算生成相同 provider-neutral Context digest。

### Context policy tests

9. 三 Turn Session 中，第三 Turn 能复述第一 Turn 的原始约束并引用第二 Turn 的正式 Result；
10. 后续 Turn 能找到此前写入的文件、Result Artifact、验证结论和失败原因；
11. 小 Context Window 下，旧 Tool payload 依次变为 fragment/reference，直接 Parent 的输入与 Outcome 仍保留；
12. 极长 Session 下，旧 Turn 可退为 archive/ref，但相关 ref 在新输入明确点名时可以重验并恢复；
13. 重复 Tool facts 不淹没 distinct file、error、validation 和 user requirement；
14. Context Meter 的 inputTokens 与最终 Model Call Ledger 一致，不累计 Session 历史调用。

### Integration / UAT

15. Desktop 在同一 Session 连续完成“创建文件 → 修改文件 → 解释此前决定”三个 Run，第三 Run 无需用户重复说明；
16. 关闭并重启 Desktop 后继续同一 Session，历史连续性保持；
17. 新建 Session 后不会继承旧 Session Context；
18. running 中发送新输入时先取消旧 Run，再创建有 lineage 的新 Run；unknown Effect 时不会越过 Recovery；
19. 使用受限 Context Window 的真实 Provider 完成一次触发压缩的长 Session Canary，并保存 Model Call/Context Manifest 证据；
20. 原 CLI 的独立新 Run 行为保持不变；显式 continuation 使用同一公共 Contract。

## 12. Non-goals

首版不包含：

- Runtime Core Session/Conversation 实体；
- Renderer 或 Desktop Host 自己组装模型 Context；
- 把完整 Session transcript 拼入 goal；
- LLM 生成的自动 Context Summary 或新的 summarizer Provider；
- 向量数据库、Embedding、语义检索服务或新的 Context 数据库；
- 用 Memory 模拟当前 Session history；
- 重放 Provider 私有 reasoning；
- 跨 Session 自动关联、跨 Project Recall 或云同步；
- Fork/Merge 语义替代 continuation；
- 为 UI 维护第二套 token、Plan、Completion 或 Context 状态。

## 13. Minimal implementation sequence

只按一个垂直 Feature 推进：

1. Runtime：增加可选不可变 continuation lineage、创建校验和只读 Harness port；
2. Harness：扩展 namespaced source refs、continuation projection、Rehydration 和现有 Eviction；
3. Provider Adapter：把有界 continuation 投影进入现有 `AgentWorkingContext`，不新增第二 Provider 路径；
4. Desktop：删除 4K continuation goal，改为公共 continuation Contract；
5. 验证：确定性测试、重启集成测试、小窗口压力测试、Desktop 三 Turn UAT；
6. 文档：实现完成后同步 `ARCHITECTURE.md`、`DATA_FLOW.md`、`SYSTEM_SOP.md`、Runtime API 文档和 `DEVELOPMENT.md`。

在第 1 步实现审查前，不提前加入 LLM Summary、Memory UI、向量检索或 Context checkpoint 表。

## 14. Feature state

```yaml
feature: session-context-continuity
mode: VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed
integration_test_status: passed
uat_status: passed
runtime_status: verified
security_status: verified
external_dependency_status: unverified
artifact_status: mixed
resolved_status: done_locally
```
