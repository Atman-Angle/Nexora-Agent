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
  <img alt="可嵌入 Runtime" src="https://img.shields.io/badge/Runtime-embeddable-F4F7FA?style=flat-square">
  <img alt="Pre-release" src="https://img.shields.io/badge/status-pre--release-8B98A7?style=flat-square">
</p>

<p align="center">
  <img src="./assets/readme/hero.png" width="100%" alt="Nexora Agent 将模型决策和 Tool Invocation 转换为持久 Evidence 与已验证结果">
</p>

## Agent 应用下面的执行层

一个 Agent 产品包含三类不同职责：

| 层 | 负责什么 |
| --- | --- |
| **你的应用** | 定义目标、领域 Prompt、Tool、数据、UI 和产品行为。 |
| **模型 Provider** | 观察当前上下文，提出 Agent 下一步应该做什么。 |
| **Nexora Runtime** | 安全执行决策、持久化真实过程、处理交互和恢复，并判断任务是否真正完成。 |

Nexora 是第三层。它不是另一个 Agent 人格，也不会替换你的应用框架。它把不稳定的模型调用和 Tool 调用转换成一个持久、可审计的 **Run**。

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
- **它需要进入真实产品。** Nexora 通过 TypeScript API 嵌入，不接管领域数据或 UI。

对于简单、无状态的一次性聊天调用，Nexora 可能没有必要。它面向具有状态、副作用、人工交互或明确完成 Contract 的 Agent。

## Context：Run 持久状态的有界视图

Nexora 不把模型 Prompt 当作 Agent 的记忆或事实源。每次调用 Provider 前，Runtime 都会从持久化 Authority 重新构建 **Projected Run Context**：当前输入与 Task Contract、Run-owned Plan 和进度、相关 Tool Observation、Evidence、交互状态与恢复事实。Projection 是可丢弃视图；删除它不会删除或改写真实执行历史。

```text
持久化 Run Authority
  → 按 phase 投影
  → Token 计量
  → 必要时确定性 Eviction
  → 必要时生成并校验 Checkpoint
  → 精确 Rehydration
  → 有界 Provider Request
```

| 机制 | 工作方式 |
| --- | --- |
| **按 phase 投影** | Decision、Validation 与 Compaction 调用只接收该阶段真正需要的字段。内部 ID、版本、workspace 信息、完整 Plan 结构和无关 provenance 不进入生产 wire。 |
| **可计量 Token 预算** | 最终序列化 Request 会按 Provider Profile 的 soft / hard limit 计量。真实 hard-limit overflow 会记录为 refused model call，并且不会调用 Provider。 |
| **确定性 Eviction** | 低价值 Tool payload 按稳定优先级从 full 收缩为 fragment、reference 或省略。Active Check、未解决失败、安全事实、Evidence 和当前工作优先于普通历史；整个过程不调用 LLM。 |
| **结构化 Compaction** | Eviction 仍不够时，Provider 可以生成严格 Schema 的 Summary，每条陈述必须引用原始 SourceRef。Nexora 在持久化唯一替代 Checkpoint 前验证归属、digest、已完成工作、未解决问题及覆盖的 Invocation。Checkpoint 只是缓存，不是 Evidence 或完成 Authority。 |
| **历史导航与精确恢复** | 有界 `historyCandidates` 只提供 ref 和短 hint，不复制大段内容。Runtime 自动恢复用户明确点名的 ref 与 active `context_ref` 要求，生成经过 digest 校验的 `rehydratedFacts`；不可用、被篡改或超预算的事实以类型化错误失败，不允许猜测。 |
| **重启与 Branch 隔离** | 进程重启后，Context 从持久化 Authority 重建。Branch 只读继承 fork base，同时独立拥有 workspace、Checkpoint、历史、Evidence 和完成状态，因此不能修改或完成父 Run。 |

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
| **有界 Candidate 投影** | Runtime 对 active、相关且 normal-sensitivity 的记录做确定性排序，最多暴露 6 条，并受 768 estimated tokens 与 4 KiB 限制。Candidate 只含 ref、类型、原因、生命周期与 digest 元数据，不含 Memory statement。 |
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
| `Runtime` | 配置好的执行环境：workspace、Provider、Tools、持久化和生命周期。 |
| `Run` | 为实现一个目标进行的一次持久执行；只有它的 State Machine 可以改变 Run Status。 |
| `RunHandle` | 宿主使用的公共控制面：观察事件、提供输入或批准、取消、恢复并读取结果。 |
| `Provider` | 提出决策的模型适配器；不能直接执行 Tool 或写 Run 状态。 |
| `Tool Invocation` | 一次真实操作请求及其执行结果的权威记录。 |
| `Evidence` | 用于验证进度、判断是否有资格完成任务的持久证据。 |

当前 Structured Plan 由 Run 持有。应用不维护第二份 Plan、第二套 State Machine 或第二个执行真相源。

## 快速开始

> Nexora Agent 目前处于 pre-release 阶段，尚未发布到 npm。下面从源码工作区开始。

要求：Node.js 20+、pnpm 11。

```powershell
git clone https://github.com/Atman-Angle/Nexora-Agent.git
Set-Location -LiteralPath 'Nexora-Agent'
pnpm install
pnpm typecheck
```

创建一个 Runtime，启动 Run，然后等待经过验证的结果：

```ts
import {
  createBuiltInTools,
  createRuntime,
  openAICompatibleProviderFromEnv
} from "@nexora/runtime";

const runtime = createRuntime({
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
6. Completion Gate 检查 Run-owned Plan 和 Evidence，满足条件后 State Machine 才能将 Run 标记为成功。

<p align="center">
  <img src="./assets/readme/runtime-architecture.png" width="100%" alt="宿主应用、Nexora Runtime 与已验证输出之间的 Authority 边界">
</p>

这个边界是刻意设计的：模型、Tool 和宿主应用都不能直接写 Run Status。执行状态、副作用、恢复判断和完成结论始终只有一个 Authority。

## 参考 Harness：Research Agent

[`apps/research-agent`](apps/research-agent) 是基于 Nexora 公共 API 构建的真实应用 Harness。研究 Profile、Tavily、新闻 Tool、Scheduler 和生成内容全部属于应用；Nexora 负责它们下面的 Run 生命周期。

```ts
const runtime = createRuntime({ workspace, provider, tools });
const run = runtime.run(buildResearchGoal(profile));
const result = await run.result();
```

这个 Harness 验证了真实检索、人工交互、失败恢复和完成验证，同时没有读取 Core Store、直接写 Run、复制 CLI 编排或向 Core 增加 Research 特判。

**[查看 Research Agent 的完整配置、产物效果与真实执行证据 →](docs/applications/research-agent.md)**

## 仓库结构

```text
Nexora-Agent/
├─ packages/
│  └─ runtime/                       # 公共可嵌入 Runtime
├─ apps/
│  ├─ cli/                           # 薄命令行宿主
│  └─ research-agent/                # 真实应用 Harness
├─ examples/
│  └─ runtime/                       # 公共 API 使用示例
├─ tests/
│  ├─ apps/                          # 宿主应用 Contract
│  ├─ benchmarks/                    # 确定性与真实 Provider Harness
│  ├─ canaries/                      # 真实 Provider 连续性 Canary
│  ├─ fixtures/                      # 共享确定性测试数据
│  └─ runtime/                       # Runtime、Context 与 Memory Contract
├─ docs/                             # 公共指南与验证参考
└─ assets/readme/                    # GitHub README 配图
```

## 文档

- [使用 Nexora Runtime 构建应用](docs/BUILD_WITH_NEXORA_RUNTIME.md)
- [Research Agent Harness 与效果](docs/applications/research-agent.md)
- [Context Harness 系统验证](docs/CONTEXT_HARNESS_SYSTEM_VALIDATION.md)
- [架构与 Authority 边界](ARCHITECTURE.md)
- [系统数据流](DATA_FLOW.md)
- [测试策略](TESTS.md)

## 项目状态

Nexora Agent 目前处于 pre-release 阶段。Runtime、CLI、Research Agent 以及 Context & Memory Harness 均可在本仓库中构建和测试；npm 发布、长期托管服务与开源许可证尚未完成或声明。

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

> License 尚未声明。在采用、分发或发布前，请先确认许可证。
