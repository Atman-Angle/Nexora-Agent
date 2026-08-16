# Nexora 渐进式 Agent 执行与确定性完成 Spec

状态：`IMPLEMENTED / VERIFIED`

Feature mode：`DIRECT`

文档日期：2026-08-16

本文档定义 Nexora 单 Agent 渐进执行主链的目标、边界、Authority、迁移和验收。实现已在 `progressive-agent-execution` 分支完成并通过 L3 验证；旧 validation Schema/Event 仅保留只读审计兼容。

## 1. 决策摘要

Nexora 的模型只负责根据用户目标、当前事实和 Tool 能力选择下一步行为。Harness 负责把模型的语义行为编译为可执行动作；Runtime 负责确定性校验、授权、执行、持久化和恢复。

主链改为：

```text
有界恢复当前相关事实
→ 模型选择直接行动、探索或可选 Plan
→ Harness 编译模型行为
→ Runtime 确定性校验并执行 Tool
→ Tool Result 持久化并返回下一轮模型
→ 模型基于新事实继续、修订 Plan 或完成
→ Runtime 确定性 Completion Gate
→ Result
```

本 Feature 删除同步语义 Validator，不再让同一个 Provider 在任务完成后审查自己的输出，也不再因语义 Verdict 失败返回通用 Agent Loop。

Plan 是提示词引导下由模型选择的渐进式工作地图，不是所有任务的必经协议，不是 Tool 白名单、Approval、Evidence 或完成 Authority。复杂且目标明确的任务可以建立轻量 Plan；信息不足时先通过只读 Tool 获取事实；简单任务可以直接 Tool 或完成。

## 2. 当前问题

当前实现已经具备 Tool Result 回流、无 Plan Tool、同轮 Plan + Tool、Plan CAS 修订、Invocation/Evidence 持久化和恢复，但存在以下问题：

1. Harness 将每个模型 Plan Task 自动编译为 required `semantic_review`。
2. 普通模型 Plan 和无 Plan 完成都几乎固定调用 `Provider.validate()`。
3. `decide()` 与 `validate()`通常属于同一 Provider，不能形成真正独立审批。
4. Validation 失败只写入通用 `repair`，模型下一轮仍可重写 Plan、重复 Tool 或重做已完成工作。
5. 模型生成的 Plan Step 缺少机械 Check，真实 Tool Result 通常不能直接推进 Step，只能等待最终语义审查。
6. Plan、Evidence 引用、Check ID 等 Runtime-owned 数据暴露为模型协议负担会增加格式失败和返工。
7. Durable Journal 已完整记录历史，但当前决策仍可能因相关 Evidence 投影不足而漂移。
8. 完整历史不能直接注入 Context；否则会增加 Token、延迟、旧事实干扰和提示注入风险。

## 3. 产品结果

开发完成后：

1. 简单任务无需创建 Plan。
2. 信息不足的任务可以先执行安全的探索性 Tool，再根据结果创建 Plan。
3. 复杂且目标明确的任务可以在同一 ModelTurn 创建轻量 Plan 并执行首个 Tool。
4. 每次 Tool Outcome 都持久化，并作为下一轮 Observation 返回模型。
5. 模型可根据新事实继续当前方向或提交完整的新 Plan revision。
6. 模型只提供业务语义：最终文本、Plan objective、Tool name/arguments 或用户问题。
7. Harness/Runtime 自动生成内部 ID、版本、Check 绑定、Invocation、幂等键、Approval 请求、Evidence 引用和 Journal provenance。
8. 正常完成不再调用语义 Validator。
9. 系统只校验可以由 Schema、当前状态、权限、持久化事实和外部回执确定性判断的条件。
10. 当前相关历史 Evidence 在模型决策前被有界恢复，减少忘记成功工作、重复 Tool 和方向漂移。

## 4. 核心原则

### 4.1 模型表达意图，不提供系统证明

允许的 ModelTurn 语义保持最小：

```json
{
  "text": "可选最终交付",
  "plan": {
    "goal": "可选目标",
    "tasks": [{ "objective": "阶段目标" }]
  },
  "toolCalls": [
    { "name": "tool.name", "arguments": {} }
  ],
  "requestInput": {
    "question": "只有用户能回答的问题",
    "reason": "为什么阻塞"
  }
}
```

模型不得提供或决定：

- Run/Plan/Step/Check/Invocation/Evidence ID；
- Plan version、revision 或 CAS token；
- Tool Schema、effect kind 或返回值合法性；
- Approval、权限、幂等、重试或恢复结论；
- Evidence 是否真实、Artifact digest 是否匹配；
- Run Status、Result provenance 或系统完成证明。

Harness 从当前 Run Authority 自动编译这些内部字段。Runtime 不信任模型对执行、授权、事实或完成状态的声明。

### 4.2 Plan 由提示词引导，不由启发式强制

Harness 的生产提示词必须引导：

```text
简单、明确、单步任务：直接回答或调用 Tool，不创建 Plan。
信息不足：先使用安全的只读 Tool 获取事实，不凭空制定完整 Plan。
多阶段、长时间或有依赖关系且目标明确：创建简短有序 Plan。
Plan 只描述阶段目标，不预设未知事实或 Tool Result。
可以在同一轮创建/修订 Plan 并立即调用 Tool。
Tool Result 返回后，基于新事实继续；只有方向真实变化时才修订 Plan。
单个 Tool 失败不自动重建全部 Plan。
```

Harness 和 Runtime 不实现任务复杂度评分器，不按输入长度、Tool 数量或模型风险分数强制 Plan。

### 4.3 ReAct 是主循环，CoT 不是持久化 Contract

每个任务或 Plan 阶段都通过多轮 Action/Observation 推进：

```text
Context
→ ModelTurn
→ Tool Action
→ Tool Observation
→ 更新后的 Context
→ 下一 ModelTurn
```

系统记录输入、Plan、可见模型输出、Action、Observation、Evidence、状态转换和简短决策元数据。系统不得要求、捕获或持久化模型未显式提供的隐藏思维链。

### 4.4 Plan 是工作地图，不是完成证明

- Run-owned Structured Plan 仍是唯一当前 Plan。
- Plan 不允许 Tool；没有 Plan 也允许安全 Tool 调用。
- Plan revision 使用现有 version/CAS，并保留完整 Journal provenance。
- 模型 Plan objective 不自动生成 `semantic_review`。
- 模型 Plan objective 默认不创建虚假的机械 Check。
- Tool Invocation 和真实 Tool Result 才是执行事实 Authority。
- 模型 Plan 的 `stepProgress` 只表示导航状态，不能被 Completion Gate 当作业务完成证明。
- 只有 Host/Tool Contract 已经提供真实机械 Acceptance Check 时，该 Check 才能阻塞完成并由对应 Evidence 满足。
- 没有机械 Check 的模型 Plan Step 不得因为缺少 Validator Evidence 阻塞 Result。

实现阶段可以保留现有 Plan 数据结构，但必须允许模型 Plan Step 没有 required Acceptance Check。不得增加另一套 Plan 或 Step 状态表。

### 4.5 验证属于确定性边界

保留并由系统自动执行：

- ModelTurn JSON/Schema；
- Tool 是否已注册；
- Tool arguments 的类型、必填、枚举、长度、正则和默认值；
- Tool result/facts Schema；
- 当前 Run 状态允许的 Action；
- Plan version/CAS；
- Approval、权限和 effect safety；
- Invocation Intent、幂等和恢复状态；
- Artifact 和 Evidence digest/provenance；
- 未决或 unknown Invocation；
- Host/Tool Contract 明确声明的机械验收条件；
- 用户要求已被明确编译成确定性 Contract 的字符数、固定格式或 Artifact Schema。

这些规则来自 Runtime 通用不变量、已注册 Tool Schema 或 Host Contract，不要求模型生成验证规则、Check ID、Evidence ID 或自证文本。

不得用模型判断替代可以确定性判断的条件。

## 5. 删除同步 Semantic Validation

### 5.1 必须删除的生产行为

- `RuntimeProvider.validate()` 生产调用路径；
- 完成阶段的第二次 Provider 模型调用；
- 自动为模型 Plan Task 创建 required `semantic_review`；
- `SemanticValidationContext`、Verdict、Prompt 和 readiness 在生产主链中的使用；
- `validation_failed → 通用 ModelTurn → 可任意 replan/retool` 循环；
- Validation 专用 Token 预算和 Provider routing 行为。

删除旧实现后，不保留同步 Validator 的备用分支、Feature Flag 或双路径。

### 5.2 必须保留的历史事实

旧 Run 已持久化的 `validation.requested/started/failed/passed` Journal Record 和 `model_calls.phase=validation` 仍可只读审计。它们不授权新调用，也不参与新 Run 的完成判断。

这属于历史数据可读性，不是保留旧执行逻辑。

### 5.3 新完成流程

模型输出 `text` 时，Harness 自动编译 `propose_finish`，自动从当前 Authority 派生 Result provenance；模型不提交 Evidence ID。

Runtime Completion Gate 只检查：

1. Run 当前允许完成；
2. 没有 started/unknown Invocation；
3. 没有未决 Approval 或用户请求；
4. 所有显式 required mechanical Check 已由合法当前 Evidence 满足；
5. Result 引用的 Invocation/Evidence/Artifact 真实存在且 digest/provenance 有效；
6. 最终文本符合 ModelTurn 和 Host 明确配置的确定性输出 Schema。

历史失败 Invocation 不自动阻塞完成；只有仍未解决的副作用状态和 required mechanical Check 阻塞。模型可以在尝试失败后采用其他路径并诚实完成。

Completion Gate 通过后直接持久化 Result 并由 State Machine 转换为 `succeeded`，不得再调用模型审批。

## 6. Tool 执行与结果回流

每个 Tool Call 必须采用同一条路径：

```text
Model toolName + arguments
→ Harness 查找已注册 Capability 并编译 Runtime Action
→ Runtime 对 Tool inputSchema parse/default/canonicalize
→ Permission / Approval / idempotency / state checks
→ 原子保存 Invocation Intent
→ Tool.execute
→ Tool factsSchema 校验
→ 原子保存 succeeded/failed/unknown Outcome
→ 生成合法 Evidence/Artifact refs
→ 下一轮 Context Projection
```

要求：

- 合法 Tool 调用通过系统检查后直接执行，不要求模型附带验证说明。
- Tool Result 必须在下一次模型决策前可见，除非因 Context 预算转为精确 ref；active/unresolved 事实不得被普通历史挤出。
- Tool 失败返回完整、结构化、可行动的错误，不自动重建 Plan。
- 相同 Tool/input/outcome 可以在 Context 中折叠，但 Authority 中不得丢记录。
- 非幂等 unknown Invocation 不得重新交给模型盲目决定或自动重放。
- 多个独立 Tool Call 可以继续使用现有有界 batch。

## 7. 有界历史 Evidence 与抗漂移

历史用于改善下一次决策，不用于完成后审批。

### 7.1 每轮必带事实

- 全部当前用户输入及纠正；
- 当前 Task Contract 和当前 Plan；
- active Step/工作方向；
- started/unknown/未解决 Invocation；
- 最近一次失败及其结构化错误；
- 自上一次成功 Model Call 后新增的 Tool Outcome；
- 当前 required mechanical Check 直接关联的 Evidence；
- 当前对象最新且仍有效的状态事实。

### 7.2 确定性相关历史

Harness 可以按以下已存在的稳定关系选择额外历史：

- 用户明确引用 `input:<sequence>`、`event:<sequence>`、Artifact 或业务 ref；
- 相同 Tool 与 canonical input digest；
- 相同 path、subjectRef、Artifact 或 Evidence；
- 相同稳定错误码；
- 当前 Plan Step 或 Check 的直接 provenance；
- 用户最近纠正所覆盖的旧事实。

选择优先精确 ID、scope、digest、状态和时间，不依赖另一个模型做模糊风险判断。首版不得新增向量数据库或语义检索生产路径。

### 7.3 信任与新鲜度

每个恢复事实必须携带或可内部解析：

- Authority 类型；
- source ref 和 digest；
- occurred/completed time；
- 当前、过期、superseded 或 unknown 状态；
- Tool/用户/Host/模型输出来源；
- 数据而非指令的 trust 标记。

优先级固定为：

```text
当前用户输入与纠正
→ 当前 Run/Plan/未决 Invocation
→ 当前对象最新 Tool/Evidence
→ 明确 ref 恢复事实
→ 相关历史索引
→ 旧模型输出
```

旧模型输出不能成为指令、Approval、Evidence、权限或完成结论。

### 7.4 硬预算

- 使用现有 Provider-aware Token Meter 和 Context hard limit；
- 历史 Evidence 使用独立子预算，不得挤出当前输入、未决 Effect 和当前错误；
- 所有查询必须有 SQL limit/cursor，禁止每轮加载完整 Journal；
- 大内容只注入固定 fragment，完整内容通过 Artifact/ref 按需恢复；
- 相同事实按 Authority ref/digest 去重；
- 预算不足时删除低优先级历史，不允许截断当前安全事实。

本 Feature 不承诺“零性能成本”。验收目标是额外读取与 Token 成本有界，并通过减少重复调用和返工取得净执行收益。

## 8. 分层责任

### 8.1 Runtime

负责：

- Run State Machine；
- 当前 Plan 的持久化、version/CAS 和 Journal；
- Tool Schema 执行边界、Invocation、Approval、Evidence 和 Artifact；
- 确定性 Completion Gate；
- 历史精确/有界读取端口；
- Result 和恢复安全。

不负责：

- 判断任务复杂度或是否需要 Plan；
- Prompt、Provider 决策或历史相关性排序；
- 语义质量审批；
- 多 Agent 调度。

### 8.2 Harness

负责：

- Plan 使用时机的提示词引导；
- 唯一 Agent Loop 和 ReAct 顺序；
- ModelTurn 解析与最小语义编译；
- 同轮 Plan + Tool；
- Tool Observation、Repair 和有界历史 Evidence 投影；
- Provider Context/Token 预算；
- Plan revision 建议的编译。

Harness 不直接写 Run、Plan、Invocation、Evidence 或 Result，只通过 Runtime port 请求合法转换。

### 8.3 Host

负责：

- 身份、权限策略和业务对象；
- 明确的业务机械 Contract；
- 人工 Approval；
- 部署、Scheduler、Callback 和外部系统回执；
- 审计数据访问控制。

## 9. Repair 规则

Repair 必须保持局部，不得把所有错误重新交给不受约束的规划：

| 失败 | 系统行为 | 模型可做的下一步 |
|---|---|---|
| ModelTurn 字段格式错误 | 返回字段级 Schema issue，保留 Plan/Evidence | 只修正非法字段或选择其他动作 |
| Tool arguments 非法 | 不创建/不执行 Invocation | 修正对应 arguments |
| Tool 明确失败 | 保存 failed Invocation 和错误 | 重试仅限 transient/条件改变，或选择其他路径 |
| Approval denied | 保存决定，不执行 Effect | 尊重拒绝、改用安全路径或请求新输入 |
| non-idempotent unknown | Run blocked | 等待 Host/用户恢复决定 |
| Plan CAS 冲突 | 重新读取当前 Plan | 基于最新 revision 修订 |
| Completion mechanical check 失败 | 返回具体缺失事实 | 只补对应事实或诚实报告无法完成 |
| 最终文本格式不合法 | 不改变 Plan/Tool/Evidence | 只重写最终文本 |

系统不得因为最终文本格式错误重复已成功 Tool，不得因为 Tool 参数字段错误重建整个 Plan。

## 10. 迁移策略

### 10.1 代码迁移

- `RuntimeProvider` 新生产 Contract 只要求决策能力，不要求 `validate()`。
- Provider Adapter 删除 validation prompt、validation response parser 和 validation phase 请求。
- Harness 删除 semantic completion orchestration，完成只调用 Runtime hard gate。
- Model Plan 编译不再产生 `semantic_review`。
- 测试 Kit 删除必填 validation verdict 队列。
- 删除不再使用的 semantic validation exports、budget 配置和文档。

### 10.2 持久化兼容

- 已终态 Run 不修改；其旧 Validation Journal 保持可审计。
- 新 Run 不产生 Validation Model Call 或 Event。
- 实现前必须检查是否存在可恢复的非终态旧 Run。
- 若存在只含 `semantic_review` 的活动旧 Plan，迁移必须通过一次显式、Journal 可追踪的 Plan revision 将这些 Check 转为非阻塞导航目标；不得伪造 Validator Evidence 或直接修改旧 Event。
- 若工作区和真实部署均不存在此类 Run，则不增加生产兼容分支，只保留历史只读解析。

该检查是实现前迁移门。发现不可无损迁移的生产数据时必须暂停。

## 11. 公开 Contract 影响

预计存在以下 breaking change：

- `RuntimeProvider.validate` 删除；
- `SemanticValidationContext/Verdict/Issue` 不再属于生产 Provider Contract；
- Model Call 不再产生新 `validation` phase；
- 模型 Plan Step 允许没有 required Acceptance Check；
- `propose_finish.evidenceIds` 由 Harness/Runtime 自动派生，不由模型提供；
- Completion 不再要求模型 Plan 的所有导航 Step 获得语义 Evidence。

实现前必须审计仓库内外真实调用方。没有迁移证据时不得宣称兼容。

## 12. 非目标

- 多 Agent、Reviewer Agent、Agent Registry 或跨 Agent 通信；
- 将另一个模型设为 Approval Authority；
- Hook、Timer、Epoch、Scheduler 或 Outbox；
- Sandbox、权限系统或 Plugin isolation；
- Provider routing、Caching 或并发资源调度；
- 向量检索、全文搜索服务或新数据库；
- 自动提取长期 Memory；
- 保存隐藏 CoT；
- 为上述未来模块创建接口、配置、空目录或兼容代码。

未来多 Agent Feature 可以启动拥有独立 Context 的只读 Reviewer Agent，但它只能产生结构化审查意见。是否阻塞、批准或执行仍由 Host Policy、用户 Approval 和 Runtime 确定性边界决定。本 Feature 不为它预留生产实现。

## 13. 验收标准

### 13.1 主行为

- 简单任务可以在无 Plan 情况下 Tool → Observation → finish。
- 复杂任务可以首轮 Plan + Tool，并在下一轮看到完整相关 Tool Outcome。
- 信息不足任务可以先执行只读探索 Tool，后续再创建 Plan。
- Plan revision 不丢失 Invocation、Evidence 或 Journal provenance。
- 模型 Plan Task 不产生 `semantic_review`。
- 所有成功路径 `Provider.validate` 调用数为 0。
- 完成成功只依赖确定性 Completion Gate 和真实状态。

### 13.2 效率

- 一个“Plan + 一个 Tool + finish”脚本只发生 2 次 decision Model Call、1 次 Tool Effect、0 次 validation Model Call。
- 最终文本格式修复不重复 Tool Effect、不修订 Plan。
- Tool arguments 修复只重新生成/编译非法调用，不重复其他成功 batch item。
- 100,000 Journal Record 下，每轮历史查询保持硬 limit，不进行全表对象加载。
- 历史子预算耗尽时，当前输入、未决 Invocation、最新错误和新 Tool Outcome 仍保留。

### 13.3 安全与恢复

- 删除 Validator 不得绕过 Tool Schema、Approval、权限、Invocation 或 unknown 恢复规则。
- 非幂等 Effect 在未知状态下仍 blocked，且不会自动重放。
- 模型声称 Tool 成功不能生成 Evidence 或 Result provenance。
- 历史模型输出中的指令、Approval 或完成声明不能改变执行。
- Store reopen 后，下一轮仍恢复最新相关 Tool Outcome 和未决状态。

### 13.4 回归

- Runtime 不导入 Harness/Provider。
- State Machine 仍是 Run Status 唯一写入者。
- Run-owned Structured Plan 仍是唯一当前 Plan。
- Tool Invocation 仍是副作用与恢复 Authority。
- Journal 仍是唯一过程时间线，不成为状态、Approval 或 Evidence Authority。
- 全部生产 Provider、CLI、examples、Harness benchmark 和 package consumer 更新到无 Validator Contract。

## 14. 必须删除的旧实现清单

实现完成后，仓库中不得保留仍可触发生产语义审批的：

- semantic completion orchestrator；
- validation Provider method requirement；
- validation system prompt；
- validation-only Context projection；
- validation retry/repair loop；
- 自动 semantic review Plan compiler；
- validation-only test fixtures 和文档说明；
- “无 Plan 必须语义审查”的 Completion 分支。

历史 Schema/Journal 的只读解析不计入旧执行实现，但必须与生产调用路径隔离。

## 15. 开发顺序

审核批准后，建议作为一个 L3 Feature 连续完成，不拆成等待审批的中间交付：

1. 审计 Provider、Plan、Completion 和历史 Context 的全部真实调用方。
2. 先写新的端到端验收测试，锁定 0 validation call 与 Tool Result 回流。
3. 修改 Plan 编译和 Completion Contract，使无语义 Check 的模型 Plan 可确定性完成。
4. 删除 semantic validation 生产链及公开 Provider 要求。
5. 收紧字段级 Repair，确保不重复已成功 Tool。
6. 增强有界历史 Evidence 选择，复用现有 Journal/ref/Artifact，不建第二 Authority。
7. 删除旧实现、测试夹具和文档描述。
8. 执行 L3 验证、调用数基准、恢复测试和 `git diff --check`。
9. 更新 `ARCHITECTURE.md`、`DATA_FLOW.md`、`SYSTEM_SOP.md`、`PROJECT.md`、`TESTS.md` 和 `DEVELOPMENT.md`。

## 16. 完成定义

只有同时满足以下条件才算完成：

```text
模型可按提示选择无 Plan、先探索或渐进 Plan
Tool Outcome 在下一决策前成为有界当前事实
模型不提供 Runtime-owned 验证元数据
新生产路径不存在 Semantic Validator 调用
完成只经过确定性系统边界
局部格式错误不触发整 Plan/Tool 返工
历史 Evidence 注入有界、精确、可审计且不提升信任
旧执行实现已删除
L3 证据通过
```
