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

E050–E052 确定性验证已通过，包括真实 HTTP Stub、SQLite、read/patch/shell、两次批准、CLI 跨进程恢复、严格 cited Evidence 完成门、非零 validation 失败，以及来自权威 Tool Invocation 的最多 8 项/约 32 KiB Provider observation。E052 唯一真实 Provider canary 在首个越界 `shell.execute("dir /b .")` Approval Request 处安全停止，0 Tool Invocation、0 Evidence、0 diff，因此状态为 `implementation_complete_verification_blocked`；E048/E049 的历史结论也不变。详见 [当前目标](docs/audit/current-goals.md)、[架构](docs/audit/current-architecture.md) 和 [E052 验证报告](docs/audit/e052-validation-report.md)。旧实现可从 `local-workspace` 和 Git snapshot `2e2d4ae` 恢复。
