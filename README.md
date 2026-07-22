# Nexora 1.1

Nexora 是以自然语言为输入、可持久化执行真实多步骤任务的 CLI 与 Node.js/TypeScript Runtime。

```powershell
$env:NEXORA_MODEL_PROVIDER = "openai-compatible"
$env:NEXORA_MODEL_BASE_URL = "https://provider.example/v1"
$env:NEXORA_MODEL_API_KEY = "..."
$env:NEXORA_MODEL_NAME = "..."

pnpm nexora "检查项目，修复问题，补充测试并确认通过" --cwd D:\project
pnpm nexora inspect <run-id> --cwd D:\project --json
pnpm nexora resume <run-id> --cwd D:\project --approve <request-id>
```

Node 程序可从 `@nexora/runtime` 导入 `createRuntime`、`createBuiltInTools` 和 Provider 工厂，调用 `start/resume/inspect/close`。CLI 与包调用共享同一持久化循环、状态机、工具、Evidence 和验证门。

Run 中 Structured Plan 是唯一计划权威，State Machine 是唯一状态权威，Tool Invocation 是副作用恢复权威；只有 `status === "succeeded"` 表示成功。

E050–E053 已完成确定性验证：Provider 可按有界 Tool description 生成 Plan，只看到 active Tool 的完整 input example，读取权威 Invocation observation，并在 protected Approval 前看到默认值已展开的 canonical input。E053 唯一真实 Provider canary `fb4e0b98-e660-4083-aa40-4dba8ad993e5` 完成 list → read → patch Approval → Node validation Approval → cited Evidence → semantic validation → `succeeded`；外部测试 exit 0，Git 只修改 `src/math.js`。E048/E049/E052 的历史 `verification_blocked` 结论不变。详见 [当前目标](docs/audit/current-goals.md)、[架构](docs/audit/current-architecture.md) 和 [E053 验证报告](docs/audit/e053-validation-report.md)。旧实现可从 `local-workspace` 和 Git snapshot `2e2d4ae` 恢复。
