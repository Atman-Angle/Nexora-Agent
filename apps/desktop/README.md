# Nexora Desktop

Nexora Desktop 是 Nexora Runtime 的官方本地 Agent Workspace。它使用两栏界面：左侧按 Project（Workspace）组织 Session，中间通过同一条 Conversation Flow 展示目标、真实 Tool 活动、验证结果和正式 Result。一个用户 Session 可以包含多个有序 Runtime Run；执行状态始终来自最新 Run，Desktop 不复制 Run 状态、Plan 或完成判断。

## 启动

要求：Windows、Node.js 20+、pnpm 11，以及一个 OpenAI-compatible Provider。

在仓库根目录安装依赖，并创建不会提交到 Git 的 `.env`：

```powershell
pnpm install
@'
NEXORA_MODEL_BASE_URL=https://your-provider.example/v1
NEXORA_MODEL_API_KEY=replace-me
NEXORA_MODEL_NAME=your-supported-model
NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096
NEXORA_MODEL_TOOL_TRANSPORT=native_tools
'@ | Set-Content -LiteralPath .env
```

模型必须存在于当前 Harness capability catalog。Provider 只支持 `native_tools` 或 `structured_output`；具体兼容性见 [`packages/harness/src/providers/README.md`](../../packages/harness/src/providers/README.md)。

启动桌面应用：

```powershell
pnpm desktop
```

该命令构建 Runtime、Harness 和 Desktop，然后打开 Electron 窗口。开发版默认以仓库根目录为 Project；左上角 `＋` 可以添加其他 Workspace。也可以直接从 Settings 配置当前 Project 的 Provider；保存后的 API Key 不会回显给 Renderer。

## 日常使用

1. 点击左上角 `＋` 添加 Project；每个 Project 对应一个 Workspace。
2. 点击 **New Task**，在底部输入目标并提交。
3. 在 Conversation 中查看用户输入、轻量 Tool 活动、Validation 和正式 Result。
4. 点击 Tool 行可展开真实参数、结果、错误、耗时和 Invocation ID。
5. Runtime 存在 Structured Plan 时，Composer 上方会出现只读 Plan 摘要；点击原地展开。
6. Runtime 等待输入或审批时，Composer 自动切换为回答或批准/拒绝入口。
7. 点击 **Activity** 在同一主区域查看持久化 Trajectory；不会打开第三栏。
8. Agent 运行时 Composer 仍可输入。发送会先安全中断当前 Run，再在同一 Session 创建下一 Run；方形按钮只停止当前 Run。
9. Run 终态后 Composer 仍可继续输入，Conversation 和 Activity 会保留同一 Session 中的全部 Run。
10. Session 行悬停后可归档、恢复或从 Desktop 移除。移除不会物理删除 Runtime Run 和审计证据。
11. Settings 可配置 Base URL、API Key、Model、decision tokens 和 Tool transport；运行中的 Session 必须先停止。

Run 数据保存在所选 Workspace 的 `.nexora` 中。Desktop 的最近 Project、Session→Run 链和归档导航信息保存在启动 Workspace 的 `.nexora/desktop-host.json`；它们不改变 Runtime Authority。不要直接编辑数据库或这些 Host 元数据。

## 测试与验收

不使用外部 Provider 的本地验证：

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @nexora/desktop build
pnpm vitest run tests/runtime/d1-developer-runtime-golden-path.test.ts tests/runtime/d2-run-handle-interaction.test.ts tests/runtime/d2-runtime-events.test.ts tests/runtime/d4-package-consumer.test.ts tests/runtime/e129-desktop-read-projections.test.ts tests/runtime/e130-desktop-session-workspace.test.ts --no-file-parallelism
```

使用 `.env` 中真实 Provider 的桌面端到端 UAT：

```powershell
pnpm desktop:uat
```

不使用外部凭据、同时验证“终态后在同一 Session 继续”的确定性 Electron UAT：

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
