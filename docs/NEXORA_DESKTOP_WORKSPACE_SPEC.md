# Nexora Desktop Agent Workspace — Feature Spec

## 1. Outcome

Nexora Desktop 是 Nexora Runtime 的官方本地宿主应用。它把 Run、Structured Plan、Tool Invocation、Approval、Input Request、Evidence、Validation、Artifact、Resume 和 Event 投影为一个可以长期使用的轻量 Agent 工作台。

用户应当能够自然完成：

```text
选择 Workspace
→ 创建或打开 Session
→ 下达目标
→ 在同一执行流中观察 Agent 工作
→ 在需要时回复、审批或恢复
→ 查看经过验证的正式结果
→ 在同一 Workspace 创建后续任务
```

Desktop 不创建第二套 Run 状态、Plan、Tool 结果、Evidence 或完成判断。只有持久化的 Runtime Authority 可以决定这些事实。

### Terminology

- Runtime、代码、持久化和公开 Core Contract 继续使用 **Run**；
- Desktop 面向用户统一使用 **Session**；
- Session 只是一个 Run 的产品层投影，不引入 Session status、Session plan 或 Session completion 等平行状态；
- 用户入口命名为 **Activity**，其内容是完整 Runtime **Trajectory**。

## 2. Product shape

首版只有两栏：

```text
┌────────────────────┬──────────────────────────────────────────┐
│ Workspace          │ Session header                           │
│ + New task         ├──────────────────────────────────────────┤
│                    │                                          │
│ Sessions           │ Conversation 或 Trajectory               │
│ · task A           │                                          │
│ · task B           │                                          │
│                    │                                          │
│ Settings           │                                          │
│                    ├──────────────────────────────────────────┤
│                    │ Plan summary（按状态出现）                │
│                    │ Composer / Input / Approval / Recovery    │
└────────────────────┴──────────────────────────────────────────┘
```

- 左侧只负责 Workspace 和 Session / Task 切换。
- 中间是唯一主执行面，同时承载用户输入和 Agent 执行输出。
- Session 默认显示 Conversation；用户可切换到 Trajectory 查看完整 Runtime 记录。
- 首版没有右栏、Workbench、Runtime Dashboard、文件树或多面板 Inspector。

## 3. Authority mapping

| GUI 概念 | 唯一事实来源 | GUI 权限 |
| --- | --- | --- |
| Session | Runtime Run | 创建、打开；不直接改状态 |
| Session status | State Machine + persisted Run | 只读投影 |
| Plan | Run-owned Structured Plan | 只读、折叠/展开 |
| Progress | persisted step progress | 只读投影 |
| Tool activity | Tool Invocation + Event | 只读投影 |
| Approval | persisted Pending Request | 通过 RunHandle 批准或拒绝 |
| Input request | persisted Pending Request | 通过 RunHandle 回复 |
| Recovery | unknown Invocation + Resume Contract | 通过 RunHandle 提交明确决定 |
| Validation | validation Events + Evidence | 只读投影 |
| Completion | Completion Gate + persisted Result | 只读投影 |
| Artifact | content-addressed Artifact | 受限读取，不复制为 GUI Authority |
| Workspace files | Workspace 外部事实 | 首版不提供独立编辑路径 |

## 4. Left rail

左栏保持低噪声，只包含：

- 当前 Workspace 名称和受限路径提示；
- 切换 Workspace；
- 新建任务；
- 当前 Workspace 的 Session 列表；
- 每个 Session 的标题、轻量状态和必要的待处理提示。
- Settings 入口。

状态使用用户语言，例如“正在工作”“需要回复”“需要确认”“已暂停”“已完成”“未完成”“已取消”。不显示统计、预算图表、Invocation 数量、项目管理字段或批量操作。

Session 列表必须来自 Runtime 的持久化事实。Desktop 不维护状态副本。若 Runtime 尚无安全的 Run 枚举投影，应先补充最小只读 Contract，而不是读取 Core Store 或建立独立历史数据库。

## 5. Conversation flow

Conversation 是按实际发生顺序生成的用户投影，不是 Runtime 原始日志，也不是伪造的聊天记录。它只保留用户理解任务进展和介入执行所必需的信息；完整事实进入 Activity。

允许出现的条目：

- 用户提交的目标或对 Input Request 的回复；
- Runtime 真正持久化并通过公开 Contract 暴露的 Agent delivery / result；
- Plan 更新摘要；
- Read、Search、Command、Edit 等 Tool Invocation；
- Tool 成功、失败或结果未知；
- Approval 和 Input Request；
- Validation 开始、通过或失败；
- Artifact 产生；
- Run blocked、resumed、failed、cancelled 或 succeeded。

所有条目由 `RunInspection`、持久化 Runtime Event、Tool Invocation、Evidence 和 Result 确定性投影。不得显示模型私有推理或根据时间间隔编造“思考过程”。

当前公开 `RunInspection` 没有提供中间 Agent 文本，因此首版不得把 `model.requested`、`model.turn` 或事件间空档翻译成“正在思考”或虚构回复。只有 Runtime 未来明确持久化并公开用户可见 Agent output 后，Conversation 才能显示相应条目。

Tool 条目默认是一行轻量活动：动作、目标、状态、可用时显示耗时。点击后在原地展开真实输入、结果、错误、Invocation ID 和时间信息。大内容只显示摘要并引用 Artifact。

Conversation 不把每个 Tool、Evidence 或 Event 做成大型卡片，也不常驻显示完整 Runtime JSON。

## 6. Plan

Plan 位于 Conversation 流中或 Composer 上方，默认折叠：

```text
● 正在实现 Desktop Host    2 / 6
```

- 标题来自当前 active step；
- 分子是 completed steps 数量，必要时把 active step 表达为正在进行；
- 分母来自当前 Structured Plan；
- 点击后原地展开 completed / active / pending steps；
- Plan version 只在 Trajectory 详情中显示；
- 用户不能编辑、拖动、勾选或在 GUI 中维护 Plan。

没有真实 Structured Plan 时不显示占位 Plan。

## 7. Composer states

Composer 是所有人机介入的统一入口，并由当前 `RunInspection` 决定状态。

### New task

接受非空目标并通过 Runtime 创建新 Run。

### Running

显示运行状态和取消入口。Runtime 没有主动追加输入 Contract 时，不提供看似可发送但无法可靠执行的普通聊天输入。

### Waiting for input

直接显示 Runtime 的问题和回答入口；提交时携带真实 request ID。提交完成后恢复运行状态。

### Waiting for approval

显示 Tool / 操作概要、真实输入，以及“拒绝”“批准”。拒绝可填写原因。关闭或切换 Session 不等于拒绝。

### Blocked / interrupted

仅在 Runtime Contract 允许时显示恢复入口。未知非幂等副作用不得自动重试，必须要求用户选择确认成功、确认失败或放弃 Run。

### Terminal

显示正式 Result 或失败 Delivery。终态 Run 不伪装成可继续对话；用户可在同一 Workspace 创建一个新的后续任务。

## 8. Activity / Trajectory

每个 Session header 提供一个轻量 **Activity** 入口。点击后，中间区域从 Conversation 切换为 Activity / Trajectory；它不会打开第三栏。Trajectory 是完整但可读的 Runtime 执行记录，按 sequence 排序，支持查看：

- Turn / Plan step；
- User / Agent event；
- Tool Invocation 和 result；
- Approval 和 Input Request；
- Validation 和 Evidence；
- Error、Recovery 和 Result；
- 时间、sequence、ID、耗时和关联引用。

Trajectory 使用 RunHandle 的公开 history、inspection 和 audit API，不读取 SQLite 或 Core Store。原始 payload 默认折叠；秘密、超大内容和被 capture policy 隐藏的内容不得在 Renderer 重新暴露。

## 9. Evidence, validation and artifacts

Conversation 只显示用户能理解的结果，例如：

```text
✓ Validation passed
✓ 42 tests passed
任务已完成
```

Evidence、Invocation、Completion Gate 和 provenance 细节进入对应 Conversation 条目的展开区域或 Trajectory。

Artifact 必须通过受限的公开读取边界访问。Renderer 不接收 Artifact Store 物理路径，也不能自行读取 `.nexora`。首版允许文本 Artifact 的有界预览和系统打开已生成 Workspace 文件；不内置文件编辑器。

## 10. Desktop host boundary

首版使用 Electron 窗口和独立 Node Runtime Host，Renderer 使用原生 TypeScript、HTML 和 CSS。独立 Node 进程复用仓库现有 `better-sqlite3` ABI，避免为 Electron 建立另一份数据库实现：

- Node Runtime Host：Workspace 生命周期、Provider、Tools、Runtime 和 RunHandle；
- Electron main：窗口生命周期、目录选择和有界 Host bridge；
- Preload：经过 Schema 校验的最小 IPC；
- Renderer：只包含 View Model 和用户意图，不持有 Runtime Authority；
- Runtime：继续拥有状态、计划、副作用、批准、证据、恢复和完成。

安全默认值：`contextIsolation: true`、`nodeIntegration: false`、Renderer sandbox、禁止任意导航、IPC 输入输出 Schema 校验、Workspace 路径边界、Provider secret 不进入 Renderer、大 payload 进入 Artifact。

Electron 与 Node Runtime Host 只交换 JSON 请求、公开 Snapshot 和错误；该进程边界不保存 Run 状态。系统找不到兼容 Node 可执行文件时必须启动失败，不得回退为 Renderer Store。

同一时刻只激活一个 Workspace Runtime。切换 Workspace 必须关闭订阅并释放旧 Runtime；不得让两个 Host 实例并发控制同一 Run。

## 11. Required public read projections

Desktop 不能为了界面完整读取内部 Store。实现前需要验证并在必要时设计两个最小只读投影：

1. 按 Workspace 分页列出 Run summary，用于重启后恢复 Session 列表；
2. 为已打开 Run 投影有界 input history，用于恢复真实用户目标和 Input Request 回复；
3. 按 Artifact reference 有界读取 Artifact metadata / content，用于结果和详情查看。

这些能力只能投影已有 Authority，不得增加第二个状态、执行路径或完成判断。公开 Contract 形状需要在实现前单独审查，当前 Spec 不预先锁定方法名。

## 12. Non-goals

首版不包含：

- 右栏、Workbench、Files Panel、Evidence Panel 或 Runtime Inspector；
- 文件树、内置编辑器、交互终端或 Git 管理；
- Runtime 统计 Dashboard、图表或项目管理；
- Fork / Merge UI、多 Agent 拓扑或 Worker 调度面板；
- Memory、MCP、Skill、插件市场或 Workflow 编辑器；
- 模型思维链、伪造流式文本或不存在的主动输入能力；
- 云同步、账户、自动更新、签名发布或多平台发布承诺。

后续能力只能由真实 Desktop 使用摩擦或 Runtime Contract 缺口触发。

## 13. Acceptance

Feature Core 完成需要以下可复现证据：

1. 选择 Workspace 后使用正式公共 API 创建真实 Run；
2. 左栏能在应用重启后从 Runtime Authority 恢复 Session；
3. Conversation 按持久化事实显示 Plan、Tool、Validation、请求和终态；
4. Plan 折叠摘要与完整 step progress 一致，且 GUI 无修改入口；
5. Input Request、批准和拒绝均携带正确 request ID 并恢复同一 Run；
6. 未知 Tool Invocation 不自动重试，可提交真实 Recovery Decision；
7. Trajectory 能从公开 audit API 恢复完整顺序，并在重启后保持一致；
8. 只有持久化 `status === "succeeded"` 显示任务完成；
9. Result、Evidence 和 Artifact 由 Runtime Authority 提供；
10. Renderer 不能直接访问 Node、Store、Workspace 或 Provider secret；
11. 切换 Workspace 和关闭窗口会释放订阅、Provider 与 Runtime；
12. 确定性测试覆盖成功、输入、批准、拒绝、失败、blocked 和 recovery；
13. 真实桌面窗口完成一次创建任务到正式结果的 UAT。

## 14. Delivery layers

- Feature Core：Windows 本地开发环境可重复启动和完成上述闭环。
- Release gates：依赖安全审查、打包、签名、自动更新、性能和安装体验。
- External acceptance：真实 Provider 凭据、不同 Workspace 和长期日常使用验证。
