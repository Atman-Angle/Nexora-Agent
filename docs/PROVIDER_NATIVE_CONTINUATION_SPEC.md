# Provider-native Tool Continuation Spec

状态：`IMPLEMENTED / VERIFIED`

Feature：`provider-native-continuation`

Owner：`@nexora/harness`；`@nexora/runtime` 只保存通用审计事实

风险等级：`L3`

文档日期：2026-08-17

## 1. 问题

OpenAI-compatible Provider 的原生 Function Calling 是多轮协议。Provider 返回
`assistant.tool_calls` 后，下一次请求必须包含原始 assistant Tool Calls，以及每个
`tool_call_id` 对应的 `role: "tool"` 结果。

当前 Nexora 执行了调用，却在下一轮只发送新的 system/user 消息。Provider 因而无法把
Runtime Observation、Plan 更新或人工输入与先前调用关联，可能重复调用、持续推理直到
输出预算耗尽，或返回空响应。此行为是 Nexora 协议缺陷，不能归因于具体模型。

## 2. 目标

1. 对 `native_tools` 发送标准 assistant/tool 续传消息。
2. Runtime Tool、Plan control、HITL control 和拒绝结果均完整闭合每个 call ID。
3. 续传可在进程重启后从当前 Runtime Authority 确定性重建。
4. Provider call ID 仅是审计和 wire correlation，不成为执行或状态 Authority。
5. 续传有界并进入 Provider token 计量与 Context 收缩。
6. `structured_output` 行为保持不变。

## 3. Authority 与数据流

```text
Provider normalized Tool Calls
→ model.turn 审计事实（callId/name/arguments）
→ Harness 确定性编译
→ Runtime Plan / Tool Invocation / waiting / rejection Authority
→ Harness 从 Journal + Invocation + Run Snapshot 派生一次续传
→ OpenAI-compatible assistant/tool messages
```

不得保存可变 Provider session，不得把 Provider call ID 写入 Runtime Action、Plan、
Invocation authority 或 Completion Gate。续传只读取最新 `model.turn` 之后的确定性事实。

## 4. Contract

`model.turn` 对已规范化的每个 Tool Call 持久化 `callId`、内部 Tool 名称和规范化参数。
`ModelDecisionContext` 可携带最近一个已闭合批次，包括原始 assistant 文本、调用和有界结果。

只有所有调用都能由当前 Authority 得到结果时才投影该批次。Runtime Tool 结果来自匹配的
Invocation；Plan 结果来自 `plan.set`；HITL 结果来自 `run.waiting` 后的恢复输入；被 Harness
拒绝的调用得到有界错误结果。不得猜测缺失结果。

## 5. Wire 规则

`native_tools` 的下一次 OpenAI-compatible 请求顺序为：

```text
system
user      bounded continuation context marker
assistant original content + tool_calls
tool      result for call 1
tool      result for call 2
...
user      current canonical Runtime context
```

Tool 名称使用本次 Tool 注册表确定性生成的 Provider alias；`tool_call_id` 必须逐字保留。
每个 assistant Tool Call 必须恰有一个 tool result。普通 assistant text永远不解析为 Tool。

`structured_output` 不生成续传消息。Delivery-only 轮可以保留已闭合续传事实，但不能重新开放 Tool。

## 6. 有界与恢复

- 最多保留最近一个批次，最多 8 个调用。
- Tool 结果复用现有 `ToolObservation` 的 full/fragment/reference 投影，不发送无限原始结果。
- Context 超预算时收缩 continuation 结果，但不能截断 call ID、名称或参数使协议失效。
- 重新打开 Runtime 后，相同 Journal、Invocation 和 Run Snapshot 必须产生相同续传。
- 旧 `model.turn` 没有 calls 时视为没有续传，保持向后可读。

## 7. 错误语义

- Tool success/failure 都生成 `role: "tool"`。
- 参数或 Harness 语义拒绝生成 `{ ok: false, error: ... }`，下一轮允许模型局部修正。
- `nexora_update_plan` 返回 accepted 及权威 Plan version，或 rejected error。
- `nexora_request_input` 仅在用户恢复后返回 accepted 及输入序号；等待期间不发下一请求。
- 批次必须保持 call/result 一一对应；部分成功时成功 sibling 使用 Invocation 事实，其余使用拒绝事实。

## 8. 验收

1. Wire 测试精确验证 assistant/tool 顺序、alias、arguments 和 call ID。
2. Runtime Tool、Plan、HITL、Tool failure、参数拒绝和批次均闭合结果。
3. 重启恢复产生等价续传。
4. 大结果被有界投影，token meter 计算完整消息。
5. structured output 与普通文本路径无回归。
6. L3 Core、全量测试、NexoraBench 和打包消费通过。
7. 真实 DeepSeek 复杂前端 Canary 实际创建并验证文件，或留下可定位且不误报的外部失败证据。

## 9. 删除项

修复完成后不得保留仅发送 system/user 的旧 native wire 路径，不得增加 Provider/model 名称
特判、自然语言 Action、`json_actions`、Action repair 或隐式 transport fallback。
