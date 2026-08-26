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
CR-completion
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
UAT-03 Mutation / Approval / Verification
UAT-04 Denial Safety
```

验收必须使用隔离的临时 Git 工作区，并检查：

- 自然语言产生真实多步骤执行；
- Tool 结果来自真实工作区；
- inspect 可反查 Input、Plan、Invocation、Evidence 和 Result；
- 写操作未批准前不执行；
- 拒绝操作不误报成功；
- 修改仅发生在允许范围；
- 只有 `succeeded / COMPLETED` 才视为成功；
- Runtime、Tool 验证或 Completion Gate 失败时没有成功 Result。

### 4.1 Feature Core 与真实 Provider 验收边界

固定场景同时用于两层证据，但结论必须分开：

```text
Feature Core
→ deterministic failure injection
→ real Store / Tool / package integration
→ Authority, safety, persistence and recovery

External Environment Acceptance
→ real Provider endpoint
→ timeout, rate limit, latency, Provider protocol compatibility and convergence
```

以下任一结果属于 Feature Core 失败，并阻断当前 Feature：

- Provider 失败后仍产生成功 Result 或 `run.succeeded`；
- protected Effect 在 Approval 前执行；
- completed Invocation 与 Evidence/Result/Event 不一致；
- unknown Effect 被自动重试或误报；
- blocked/failed Run 无法 inspect、resume 或 recover；
- Lease/Fencing、并发控制或资源释放失效；
- package caller 必须导入 CLI、Store 或内部源码。

如果 Runtime 正确持久化 blocked/failed、没有假成功、没有越权 Effect、保留已有 Invocation/Evidence 且可恢复，则特定 Provider 的 timeout、协议不兼容、响应拒绝次数、交互收敛轮数和并发成功率属于 External Environment Acceptance。

External Acceptance 失败必须继续记录为失败或 `verification_blocked`，不能被确定性测试通过覆盖；但它不自动否定已由独立证据证明的 Runtime Feature Core。

### 4.2 Durable Journal 长时等价验证

长时 Run 不等待 500 小时墙钟完成 Feature Core。确定性门禁必须覆盖：虚拟时钟至少 500 小时、100,000 条 Journal Record、有界分页与重复读取、v6 legacy migration、digest/Artifact 漂移、Provider Attempt 中断、Lease/Fencing/并发和脱敏 secret fixture。1–4 小时真实 soak、真实 Provider 多 Attempt、部署加密/备份/保留策略仍是独立 Release/External Environment Gate；未执行时必须明确记录，不能由虚拟时间测试替代。

### 4.3 Progressive Agent Execution 验收

Agent Loop、Provider Contract 或 Completion Gate 改动必须固定验证：无 Plan 的 Tool → Observation → finish；首轮 Plan + Tool 且总计两次 decision；先只读探索再建 Plan；零 validation Model Call；重启后首轮恢复最新 Tool Outcome；最终文本字段修复不重复 Tool 或修订 Plan；Tool 参数字段修复不重复成功 batch sibling；unknown 非幂等 Effect 仍保持 blocked。历史 validation Event/Model Call 只做旧数据可读性测试，不属于新执行路径。

### 4.4 General Agent Prompt / Profile 验收

Prompt、Profile、Tool Schema、ModelResponse 或 Provider Transport 改动必须固定验证：Kernel/Host/Profile/Project/Tool 语义优先级；Profile 不能改变 Tool、权限、Approval、Evidence 或 Completion；canonical stable prefix 和 Tool ordering；真实 Zod JSON Schema；`native_tools`/`structured_output` 单 Transport wire；Provider call ID 保留；Plan/HITL controls 的确定性路由；普通 native content 不执行 Tool；reopen strategy continuity；逐 Attempt cache usage 持久化；Bench provenance 与六种 cache status 口径。`unsupported/disabled/unknown` 不进入 zero-hit 分母。L3 还必须保留真实 Provider capability 与任务结果，并把缓存门槛、Provider 不返回指标、协议不兼容和外部模型失败如实区分。

### 4.5 Agent Skill 自动选择验收

Skill 改动必须固定验证：Agent Skills `SKILL.md` frontmatter/name 约束；显式本地根目录、重复 ID、目录/文件链接、路径逃逸和 package/file/指令预算；目录只包含元数据与 digest，未选择前 Prompt 不含正文；`nexora_select_skills` 必须独占响应并校验 catalog/id/version/package digest；选择后下一轮才出现正文；拒绝 stale/unknown/duplicate/compound selection 时不创建 Runtime Tool Invocation；恶意 Skill 文本不能改变 Tool、Approval、Evidence、Plan、Run Status 或 Completion；model.turn 审计可在 reopen 重建 active Skill；package/instruction drift 失败关闭；context eviction 不得静默丢弃 active instructions。远程下载、MCP、市场和脚本自动执行不属于本 Feature 验收。

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
