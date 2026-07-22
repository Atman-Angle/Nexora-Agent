# Nexora 1.1

Nexora 是以自然语言为输入、可持久化执行真实多步骤任务的 CLI 与 Node.js/TypeScript Runtime。

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
# 编辑 .env，填写 Provider URL、API key 和模型名称

pnpm nexora "检查项目，修复问题，补充测试并确认通过" --cwd D:\project
pnpm nexora inspect <run-id> --cwd D:\project --json
pnpm nexora resume <run-id> --cwd D:\project --approve <request-id>
```

CLI 的 start/resume 自动加载启动目录（`process.cwd()`）下的 `.env`；显式进程环境变量优先。`--cwd` 目标项目中的 `.env` 不会被读取。`inspect` 不需要 Provider，也不加载 `.env`。

Node 程序可从 `@nexora/runtime` 导入 `createRuntime`、`createBuiltInTools` 和 Provider 工厂，调用 `start/resume/inspect/close`。CLI 与包调用共享同一持久化循环、状态机、工具、Evidence 和验证门。

成功的CLI最终JSON与可复用Runtime `RunResult`都直接包含经过验证的`summary`；未产生Result时该字段为`null`。summary来自持久化Run Result，CLI不二次生成或润色。

Run 中 Structured Plan 是唯一计划权威，State Machine 是唯一状态权威，Tool Invocation 是副作用恢复权威；只有 `status === "succeeded"` 表示成功。

模型负责理解自然语言并根据Tool description选择工具；Runtime不实现关键词式自然语言解析，只确定性保证结构、权限、执行、Evidence、恢复和状态。最终semantic validation必须重新对照全部原始与追加输入。

E050–E059 已完成确定性验证：Provider 可按有界 Tool description 生成 Plan，只看到 active Tool 的完整 input example，读取权威 Invocation observation，并在 protected Approval 前看到默认值已展开的 canonical input。`filesystem.search` 在原 RuntimeTool 内直接使用 bundled Ripgrep，不恢复旧 Registry/状态架构。E053 mutation、E055 search/read、E058 自然语言字面搜索与E059结果显示canary均完成 cited Evidence → semantic validation → `succeeded`；E058同时证明否定Tool不会被Runtime反向提取为要求，遗漏动作不会通过最终验证。E048/E049/E052 的历史 `verification_blocked` 结论不变。详见 [当前目标](docs/audit/current-goals.md)、[架构](docs/audit/current-architecture.md) 和 [E059 验证报告](docs/audit/e059-validation-report.md)。旧实现可从 `local-workspace` 和 Git snapshot `2e2d4ae` 恢复。
