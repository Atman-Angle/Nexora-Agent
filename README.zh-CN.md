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
├─ packages/runtime/                 # 公共 Runtime
├─ apps/cli/                         # 薄 CLI 宿主
├─ apps/research-agent/              # 真实应用 Harness
│  └─ src/                           # 应用代码
├─ tests/                            # Runtime 与应用 Contract
├─ docs/                             # 指南与案例
└─ assets/readme/                    # Logo 与 README 配图
```

## 文档

- [使用 Nexora Runtime 构建应用](docs/BUILD_WITH_NEXORA_RUNTIME.md)
- [Research Agent Harness 与效果](docs/applications/research-agent.md)

## 项目状态

Nexora Agent 目前处于 pre-release 阶段。Runtime、CLI 和 Research Agent Harness 可在本仓库中构建和测试；npm 发布、长期托管服务与开源许可证尚未完成或声明。

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

> License 尚未声明。在采用、分发或发布前，请先确认许可证。
