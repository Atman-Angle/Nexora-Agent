<p align="right"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center"><img src="./assets/readme/logo.png" width="104" alt="Nexora Agent 标志"></p>

<h1 align="center">Nexora Agent</h1>

<p align="center"><strong>让 Agent 可靠执行真实工作的可信运行时。</strong></p>

<p align="center">
  使用你自己的模型、工具、Prompt 和产品体验。<br>
  Nexora 让每次运行都可持久化、可控制、可恢复、可验证。
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-5CE1A4?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-5EA2FF?style=flat-square">
  <img alt="版本 0.1.0" src="https://img.shields.io/badge/version-0.1.0-5EA2FF?style=flat-square">
  <img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-5CE1A4?style=flat-square">
</p>

<p align="center"><img src="./assets/readme/hero.png" width="100%" alt="Nexora 将 Agent 操作转化为持久证据和可信结果"></p>

## Nexora 是什么？

Nexora 是一个可嵌入的 TypeScript Agent Runtime，适用于需要调用工具、改变外部状态、等待人工交互，或在进程重启后继续执行的 Agent。

你的应用仍然拥有用户体验、领域逻辑、Prompt、模型和工具。Nexora 负责容易出错的执行问题：持久状态、操作批准、副作用记录、故障恢复、执行证据和可信完成。

```text
用户目标
  → Harness 询问模型下一步做什么
  → Runtime 校验并执行操作
  → Tool 结果成为持久化 Evidence
  → Run 继续、暂停、恢复或完成
  → 应用获得经过验证的结果
```

Nexora 不是聊天机器人、托管式 Agent 服务、工作流搭建器，也不替代你的应用框架。如果只需要一次无状态模型回复，通常不需要 Nexora。

## 为什么使用 Nexora？

| 需求 | Nexora 提供的能力 |
| --- | --- |
| 执行真实操作 | Schema 校验、权限检查、批准门禁和权威 Tool Invocation |
| 中断后继续 | 持久化 Run，可在进程或应用重启后恢复 |
| 避免危险重试 | 幂等机制与未知非幂等副作用的显式处理 |
| 确认真实执行情况 | 追加式事件、Artifact、工具结果和持久化 Evidence |
| 防止虚假成功 | Run 成功前必须通过确定性的 Completion Gate |
| 嵌入真实产品 | TypeScript API、`RunHandle`、事件、取消、输入、批准和恢复 |

模型只能提出决策，不能直接执行工具、改写 Run 状态、伪造 Evidence 或宣布成功。

## 系统如何协作？

| 层级 | 职责 |
| --- | --- |
| **你的应用** | 用户体验、目标、领域数据、Prompt、工具和业务规则 |
| **Nexora Harness** | Agent Loop、模型调用、上下文、计划、Profile、Skill 和决策编译 |
| **Nexora Runtime** | Run 状态、工具执行、批准、恢复、Evidence 和完成不变量 |
| **模型 Provider** | 根据有界工作上下文提出下一步决策 |

所有执行只有一条权威路径：Tool 副作用记录为 Invocation，进度由 Evidence 支持，只有 Runtime State Machine 可以修改 Run 状态。

## 快速开始

Nexora 当前从源码运行，需要 Node.js 20+ 和 pnpm 11。

```powershell
git clone https://github.com/Atman-Angle/Nexora-Agent.git
Set-Location -LiteralPath 'Nexora-Agent'
pnpm install
pnpm typecheck
```

### 启动 Desktop 工作区

```powershell
pnpm desktop
```

Desktop 提供 Project、Session、模型流式输出、操作批准、故障恢复、工作区文件、模型设置和持久化执行历史。配置与使用方法请查看 [Desktop 指南](./apps/desktop/README.md)。

### 嵌入 Runtime

```ts
import {
  createAgent,
  createBuiltInTools,
  openAICompatibleProviderFromEnv
} from "@nexora/harness";

const agent = createAgent({
  workspace: "D:/my-agent-workspace",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  const run = agent.run("读取 note.txt，并生成一份有执行证据支持的摘要");
  const result = await run.result();
  console.log(result.status, result.summary);
} finally {
  await agent.close();
}
```

`agent.run()` 返回的是持久化 `RunHandle`，不是未经验证的模型回答。宿主可以订阅事件、提供输入、批准受保护操作、取消任务、重新打开 Run，并读取正式结果。

## 当前能力

- 持久化 Run、Event、Artifact、Tool Invocation 和 Evidence
- 具备 Schema、权限、风险、批准和恢复语义的工具执行
- 支持原生 Tool Calling 和流式输出的 OpenAI-compatible Provider
- 有界上下文、确定性收缩、事实恢复和跨 Run 作用域 Memory
- Run-owned Plan 和确定性完成验证
- 人工输入、操作批准、取消、Session 延续和故障恢复
- 本地 Agent Skill 发现与模型自主渐进加载
- 通过同一 Runtime Authority 管理长期本地进程
- 具备隔离工作区的有界 Supervisor 与 Child Run 协作
- Desktop、CLI、公开 TypeScript API 和 Runtime 测试工具

## 项目状态

Nexora 当前版本为 `0.1.0`，尚未发布到 npm。项目正在积极开发中，应视为发布候选版本，而不是 API 已稳定的 1.0 产品。

当前实现面向本地 TypeScript 应用和 OpenAI-compatible Provider。项目暂不提供托管执行、插件市场、远程 Skill 安装、无代码工作流编辑器或通用 SaaS 控制平面。

## 文档导航

| 如果你想…… | 请阅读 |
| --- | --- |
| 使用 Desktop 应用 | [Desktop 指南](./apps/desktop/README.md) |
| 在应用中嵌入 Nexora | [Runtime 开发指南](./docs/BUILD_WITH_NEXORA_RUNTIME.md) |
| 了解当前用户工作流 | [当前用户指南](./docs/USER_GUIDE_CURRENT.md) |
| 理解系统边界 | [架构说明](./ARCHITECTURE.md) |
| 理解执行与持久化流程 | [数据流](./DATA_FLOW.md) |
| 查看产品方向与范围 | [项目说明](./PROJECT.md) |
| 查看验证要求 | [测试策略](./TESTS.md) |
| 浏览全部公开文档 | [文档索引](./docs/README.md) |

## 开发验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

专项测试和验收命令请查看 [TESTS.md](./TESTS.md) 与 [Desktop 指南](./apps/desktop/README.md)。

## 许可证

[Apache License 2.0](./LICENSE)
