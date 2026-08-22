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
- Session 是一个用户连续任务，可包含一个或多个按顺序执行的 Run；Session 不拥有执行状态，界面状态始终由最新 Run 投影；
- 用户在运行中发送新输入时，Desktop 先通过公开 Contract 安全取消当前 Run，再在同一 Session 创建后续 Run。它不向 busy Run 强塞输入，也不复活终态 Run；
- 用户入口命名为 **Activity**，其内容是完整 Runtime **Trajectory**。

## 2. Product shape

首版只有两栏：

```text
┌────────────────────┬──────────────────────────────────────────┐
│ Projects           │ Session header                           │
│ + New task         ├──────────────────────────────────────────┤
│ Project A          │                                          │
│   Sessions         │ Conversation 或 Trajectory               │
│ · task A           │                                          │
│ · task B           │                                          │
│                    │                                          │
│ Settings           │                                          │
│                    ├──────────────────────────────────────────┤
│                    │ Plan summary（按状态出现）                │
│                    │ Composer / Input / Approval / Recovery    │
└────────────────────┴──────────────────────────────────────────┘
```

- 左侧只负责 Project（Workspace）和 Session / Task 切换。
- 中间是唯一主执行面，同时承载用户输入和 Agent 执行输出。
- Session 默认显示 Conversation；用户可切换到 Trajectory 查看完整 Runtime 记录。
- 首版没有右栏、Workbench、Runtime Dashboard、文件树或多面板 Inspector。

## 3. Authority mapping

| GUI 概念 | 唯一事实来源 | GUI 权限 |
| --- | --- | --- |
| Project | Workspace + Desktop Host 最近项目元数据 | 添加、切换；不复制 Workspace 文件状态 |
| Model catalog | Desktop Host 全局 Model Profile + secret store | 全局增删改；不改变活动 Run Provider |
| Project model selection | Project 的 `selectedModelProfileId` | 为该 Project 的后续 Run 选择全局 Profile |
| Session | Desktop Host 中有序 Run 引用 | 创建、打开、归档；不直接改 Run |
| Session status | 最新 Run 的 State Machine + persisted Run | 只读投影 |
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

- 已添加 Project；每个 Project 对应一个 Workspace；
- 添加和切换 Project；
- 新建任务；
- Project 下的 Session 列表；
- 每个 Session 的标题、轻量状态和必要的待处理提示。
- Session 归档、恢复和从 Desktop 移除；移除只删除 Host 导航引用，Runtime Run 与审计证据必须保留。
- Settings 入口。

状态使用用户语言，例如“正在工作”“需要回复”“需要确认”“已暂停”“已完成”“未完成”“已取消”。不显示统计、预算图表、Invocation 数量、项目管理字段或批量操作。

Session header 可显示一个紧凑的 Context 占用提示。它只投影最近一次真实 Model Call 的 `actualInputTokens`（不可用时使用 `measuredInputTokens`）与 `contextWindowTokens`，不累计估算、不形成 Dashboard，也不由 Renderer 自行计数。

Session 列表必须来自 Runtime 的持久化事实。Desktop 不维护状态副本。若 Runtime 尚无安全的 Run 枚举投影，应先补充最小只读 Contract，而不是读取 Core Store 或建立独立历史数据库。

## 5. Conversation flow

Conversation 是按实际发生顺序生成的用户投影，不是 Runtime 原始日志，也不是伪造的聊天记录。它只保留用户理解任务进展和介入执行所必需的信息；完整事实进入 Activity。

允许出现的条目：

- 用户提交的目标或对 Input Request 的回复；
- Runtime 真正持久化并通过公开 Contract 暴露的 Agent delivery / result；
- Provider 通过 Harness 公共输出通道明确返回的 `content` / `reasoning_content` 过程文字；
- Plan 更新摘要；
- Read、Search、Command、Edit 等 Tool Invocation；
- Tool 成功、失败或结果未知；
- Approval 和 Input Request；
- Validation 开始、通过或失败；
- Artifact 产生；
- Run blocked、resumed、failed、cancelled 或 succeeded。

权威条目由 `RunInspection`、持久化 Runtime Event、Tool Invocation、Evidence 和 Result 确定性投影。Provider 的公开文字是临时 Conversation 投影，必须标记为 Agent 输出，不得被当作 Tool 成功、Evidence 或完成事实；可以显示 Provider 明确返回的 `reasoning_content`，但不得生成、补全或推断 Provider 未返回的隐藏推理，也不得根据时间间隔编造“思考过程”。

Provider 过程文字默认放在最多两行的紧凑动态框中，避免长 reasoning 淹没 Conversation；用户可以在原位置展开查看该次 Provider 实际返回的完整过程文字，再次点击收起。折叠状态只属于 Renderer 展示偏好，不成为 Runtime 状态。

Harness 可以通过 Provider-neutral 的临时观察接口转发 Provider 实际返回的 `content` 与 `reasoning_content` 增量。`reasoning_content` 只进入临时展示通道，不并入最终 `ModelResponse.text`。增量携带 Run、Model Call、Attempt 和 sequence，只用于当前 Desktop 渲染，不写入 Run、Event Store、Evidence 或 Context；失败 Attempt 的增量必须丢弃。重启后从持久 Runtime 事实恢复，不恢复未完成 token。`native_tools` 可使用 SSE；`structured_output` 未完成的 JSON 不作为 Markdown 展示。

Agent 公开输出和正式 Result 使用经过转义的 Markdown 渲染。原始 HTML 和非 `http`、`https`、`mailto` 链接不得成为可执行内容。

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

普通 Composer 使用 `Enter` 发送、`Shift + Enter` 换行；输入法组合输入期间不得把 Enter 当作提交。

### Running

Composer 始终可输入，并同时提供停止入口。用户发送时，Desktop 必须先调用当前 Run 的安全取消 Contract；取消完成后才可在同一 Session 创建后续 Run。若未知副作用阻止取消，不得创建后续 Run，必须进入 Recovery。

### Waiting for input

Runtime 的问题作为一条 Nexora 消息进入 Conversation；底部保持普通 Composer，仅 placeholder 提示用户回复。提交时携带真实 request ID，提交完成后恢复运行状态。问题文本不得占用 Composer 或形成独立大面板。

### Waiting for approval

显示 Tool / 操作概要、真实输入，以及“拒绝”“批准”。拒绝可填写原因。关闭或切换 Session 不等于拒绝。

### Blocked / interrupted

仅在 Runtime Contract 允许时显示恢复入口。未知非幂等副作用不得自动重试，必须要求用户选择确认成功、确认失败或放弃 Run。

### Terminal

显示正式 Result 或失败 Delivery。终态 Run 不被复活；用户可以在同一 Session 输入，Desktop 创建新的后续 Run，并把上一 Run 的有界 Delivery 作为明确的 Host continuation context。

## 7.1 Global model settings

Settings 管理 Nexora Desktop 安装级的 OpenAI-compatible Model Profile 目录。Provider 连接由 Base URL 和 API Key 标识，可被同一厂商的多个 Model Profile 复用；新增同 Provider 模型时用户只需选择 Provider 并填写 Model ID、可选 Context Window、decision output tokens 和 Tool transport，不重复填写连接信息。每个 Project 只保存一个 `selectedModelProfileId`，选择只影响该 Project 的后续新 Run；活动 Run 固定使用创建时的 Provider，不热切换也不因全局配置编辑而中断。

全局 Profile 元数据保存在 Desktop Host 配置，Provider secret 保存在独立 Host secret 文件，不进入 Project 元数据、Renderer Snapshot 或普通日志。选中 Profile 的兼容配置镜像到对应 Workspace 的本地 `.env`，使原有 CLI 可继续使用相同 Provider。全局 Profile 可以在任意 Project 运行时增删改；受影响 Project 的 Runtime 仅在该 Project 没有活动 Session、且准备创建后续 Run 时安全重建。切换 Project 或打开 Settings 不受其他 Project 的运行状态限制。

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

正式结果可从成功的 Workspace 写入 / 补丁 Tool Invocation 结果投影紧凑的可点击产物链接。相同路径去重，HTML 交给系统默认浏览器，文档和其他文件交给系统默认应用。Renderer 只提交 Project 与 Workspace 相对路径；Electron Main 必须重新验证 Project 已由 Desktop Host 管理、解析后仍位于 Project 内。Markdown 的 `http`、`https`、`mailto` 链接也只通过受限 Host IPC 打开。

## 10. Desktop host boundary

首版使用 Electron 窗口和独立 Node Runtime Host，Renderer 使用原生 TypeScript、HTML 和 CSS。独立 Node 进程复用仓库现有 `better-sqlite3` ABI，避免为 Electron 建立另一份数据库实现：

- Node Runtime Host：Workspace 生命周期、Provider、Tools、Runtime 和 RunHandle；
- Electron main：窗口生命周期、目录选择和有界 Host bridge；
- Preload：经过 Schema 校验的最小 IPC；
- Renderer：只包含 View Model 和用户意图，不持有 Runtime Authority；
- Runtime：继续拥有状态、计划、副作用、批准、证据、恢复和完成。

安全默认值：`contextIsolation: true`、`nodeIntegration: false`、Renderer sandbox、禁止任意导航、IPC 输入输出 Schema 校验、Workspace 路径边界、Provider secret 不进入 Renderer、大 payload 进入 Artifact。

Electron 与 Node Runtime Host 只交换 JSON 请求、公开 Snapshot 和错误；该进程边界不保存 Run 状态。系统找不到兼容 Node 可执行文件时必须启动失败，不得回退为 Renderer Store。

Desktop Host 可以持久化最近 Project、Session→Run 引用、归档和移除 tombstone；这些只控制导航与 Conversation 组合，不能修改或替代 Run Status、Plan、Invocation、Evidence、Result 或 Completion Gate。

一个 Nexora Desktop Host 在同一进程内为每个已打开 Project 持有独立 Workspace Runtime 和订阅；这不是为每个 Workspace 安装一份 Nexora。切换 Project 只改变当前 Renderer 投影，原 Project 的 Run 可继续在后台执行；同一 Workspace 仍只能由一个 Runtime 实例控制。全局模型变更不会重建或中断活动 Runtime；受影响 Project 在下一次安全创建 Run 前按需重建。关闭 Desktop 时统一释放全部订阅和 Runtime。

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
- 向 active Run 并发追加输入、复活终态 Run，或物理删除 Runtime 审计记录；
- Memory、MCP、Skill、插件市场或 Workflow 编辑器；
- 未由 Provider 返回的隐藏思维链、伪造流式文本或不存在的主动输入能力；Provider 明确返回的 `content` / `reasoning_content` 可以作为非权威临时过程文字展示；
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
11. 切换 Workspace 不打断原 Project 的后台 Run；关闭窗口会释放全部订阅、Provider 与 Runtime；
12. 确定性测试覆盖成功、输入、批准、拒绝、失败、blocked 和 recovery；
13. 真实桌面窗口完成一次创建任务到正式结果的 UAT。
14. 运行中 Composer 可输入；发送会先取消旧 Run，再把新 Run 追加到同一 Session，且不能绕过 unknown Effect Recovery；
15. 终态后可在同一 Session 创建后续 Run，Conversation 和 Activity 保留每个 Run 的边界；
16. Project、Session 归档/恢复/移除和模型设置重启后保持，且 API Key 不出现在 Snapshot。
17. `native_tools` 的公开 Provider 文本可以跨 Worker/IPC 增量显示，失败 Attempt 不保留，token delta 不进入 Runtime Authority；
18. Agent output 和 Result 安全渲染 Markdown，Enter / Shift+Enter / IME 行为可验收；
19. Settings 可全局增删改 Model Profile，同一 Provider 的多个模型复用连接和密钥；每个 Project 独立选择 Profile，切换只影响后续 Run，活动 Run 不被中断。

## 14. Delivery layers

- Feature Core：Windows 本地开发环境可重复启动和完成上述闭环。
- Release gates：依赖安全审查、打包、签名、自动更新、性能和安装体验。
- External acceptance：真实 Provider 凭据、不同 Workspace 和长期日常使用验证。
