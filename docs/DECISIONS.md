# DECISIONS.md

## ADR-001 — 纵向 Feature 开发

不按前端、后端、数据库和 Agent 横向铺开。

## ADR-002 — 单 Agent 主循环

v1 不使用固定多 Agent 链。

## ADR-003 — JSON 控制面 + Artifact 数据面

跨边界使用 Schema JSON，大内容外置。

## ADR-004 — 全量 Spec 路线图，分成熟度

**状态：路线 Authority 已被 P2 取代。** F001–F024 索引只保留为历史 Feature 资料；当前版本路线以 `PROJECT.md` 为准，当前开发状态以 `DEVELOPMENT.md` 为准。

全部 F001–F024 放入 `specs/`：

- 当前 Feature：ready；
- 后续 Feature：outline；
- 开发前结合真实代码升级为 ready。

## ADR-005 — Desktop 左右栏完全收起

**状态：已被 P2 取代。** Nexora 不再规划官方 Desktop 产品；以下内容仅作历史记录。

左右收起后不保留固定窄图标栏，只保留轻量边缘展开控制。

## ADR-006 — Workspace 单一代码画布

**状态：已被 P2 取代。** 该决定只属于已取消的 Desktop 方向。

右侧展开后不做文件树和多个嵌套子面板。

## ADR-007 — Activity 动态文本流

**状态：已被 P2 取代。** 该决定只属于已取消的 Desktop 方向。

不显示固定步骤和私有思维链。


## ADR-008 — 项目目录按 Feature 生长

**状态：原则保留，F001 示例已过时。** “按真实 Feature 生长、不预建空壳”继续有效；下方 F001 内容只记录当时起点。

项目使用轻量 Monorepo，但不提前创建全部模块空壳。

F001 只创建 CLI、Contracts、Core、Storage、Model Gateway、Testkit 和必要测试目录。

## ADR-009 — Runtime Feature Core 与真实 Provider 验收分层

**状态：已接受。**

Runtime Feature Core 由确定性故障注入、真实 Store/Tool integration、package consumer、Authority 与恢复证据验收。它必须保证 Provider invalid output、timeout、不可用或不收敛时不会产生假成功、越权副作用、Evidence 丢失或不可恢复状态。

特定真实 Provider 的 timeout、限流、Action repair 次数、交互收敛轮数和并发任务成功率属于 External Environment Acceptance。该层失败必须诚实保留，但在 Runtime 正确进入 blocked/failed、保存执行证据且可恢复时，不自动否定 Feature Core。

真实 Provider UAT 一旦暴露假成功、Approval 绕过、Invocation/Evidence 不一致、unknown Effect 错误处理、不可恢复或资源泄漏，立即重新归入 Feature Core 并阻断 Feature。

该决定不修改历史 `verification_blocked` 结论，也不代表 1.1 整体发布完成。详细 Contract 见 `docs/superpowers/specs/2026-07-28-g0-provider-acceptance-boundary.md`。
