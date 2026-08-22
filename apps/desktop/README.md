# Nexora Desktop

Nexora Desktop 是 Nexora Runtime 的官方本地 Agent Workspace。它使用两栏界面：左侧切换 Workspace 和 Session，中间通过同一条 Conversation Flow 展示目标、真实 Tool 活动、验证结果和正式 Result。面向用户称为 Session，底层仍是 Runtime Run；Desktop 不保存第二套状态。

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

该命令构建 Runtime、Harness 和 Desktop，然后打开 Electron 窗口。开发版默认以仓库根目录为 Workspace；可以从左上角切换到其他目录。Provider secret 只在 Node Runtime Host 中读取，不进入 Renderer。

## 日常使用

1. 点击 Workspace 名称选择工作目录。
2. 点击 **New Task**，在底部输入目标并提交。
3. 在 Conversation 中查看用户输入、轻量 Tool 活动、Validation 和正式 Result。
4. 点击 Tool 行可展开真实参数、结果、错误、耗时和 Invocation ID。
5. Runtime 存在 Structured Plan 时，Composer 上方会出现只读 Plan 摘要；点击原地展开。
6. Runtime 等待输入或审批时，Composer 自动切换为回答或批准/拒绝入口。
7. 点击 **Activity** 在同一主区域查看持久化 Trajectory；不会打开第三栏。
8. 终态 Session 不能伪装成连续聊天；点击 **New follow-up** 创建新的 Run。

Session 数据保存在所选 Workspace 的 `.nexora` 中。重启 Desktop 后，左栏通过公开 Runtime API 恢复这些 Session。不要直接编辑数据库或 `.nexora` 内容。

## 测试与验收

不使用外部 Provider 的本地验证：

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @nexora/desktop build
pnpm vitest run tests/runtime/d1-developer-runtime-golden-path.test.ts tests/runtime/d2-run-handle-interaction.test.ts tests/runtime/d2-runtime-events.test.ts tests/runtime/d4-package-consumer.test.ts tests/runtime/e129-desktop-read-projections.test.ts --no-file-parallelism
```

使用 `.env` 中真实 Provider 的桌面端到端 UAT：

```powershell
pnpm desktop:uat
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
