# Nexora Manual Context Compaction — Feature Spec

状态：`DONE LOCALLY`

Feature：`manual-context-compaction`

风险等级：`L3`

## Outcome

用户可在 Desktop Session Composer 输入 `/压缩上下文`（兼容 `/compact`）主动压缩此前 Context；Harness 在接近 Provider Context soft/hard limit 时继续自动压缩。两种路径都保留完整 Runtime 历史，只改变后续 Model Call 的有界 Context View，并在 Conversation / Activity 中展示真实发生的压缩事实。

## Authority and flow

### Manual

```text
Desktop slash command
→ latest Run safely reaches terminal state
→ RunHandle.compactContext()
→ Runtime appends context.compaction.requested
→ next continuation Run reads verified ancestor event
→ older ancestors reference, boundary ancestor compact, later turns full
```

Slash command 不进入 `inputHistory`，不创建假用户任务，不调用模型生成摘要，也不删除 Conversation、Event、Invocation、Evidence 或 Artifact。重复请求可追加新的真实边界；当前 Run 的输入和执行状态仍由原有 Authority 决定。

### Automatic

Harness 继续以最终 Provider wire 的真实 Token Meter 和 Model Profile soft/hard limit 为触发条件。发生收缩时，`model.requested` 必须记录：

- `compacted: true`；
- `compactionMode: automatic`；
- `tokenEvictionCount`；
- 收缩前和最终 measured input tokens。

未收缩时记录 `compacted: false`。前端只投影这些事实，不自行估算或宣称压缩。

## Runtime boundary

- 新增 `RunHandle.compactContext()`；
- 只允许 terminal Run 且没有 started/unknown Invocation；
- 写入 append-only `context.compaction.requested` Journal record；
- continuation ancestor 读取严格限制在 Child 捕获的 parent event boundary，允许 Parent 后续追加审计事件而不破坏既有 Child；
- 不使用或扩展遗留 `context_checkpoints` 表，不新增迁移。

## Desktop behavior

- Terminal Session：执行命令后保持同一 Session，显示“上下文已压缩，将用于下一条消息”；
- Running Session：先安全取消当前 Run，再记录压缩请求；
- waiting / approval / blocked：保持现有 Composer 专用交互，不接受该命令；
- 普通文本仍走原有 follow-up；
- 自动压缩后显示轻量单行结果，不增加面板。

## Non-goals

- LLM summary / compaction Provider phase；
- Renderer 删除或重写历史；
- Context checkpoint 数据库或第二 Context Authority；
- 手动编辑压缩内容；
- 把 `/压缩上下文` 发送给 Agent；
- 累计 Session token 作为触发条件。

## Acceptance

1. terminal Run 可持久化 compaction request，重启后仍可读；
2. running Desktop Session 执行命令时先安全取消；
3. waiting/blocked/unknown effect 不绕过现有边界；
4. Slash command 不进入任何 Run inputHistory；
5. 下一 continuation Run 的祖先投影在无 Token 压力时也按 request boundary 收缩；
6. sibling Session 不继承 request；
7. 自动 Token eviction 的 persisted `model.requested` 显示真实 before/final tokens 和 eviction count；
8. 无 eviction 时不得显示自动压缩；
9. Desktop Conversation 和 Activity 可看到手动/自动压缩事实；
10. Context Meter 仍对应最新实际 Model Call；
11. Runtime/Harness Context、Recovery、Desktop 回归通过；
12. Desktop deterministic UAT 通过并可重新启动。

## State

```yaml
feature: manual-context-compaction
mode: VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed
integration_test_status: passed
uat_status: passed
runtime_status: verified
security_status: verified
external_dependency_status: clear
artifact_status: tracked
resolved_status: done_locally
```

本地证据：手动/自动/连续 Session 定向回归 22/22；Context Quality 65/65；Runtime/Harness Release 88/88；`typecheck`、`lint`、全仓与 Desktop build、确定性 Electron UAT、`git diff --check` 均通过。真实 Provider 长 Session canary 未运行，不属于本 Feature 的本地完成门。
