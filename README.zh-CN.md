<p align="right"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <img src="./assets/readme/logo.png" width="104" alt="Nexora Agent Logo">
</p>

<h1 align="center">Nexora Agent</h1>

<p align="center"><strong>位于 Agent 应用之下的可信执行层。</strong></p>

<p align="center">
  使用你自己的模型、Tool、Prompt 和产品体验。<br>
  让 Nexora 保证每次执行可持久、可控制、可恢复、可验证。
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-5CE1A4?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-5EA2FF?style=flat-square">
  <img alt="版本 0.1.0" src="https://img.shields.io/badge/version-0.1.0-5EA2FF?style=flat-square">
  <img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-5CE1A4?style=flat-square">
  <img alt="可嵌入 Runtime" src="https://img.shields.io/badge/Runtime-embeddable-F4F7FA?style=flat-square">
  <img alt="Release candidate" src="https://img.shields.io/badge/status-release%20candidate-8B98A7?style=flat-square">
</p>

<p align="center">
  <img src="./assets/readme/hero.png" width="100%" alt="Nexora Agent 将模型决策和 Tool Invocation 转换为持久 Evidence 与已验证结果">
</p>

## Agent 应用下面的执行层

一个 Agent 产品包含四类不同职责：

| 层 | 负责什么 |
| --- | --- |
| **你的应用** | 定义目标、领域 Prompt、Tool、数据、UI 和产品行为。 |
| **Nexora Harness** | 负责 Agent Loop、通用 Prompt Compiler、版本化 Agent Profile、Context、Memory 策略、Planning、Provider Transport 和 ModelTurn 编译。 |
| **模型 Provider** | 接收 Harness 的有界请求，提出 Agent 下一步应该做什么。 |
| **Nexora Runtime** | 安全执行已批准命令，负责持久状态、Tool Invocation、恢复、Evidence 和机械完成门。 |

Nexora 提供 Harness 与 Runtime 两层。它不是另一个 Agent 人格，也不会替换你的应用框架。Harness 把模型响应编译为 Runtime 命令；Runtime 把命令和 Tool Effect 转换成一个持久、可审计的 **Run**。

这里的“机械”指确定性代码，不是另一轮 LLM 判断。Runtime 从不调用 Provider：它校验 Schema 与权限，记录 Invocation 和 Evidence，执行状态转换与完成不变量，并持久化结果。所有模型调用和语义决策都属于 Harness。

```text
目标
  → 模型决策
  → Tool Invocation
  → 持久化 Evidence
  → 下一次决策或人工交互
  → 已验证的终态 Result
```

如果没有 Runtime，每个应用最终都会重新实现状态标记、重试规则、批准流程、部分进度存储和“什么才算完成”。Nexora 为这些问题提供唯一执行路径，同时把所有领域行为留在应用侧。

## 为什么使用 Nexora？

当 Agent 不只是返回一次模型回答时，就适合使用 Nexora：

- **它会执行真实操作。** Tool 调用经过 Schema 校验，并记录为权威 Invocation。
- **它可能需要人工参与。** 输入、批准和拒绝暂停并继续同一个 Run。
- **它必须承受进程中断。** 持久状态允许进程重启后重新打开 Run。
- **它不能盲目重复副作用。** Recovery 能区分安全重试和状态未知的非幂等操作。
- **它的结果必须可信。** Evidence 与 Completion Gate 阻止看似合理的模型文本冒充成功。
- **它可以有界委派工作。** Supervisor 能协调隔离的 Child Run，但 Worker 不获得 Parent Authority。
- **它需要进入真实产品。** Nexora 通过 TypeScript API 嵌入，不接管领域数据或 UI。

对于简单、无状态的一次性聊天调用，Nexora 可能没有必要。它面向具有状态、副作用、人工交互或明确完成 Contract 的 Agent。

全部原始用户输入在 Run 内持续可见；模型生成的 Task Contract 或 Plan 不能替换它们。Harness 按已有事实、Tool 探寻、有界重试和换路径的顺序消解不确定性，最后才询问用户。存在可用 Tool 且尚未尝试时，第一次输入请求会返回模型做一次自主纠错；真正属于用户的选择仍会暂停 Run。

每个终态或外部阻塞的 Run 都暴露用户可读 **Delivery**。成功 Delivery 使用已验证的模型结果；失败、取消和阻塞 Run 使用确定性 Delivery，说明已产生 Artifact、已确认事实、未完成工作、确切原因和下一步，绝不把部分进度改写成成功。

## 有界 Multi-Agent 协调

Nexora 通过持久化 Parent/Child Run 支持 Supervisor/Coordinator 执行。Parent 一次委派一组有界、彼此独立的 Assignment；每个 Worker 获得隔离 Branch workspace、明确 Tool allowlist、Profile 和预算。Worker 不能继续委派、不能直接修改 Parent workspace，也不能宣布 Parent 完成。

```text
Parent 决策
  → 有界 Worker batch
  → 隔离 Child Run 与 Branch workspace
  → 持久 Join 与失败隔离
  → Child Observation 返回 Parent
  → 正常 Tool / Approval / Evidence 采纳路径
```

崩溃恢复会重新打开已经接受的 Child Run，而不是要求模型再次委派。blocked、waiting 或 failed Child 始终可检查；成功 Worker 输出也只有经过 Parent 正常的 Runtime Authority 与安全门采纳后，才能影响 Parent。

## 通用 Prompt 与 Agent Profile

Nexora 每次模型请求都由稳定通用 Kernel、单一 Provider Transport、Host Policy、可选版本化 Agent Profile、Project Instructions、canonical Tool JSON Schema 和动态 Run Context 编译而成。Profile 描述角色、策略、工作流与沟通偏好，但不能注册 Tool、授予权限、批准 Effect、制造 Evidence 或宣布 Run 完成。

每次 Model Call 都审计稳定策略前缀 digest。Provider cache 遥测记录 eligible/cached/write tokens 和 `unsupported`、`disabled`、`miss`、`partial_hit`、`hit`、`unknown`；只有 Provider 明确报告且口径可比的调用进入 cached-input ratio。缓存复用不会跳过 Provider 调用或任何 Runtime gate。

## Context：Run 持久状态的有界视图

Nexora 不把模型 Prompt 当作 Agent 的记忆或事实源。每次调用 Provider 前，Harness 都会从 Runtime Authority 重新构建有界的 **Agent Working Context**：当前输入与 Task Contract、Run-owned Plan 和进度、相关 Tool Observation、Evidence、交互状态与恢复事实。Projection 是可丢弃视图；删除它不会删除或改写真实执行历史。

```text
持久化 Run Authority
  → 有界工作投影
  → Token 计量
  → 必要时确定性 Eviction
  → 精确 Rehydration
  → 有界 Provider Request
```

| 机制 | 工作方式 |
| --- | --- |
| **有界投影** | Decision 只接收面向当前任务的工作 Context，同时保留全部原始用户输入和最近相关 Tool Outcome。内部 ID、版本、workspace 信息、完整 Plan 结构和无关 provenance 不进入生产 wire。 |
| **可计量 Token 预算** | 最终序列化 Request 会按 Provider Profile 的 soft / hard limit 计量。Harness 在发送前做确定性收缩，并把最终预算判定写入 model-call Ledger；Context 预算判定本身不会使 Run 失败。 |
| **确定性 Eviction** | 低价值 Tool payload 按稳定优先级从 full 收缩为 fragment、reference 或省略。Active Check、未解决失败、安全事实、Evidence 和当前工作优先于普通历史；整个过程不调用 LLM。 |
| **历史导航与精确恢复** | 有界 `historyCandidates` 只作为 Harness 内部导航元数据，生产 Adapter 不发送它。Harness 自动恢复最新输入点名的已发布 ref、active `context_ref` 要求、最高相关 eligible Memory 与关键 Tool 事实，生成经过 digest 校验的 `rehydratedFacts`；不可用、被篡改或超预算的事实保留为类型化 unavailable 数据，不允许猜测，也不会直接中止 Run。 |
| **重启与 Branch 隔离** | 进程重启后，Context 从持久化 Authority 重建。Branch 只读继承 fork base，同时独立拥有 workspace、历史、Evidence 和完成状态，因此不能修改或完成父 Run。 |

优先级是刻意设计的：当前任务和权威 Evidence 在前，可重建历史在后。Context 管理可以改变模型在某一次调用中看到什么，但不能改变 Run Status、Plan、Invocation、Evidence、Approval 或 Completion Gate。

## Memory：跨 Run 的有作用域持久知识

Memory 与 Run Store 相互独立。宿主打开专用 Memory Store，并注入精确身份作用域：`userId`、`projectId`、`workspaceId` 和可选 branch。每条记录保留来源 Run、source ref、digest、类型、验证状态、敏感级别、生命周期和时间。Memory 能帮助后续 Run 找回相关知识，但不会成为第二份 Plan、任务状态、权限系统或事实 Authority。

```text
从 Run 派生的 Candidate
  → 显式或已验证 Promotion
  → 作用域内 Active Memory
  → 有界 Candidate 导航
  → eligibility + digest 复验
  → 不可信 Rehydrated Fact
  → 正常 Tool / Approval / Evidence 路径
```

| 机制 | 工作方式 |
| --- | --- |
| **生命周期与 provenance** | 新知识从 candidate 开始，经显式或 Evidence 支持的 promotion 变为 active。修正和合并会创建新记录，并在单个事务中 supersede 前序记录，不会静默原地修改 statement；记录还可以 expire、archive、invalidate 或 delete。 |
| **精确 Scope 隔离** | 创建、查询、更新、召回和审计都包含完整 scope。跨用户、跨项目、跨 workspace、sibling branch、敏感、过期、已删除或已禁用的记录均不能召回。 |
| **有界 Candidate 投影** | Harness 对 active、相关且 normal-sensitivity 的记录做确定性排序，最多暴露 6 条，并受 768 estimated tokens 与 4 KiB 限制。Candidate 只含 ref、类型、原因、生命周期与 digest 元数据，不含 Memory statement。 |
| **精确恢复** | 使用前重新检查 scope、生命周期、过期时间、敏感级别和 digest，再将选中记录恢复为 `rehydratedFacts(kind="memory")`。已删除或内容漂移的记录会变为 unavailable，不会泄漏陈旧内容。 |
| **天然不可信** | 恢复精确字节只能证明 provenance，不能提升 Authority。Memory 内容始终标记为不可信数据，不能覆盖 Policy、请求 Tool、绕过 Approval、制造 Evidence 或宣布完成。召回内容建议的任何操作仍必须经过 Runtime 正常门禁。 |
| **用户控制与审计** | 宿主可以在精确 scope 内进行 correct、invalidate、delete、clear、导出审计或禁用 recall。控制操作具有幂等语义，并追加不复制敏感 statement 正文的审计事件。 |

Context 回答的是：**当前 Run 的这次模型调用需要看到什么**。Memory 回答的是：**之前 Run 中哪些 eligible 知识现在可能有用**。两者只通过有界 Candidate 与校验后的 Rehydration 连接，都不会创建第二个执行 Authority。

## 压力下的实证：Context & Memory Harness

Nexora 内置了一套可复现 Harness，专门覆盖 Agent 长时间运行后才容易暴露的问题：上下文驱逐、跨 Run Memory 召回、同一 Run 的历史恢复、不可信召回内容、Token 压力，以及基于 Evidence 的完成判断。

| 门禁 | 验证内容 | 当前已验证基线 |
| --- | --- | --- |
| **确定性 Harness v2** | 13 个固定场景，覆盖连续性、预算、安全、恢复与完成；不调用外部模型 | **13 / 13 通过** |
| **真实 Provider Harness** | 使用真实 OpenAI-compatible Provider 执行 HPE-01～05，每个场景重复 3 次 | **15 / 15 通过** |

Provider 门禁不只比较最终文本。它还检查持久化 Run 状态、请求与恢复的 ref、Tool Invocation、Evidence、Token 用量和不安全操作。缺少 Run、跳过证据、场景键重复、虚假成功、突破 Token 硬限制或出现不安全 Invocation，都会让聚合报告以 fail-closed 方式失败。

```powershell
# 快速、确定性的回归基线
pnpm benchmark:context-memory:v2

# 真实 Provider 基线；从 .env 读取 Provider 配置
$env:NEXORA_PROVIDER_BENCHMARK_CONFIRM = '15'
pnpm benchmark:context-memory:provider
```

当前记录的基线使用 `qwen3.7-flash`；除非显式配置 Token 价格，否则 Provider 成本会如实标记为未定价。这套 Harness 衡量的是 Nexora 自身的执行 Contract，不用于宣称相对其他 Agent 系统的性能优势。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| `Agent` | `createAgent()` 组合的 Harness 策略、Provider、Tools 与唯一 Runtime。 |
| `Runtime` | 不依赖 Provider 的机械执行引擎，负责持久 Run、Effect、恢复与完成不变量。 |
| `Run` | 为实现一个目标进行的一次持久执行；只有它的 State Machine 可以改变 Run Status。 |
| `RunHandle` | 宿主使用的公共控制面：观察事件、提供输入或批准、取消、恢复并读取结果。 |
| `Provider` | 提出决策的模型适配器；不能直接执行 Tool 或写 Run 状态。 |
| `Tool Invocation` | 一次真实操作请求及其执行结果的权威记录。 |
| `Evidence` | 用于验证进度、判断是否有资格完成任务的持久证据。 |

当前 Structured Plan 由 Run 持有。应用不维护第二份 Plan、第二套 State Machine 或第二个执行真相源。

## 快速开始

> Nexora Agent `0.1.0` 是 release candidate，尚未发布到 npm。下面从源码工作区或本地 tarball 开始。

要求：Node.js 20+、pnpm 11。

```powershell
git clone https://github.com/Atman-Angle/Nexora-Agent.git
Set-Location -LiteralPath 'Nexora-Agent'
pnpm install
pnpm typecheck
```

### 打开 Desktop Agent Workspace

在仓库根目录创建 `.env`，配置 `NEXORA_MODEL_BASE_URL`、`NEXORA_MODEL_API_KEY`、`NEXORA_MODEL_NAME` 和 `NEXORA_MODEL_DECISION_OUTPUT_TOKENS`，然后运行：

```powershell
pnpm desktop
```

Desktop 是一个两栏 Runtime 宿主：左侧管理 Workspace 和持久 Session，中间是唯一的 Conversation / Activity 执行面。它与公共 Runtime 共享同一份 Run、Plan、Invocation、Approval、Evidence 和 Result Authority；Renderer 不维护平行状态。

使用 `pnpm desktop:uat` 可运行真实 Provider 的 Electron 验收链路。Provider 配置、交互状态、测试命令、UAT 产物和当前发布门禁见 [Desktop 使用与验证指南](apps/desktop/README.md)。

创建一个 Runtime，启动 Run，然后等待经过验证的结果：

```ts
import {
  createBuiltInTools,
  createAgent,
  openAICompatibleProviderFromEnv
} from "@nexora/harness";

const runtime = createAgent({
  workspace: "D:/my-agent-workspace",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  const run = runtime.run("读取 note.txt，并给出有证据的摘要");
  const result = await run.result();

  console.log(result.status, result.summary);
} finally {
  await runtime.close();
}
```

`runtime.run()` 返回的是 `RunHandle`，而不是未经验证的模型答案。交互型宿主可以用同一个 Handle 继续 Run：

```ts
const subscription = run.subscribe(async (event) => {
  if (event.type === "input.required") {
    await run.input(await askUser(event.prompt), {
      requestId: event.requestId
    });
  }

  if (event.type === "approval.required") {
    await run.approve({ requestId: event.request.id });
  }
});
```

Provider 适配、领域 Tool、事件、取消与恢复详见 [使用 Nexora Runtime 构建应用](docs/BUILD_WITH_NEXORA_RUNTIME.md)。

## 一次 Run 如何执行？

1. `runtime.run(goal)` 创建并持久化一个新 Run。
2. Provider 观察 Run 上下文并提出下一步决策。
3. Tool 请求经过校验；需要批准时，Run 会等待用户决定。
4. Nexora 记录 Tool Invocation 及其 Evidence，然后才继续执行。
5. 输入、失败、取消或进程重启都通过同一个持久 Run 处理。
6. Completion Gate 检查持久化 Evidence，并在存在 Plan 时检查 Run-owned Plan；满足条件后 State Machine 才能将 Run 标记为成功。

<p align="center">
  <img src="./assets/readme/runtime-architecture.png" width="100%" alt="宿主应用、Nexora Runtime 与已验证输出之间的 Authority 边界">
</p>

这个边界是刻意设计的：模型、Tool 和宿主应用都不能直接写 Run Status。执行状态、副作用、恢复判断和完成结论始终只有一个 Authority。

## 参考 Harness：Research Agent

[`apps/research-agent`](apps/research-agent) 是基于 Nexora 公共 API 构建的真实应用 Harness。研究 Profile、Tavily、新闻 Tool、Scheduler 和生成内容全部属于应用；Nexora 负责它们下面的 Run 生命周期。

```ts
const runtime = createAgent({ workspace, provider, tools });
const run = runtime.run(buildResearchGoal(profile));
const result = await run.result();
```

这个 Harness 验证了真实检索、人工交互、失败恢复和完成验证，同时没有读取 Core Store、直接写 Run、复制 CLI 编排或向 Core 增加 Research 特判。

**[查看 Research Agent 的完整配置、产物效果与真实执行证据 →](docs/applications/research-agent.md)**

## 仓库结构

```text
Nexora-Agent/
├─ packages/
│  ├─ harness/                       # Agent Loop、Provider、Context、Memory
│  └─ runtime/                       # 可靠 Effect Runtime
├─ apps/
│  ├─ cli/                           # 薄命令行宿主
│  ├─ desktop/                       # 官方两栏 Desktop Agent Workspace
│  └─ research-agent/                # 真实应用 Harness
├─ examples/
│  └─ runtime/                       # 公共 API 使用示例
├─ tests/
│  ├─ apps/                          # 宿主应用 Contract
│  ├─ benchmarks/                    # 确定性与真实 Provider Harness
│  ├─ canaries/                      # 真实 Provider 连续性 Canary
│  ├─ fixtures/                      # 共享确定性测试数据
│  └─ runtime/                       # Runtime 与 Harness Contract
├─ docs/                             # 公共指南与验证参考
└─ assets/readme/                    # GitHub README 配图
```

## 文档

- [Desktop 使用与验证](apps/desktop/README.md)
- [Desktop Workspace Feature Spec](docs/NEXORA_DESKTOP_WORKSPACE_SPEC.md)
- [使用 Nexora Runtime 构建应用](docs/BUILD_WITH_NEXORA_RUNTIME.md)
- [Research Agent Harness 与效果](docs/applications/research-agent.md)
- [Context Harness 系统验证](docs/CONTEXT_HARNESS_SYSTEM_VALIDATION.md)
- [架构与 Authority 边界](ARCHITECTURE.md)
- [系统数据流](DATA_FLOW.md)
- [测试策略](TESTS.md)

## 项目状态

Nexora Agent `0.1.0` 是采用 Apache-2.0 的 release candidate。Runtime、Harness、Multi-Agent 协调、CLI、Research Agent 与 Context & Memory 验证均可在本仓库中构建和测试；公开 npm 发布与长期托管服务尚未完成。

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

本项目采用 [Apache License 2.0](LICENSE)。
