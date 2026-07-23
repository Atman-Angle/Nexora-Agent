# Nexora 1.1

Nexora 是以自然语言为输入、可持久化执行真实多步骤任务的 CLI 与 Node.js/TypeScript Runtime。

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
# 编辑 .env，填写 Provider URL、API key 和模型名称

pnpm nexora "检查项目，修复问题，补充测试并确认通过" --cwd D:\project
pnpm nexora inspect <run-id> --cwd D:\project --json
pnpm nexora resume <run-id> --cwd D:\project --approve <request-id>
```

在TTY终端直接提供自然语言目标时，CLI会在同一进程显示精确Pending Action并处理批准/输入，正常使用无需复制Run ID或Request ID。人工等待不消耗本次Runtime活跃执行时长预算。非TTY/CI仍在`waiting`时返回退出码2，供调用方显式resume。

CLI 的 start/resume 自动加载启动目录（`process.cwd()`）下的 `.env`；显式进程环境变量优先。`--cwd` 目标项目中的 `.env` 不会被读取。`inspect` 不需要 Provider，也不加载 `.env`。

Node 程序可从 `@nexora/runtime` 导入 `createRuntime`、`createBuiltInTools` 和 Provider 工厂，调用 `start/resume/inspect/close`。CLI 与包调用共享同一持久化循环、状态机、工具、Evidence 和验证门。

成功的CLI最终JSON与可复用Runtime `RunResult`都直接包含经过验证的`summary`；未产生Result时该字段为`null`。summary来自持久化Run Result，CLI不二次生成或润色。

Run 中 Structured Plan 是唯一计划权威，State Machine 是唯一状态权威，Tool Invocation 是副作用恢复权威；只有 `status === "succeeded"` 表示成功。

模型负责理解自然语言并根据五层 Tool Capability Contract 选择最小必要行动；Runtime不实现关键词式自然语言解析，只确定性保证结构、权限、执行、Evidence、恢复和状态。Tool只返回经过自身 Facts Schema 校验的事实，不生成最终答案。最终semantic validation只用全部原始/追加输入、候选summary和已引用Tool事实，不读取模型生成的Plan/Contract或不透明digest。

E050–E061 已完成确定性验证。E061 用 Identity→Capability→Decision→Execution→Evidence 替换可选 description、顶层 risk/idempotent 和泛化 output；模型只看到选择信息与 active Tool 示例，Runtime 才读取 Schema、幂等和 Effect。真实 Run `04f5c0ce-02b3-43fc-a4e1-9804b17dd3bd` 以 list→read、0 retry/rejection 完成。E048/E049/E052 的历史 `verification_blocked` 结论不变。详见 [当前目标](docs/audit/current-goals.md)、[架构](docs/audit/current-architecture.md) 和 [E061 验证报告](docs/audit/e061-validation-report.md)。旧实现可从 `local-workspace` 和 Git snapshot `2e2d4ae` 恢复。
