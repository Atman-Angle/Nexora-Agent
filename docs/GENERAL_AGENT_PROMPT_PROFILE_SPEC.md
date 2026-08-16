# Nexora 通用 Agent Prompt 与 Host Profile Spec

状态：`DRAFT / REVIEW_REQUIRED`

Feature mode：`PLAN`

建议 Feature：`general-agent-prompt-profile`

建议 Owner：`@nexora/harness`，Host Application 提供 Profile；`@nexora/runtime` 仅提供既有确定性 Authority 与通用审计端口

风险等级：`L3`

文档日期：2026-08-16

本文档定义 Nexora 通用 Agent Prompt、Host Policy、Agent Profile、Provider Transport 和当前执行事实之间的边界，以及下一轮 Prompt 优化所需的 Contract、迁移和验收。本文档获得明确批准前，不授权修改 `DEVELOPMENT.md`、生产代码、公开 API 或持久化 Schema。

## 1. 决策摘要

Nexora 不在 Runtime 或通用 Harness 中内置“程序员”“研究员”“客服”“运维”等具体角色。

职责固定为：

```text
Runtime
→ 确定性状态、权限、Approval、Invocation、Evidence、恢复与完成

Harness
→ 通用 Agent Loop、通用行为内核、Prompt 编译、Context 投影与 Provider 协议

Host
→ 产品场景、业务 Policy、Profile 注册与选择、可用 Tool 和业务验收

Agent Profile
→ 角色目标、领域方法、默认策略、沟通与输出偏好
```

目标 Prompt 不再由一组固定自然语言段落直接拼接，而由 Harness 的通用 Prompt Compiler 从稳定内核、Host Policy、Agent Profile、项目规则、当前 Runtime 状态和真实 Tool Contract 编译得到。

```text
稳定通用内核
+ Host Policy
+ 当前 Agent Profile
+ Host 认可的 Project Instructions
+ 当前用户输入与纠正
+ Task Contract / Plan / Evidence / Repair 状态
+ Provider Transport Profile
+ 真实 Tool JSON Schema
→ 本轮 Provider Request
```

Profile 只能影响“模型如何工作和表达”，不能影响“系统允许什么、事实是什么、是否已经完成”。Profile 不是权限、Approval、Evidence、Run Status、Tool Result 或 Completion Authority。

Prompt Compiler 还必须优化 Provider-native prompt caching：稳定内容形成最长可复用前缀，当前任务状态和每轮变化内容后置；相同 kernel、Host Policy、Profile、Project Policy、Tool Contract 和 Provider Transport 的连续 Model Call 应尽可能复用相同 Token 前缀。缓存优化不得改变指令优先级、Context 完整性、Tool Schema 或安全边界。

## 2. 问题与现实基线

当前 Harness 已具备以下正确基础：

- 用户原始输入保持最高任务语义权威，Task Contract 和 Plan 不能削弱用户要求；
- 简单任务可直接行动，复杂任务可选择 Plan，信息不足可先只读探索；
- Tool Outcome 在下一轮成为 Observation；
- Memory、检索内容和外部数据被视为不可信数据；
- Completion 依赖 Runtime 确定性 Gate，不再依赖同步语义 Validator；
- Repair Context 已区分非法 Action、Tool failure、Approval denied 和 completion blocked；
- Provider Context 已具备有界 Token 预算和历史恢复能力。

当前缺口是：

1. `DECISION_PROMPT_LAYERS` 是固定通用段落，除 finalization 外缺少按任务语义、执行阶段、失败类型、Host 场景和 Provider 能力进行的显式组合。
2. Prompt 主要表达抽象原则，未形成清晰、短小、可逐轮执行的 Observe → Decide → Act → Verify → Finish 协议。
3. 通用 Prompt 未明确区分 inquiry、diagnose、change、review、research 等请求语义，模型可能把问题误当成修改授权，或把明确执行请求降级为只给建议。
4. Prompt 要求模型按 Task Contract 和 Evidence 判断完成，但 Provider 工作上下文没有稳定提供完整的需求清单、required mechanical checks 和当前有效 Evidence 摘要。
5. 原生 Tool 描述主要使用 `purpose`，已有的 `useWhen`、`avoidWhen`、`nonGoals`、effect 和 produces 没有完整进入 Provider-native Tool Contract。
6. 原生 Tool 参数 Schema 从 `inputExample` 推断，不能准确表达 required、enum、union、长度、正则、默认值和 additional properties 约束。
7. 同一请求同时存在原生 function calling 和 JSON `toolCalls` 表达，模型面对双 Tool 协议，增加格式漂移和非法参数概率。
8. `text` 同时承担普通说明和完成提议，完成意图缺少显式判别字段。
9. 具体 Host 应用只能自行包裹或替换 Prompt，缺少版本化、可验证、可恢复的 Agent Profile Contract。
10. Profile、Prompt 版本和最终编译 digest 没有成为每次 Model Call 的标准审计 provenance，恢复时可能静默使用不同策略。
11. Prompt 变更缺少专门的跨 Provider 行为基准，单元测试通过不能证明任务完成率、调用效率或错误完成率没有回归。
12. 当前请求会因 finalization、动态字段位置、Tool 顺序或非规范化序列化改变早期 Token，缺少 cache-stable prefix Contract 和 Provider cached-token 可观测性，无法证明连续决策是否有效利用 LLM Prompt Cache。

## 3. 产品结果

开发完成后：

1. Runtime 不导入、不解释、不选择任何 Prompt、角色或 Profile。
2. Harness 只包含通用 Agent 行为内核和通用 Prompt Compiler，不硬编码具体职业或领域角色。
3. Host 可以注册并选择版本化 Agent Profile；未提供 Profile 时使用中性的通用 Agent 行为。
4. 同一个 Harness 可被 Coding、Research、Operations 或其他 Host 使用，而不产生第二套 Agent Loop。
5. Profile 可以定义领域方法、默认工作流和沟通要求，但不能授予权限、绕过 Approval 或声明完成。
6. 当前任务、环境、Repair 和 finalization 通过动态 Runtime Directive 注入，不要求改变稳定 System Prompt 前缀。
7. 原生 Tool 获得真实 JSON Schema 和完整的决策语义；不再从示例猜测参数 Contract。
8. Provider 使用单一明确的 Action Transport；原生 function calling 和 JSON-only fallback 不在同一请求中竞争。
9. 模型使用显式 ModelTurn action 表达继续、请求输入或完成，不再用任意 `text` 隐式触发 finish。
10. 每次 Model Call 都可审计所用 kernel、Profile、Host Policy、Project Instructions、Tool Contract 和最终 Prompt digest。
11. Prompt 优化由真实 Provider A/B 结果证明，不以“提示词更长”或单个成功样本作为完成证据。
12. 相同策略与 Tool 集合的连续 Model Call 保持最长稳定前缀；支持 Prompt Cache 的 Provider 能报告实际缓存 Token、写入 Token 和命中状态，并通过基准证明命中率相对旧实现提高。

## 4. 核心原则

### 4.1 Runtime 对 Prompt 和角色无感知

Runtime 继续只负责：

- Run State Machine；
- Run-owned Structured Plan；
- Tool Invocation、Attempt、Approval 和 effect safety；
- Evidence、Artifact 和 Result provenance；
- durable Journal 和恢复；
- deterministic Completion Gate；
- 通用 Model Call / Context Manifest 审计端口。

Runtime 不得：

- 定义或拼接 System Prompt；
- 存储可执行角色逻辑；
- 判断当前角色是程序员、研究员或其他业务身份；
- 根据 Profile 改变权限、Tool Schema、Approval 或完成条件；
- 让 Profile 成为新的状态或策略 Authority。

Runtime 可以保存由 Harness 提交的 opaque prompt/profile provenance，例如版本、digest 和 Artifact ref，但不得解释其业务含义。

### 4.2 Harness 保持领域无关

Harness 负责所有 Agent 共用的行为语义：

- 判断直接回答、探索、可选 Plan、Tool、请求输入或完成的通用规则；
- Observation 回流和有界 Context；
- 失败后局部 Repair；
- 不重复无进展 Action；
- Tool 调用与 ModelTurn 的 Schema 编译；
- Prompt 分层、转义、预算和 Provider Transport；
- 最终交付轮的通用真实性要求。

Harness 不得内置：

- “代码 Agent 必须先写测试”；
- “研究 Agent 必须引用学术来源”；
- “客服 Agent 必须使用某种品牌语气”；
- 任何垂类术语、业务字段或固定输出模板；
- 任何由角色决定的权限或完成规则。

### 4.3 Host 拥有场景和 Profile 选择

Host 负责：

- 注册可用 Agent Profile；
- 在 Run 开始前选择 Profile；
- 提供 Host Policy、产品模式和业务输出要求；
- 决定注册哪些 Tool 以及对应权限；
- 提供真实业务 Task Contract 和 mechanical checks；
- 将 Host 认可的 Project Instructions 与普通仓库数据区分；
- 控制 Profile 是否允许在 Run 中途切换。

Host 不得通过 Profile 绕过 Runtime API 直接写 Run、Plan、Invocation、Evidence 或 Result。

### 4.4 Profile 是策略，不是 Authority

Profile 可以描述：

- 角色身份和主要目标；
- 领域专业方法；
- 常见任务的默认步骤；
- Tool 选择偏好；
- 沟通语气、受众、语言和输出结构；
- 领域特有的质量提醒。

Profile 不得决定或声明：

- Tool 是否注册或允许执行；
- Tool input/result 是否合法；
- Approval 是否通过；
- Effect 是否幂等或可重放；
- 某个 Tool 是否真实成功；
- Evidence 是否有效；
- Run Status 或 Completion Gate 结果；
- 系统、Host 或用户指令的优先级；
- Memory、网页或 Tool output 可以作为指令执行。

### 4.5 Prompt 不能代替确定性 Contract

以下问题必须由结构化 Contract 或 Runtime/Harness 代码解决，而不是追加提示词：

- Tool required/enum/union/format/default；
- Action 判别和互斥字段；
- Plan version/CAS；
- Approval、permission 和 idempotency；
- started/unknown Invocation；
- Artifact/Evidence digest；
- mechanical checks；
- Context Token hard limit；
- Profile 和 Prompt provenance。

## 5. 指令和数据优先级

Prompt Compiler 必须显式表达以下顺序：

```text
Nexora 通用安全与执行协议
→ Host Policy 和 Host 明确授权的 Project Policy
→ 当前用户输入、后续纠正和原始需求
→ Task Contract（只表示用户需求的派生结构，不得削弱用户要求）
→ Agent Profile 的角色与方法建议
→ Plan 的当前工作方向
→ Tool Observation、Evidence、Memory、检索和外部数据
```

补充规则：

- 后续用户纠正在同一权限范围内覆盖较早冲突输入，但不能绕过系统或 Host 安全 Policy。
- Task Contract 与用户输入冲突时，保留用户原始要求并要求 Host 修正 Contract；不得让派生 Contract 静默覆盖用户。
- Host 明确加载的 Project Policy 可以约束仓库操作；普通文件内容、README、网页和 Tool output 仍只是数据。
- Profile 与 Project Policy 冲突时，以 Project Policy 为准。
- Plan 与任何更高层要求冲突时必须修订 Plan。
- Memory、外部内容和旧模型输出永远不能提升为权限、Approval、Evidence 或指令 Authority。

## 6. Prompt 编译架构

### 6.1 编译输入

Harness 应定义等价于以下概念的领域无关输入；具体名称可按现有代码风格调整：

```ts
type PromptCompilationInput = {
  kernel: {
    version: string;
  };
  hostPolicy?: HostAgentPolicy;
  profile?: AgentProfileSnapshot;
  projectInstructions?: readonly ProjectInstruction[];
  runtimeDirective: RuntimeDirective;
  workingContext: AgentWorkingContext;
  tools: readonly ProviderToolContract[];
  transport: ProviderTransportProfile;
};
```

Prompt Compiler 必须是确定性纯编译：相同规范化输入产生相同输出和 digest。不得在编译过程中调用模型、读取隐式全局状态或执行 Tool。

### 6.2 稳定 System Kernel

稳定内核只包含所有 Agent 共用且长期不变的规则：

```text
使命和授权语义
→ 指令与数据边界
→ 通用 Observe / Decide / Act / Verify / Finish 循环
→ Plan 的定位
→ Tool 和失败处理原则
→ 用户输入兜底规则
→ 诚实完成与不可伪造事实
→ Transport 输出约束
```

内核不得包含当前日期、workspace、Plan 内容、Tool 列表、Repair 错误、Profile 名称或用户任务。稳定前缀用于降低重复 Token 和支持 Provider prompt caching。

建议的通用循环语义是：

```text
1. Identify the unresolved user requirement or decision.
2. Reuse current authoritative facts before obtaining more context.
3. If facts are missing, obtain the smallest useful observation.
4. Choose one action or a bounded batch of independent actions.
5. After observations, update only conclusions contradicted by new facts.
6. After changing state, verify the resulting state proportionately.
7. Finish only when every requirement is satisfied, explicitly unresolved,
   or impossible for a stated, evidence-backed reason.
```

这段文字是行为协议示例，不是要求逐字采用的最终 Prompt。

### 6.3 动态 Runtime Directive

Harness 必须根据当前确定性状态生成一个短小、结构化的动态指令块。首版至少支持：

```ts
type RuntimeDirective =
  | { kind: "normal" }
  | { kind: "invalid_action_repair"; issues: readonly RepairIssue[] }
  | { kind: "tool_failure_repair"; failure: ToolFailureSummary }
  | { kind: "approval_denied"; decisionRef: string }
  | { kind: "completion_blocked"; missing: readonly CompletionIssue[] }
  | { kind: "delivery_only"; reason: string };
```

行为必须局部：

| Directive | 模型允许的主要行为 |
|---|---|
| `normal` | 直接回答、探索、Plan、Tool、请求输入或完成 |
| `invalid_action_repair` | 只修正非法字段或选择另一个合法 Action |
| `tool_failure_repair` | 根据完整错误和最新状态决定有限重试或替代路径 |
| `approval_denied` | 尊重拒绝，不重复或规避同一受保护 Effect |
| `completion_blocked` | 只补充明确缺失的机械事实，或诚实交付未完成边界 |
| `delivery_only` | 不再调用 Tool、修改 Plan 或请求输入，只生成最终交付 |

Directive 属于 Harness 根据 Runtime 状态生成的控制信息，不允许 Profile 覆盖。

### 6.4 Agent Profile

首版 Profile Contract 建议为：

```ts
type AgentProfile = {
  schemaVersion: 1;
  id: string;
  version: string;
  role: {
    identity: string;
    objective: string;
    expertise?: readonly string[];
  };
  strategy?: {
    principles?: readonly string[];
    workflows?: readonly {
      when: string;
      steps: readonly string[];
    }[];
    toolGuidance?: {
      prefer?: readonly string[];
      avoid?: readonly string[];
    };
  };
  communication?: {
    language?: string;
    audience?: string;
    tone?: string;
    outputGuidance?: readonly string[];
  };
};
```

要求：

- 所有字符串 trim 后非空并有单项及总字节上限；
- `id + version` 在一个 Host 注册表内唯一；
- Profile 注册时计算 canonical digest；
- Profile 不携带任意 Tool Schema、权限、Approval 或 Completion 配置；
- `toolGuidance` 只允许引用 capability 名称或稳定类别，引用未注册 Tool 时忽略偏好而不是创建 Tool；
- Profile 缺失时编译中性通用 Agent，不隐式选择 Coding Profile；
- Profile 内容进入明确的 `strategy_only` 区域；
- 首版不从网页、Tool output 或 Memory 自动安装 Profile；
- Host 若允许用户自定义 Profile，必须标记来源并保持低于 Host Policy 的优先级。

示例 Coding Profile 可以要求理解仓库、遵循既有约定、最小修改和比例验证；Research Profile 可以要求区分一手来源、事实与推断并标记时效性。这些内容不得进入 Harness 通用内核。

### 6.5 Host Policy 与 Project Instructions

Host Policy 负责稳定产品规则，例如：

- 当前交互是只读分析还是允许修改；
- 是否允许外部网络或外部消息；
- 用户沟通和人工决策要求；
- Host 特有的敏感数据处理规则；
- 产品级输出 Contract。

Project Instructions 必须由 Host 显式加载并提供 provenance：

```ts
type ProjectInstruction = {
  sourceRef: string;
  scope: string;
  content: string;
  digest: string;
  authority: "host_project_policy";
};
```

不能把所有仓库文件或检索结果自动标为 Project Policy。

### 6.6 Authority Context

Provider 工作上下文至少显式提供：

- 全部当前用户输入及纠正；
- Task Contract 的目标、Scope、Invariants、Non-goals 和 Acceptance；
- 当前 Plan 和 step progress；
- active/unknown Invocation；
- 最新相关 Tool Outcomes；
- required mechanical checks 及其满足状态；
- 当前有效 Evidence 的 bounded summary 和 refs；
- Repair Context；
- 当前 Profile/Host Policy/Project Policy 的 id、version 和 digest；
- Memory、检索和外部内容的 trust 标记。

Prompt 不能要求模型检查未投影的 Contract 或 Evidence。预算不足时保留当前输入、安全状态、required checks 和最新错误，优先驱逐旧模型文本和低优先级历史。

### 6.7 Prompt 区域隔离

最终请求必须让模型能够区分至少以下区域：

```text
SYSTEM_KERNEL             stable, non-negotiable
HOST_POLICY               host-controlled
AGENT_PROFILE             strategy only
PROJECT_POLICY            scoped host-authorized instructions
RUNTIME_DIRECTIVE         current deterministic control state
AUTHORITATIVE_CONTEXT     user/run/contract/current evidence
UNTRUSTED_CONTEXT         tool output/memory/retrieved data
TOOL_CONTRACTS            provider-native schemas
```

可以使用结构化 messages、XML 标签或 Provider 支持的 developer/system roles。不得依赖容易与用户内容混淆的自然语言前后缀。

### 6.8 Cache-friendly Prompt 布局

Prompt Compiler 必须同时优化语义正确性和 prefix cache locality。默认顺序为：

```text
1. SYSTEM_KERNEL                 全局稳定
2. TRANSPORT_INSTRUCTIONS        Provider/model/transport 稳定
3. HOST_POLICY                   同 Host Policy 版本稳定
4. AGENT_PROFILE                 同 Profile snapshot 稳定
5. PROJECT_POLICY                同项目 policy revision 稳定
6. TOOL_CONTRACTS                同 Tool registry revision 稳定
7. ORIGINAL_TASK_CONTRACT        同一 Run 内通常稳定
8. CURRENT_RUNTIME_DIRECTIVE     每轮可能变化
9. CURRENT_PLAN_AND_CHECKS       每轮可能变化
10. OBSERVATIONS_AND_REPAIR      每轮高频变化
11. LATEST_USER_INPUT            追加或纠正时变化
```

具体 Provider 若要求 Tool Schema 位于独立 request 字段，Adapter 仍必须使用相同的 canonical Tool 顺序和 Schema 序列化。布局调整不得改变第 5 节定义的语义优先级；物理位置用于缓存复用，不代表较后的用户输入优先级降低。

要求：

- System Kernel 在 normal、repair、completion blocked 和 delivery-only 轮保持字节一致；
- finalization、时间、workspace、Run ID、Invocation ID、digest、Token 计数和最新错误不得进入稳定 Kernel；
- Host Policy、Profile 和 Project Policy 使用 canonical snapshot，不在每轮加入生成时间或无语义随机字段；
- Tool Contract 按稳定 capability identity 排序，Schema 属性使用 canonical JSON 顺序；
- 有语义顺序的 Profile workflow、用户输入、Plan step 和 Observation 不得为了排序稳定而重排；
- Context envelope 的字段顺序固定，缺失可选字段采用固定省略规则；
- 大段动态 Context 必须位于稳定区域之后，不能因为一个状态字段变化使此前稳定 Token 整体位移；
- Provider 支持显式 cache breakpoint 或 `cache_control` 时，由 Adapter 在稳定区域末端设置，不把供应商字段泄漏进通用 Harness Contract；
- Provider 只支持自动 prefix caching 时，仍通过稳定 messages、稳定 Tool Schema 和动态内容后置提高命中概率；
- Prompt Cache 不得复用模型响应、跳过 Provider 调用或跳过 Runtime/Completion Gate；
- 缓存优化不得删除当前输入、required checks、unknown Invocation、最新错误或有效 Evidence；
- Host 必须能够因 Provider 数据保留策略、租户隔离或敏感任务关闭 Provider Prompt Cache hint。

Harness 应为编译结果提供稳定区域 manifest：

```ts
type PromptCacheLayout = {
  version: 1;
  stablePrefixDigest: string;
  stablePrefixTokens: number;
  stableSegmentDigests: readonly {
    kind: "kernel" | "transport" | "host_policy" | "profile" | "project_policy" | "tools";
    digest: string;
  }[];
};
```

`stablePrefixTokens` 必须使用本次请求相同的 Provider-aware Token Meter 计算，不得用字符数伪装成准确 Token。Provider 不支持精确 Meter 时必须标记 estimated。

## 7. Task 语义与授权

通用 Kernel 必须区分请求的行为授权：

| 用户意图 | 默认行为 |
|---|---|
| 询问、解释、比较 | 调研并回答；不自动修改状态 |
| 诊断、定位原因 | 获取证据并说明原因；除非用户同时要求修复，否则不修改 |
| 修改、实现、构建 | 自主完成实现、验证和交付 |
| Review、Audit | 只读检查并优先报告风险；不自动修复 |
| 等待、监控 | 使用 Host 提供的等待机制；状态未变化不是失败 |

这不是新增 Runtime 状态机。它是通用 Agent 对用户自然语言授权范围的行为协议。Host 可以显式提供任务模式；未提供时由模型根据用户原文判断，并在重大歧义无法通过只读事实消解时请求用户输入。

## 8. Tool Contract 与 Transport

### 8.1 真实 Tool Schema

Provider Tool Contract 必须来自已注册 Tool 的真实输入 Contract，而不是 `inputExample` 推断：

```ts
type ProviderToolContract = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  decision: {
    useWhen: readonly string[];
    avoidWhen: readonly string[];
    nonGoals: readonly string[];
  };
  effect: "read" | "write" | "execute";
  produces: readonly string[];
};
```

`inputExample` 可以作为例子保留，但不能充当 Schema Authority。

### 8.2 单一 Action Transport

每次 Provider Request 只能选择一种 Tool Transport：

```ts
type ProviderTransportProfile =
  | { kind: "native_tools"; promptCache?: ProviderPromptCachePolicy }
  | { kind: "json_actions"; promptCache?: ProviderPromptCachePolicy };
```

- `native_tools`：Tool Calls 只通过 Provider-native function calling 表达；正文不得再提交 JSON `toolCalls`。
- `json_actions`：不注册 Provider-native tools，模型按完整 JSON Schema 返回 Tool Action。
- Adapter 将两种 Transport 规范化为同一个内部 ModelTurn，不改变 Runtime Action 路径。
- 不允许同一请求同时把两套协议交给模型选择。

Prompt Cache Policy 是 Provider Adapter 能力，不是角色能力：

```ts
type ProviderPromptCachePolicy =
  | { mode: "disabled" }
  | { mode: "automatic" }
  | { mode: "explicit_breakpoints" };
```

- `disabled` 不发送任何 Provider cache hint，但仍保持确定性布局；
- `automatic` 依赖 Provider 自动 prefix caching；
- `explicit_breakpoints` 只用于明确支持并已实现对应语义的 Provider；
- 未识别的 Provider 不得猜测或发送供应商私有缓存字段；
- Profile 不能打开、关闭或配置 Prompt Cache。

### 8.3 显式 ModelTurn

建议将 ModelTurn 迁移为判别联合：

```ts
type ModelTurn =
  | { action: "continue"; plan?: ModelPlanUpdate; toolCalls: ModelToolCall[] }
  | { action: "request_input"; question: string; reason: string }
  | { action: "finish"; text: string };
```

Provider-native Tool Call 可以由 Adapter 合并进 `continue`。同轮 Plan + Tool 仍允许。

约束：

- `finish` 不允许携带 Tool、Plan 或 input request；
- `request_input` 不允许同时执行 Tool；
- `continue` 必须包含 Plan update 或至少一个 Tool Call；
- 普通进度说明不触发完成；
- 最终格式修复不得重复已成功 Tool；
- Runtime 仍对 `finish` 执行 Completion Gate，模型 action 只是完成提议。

## 9. Profile 生命周期、恢复与审计

### 9.1 Run 开始

Host 在 Run 开始前解析 Profile，并向 Harness 提供不可变 snapshot：

```text
profile id
+ version
+ canonical content
+ digest
+ source provenance
```

Harness 不按 `id` 隐式读取全局最新版本，避免恢复时行为漂移。

### 9.2 Run 中途变更

默认不允许静默切换 Profile。若 Host 业务确实支持切换：

- 必须由明确用户或 Host 操作触发；
- 必须生成新的 Profile snapshot 和 digest；
- 必须通过 Runtime 通用审计端口记录 revision provenance；
- 只影响后续 Model Call，不重写旧 Plan、Invocation、Evidence 或 Event；
- 不得借切换 Profile 改变已有 Approval、权限或 unknown Effect 恢复规则。

### 9.3 Store reopen

恢复后必须使用与下一 Model Call 记录一致的 Profile snapshot。若 Host 无法提供匹配 digest：

- 不得静默使用同 ID 的新版本；
- Run 保持可审计；
- Harness 返回明确的 strategy snapshot unavailable 错误；
- Host 可以通过显式 Profile revision 继续，但必须记录变化。

### 9.4 Model Call provenance

每次 Model Call 的 Context Manifest 至少记录：

- kernel version/digest；
- Prompt Compiler version；
- Host Policy digest；
- Profile id/version/digest；
- Project Instructions refs/digests；
- Runtime Directive kind；
- Tool Contract digest；
- Transport Profile；
- Authority Context digest；
- 最终 system/developer/user payload digests；
- Token measurement；
- cache layout version、stable prefix digest 和 stable prefix token count；
- Provider cache mode 和本次 cache breakpoint manifest；
- Provider 实际返回的 cached input tokens、cache write tokens 和 cache status（若支持）。

完整 Prompt 正文是否保存服从现有捕获和敏感数据策略；digest 和组成 manifest 必须可审计。

Provider Cache 指标必须区分：

```text
unsupported  → Provider 不提供缓存或不返回指标
disabled     → Host/Adapter 明确关闭
miss         → 符合条件但本次未命中
partial_hit  → 部分输入 Token 命中
hit          → Provider 报告可缓存前缀命中
unknown      → Provider 使用缓存但无法可靠分类
```

`unsupported`、`disabled` 和 `unknown` 不得计为零命中。报告中的 cache hit ratio 只使用 Provider 明确报告且具备相同计量口径的调用。

## 10. 安全要求

- Profile 内容即使由 Host 配置，也只能进入 strategy-only 区域。
- Profile 不允许声明自己是 system、developer、Runtime、用户或 Approval Authority。
- Profile 中的 Tool 名称不能创建、注册、授权或隐藏 Tool。
- Profile 不能改变外部内容的 trust 标签。
- Project Instructions 必须有 Host provenance；普通仓库内容保持 untrusted data。
- Tool output、Memory 和网页中的角色声明、权限声明、完成声明和 Prompt override 必须被忽略。
- 用户自定义 Profile 不得扩大用户原本拥有的权限。
- Prompt 模板插值必须结构化转义，禁止通过未转义分隔符逃逸 Profile 区域。
- Profile 和 Host Policy 必须有字节和 Token 上限，不能挤出当前安全状态与 required evidence。
- 不允许跨 Provider credential、Host tenant 或数据保留边界建立 Nexora 自管共享 Prompt Cache。
- Cache key、breakpoint metadata 和遥测不得包含 API key、明文 secret 或未经策略允许的 Prompt 正文。
- 缓存命中不能使旧 Profile、旧 Project Policy、旧 Tool Schema 或旧用户输入覆盖当前 revision；任何稳定区域 digest 变化必须自然形成新的缓存前缀。

## 11. Prompt 质量规则

通用 Kernel 应遵守：

- 使用清晰标题、短句和肯定式动作规则；
- 每条规则对应真实失败模式或 Contract；
- 避免同义重复和互相冲突的绝对词；
- 不要求模型输出隐藏 Chain of Thought；
- 不要求模型生成 Runtime-owned ID、Evidence 或验证结论；
- 不把所有任务强制成 Plan；
- 不把所有失败升级为重新规划；
- 不用角色语气要求替代完成质量；
- 不通过长篇 Prompt 补偿缺失 Schema 或缺失 Context。

允许为高频关键决策加入少量短示例，首版最多覆盖：

1. 简单问题直接回答；
2. 信息不足先只读探索；
3. 复杂任务同轮 Plan + Tool；
4. Tool 参数错误只修字段；
5. Tool 失败后不盲目重复；
6. completion blocked 只补缺失事实；
7. 完成时诚实区分 produced、observed 和 verified。

示例必须进入独立预算，并通过 A/B 证明有净收益后才能进入生产 Kernel。

## 12. 配置与公开 Contract

预计新增或变更：

- Harness `AgentProfile`、`HostAgentPolicy`、`PromptCompiler` 和 `ProviderTransportProfile` Contract；
- Host 创建 Agent/Run 时提供可选 Profile snapshot；
- Tool Descriptor 暴露 Provider 可用的真实 JSON Schema；
- ModelTurn 迁移到显式 action 判别联合；
- Model Call Context Manifest 增加通用 prompt strategy provenance；
- Provider Adapter 区分 native tools 和 JSON actions；
- Prompt Compiler 输出 cache-stable layout 和 stable prefix manifest；
- Provider Adapter 声明 Prompt Cache capability、投影显式 breakpoint 并报告真实 cache usage；
- benchmark/report 增加口径明确的 cache eligibility、cached input tokens、cache write tokens 和 hit status；
- finalization/repair 不再通过修改稳定 System Prompt 直接实现。

不得新增：

- Runtime `CodingProfile`、`ResearchProfile` 或其他角色类型；
- Runtime Profile Registry；
- Profile 驱动的权限、Approval 或 Completion 分支；
- 第二套 Run、Plan、Evidence 或 Result Authority；
- 为每个角色复制 Agent Loop；
- 自动从网络下载和执行 Profile；
- 用另一个模型动态生成生产 System Prompt；
- Nexora 自建跨 Run、跨 Host 或跨租户的共享 Prompt 正文缓存。

## 13. 迁移策略

### 13.1 调用方审计

实现前必须审计：

- 所有生产 `RuntimeProvider` 和 Provider Adapter；
- CLI、examples、research-agent 和 benchmark Host；
- 外部 package consumer fixtures；
- 所有直接断言 Prompt 字节或 ModelTurn 形状的测试；
- durable Model Call / Context Manifest 读取方；
- 当前 Tool Descriptor 和 Zod Schema 的真实导出能力。

### 13.2 分阶段迁移

建议在同一 L3 Feature 内按以下顺序连续完成：

1. 为现有 Prompt 和 Provider wire 建立不可变 baseline 与真实 Provider 对照。
2. 增加 Prompt Compiler 和中性 Kernel，先保持现有 ModelTurn 行为等价。
3. 增加 Host Policy、Profile snapshot 和 provenance，不提供内置具体角色。
4. 补全 Authority Context 中的 Task Contract、checks 和 Evidence summary。
5. 将 Tool Contract 改为真实 JSON Schema 和完整决策元数据。
6. 按 Provider 能力拆分 native tools / JSON actions Transport。
7. 迁移显式 ModelTurn action 并删除旧双协议生产路径。
8. 将 Repair、finalization 和环境状态移入动态 Directive。
9. 固定 System/Host/Profile/Project/Tool 的 canonical 顺序，加入 cache layout manifest 和 Provider cache usage telemetry。
10. 删除旧固定 Prompt 拼接、示例推断 Schema 和隐式 text-finish 实现。
11. 执行 L3 回归、Prompt 注入、Prompt Cache 和跨 Provider A/B。

迁移完成后不得保留可触发旧双协议或旧隐式完成语义的 Feature Flag。历史 Model Call payload 保持只读审计。

### 13.3 兼容性

- 已终态 Run 不修改。
- 非终态 Run 的下一次模型调用可以使用新 Prompt Compiler，但必须保留旧执行事实并记录 strategy revision。
- 外部自定义 Provider Adapter 是公开 Contract breaking change，必须提供迁移说明和编译期错误。
- Profile 缺失保持中性通用行为，不用具体角色作为兼容默认值。
- 历史 Prompt digest 不要求重新生成或伪造新的组成 manifest。

## 14. 验收标准

### 14.1 边界

- Runtime package 不包含 Prompt、Profile、具体角色或 Provider 导入。
- Harness 不包含 Coding、Research、Customer Support 等具体 Profile 内容。
- Host 可用相同 Harness 注册两个不同 Profile，并获得不同策略 Prompt。
- 无 Profile Host 仍能完成通用直接回答、探索、Tool 和完成流程。
- Profile 无法增加 Tool、绕过 Approval、伪造 Evidence 或改变 Completion Gate。

### 14.2 Prompt 编译

- 相同规范化输入产生字节一致输出和一致 digest。
- System Kernel 在正常、Repair 和 delivery-only 轮保持稳定前缀。
- Profile、Host Policy、Project Policy、Runtime Directive 和不可信数据有不可混淆边界。
- Profile 内容包含伪造 system/tool/completion 指令时不能改变 Authority 行为。
- Token 预算不足时不会驱逐当前用户输入、unknown Invocation、required checks 或最新错误。

### 14.3 Tool 与 ModelTurn

- Provider 收到的 Tool required、enum、union 和 additional properties 与 Runtime 输入 Contract 一致。
- `inputExample` 不再是 Schema Authority。
- native Provider 请求不同时要求 JSON `toolCalls`。
- JSON-only Provider 不注册 native tools。
- 普通文本不能隐式触发 finish。
- final text 格式修复不重复 Tool Effect。
- invalid arguments repair 只修复非法调用，不重复同 batch 已成功项。

### 14.4 恢复与审计

- Model Call 可追踪 kernel、compiler、Profile、Host Policy、Project Policy、Tool Contract、Transport 和最终 payload digest。
- Store reopen 后使用同一 Profile digest。
- Profile 内容缺失或 digest 不匹配时显式失败，不静默升级版本。
- 显式 Profile revision 不改变旧 Invocation、Evidence 或 Result provenance。

### 14.5 行为基准

至少覆盖以下任务集：

- 无 Tool 的直接问答；
- 只诊断不修复；
- 简单单 Tool；
- explore-before-plan；
- Plan + batch reads + edit + verify；
- Tool 参数 Repair；
- transient 和 non-transient failure；
- Approval denied；
- completion blocked；
- 长 Context、Memory 和 Prompt injection；
- Coding 与 Research 两个 Host Profile；
- 无 Profile 中性 Host。

真实 Provider A/B 至少比较：

- 外部 grader 任务成功率；
- false success / premature finish；
- Tool argument rejection；
- 重复或未授权 Effect；
- 不必要 Plan 率；
- 可由 Tool 解决却请求用户输入的比例；
- Model Call、Tool Call、Token、耗时；
- Profile 指令遵循率；
- Prompt injection 越权率；
- 跨 Provider 方差。

同时记录：

- compiler-declared stable prefix tokens；
- Provider cache-eligible input tokens；
- cached input tokens；
- cache write tokens；
- hit/miss/partial/unsupported/disabled/unknown 分布；
- 可比较调用中的 cached-input ratio；
- Provider 报告的缓存相关费用或延迟变化（若提供）。

单个样本不能证明成功率改善。建议至少使用 3 个 Provider/model、每个代表任务 5 次重复，并保留旧 Prompt 的同任务对照。

### 14.6 Prompt Cache

- 相同 kernel/Host Policy/Profile/Project Policy/Tool registry/Transport 的连续轮具有相同 stable prefix digest。
- normal → repair → delivery-only 不改变 System Kernel digest。
- 仅 Observation、Repair、Plan progress 或最新输入变化时，变化发生在声明的动态边界之后。
- Tool 注册顺序不同但 canonical Tool Contract 相同时产生相同 Tool Contract digest 和稳定序列化。
- Profile、Project Policy、Tool Schema 或 Transport revision 变化时必须形成新的稳定前缀，不错误命中旧语义。
- 在支持并报告 Prompt Cache、达到 Provider 最低缓存 Token 门槛且处于有效 TTL 的真实 Provider 上，第二次及后续相同前缀调用必须观察到非零 cached input tokens；否则 Feature 不得宣称命中率提高。
- 新实现的可比较 cached-input ratio 必须高于旧 Prompt baseline；如果 Provider 只返回粗粒度指标，报告必须注明口径和不确定性。
- 缓存命中不得降低外部 grader 成功率、增加 false success、Action rejection、重复 Effect 或 Prompt injection 越权。
- 不支持缓存的 Provider 必须正常执行，且报告 `unsupported` 而不是伪造命中或失败。

## 15. 测试策略

本 Feature 风险为 L3，至少需要：

- Prompt Compiler 单元测试和 snapshot；
- cache-stable prefix、canonical segment ordering 和 dynamic-boundary snapshot 测试；
- Profile Schema、canonicalization、digest 和预算测试；
- Host/Profile/Project/Runtime Directive 优先级测试；
- Prompt boundary escaping 和 injection 测试；
- 两种 Provider Transport 的 wire contract 测试；
- 真实 Tool JSON Schema parity 测试；
- ModelTurn discriminated union 与字段局部 Repair 测试；
- Store reopen 和 Profile digest continuity 测试；
- Completion、Approval、unknown Effect 和 duplicate Effect 回归；
- CLI、examples、Host application 和 packed consumer 测试；
- benchmark report 对 Prompt/Profile/Transport 指标的真实性测试；
- Provider cached-token usage parser、unsupported/disabled/unknown 口径和费用字段测试；
- 全仓 typecheck、build、lint 和 tests；
- 至少一轮有旧基线的真实 Provider A/B，并在支持缓存的 Provider 上包含同一 stable prefix 的连续调用。

测试通过只是证据之一。完成还必须证明具体角色没有进入 Runtime/Harness，且旧双协议、示例 Schema 和隐式 text-finish 生产路径已删除。

## 16. 非目标

- 多 Agent、子 Agent、Reviewer Agent 或 Agent Registry；
- 自动选择“最优角色”的模型 Router；
- 让模型编写或修改自己的 System Prompt；
- Profile 市场、远程安装、签名分发或 Plugin 系统；
- 向量检索或新的 Memory 数据库；
- Provider routing、response caching 或并发资源调度；
- Nexora 自管的 LLM response cache、semantic cache 或跨安全域 Prompt 内容缓存；
- 用 Profile 表达业务数据库 Schema；
- 用 Profile 代替 Host Task Contract；
- 保存隐藏 Chain of Thought；
- 改变现有 Runtime Authority、Approval 或安全边界。

## 17. 必须暂停

开发中出现以下情况必须停止并请求决策：

- 需要让 Runtime 理解具体 Profile 或角色语义；
- Profile 需要改变权限、Approval、Tool effect 或 Completion Gate；
- 真实 Tool JSON Schema 无法从现有 Tool Contract 无损提供，需要改变公开 Tool 定义方式；
- 外部 Provider Adapter 无法迁移到单一 Transport；
- 非终态 Run 无法在保留审计的情况下切换 Prompt Contract；
- Prompt/Profile provenance 需要破坏性迁移；
- 提高缓存命中需要移动、删除或弱化当前安全事实、用户输入或 required Evidence；
- Provider 缓存能力无法满足 Host 的数据保留或租户隔离要求；
- 真实 Provider A/B 显示任务质量或安全指标显著回归；
- 同一根因连续失败三次；
- 无法提供 L3 要求的恢复、权限和完成证据。

## 18. 完成定义

只有同时满足以下条件才算完成：

```text
Runtime 对 Prompt、Profile 和具体角色无感知
Harness 只包含通用 Agent Kernel、Compiler 和执行协议
Host 注册并选择版本化 Agent Profile
Profile 只能影响策略与表达，不能成为 Authority
System Kernel 稳定，动态状态通过 Runtime Directive 注入
Task Contract、Checks 和 Evidence 对模型真实可见且有界
Provider Tool 使用真实 Schema，不从示例猜测
每次请求只有一种 Tool Transport
ModelTurn 使用显式 action，不以任意 text 隐式完成
Profile 与最终 Prompt provenance 可恢复、可审计
稳定前缀确定性编译，动态内容后置且 Provider cache usage 可观测
支持缓存的真实 Provider 相对旧基线提高 cached-input ratio
旧固定拼接、双 Tool 协议和隐式完成生产路径已删除
L3 回归、Prompt injection 和真实 Provider A/B 通过
```
