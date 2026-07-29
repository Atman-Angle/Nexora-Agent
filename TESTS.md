# TESTS.md — Nexora 测试与验收策略

## 1. 测试层级

```text
L0 Static
L1 Unit
L2 Contract
L3 Integration
L4 Feature Chain
L5 Recovery
L6 Security
L7 Agent Eval
L8 User Acceptance
```

测试层级是可选择的工具，不是每个 Feature 都必须全部执行。

## 2. 风险分级

### L1 — 局部修改

适用于：

- 纯函数和局部逻辑；
- 错误信息或输出映射；
- 不改变 Contract、状态、持久化和跨模块数据流的修改。

最低验证：

```text
目标测试
+ 必要 Static Check
+ Diff Review
```

### L2 — 边界修改

适用于：

- 模块间数据传输；
- Tool/API Contract；
- 持久化读写；
- Approval、Context 或跨模块调用；
- 已有边界内的行为变化。

最低验证：

```text
目标测试
+ Contract / Integration
+ 相关 Core Regression
+ Diff Review
```

必须验证：

```text
发送方实际输出
→ Contract
→ 接收方实际读取
→ 持久化
→ 下游真实消费
```

不得 Mock 掉正在验证的关键边界。

### L3 — 系统级修改

适用于：

- Runtime Loop；
- State Machine；
- Completion Gate；
- Checkpoint / Recovery；
- 核心数据 Authority；
- 安全边界；
- Capability Integration。

最低验证：

```text
Feature Chain
+ Recovery / Security
+ 全部 Core Regression
+ 真实入口 UAT
+ 正向/逆向证据检查
```

涉及状态、持久化、跨模块 Contract、Approval、Completion 或 Recovery，
最低为 L2；

涉及 Authority、Run Loop、State Machine 或安全边界，
必须为 L3。

### Release

发布候选执行：

```text
全部测试
+ 全部固定 UAT
+ 正向 SOP
+ 逆向 SOP
+ Git Diff / Packaging / Consumer 验证
```

## 3. Core Regression 标签

Core Regression 按能力打标签：

```text
CR-direct
CR-read
CR-search
CR-mutation
CR-approval
CR-validation
CR-context
CR-recovery
CR-cli
CR-host-integration
```

执行规则：

```text
L1 → 目标测试
L2 → 目标测试 + 受影响标签
L3 / Release → 全部 Core Regression
```

不得默认让每个 Feature 运行全部既有回归。

## 4. 固定用户验收

以下 UAT 用于 Capability Integration、Runtime 核心变化和发布前验收：

```text
UAT-01 Search / Read
UAT-02 Literal Search
UAT-03 Mutation / Approval / Validation
UAT-04 Denial Safety
```

验收必须使用隔离的临时 Git 工作区，并检查：

- 自然语言产生真实多步骤执行；
- Tool 结果来自真实工作区；
- inspect 可反查 Input、Plan、Invocation、Evidence 和 Result；
- 写操作未批准前不执行；
- 拒绝操作不误报成功；
- 修改仅发生在允许范围；
- 只有 succeeded / VALIDATED 才视为成功；
- Runtime 或验证失败时没有成功 Result。

### 4.1 Feature Core 与真实 Provider 验收边界

固定场景同时用于两层证据，但结论必须分开：

```text
Feature Core
→ deterministic failure injection
→ real Store / Tool / package integration
→ Authority, safety, persistence and recovery

External Environment Acceptance
→ real Provider endpoint
→ timeout, rate limit, latency, Action repair and convergence
```

以下任一结果属于 Feature Core 失败，并阻断当前 Feature：

- Provider 失败后仍产生成功 Result 或 `run.succeeded`；
- protected Effect 在 Approval 前执行；
- completed Invocation 与 Evidence/Result/Event 不一致；
- unknown Effect 被自动重试或误报；
- blocked/failed Run 无法 inspect、resume 或 recover；
- Lease/Fencing、并发控制或资源释放失效；
- package caller 必须导入 CLI、Store 或内部源码。

如果 Runtime 正确持久化 blocked/failed、没有假成功、没有越权 Effect、保留已有 Invocation/Evidence 且可恢复，则特定 Provider 的 timeout、Action repair 次数、交互收敛轮数和并发成功率属于 External Environment Acceptance。

External Acceptance 失败必须继续记录为失败或 `verification_blocked`，不能被确定性测试通过覆盖；但它不自动否定已由独立证据证明的 Runtime Feature Core。

## 5. 完成证据

证据要求与风险匹配。

- L1：行为和测试证据；
- L2：边界输入、输出、持久化和消费证据；
- L3：完整输入、执行、状态、持久化、结果和验证证据。

不得仅凭以下内容宣布完成：

- Model 输出 Final；
- Tool 返回 success；
- Schema 合法；
- Mock 测试通过；
- Build、Lint 或 Typecheck 通过；
- AI 自己的总结。

没有固定 Dataset 或 Benchmark 时，不得声明性能、成功率或质量优于其他系统。
