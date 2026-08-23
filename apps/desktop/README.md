# Nexora Desktop

Nexora Desktop 是 Nexora Runtime 的官方本地 Agent Workspace。它使用两栏界面：左侧按 Project（Workspace）组织 Session，中间通过同一条 Conversation Flow 展示目标、真实 Tool 活动、验证结果和正式 Result。一个用户 Session 可以包含多个有序 Runtime Run；执行状态始终来自最新 Run，Desktop 不复制 Run 状态、Plan 或完成判断。

## 启动

要求：Windows、Node.js 20+、pnpm 11，以及一个 OpenAI-compatible Provider。

在仓库根目录安装依赖。首次启动可以直接在 Desktop Settings 中添加全局 Provider 和模型；也可以先创建不会提交到 Git 的 `.env`，Desktop 会在首次迁移时导入它：

```powershell
pnpm install
@'
NEXORA_MODEL_BASE_URL=https://your-provider.example/v1
NEXORA_MODEL_API_KEY=replace-me
NEXORA_MODEL_NAME=your-supported-model
NEXORA_MODEL_CONTEXT_WINDOW_TOKENS=128000
NEXORA_MODEL_ACTIVE_INPUT_TOKENS=96000
NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096
NEXORA_MODEL_TOOL_TRANSPORT=native_tools
NEXORA_MODEL_REASONING=dynamic
NEXORA_MODEL_THINKING_PARAM=enable_thinking
NEXORA_MODEL_TIMEOUT_MS=300000
NEXORA_MODEL_CONNECT_TIMEOUT_MS=60000
NEXORA_MODEL_MAX_DURATION_MS=1800000
'@ | Set-Content -LiteralPath .env
```

内置 capability catalog 已知的模型可以省略 `NEXORA_MODEL_CONTEXT_WINDOW_TOKENS`；自定义模型必须明确填写真实 Context Window。`NEXORA_MODEL_ACTIVE_INPUT_TOKENS` 是低于容量上限的成本/延迟目标；未配置时 OpenAI-compatible Provider 默认不超过 128K，且不会放宽原有 hard/soft capacity boundary。Provider 支持 `native_tools` 或 `structured_output`。支持厂商 thinking 开关时，`dynamic` 会在普通机械 Turn 明确关闭长推理，只在恢复等语义压力下开启；DashScope 的参数名是 `enable_thinking`。`NEXORA_MODEL_CONNECT_TIMEOUT_MS` 限制等待响应头的时间；响应建立后，`NEXORA_MODEL_TIMEOUT_MS` 是流式空闲时限而不是整个生成时长，每个真实 SSE frame 都会续期。`NEXORA_MODEL_MAX_DURATION_MS` 是独立的 Attempt 安全总上限。具体兼容性见 [`packages/harness/src/providers/README.md`](../../packages/harness/src/providers/README.md)。

启动桌面应用：

```powershell
pnpm desktop
```

该命令构建 Runtime、Harness 和 Desktop，然后打开 Electron 窗口。开发版默认以仓库根目录为 Project；左上角 `＋` 可以添加其他 Workspace。Settings 管理整个 Nexora Desktop 共用的 Provider 和模型目录；保存后的 API Key 不会回显给 Renderer。

## 日常使用

1. 点击左上角 `＋` 添加 Project；每个 Project 对应一个 Workspace。
2. 点击 **New Task**，在底部输入目标并提交。
   普通问答可由 Harness 基于现有权威 Context 直接回复；依赖当前项目文件、Git、命令或外部状态时，Agent 会进入同一 Run 的真实 Tool / Evidence 路径。
3. 在 Conversation 中查看模型公开的流式工作说明、轻量 Tool 活动、Validation 和正式 Result。`native_tools` 支持 Provider 实际返回的 `content` / `reasoning_content` SSE 增量；Think 行持续显示最新尾部片段，点击后展开持久化全文。同一 Attempt 已有 reasoning 时，重复的非终态 content 不会再次铺开；没有 reasoning 的工作 content 也保持折叠。只有与 Runtime 正式 Result 一致的 content 才完整渲染 Markdown。失败、取消或超时 Attempt 的临时文字会丢弃。它们不作为 Evidence 或完成事实。`structured_output` 等待完整 JSON，不显示伪造流。
4. 正式结果会把成功写入或补丁产生的 Workspace 文件显示为去重后的可点击产物；HTML 使用默认浏览器，文档和其他文件使用系统默认应用。打开前由 Desktop Host 重新验证 Project 和路径边界。
5. Tool 名称和状态默认保持单行，并显示最多 8 行的真实结果或错误预览；点击 Tool 行可展开完整参数、结果、错误、耗时、Invocation ID 和 Artifact。
6. Runtime 存在 Structured Plan 时，Composer 上方会出现只读 Plan 摘要；点击原地展开。
7. Runtime 等待输入或审批时，Composer 自动切换为回答或批准/拒绝入口。
8. 点击 **Activity** 在同一主区域查看持久化 Trajectory；不会打开第三栏。
9. Agent 运行时 Composer 仍可输入。发送会先安全中断当前 Run，再在同一 Session 创建下一 Run；方形按钮只停止当前 Run。
10. Run 终态后 Composer 仍可继续输入，Conversation 和 Activity 会保留同一 Session 中的全部 Run。
11. Session 行悬停后可归档、恢复或从 Desktop 移除。移除不会物理删除 Runtime Run 和审计证据。
12. `Enter` 发送，`Shift + Enter` 换行；中文输入法仍在组字时不会误发送。
13. Settings 可全局增删改 OpenAI-compatible 模型 Profile，包括 Base URL、API Key、Model ID、Context Window、Active Context Target、decision tokens、Tool transport、Reasoning Policy 和可选厂商 thinking 参数。同一 Base URL 的多个模型复用 Provider 密钥；每个 Project 通过顶部选择器决定后续新 Run 使用的 Profile。Settings 编辑、Project 切换和全局模型管理不会停止其他正在运行的 Session；活动 Run 始终保留创建时的 Provider。
14. 在普通 Composer 输入 `/压缩上下文`（兼容 `/compact`）会请求 Runtime 压缩该 Session 的历史投影；若当前 Run 正在执行，Desktop 会先安全停止它。命令不会发送给模型、不会进入输入历史，也不会删除 Conversation、Tool、Evidence 或 Artifact。下一条消息仍在同一 Session 继续；接近模型窗口限制时 Harness 也会按真实 Token Meter 自动收缩，并在 Conversation / Activity 显示持久化结果。

当 Runtime 检测到重复 Tool 结果、重复失败、等价 Plan 或相同完成拒绝持续没有产生新权威事实时，会以 `NO_PROGRESS_DETECTED` 暂停，而不是继续消耗模型和 Tool 预算。已有 delegated Worker 被阻塞时，Parent Session 的 Composer 会提供恢复同一 Worker 或放弃其隔离 Branch 的操作。内部 Worker Run 只出现在 Parent Activity 中，不会成为左栏 Session；Desktop 新任务默认不启用隐式 Worker 委派。

Run 数据保存在所选 Workspace 的 `.nexora` 中。一个 Nexora Desktop Host 可以同时管理任意已添加的本地 Workspace；每个 Workspace Runtime 是同一 Host 内的隔离实例，不是单独安装 Nexora。Desktop 的最近 Project、Session→Run 链、全局 Model Profile 元数据和归档导航信息保存在启动 Workspace 的 `.nexora/desktop-host.json`；全局 Provider 密钥保存在 `.nexora/desktop-secrets.env`。每个 Project 只保存选中的 Profile ID，兼容配置会镜像到对应 Workspace `.env`，因此原有 CLI 可继续使用相同 Provider。API Key 不进入 Host JSON 或 Renderer Snapshot。Host 元数据不改变 Runtime Authority。

## 测试与验收

不使用外部 Provider 的本地验证：

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @nexora/desktop build
pnpm vitest run tests/runtime/e084-model-config.test.ts tests/runtime/e121-provider-native-tool-protocol.test.ts tests/runtime/e129-desktop-read-projections.test.ts tests/runtime/e130-desktop-session-workspace.test.ts tests/runtime/e131-provider-public-stream.test.ts tests/runtime/e132-desktop-markdown.test.ts tests/runtime/e132-manual-context-compaction.test.ts --no-file-parallelism
```

使用 `.env` 中真实 Provider 的桌面端到端 UAT：

```powershell
pnpm desktop:uat
```

不使用外部凭据，同时验证 Enter 发送、公开文字流、Markdown、真实 Tool/Evidence 和“终态后在同一 Session 继续”的确定性 Electron UAT：

```powershell
pnpm desktop:uat:deterministic
```

UAT 会打开真实 Electron Renderer，通过 Composer 提交一个只读目标，并等待 Runtime 正式终态。只有持久化 `status === "succeeded"` 才通过；等待输入、等待审批、blocked、failed、cancelled 或超时都以非零退出码失败。默认产物：

- `.tmp/desktop-uat-report.json`：Run ID、终态、Invocation、Evidence 和 Result；
- `.tmp/desktop-uat.png`：终态窗口截图。

可选环境变量：

```powershell
$env:NEXORA_DESKTOP_UAT_GOAL = '只读检查 README.md 并总结；不要修改文件。'
$env:NEXORA_DESKTOP_UAT_TIMEOUT_MS = '180000'
$env:NEXORA_DESKTOP_UAT_REPORT_PATH = '.tmp/my-desktop-uat.json'
$env:NEXORA_DESKTOP_UAT_CAPTURE_PATH = '.tmp/my-desktop-uat.png'
pnpm desktop:uat
```

真实 UAT 会产生 Provider 调用和本地持久 Run。目标应保持只读，除非验收者明确授权写操作及其审批。

## 当前边界

首版没有右栏、Workbench、Dashboard、文件树、编辑器、交互终端、安装包、签名、自动更新或内置 Node 分发。当前可重复启动方式是从源码运行 `pnpm desktop`；打包、签名、自动更新和安装体验仍是独立 Release Gates。

完整产品与 Authority 约束见 [`docs/NEXORA_DESKTOP_WORKSPACE_SPEC.md`](../../docs/NEXORA_DESKTOP_WORKSPACE_SPEC.md)。
