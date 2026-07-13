# Nexora 当前版本用户指南

> 版本：v0.1.0 | 日期：2026-06-27 | 状态：早期开发阶段

本文档面向第一次使用 Nexora 的开发者，以当前仓库真实代码为准，不包含尚未实现的规划功能。

---

## 1. 当前版本定位

Nexora v0.1.0 是一个 **Agent Runtime 与 Builder 的开发期早期版本**。当前已实现的核心链路：

```
用户输入 → CLI → Task/Run → Model → Tool → 验证 → 结果
```

已完成的 Feature：F001（Direct Mode）到 F012（Full-stack Feature）均已通过内部验证，但**大部分高级能力仅通过内部 Fixture 和测试验证，尚未暴露为正式用户 CLI 命令**。

**当前可以实际使用的功能**：通过 CLI 执行直接问答、文件读取、文件搜索、文件修改、命令验证和多轮 Agent 循环。

---

## 2. 已开放的用户入口

| 入口 | 状态 | 说明 |
|---|---|---|
| `pnpm nexora <command>` | **可直接使用** | CLI 主入口，通过 tsx 直接运行源码 |
| CLI 15 个命令 | **可直接使用** | ask/read/search/patch/verify/agent 等，详见 §5 |
| Fake Model Provider | **可直接使用** | 默认，无需配置任何模型 |
| OpenAI-Compatible Provider | **需要配置** | 需设置 4 个环境变量 |
| F011 Bug Fix Fixtures | **仅内部 API** | 无 CLI 入口，需通过代码调用 `packages/bugfix` |
| F012 Full-stack Feature | **仅内部 API** | 无 CLI 入口，需通过代码调用 `packages/feature` |
| F010 仓库分析 (project.inspect 等) | **仅内部 API** | Tool 已注册但无 CLI 入口 |

---

## 3. 安装与环境要求

### 3.1 前置依赖

| 依赖 | 要求 |
|---|---|
| Node.js | ≥ 22.x（当前开发使用 v24.11.1）|
| pnpm | ≥ 11.x（当前开发使用 11.7.0）|
| Git | 可选，部分命令需要 |
| 操作系统 | Windows / macOS / Linux |

### 3.2 安装步骤

```powershell
# 1. 克隆仓库
git clone <repo-url>
cd Nexora

# 2. 安装依赖
pnpm install

# 3. （可选）构建
pnpm build

# 4. 验证安装
pnpm nexora --version
# 输出: 0.1.0
```

**说明**：
- `pnpm nexora` 直接运行 TypeScript 源码（通过 `node --import tsx apps/cli/src/index.ts`），**无需先 build**。
- `pnpm build` 生成 `dist/` 下的编译产物，但不影响 CLI 使用。
- Windows 为当前主要开发环境。

---

## 4. 环境变量配置

### 4.1 环境变量一览

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `NEXORA_MODEL_PROVIDER` | 是（模型命令） | 无 | 必须为 `"openai-compatible"` |
| `NEXORA_MODEL_BASE_URL` | 是（模型命令） | 无 | OpenAI 兼容 API 的 base URL |
| `NEXORA_MODEL_API_KEY` | 是（模型命令） | 无 | API Key，不上报日志/事件 |
| `NEXORA_MODEL_NAME` | 是（模型命令） | 无 | 模型名称，如 `gpt-4o-mini` |
| `NEXORA_MODEL_TIMEOUT_MS` | 否 | `60000` | 请求超时（毫秒） |
| `NEXORA_DB_PATH` | 大部分命令必填 | 无 | SQLite 数据库文件路径 |
| `NEXORA_WORKSPACE_ROOT` | 文件/Shell 命令必填 | 无 | 工作区根目录 |
| `NEXORA_ARTIFACT_ROOT` | 否 | `<DB目录>/artifacts` | Artifact 存储目录 |

> R010 破坏性迁移：CLI 不再支持 `fake` 或任何 `NEXORA_FAKE_*` 配置。未配置真实 Provider 时，模型命令返回 `MODEL_CONFIG_ERROR` 并列出所需变量。

### 4.2 最小配置示例

**OpenAI-Compatible 模式**：

```powershell
$env:NEXORA_MODEL_PROVIDER = "openai-compatible"
$env:NEXORA_MODEL_BASE_URL = "https://api.openai.com/v1"
$env:NEXORA_MODEL_API_KEY = "sk-..."       # 填入你的 API Key
$env:NEXORA_MODEL_NAME = "gpt-4o-mini"
$env:NEXORA_DB_PATH = "C:\nexora-data\nexora.db"
$env:NEXORA_WORKSPACE_ROOT = "C:\nexora-data\workspace"
$env:NEXORA_ARTIFACT_ROOT = "C:\nexora-data\artifacts"
```

**路径需提前创建**：
- `NEXORA_DB_PATH` 的父目录（文件由 Nexora 自动创建）
- `NEXORA_WORKSPACE_ROOT` 整个目录
- `NEXORA_ARTIFACT_ROOT` 目录

**不得提交 Git 的文件**：
- `.env`（已在 `.gitignore` 中排除）
- `*.db`、`*.db-wal`、`*.db-shm`
- `.nexora/` 目录

---

## 5. CLI 命令参考

> 状态标记：**可直接使用** | **需要配置** | **仅内部 API** | **仅 Fixture 验证** | **尚未实现**

### 5.1 `ask` — 直接模型问答

```
pnpm nexora ask "<文本>"
```

- **状态**：可直接使用
- **参数**：一段文本
- **输出**：JSON `{ runId, status: "succeeded", text }`
- **会调模型**：是
- **会写数据库**：是（创建 Task、Run、Event、Artifact）
- **会修改 Workspace**：否
- **需要 Approval**：否

```powershell
# 已按 4.2 配置真实 Provider
pnpm nexora ask "解释什么是 monorepo"
# 输出由配置的模型决定
```

### 5.2 `read` — 读取工作区文件

```
pnpm nexora read "<相对路径>"
```

- **状态**：可直接使用
- **参数**：工作区内的相对文件路径
- **输出**：JSON `{ runId, status: "succeeded", text }`
- **会调模型**：否（Tool Mode）
- **会写数据库**：是
- **会修改 Workspace**：否
- **需要 Approval**：否

```powershell
# 先在 workspace 中放一个文件
echo "hello nexora" > $env:NEXORA_WORKSPACE_ROOT\test.txt
pnpm nexora read "test.txt"

# 大文件（>16KB）或二进制文件会存入 Artifact，返回 artifact_ref
```

**限制**：
- 路径不得逃逸 Workspace 根目录（`../` 会被拒绝）
- 符号链接逃逸会被拒绝

### 5.3 `search` — 搜索工作区文件

```
pnpm nexora search "<查询文本>"
```

- **状态**：可直接使用
- **参数**：搜索关键词
- **输出**：JSON `{ runId, status: "succeeded", text }`（text 包含文件路径列表）
- **会调模型**：否（Tool Mode）
- **会写数据库**：是
- **会修改 Workspace**：否
- **需要 Approval**：否

```powershell
pnpm nexora search "add"
# 在 workspace 中搜索包含 "add" 的文件名和内容
```

**实现细节**：
- 默认忽略 `node_modules`、`dist`、`.git`、`coverage`、`tmp`
- 返回匹配文件的路径列表和 snippet（最多 20 条）
- 大型搜索结果显示在 Artifact 中

### 5.4 `patch` — 修改工作区文件

```
pnpm nexora patch "<路径>" "<expectedHash>" "<查找文本>" "<替换文本>" ["<idempotencyKey>"]
```

- **状态**：可直接使用
- **参数**：
  - `路径`：工作区内的相对文件路径
  - `expectedHash`：修改前的文件 SHA256 哈希（防止并发冲突）
  - `查找文本`：要替换的文本
  - `替换文本`：新文本
  - `idempotencyKey`：可选，幂等键
- **输出**：JSON `{ runId, status: "succeeded", text }`
- **会调模型**：否（Tool Mode）
- **会写数据库**：是
- **会修改 Workspace**：是
- **需要 Approval**：**是**（写操作需要审批）

```powershell
# 计算当前文件的哈希
$hash = (Get-FileHash -Algorithm SHA256 test.txt).Hash.ToLower()

# 执行修改（需要通过 approve 命令审批）
pnpm nexora patch "test.txt" $hash "hello" "你好"
# 输出: { "runId":"...", "status":"waiting_for_approval", "approvalId":"..." }

# 审批
pnpm nexora approve "<approvalId>"
# 输出: { "runId":"...", "status":"succeeded", "text":"Patched test.txt..." }
```

**限制**：
- 只支持 `replace_text` 类型（精确字符串替换）
- `expectedHash` 不匹配时拒绝修改（防止覆盖他人修改）
- `patch` 命令本身直接执行；CLI 不内置审批交互

### 5.5 `verify` — 运行验证命令

```
pnpm nexora verify "<命令>" ["<参数>" ...]
```

- **状态**：可直接使用
- **参数**：可执行文件和参数
- **输出**：JSON `{ runId, status: "succeeded", text }`
- **会调模型**：否（Tool Mode）
- **会写数据库**：是
- **会修改 Workspace**：否（只读执行）
- **需要 Approval**：否（只读工具）；`shell.execute` 需要审批

```powershell
pnpm nexora verify "node" "-e" "console.log('test passed')"
```

**限制**：
- 只能在 Workspace 内执行
- 不能执行 `cmd`、`powershell`、`bash` 等 Shell 解释器
- 不能执行 `rm -rf`、`shutdown` 等破坏性命令
- 子进程环境变量经过清理（不继承 `NEXORA_*`、`PATH` 等）

### 5.6 `agent` — 多轮 Agent 循环

```
pnpm nexora agent "<目标>" "<验证命令>" ["<参数>" ...]
```

- **状态**：可直接使用
- **参数**：
  - `目标`：自然语言任务描述
  - `验证命令`：用于验收的可执行文件
  - `参数`：传递给验证命令的参数
- **输出**：
  - 成功时：`{ runId, status: "succeeded", text }`
  - 等待审批时：`{ runId, status: "waiting_for_approval", approvalId }`
- **会调模型**：是
- **会写数据库**：是
- **会修改 Workspace**：是（通过 patch tool）
- **需要 Approval**：是（写操作和 Shell 执行需要审批）

```powershell
# 需先按 4.2 配置真实 Provider
pnpm nexora agent "搜索并分析代码" "node" "-e" "process.exit(0)"
```

Agent 会在每次需要审批时暂停：
```powershell
# 查看待审批操作
pnpm nexora approvals list "<runId>"

# 批准
pnpm nexora approve "<approvalId>" once "原因"

# 拒绝
pnpm nexora deny "<approvalId>" "原因"
```

### 5.7 `approvals list` — 查看待审批操作

```
pnpm nexora approvals list "<runId>"
```

- **状态**：可直接使用
- **输出**：该 run 的所有审批请求列表
- **会调模型**：否
- **会修改 Workspace**：否

### 5.8 `approve` — 批准操作

```
pnpm nexora approve "<approvalId>" ["once"|"current_run"] ["<原因>"]
```

- **状态**：可直接使用
- **参数**：
  - `approvalId`：审批 ID
  - 范围：`once`（单次，默认）或 `current_run`（当前 Run 内复用）
  - 原因：可选
- **输出**：恢复 Agent Loop 后的结果
- **会调模型**：是（恢复 Agent 执行）
- **会修改 Workspace**：是（执行被批准的操作）

### 5.9 `deny` — 拒绝操作

```
pnpm nexora deny "<approvalId>" ["<原因>"]
```

- **状态**：可直接使用
- **输出**：将 Run 标记为 `failed`
- **会修改 Workspace**：否

### 5.10 `requests list` — 查看用户输入请求

```
pnpm nexora requests list "<runId>"
```

Agent 在运行中可以向用户提问（`ask_user` action），用此命令查看待回答的问题。

### 5.11 `respond` — 回复用户输入请求

```
pnpm nexora respond "<requestId>" "<回答>"
```

### 5.12 `run status` / `run cancel` / `run resume`

```
pnpm nexora run status "<runId>"
pnpm nexora run cancel "<runId>"
pnpm nexora run resume "<runId>"
```

- `run status`：查看 Run 的当前状态、审批、用户输入、挂起操作
- `run cancel`：取消 `waiting_for_approval` 或 `waiting_for_user` 的 Run
- `run resume`：从中断中恢复 Run

```powershell
# 查看状态
pnpm nexora run status "<runId>"
# 输出: {"runId":"...","status":"waiting_for_approval","approvals":[...],...}

# 恢复中断的 Run（如 CLI 崩溃后）
pnpm nexora run resume "<runId>"
```

**恢复行为**：
- 只读操作（read/search）：安全重试
- 非幂等操作状态未知时：进入 `blocked`，需手动审查
- Patch 后目标文件已外部变化：旧 patch 作废，重新进入 plan
- 终端状态（succeeded/failed/cancelled）的 Run 不可恢复

---

## 6. 五分钟快速开始

```powershell
# 步骤 1：进入仓库
cd local-workspace

# 步骤 2：安装依赖
pnpm install

# 步骤 3：创建运行目录
mkdir D:\nexora-test\workspace -Force
mkdir D:\nexora-test\artifacts -Force

# 步骤 4：配置真实 OpenAI-Compatible Provider
$env:NEXORA_MODEL_PROVIDER = "openai-compatible"
$env:NEXORA_MODEL_BASE_URL = "https://api.openai.com/v1"
$env:NEXORA_MODEL_API_KEY = "sk-..."
$env:NEXORA_MODEL_NAME = "gpt-4o-mini"
$env:NEXORA_DB_PATH = "D:\nexora-test\nexora.db"
$env:NEXORA_WORKSPACE_ROOT = "D:\nexora-test\workspace"
$env:NEXORA_ARTIFACT_ROOT = "D:\nexora-test\artifacts"

# 步骤 5：查看帮助
pnpm nexora --help

# 步骤 6：执行第一个只读任务
echo "Hello from Nexora" > D:\nexora-test\workspace\hello.txt
pnpm nexora read "hello.txt"
# 输出: {"runId":"...","status":"succeeded","text":"Hello from Nexora"}

# 步骤 7：直接问答
pnpm nexora ask "今天天气怎么样"
# 输出: {"runId":"...","status":"succeeded","text":"<模型回答>"}

# 步骤 8：查看数据库
# 数据库路径: D:\nexora-test\nexora.db
# 可以用 SQLite 工具查看 runs、events、artifacts 等表
```

**更换 OpenAI-Compatible 模型端点**：

```powershell
$env:NEXORA_MODEL_PROVIDER = "openai-compatible"
$env:NEXORA_MODEL_BASE_URL = "https://api.openai.com/v1"
$env:NEXORA_MODEL_API_KEY = "sk-..."       # 替换为真实 Key
$env:NEXORA_MODEL_NAME = "gpt-4o-mini"

pnpm nexora ask "用 TypeScript 写一个 add 函数"
```

---

## 7. 对其他项目使用 Nexora

### 7.1 当前支持的能力

| 能力 | 状态 | 入口 |
|---|---|---|
| 指向其他代码仓库（设置 `NEXORA_WORKSPACE_ROOT`） | **可直接使用** | CLI 环境变量 |
| 读取文件 | **可直接使用** | `pnpm nexora read` |
| 搜索文件 | **可直接使用** | `pnpm nexora search` |
| 修改文件 | **可直接使用**（需审批） | `pnpm nexora patch` + `approve` |
| 执行 Shell 命令 | **可直接使用**（需审批） | `pnpm nexora verify` / `agent` |
| 分析项目结构 | **仅内部 API** | `packages/tool-runtime/src/project-inspect.ts`（无 CLI） |
| 查看 Git 状态 | **仅内部 API** | `packages/tool-runtime/src/git-status.ts`（无 CLI） |
| 目录列表 | **仅内部 API** | `packages/tool-runtime/src/filesystem-list.ts`（无 CLI） |
| 修复 Bug | **仅内部 API** | `packages/bugfix/`（无 CLI，需代码调用） |
| 开发完整功能 | **仅内部 API** | `packages/feature/`（无 CLI，需代码调用） |

### 7.2 实际用法

```powershell
# 将 Nexora 指向任意项目
$env:NEXORA_WORKSPACE_ROOT = "C:\my-project"
$env:NEXORA_DB_PATH = "D:\nexora-data\my-project.db"
$env:NEXORA_ARTIFACT_ROOT = "D:\nexora-data\artifacts"

# 读取文件
pnpm nexora read "package.json"

# 搜索代码
pnpm nexora search "useState"

# 执行测试（无需模型）
pnpm nexora verify "npx" "vitest" "run"
```

**当前限制**：
- `git.status`、`git.diff`、`project.inspect` 等 F010 工具已实现在 Tool Registry 中，但**没有对应的 CLI 命令**——只能通过 Agent Loop 内部调用。
- 没有 `nexora inspect`、`nexora git status` 等用户命令。

---

## 8. Bug Fix 能力使用现状

**当前状态：能力已经通过内部 Fixture 验证，但尚未暴露为正式用户 CLI。**

- **CLI 命令**：无。没有 `nexora bugfix` 命令。
- **入口**：只能通过代码调用 `packages/bugfix/src/` 中的 API。
- **Fixture 位置**：`tests/fixtures/bugfix/`（8 个预定义 Fixture，含 manifest.json 和 template）
- **运行方式**：通过 vitest 测试运行

**开发者最小调用代码**（仅内部使用）：

```typescript
import { parseFixtureManifest } from "./packages/contracts/src/index.js";
import { prepareFixtureEnvironment, runCodingHarness, parseAgentScript } from "./packages/bugfix/src/index.js";

const manifest = parseFixtureManifest(JSON.parse(readFileSync("manifest.json", "utf8")));
const env = prepareFixtureEnvironment({ manifest, runId, templateRoot });
const harness = await runCodingHarness({ manifest, environment: env, agentScript, now, idGenerator });
```

**添加自定义 Fixture**：
1. 在 `tests/fixtures/bugfix/<id>/` 下创建 `manifest.json` 和 `template/` 目录
2. 编写复现命令、验收命令、回归命令
3. 编写 Agent 行为脚本（FakeModel 的 `agentActions`）
4. 通过 `runCodingHarness` 或 `runFixture` 执行

---

## 9. Full-stack Feature 能力使用现状

**当前状态：能力已经通过内部 Fixture 验证，但尚未暴露为正式用户 CLI。**

- **CLI 命令**：无。没有 `nexora feature` 命令。
- **入口**：只能通过代码调用 `packages/feature/src/` 中的 API。
- **Fixture 位置**：`tests/fixtures/fullstack/`（3 个 Fixture）
- **运行方式**：通过 vitest 测试运行

**开发者最小调用代码**（仅内部使用）：

```typescript
import { parseFeatureFixtureManifest } from "./packages/contracts/src/index.js";
import { prepareFeatureFixtureEnvironment, runFeatureCodingHarness } from "./packages/feature/src/index.js";

const manifest = parseFeatureFixtureManifest(JSON.parse(readFileSync("manifest.json", "utf8")));
const env = await prepareFeatureFixtureEnvironment({ manifest, runId, templateRoot });
const harness = await runFeatureCodingHarness({ manifest, environment: env, agentScript, now, idGenerator });
```

**3 个预定义 Fixture**：
1. `data-management` — 数据管理功能（Data→Repository→Service→E2E）
2. `async-task-runtime` — 异步任务功能（复用 Nexora Runtime）
3. `domain-agent-knowledge` — 领域 Agent 集成（知识库，复用 Runtime）

---

## 10. 数据库、Artifact 和日志

### 10.1 数据库

SQLite 数据库位于 `NEXORA_DB_PATH` 指定的路径（WAL 模式）。主要表：

| 表 | 说明 |
|---|---|
| `tasks` | 任务记录 |
| `runs` | Run 状态 |
| `events` | 事件流 |
| `artifacts` | Artifact 记录 |
| `execution_records` | 工具执行记录 |
| `ledgers` | 进度账本 |
| `agent_iterations` | Agent 迭代 |
| `approvals` | 审批记录 |
| `pending_actions` | 挂起操作 |
| `user_inputs` | 用户输入 |
| `checkpoints` | 检查点 |
| `validation_results` | 验证结果 |

**查看方式**：
```powershell
# 使用 sqlite3 工具
sqlite3 D:\nexora-test\nexora.db ".tables"
sqlite3 D:\nexora-test\nexora.db "SELECT run_id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 5"
```

### 10.2 Artifact

Artifact 文件存储在 `NEXORA_ARTIFACT_ROOT` 目录（默认 `<DB目录>/artifacts`）。

**触发条件**：
- 读取大文件（>16KB）
- 读取二进制文件
- 大型搜索结果
- Shell 命令的标准输出/标准错误
- 大型 Git Diff

### 10.3 Workspace

`NEXORA_WORKSPACE_ROOT` 是所有文件操作的根目录。所有路径必须在此目录内，`../` 逃逸会被拒绝。

### 10.4 `.nexora/`

仓库根目录下的 `.nexora/` 是运行时临时目录（已在 `.gitignore` 中排除），包含 `artifacts/` 子目录和 `nexora.db`。**不应提交到 Git**。

### 10.5 日志

当前版本**没有独立的日志文件**。执行状态通过以下方式查看：
- CLI 输出的 JSON（成功/错误）
- SQLite 中的 `events` 表（事件流）
- SQLite 中的 `execution_records` 表（工具执行详情）

### 10.6 临时 Fixture 文件

Bug Fix 和 Full-stack Feature Fixture 在系统临时目录中创建（`os.tmpdir()`），每次运行结束后自动清理。测试框架会清理残留。

---

## 11. Approval、Checkpoint、Recovery

### 11.1 审批机制

**需要审批的操作**：

| 操作 | 风险级别 | 需要 Approval |
|---|---|---|
| `filesystem.read` | read | 否 |
| `filesystem.search` | read | 否 |
| `filesystem.list` | read | 否 |
| `git.status` / `git.diff` / `git.show` | read | 否 |
| `project.commands` / `project.inspect` | read | 否 |
| `filesystem.patch` | write | **是** |
| `shell.execute` | execute | **是** |

**当前 CLI 审批流程**（非交互式）：

```powershell
# 执行需要审批的操作（如 agent）
pnpm nexora agent "修复 add 函数" "node" "test.js"
# 输出: { "status":"waiting_for_approval", "approvalId":"..." }

# 查看待审批
pnpm nexora approvals list "<runId>"

# 批准
pnpm nexora approve "<approvalId>" once "确认安全"

# 拒绝
pnpm nexora deny "<approvalId>" "不符合预期"
```

**审批特性**：
- `once`（单次）：仅审批当前操作
- `current_run`：当前 Run 内同类操作可复用审批
- 审批有 15 分钟有效期
- 过期审批会被自动标记为 `expired`
- 同一 Run 内已批准的操作可复用（`current_run` 范围）

### 11.2 Checkpoint（检查点）

系统在以下时机自动保存检查点：plan 形成后、tool 执行前后、等待审批/用户输入时、审批批准/拒绝后、验证前后、运行时关闭时。

**当前 CLI 不提供直接查看检查点的命令**，检查点数据存储在 SQLite 的 `checkpoints` 表中。

### 11.3 Recovery（恢复）

```powershell
# 查看 Run 状态
pnpm nexora run status "<runId>"

# 恢复中断的 Run（CLI 崩溃、手动中断等）
pnpm nexora run resume "<runId>"
```

**恢复规则**：
- 只读操作（read/search）：安全重试
- Patch 已成功执行：不重复，直接进入验证
- Patch 执行后目标文件被外部修改：旧 patch 作废，重新 plan
- 非幂等且状态未知：进入 `blocked`，需人工审查
- `succeeded`/`failed`/`cancelled` 状态不可恢复

---

## 12. 常见问题

### 12.1 `pnpm nexora` 找不到命令

```
$ pnpm nexora --help
Usage: ...  # 正常输出
```

如果报错 `command not found` 或类似错误：
- 确认在 Nexora 仓库根目录下执行
- 确认 `pnpm install` 已完成
- `pnpm nexora` 调用 `package.json` 中 `scripts.nexora`，实际执行 `node --import tsx apps/cli/src/index.ts`

### 12.2 `.env` 未加载

Nexora CLI **不自动读取 `.env` 文件**。环境变量必须在 Shell 中手动设置：

```powershell
# PowerShell
$env:NEXORA_DB_PATH = "D:\data\nexora.db"

# Bash
export NEXORA_DB_PATH=/data/nexora.db
```

### 12.3 API Key 缺失

```powershell
# 使用 openai-compatible 但未设置 API Key 时：
pnpm nexora ask "hello"
# 输出: {"code":"MODEL_CONFIG_ERROR","message":"NEXORA_MODEL_API_KEY is required."}
```

解决：设置 `NEXORA_MODEL_API_KEY` 环境变量。Key 不会出现在日志、事件或错误消息中。

### 12.4 Workspace 路径越界

```
{"code":"PATH_ESCAPE","message":"Requested path escapes the workspace root."}
```

原因：尝试访问 `NEXORA_WORKSPACE_ROOT` 之外的路径（如 `../outside`）。

解决：确保请求的文件路径在 workspace 内。

### 12.5 数据库目录不存在

```
Error: NEXORA_DB_PATH is required.
```

原因：未设置 `NEXORA_DB_PATH` 或其父目录不存在。

解决：
```powershell
mkdir D:\nexora-data -Force
$env:NEXORA_DB_PATH = "D:\nexora-data\nexora.db"
```

### 12.6 文件无法读取

```
{"code":"FILE_NOT_FOUND","message":"Requested file was not found."}
```

原因：文件不在 workspace 中，或路径拼写错误。

解决：确认文件在 `NEXORA_WORKSPACE_ROOT` 下存在，使用相对路径。

### 12.7 模型响应格式错误（OpenAI-Compatible）

```
{"code":"MODEL_JSON_PARSE_ERROR","message":"..."}
```

原因：模型返回了非 JSON 格式的响应（Agent 模式下需要 JSON）。

解决：
- 检查 `NEXORA_MODEL_NAME` 是否正确
- 使用支持 JSON 输出的模型（如 gpt-4o-mini、gpt-4）
- 查看模型返回的实际内容（通过 `events` 表或 CLI 输出）

### 12.8 测试超时

```
Test timed out in 5000ms.
```

原因：Windows 下多个 CLI 测试并行运行时可能出现超时。

解决：单独运行超时的测试：
```powershell
pnpm vitest run <test-file> --testTimeout=60000
```

### 12.9 Windows 文件清理失败

```
Feature cleanup failed: ... temp root could not be removed
```

原因：Windows 下 Git 或 Node.js 进程可能持有临时文件的句柄。

解决：
- 等待几秒后重试
- 手动清理 `%TEMP%\nexora-*` 目录
- 重启后清理

### 12.10 Run 进入 `blocked` 状态

```
{"runId":"...","status":"blocked","text":"Run ... was interrupted ... and needs manual review."}
```

原因：恢复时遇到非幂等操作且状态未知（如进程可能在执行中）。

解决：
- 查看 `run status` 获取详细信息
- 人工审查工作区状态后决定是否继续
- 目前无法从 CLI 解除 `blocked`（需要代码层面操作）

### 12.11 Completion Gate 未通过

Agent 执行可能进入 `failed` 状态，失败原因包括：
- `VALIDATION_FAILED`：验收命令未通过（exit 非 0）
- `MODEL_FINAL_REJECTED`：模型在验收未通过前就提出 final
- `NO_PROGRESS`：连续重复相同操作无进展
- `BUDGET_EXCEEDED`：超出迭代/工具调用/时长预算

解决：查看失败原因后调整 Agent 脚本或验收命令。

---

## 13. 当前限制

1. **没有任何交互式 UI**：所有操作通过 CLI 命令+环境变量+JSON 输出，无聊天界面、无进度条。
2. **CLI 不自动读取 `.env`**：环境变量必须手动设置。
3. **模型命令必须配置真实 Provider**：未设置 `NEXORA_MODEL_PROVIDER=openai-compatible` 及其三项连接变量时，CLI 返回可操作的 `MODEL_CONFIG_ERROR`。
4. **确定性 Provider 脚本仅用于内部测试**：不是 CLI 用户配置能力。
5. **审批是非交互式的**：需要用户在单独的终端窗口中手动执行 `approve`/`deny` 命令。
6. **Shell 执行受限**：不能执行 cmd/powershell/bash；不能执行 `rm -rf` 等破坏性命令；子进程只能访问有限的系统 PATH；不继承 `NEXORA_*` 变量。
7. **F010 仓库分析工具无 CLI**：`git.status`、`project.inspect` 等已实现在 Agent 内部可用，但用户无法直接通过 CLI 调用。
8. **Bug Fix 和 Feature 能力无 CLI**：只能通过代码/测试使用。
9. **无 Workflow DSL、Skill Runtime、MCP、Desktop UI**：这些均为后续 Feature（F013–F020），当前未实现。
10. **文件 Patch 只支持精确字符串替换**：不支持正则、多文件、结构化编辑。

---

## 14. 已验证但尚未产品化的能力

以下能力已经通过内部验证（CR-001 至 CR-012 全部通过），但**尚未暴露为正式用户入口**：

| 能力 | 实现位置 | 测试覆盖 | 用户入口 |
|---|---|---|---|
| 仓库结构分析（Project Inspect） | `packages/tool-runtime/src/project-inspect.ts` | 10 tests | **无 CLI** |
| Git 状态/Diff/Show | `packages/tool-runtime/src/git-*.ts` | 16 tests | **无 CLI** |
| 目录列表（filesystem.list） | `packages/tool-runtime/src/filesystem-list.ts` | 8 tests | **无 CLI** |
| 项目命令发现（project.commands） | `packages/tool-runtime/src/project-commands.ts` | 5 tests | **无 CLI** |
| Bug Fix Fixtures | `packages/bugfix/` | 44 tests | **无 CLI** |
| Full-stack Feature Fixtures | `packages/feature/` | 25 tests | **无 CLI** |
| Context Compaction（F008） | `packages/context/src/compaction.ts` | 验证通过 | Agent 内部自动 |
| Recovery 恢复（F009） | `apps/cli/src/index.ts`（`run resume`） | 验证通过 | **有 CLI** |
| Model Provider（OpenAI-Compatible） | `packages/model-gateway/` | 18 tests | **有 CLI** |
| Approval 审批链路 | `apps/cli/src/index.ts` | 验证通过 | **有 CLI** |

---

## 15. 下一步应补充的用户入口

按优先级排列：

1. **`nexora inspect`** — 将 `project.inspect` 暴露为 CLI 命令，输出结构化 Repository Profile。这会让用户能直接分析任意项目。
2. **`nexora git status` / `nexora git diff`** — 暴露 F010 的 Git 工具，让用户能查看项目 Git 状态。
3. **`.env` 自动加载** — CLI 启动时自动读取当前目录或家目录的 `.env` 文件，降低初次使用门槛。

---

> **文档路径**：`docs/USER_GUIDE_CURRENT.md`
> **最后更新**：2026-06-27
> **基于代码版本**：F012 done（commit `e9788c1` 及未提交 F010/F012 工作）
