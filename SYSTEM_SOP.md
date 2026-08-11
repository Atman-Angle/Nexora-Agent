# SYSTEM_SOP.md — Nexora 系统级正向与逆向 SOP

本文件在项目启动、重大重构、Capability 集成和发布验收时使用。

它不是单个 Feature 的详细实施计划。

## 1. 正向 SOP：从目标到真实结果

# 正向 SOP：开发、执行与验收

用途：开发新行为时，从目标证据一路推进到可验证结果；避免绕过 Runtime 权威、先写实现后补测试或只验证 Happy Path。

## A. 开发开始前

1. 执行 `git status --short`，阅读当前 Feature 相关 diff 和未跟踪文件。当前工作树是唯一现实基线。
2. 从 `DEVELOPMENT.md`、当前 Feature Spec 和审计文档提取：目标、范围、非目标、硬约束、验收标准。
3. 从正式入口追踪现有调用链，并记录到函数级：
   - CLI：`apps/cli/src/index.ts::main`
   - Runtime：`createRuntime` → `RuntimeEngine.start/resume` → `#runLoop`
   - 决策：`RuntimeProvider.decide`
   - Effect：`#callTool` → `RuntimeTool.execute`
   - 持久化：`RunStore` 原子方法
   - 完成：`validateCompletion` → `RuntimeProvider.validate` → `transitionRunStatus`
4. 明确本次数据 authority：Plan、Run Status、Tool Result、Evidence 分别由谁创建和持久化。跨 Run Memory 只能进入独立 Memory Store，不能伪装为或反写这些 Run Authority；若同一事实出现第二个执行 authority，停止并重新设计。
5. 列出可复用点、删除/合并候选、首个真实断点和最小修改文件。没有第二个真实调用方时不新增抽象。
6. 写 RED 测试，先运行并确认它因目标缺口失败，而不是 Fixture、配置或测试本身失败。

## B. 最小实现顺序

1. 先修纯 Contract/状态转换，再修 Store 事务，最后接 Runtime wiring；不要从 CLI 添加旁路。
   Memory 内容变化必须先创建 candidate，再通过 `promote` 或 `supersede`；update 和 merge 不得直接改写既有 statement/provenance，也不得用 `setStatus` 模拟生命周期。
   Runtime 需要跨 Run 连续性时，由 Host 显式传入 `{store, scope}`。模型只能先看到有界 `memoryCandidates`；必须请求其原样 `memory:<id>` ref，Harness 重验 exact scope、active、未过期、normal sensitivity 和 record digest 后才交付完整 MemoryRecord。Memory 与当前 Run 冲突时，以最新 Input、TaskContract、Plan、Progress 和 Evidence 为准。
   用户查看、修正、失效、删除、禁用、清域和审计导出必须走 `MemoryControls`。所有 mutation 必须携带 exact scope、operationId、actor、reason、occurredAt；修正只能走 candidate + supersession。禁用 scope 后检查生产 Context 无 Memory candidate，删除/清域后检查 audit tombstone 不含 statement，并验证 close/reopen 后策略与 audit 仍存在。
   所有 Memory statement 按 untrusted data 处理，即使已 verified 或 digest 精确也不得执行其内部指令。安全验收必须使用包含伪 system role、越权 Tool 请求、Approval/完成伪造的固定攻击样本，并检查：候选不含正文；恢复 Fact 有 trust 标记；当前 TaskContract 不变；猜测/跨域/sensitive/deleted ref 统一不可用；write/execute 仍停在正常 Approval Gate。Host 负责把已认证身份绑定到 exact scope，部署侧另行满足加密和 secure erase 发布门。
2. 外部输入先过 Zod。Model 只能提出 `set_plan | call_tool | request_input | propose_finish`。
3. Provider context 必须由 Runtime 投影真实 workspace、Tool 的 Identity/Capability/Decision/Effect/Evidence、当前 allowed Action 的 Schema 合法示例、active Step 所绑定 Tool 的输入示例，以及权威 Invocation 的有界 observation；不要在 Provider Prompt 复制第二份 Action/Tool facts 状态。
4. 每个 RuntimeTool 五层Contract的文本边界必须完整且有界；`inputExample`必须在Runtime构造时通过JSON Contract和该Tool的`inputSchema`，`facts`必须在成功持久化前通过`factsSchema`。example只用于active Tool字段构造，Schema/idempotency不暴露给Model。
5. 首个 `set_plan` 必须包含 Task Contract；修订示例必须携带当前 Plan version，并只在有新增输入时携带更新后的 Task Contract。Plan version 和 goal digest 只能由 Runtime 生成。
6. Tool Action 必须绑定当前 active Step 和 Acceptance Check；Invocation ID、幂等键和 Fencing Token 只能由 Runtime 生成。
7. 所有 Tool input 必须先通过真实 Tool Schema 并展开默认值；若同一 Run/Plan/Step/Tool/input 的 Invocation 幂等键已经持久化，必须在 Approval/Effect 前按非法 Action 拒绝；否则写/执行工具才转为 `waiting/APPROVAL_REQUIRED`。Pending Action、批准后 Invocation 与 Tool execute 必须使用同一 canonical input，resume 必须重校验，批准必须绑定 Pending Request ID。
8. Tool 意图与 Run snapshot/event 原子提交后才执行 Effect；Tool 结果、Evidence 与 Run snapshot/event 再原子提交。
9. 下一轮只从 `tool_invocations` 投影最近 8 个 completed result/error；约 32 KiB 以上使用 digest + preview，且不得暴露 input/idempotency/Fencing/Lease。read 结果必须提供 patch-compatible 内容 digest。
10. 非法 Action 必须记录路径化诊断，并把原始 JSON 写入 Artifact 后关联 `detailsArtifact`；它不能进入执行路径。
11. 非零命令、Schema 错误、Provider 错误或失效 Fencing Token 必须形成失败/阻断，不得生成成功 Evidence。
12. Provider decide/validate 调用只能在同一无副作用请求内有限重试；耗尽后使用 `blocked/PROVIDER_UNAVAILABLE`，resume 回到同一 loop，不能重放已成功 Tool Effect。
13. `propose_finish.evidenceIds` 必须非空、唯一，并覆盖每个 required Check；`validateCompletion` 只能解析这组 persisted Evidence，不能替换为 Run 全部 Evidence。
14. 确定性完成、独立语义验证、Result、`validation.passed` 和 State Machine 必须消费同一 cited Evidence 集；两道门都通过才允许写 `succeeded`。

## C. 正常运行链

1. 执行 `nexora "自然语言目标" [--cwd <path>]`，或调用 `runtime.start({input})`。
2. CLI start/resume 先从启动目录加载可选 `.env`，再创建 Provider；显式进程环境优先，目标 `--cwd` 的 `.env` 不加载。Runtime API 调用方显式提供配置。
3. Runtime 创建 Run、`run.created` 和 Lease。
4. 循环检查预算，从 Run/Tool Invocation 权威投影状态正确且有界的 Provider context，记录 `model.requested`，获取一个 Action并由唯一 Zod Contract 校验。
5. `set_plan` 保存唯一当前 Plan；`call_tool` 执行真实工具；`request_input` 停在 waiting；`propose_finish` 引证 required Evidence 后进入两道完成门。
6. read 工具在 Schema parse 后直接执行；write/execute 在 parse/default expansion 后持久化 canonical Pending Action，用 `inspect` 核对精确 input 和 Request ID，再显式 `resume --approve <id>`。
7. 进程崩溃后，`resume` 必须先检查未决 Invocation：
   - 幂等 started：原 ID、原输入重试；
   - 非幂等 started：转 `blocked/TOOL_RESULT_UNKNOWN`；
   - unknown：仅接受绑定 Invocation 的 Recovery Decision。
8. `blocked/PROVIDER_UNAVAILABLE` 且无未决副作用时，resume 经 State Machine 恢复 running；其他 blocked 原因不得绕过恢复决定。
9. start/resume 必须先取得 Lease；有效 owner 存在时返回 `RUN_BUSY`，且不能追加输入、批准或执行 Effect。
10. CLI 退出码：0 succeeded、2 waiting、3 blocked、4 failed、64 参数/配置错误。

## D. 验收顺序

```powershell
pnpm exec vitest run <target-tests> --no-file-parallelism
pnpm exec vitest run tests/runtime --no-file-parallelism
pnpm typecheck
pnpm build
pnpm lint
pnpm --filter @nexora/runtime build
pnpm test
git diff --check
```

随后检查：

- `inspect` 中 Plan/Step/Evidence/Invocation 可互相引用；
- `validation.requested/passed` 与 Result 的 Evidence IDs 等于 finish cited Evidence，并覆盖全部 required Checks；
- 失败状态没有 Result 或成功事件；
- 包外消费者只从 `@nexora/runtime` 导入；
- Provider 请求中的 Action 示例只包含当前允许动作，Tool 输入示例只出现在当前可调用 Tool 上；
- `action.rejected` 的诊断和 `detailsArtifact` 能还原原始非法 JSON；
- 热路径没有增加模型调用；Prompt+Context 必须有修改前后量化基线，新增静态 metadata 必须有界且与收益匹配；
- mutation Feature 必须用真实文件、真实 patch/write、真实 validation command 和真实 Approval/Resume；非零命令必须无 validation Evidence、无 semantic validate、无 success；
- Git diff 只包含当前 Feature；
- 真实 Provider canary 只能在确定性门禁通过后运行，失败结果不得重写。

one-shot canary 必须先冻结 workspace、目标和允许批准范围。创建首个 Run 后，任何越界 Pending Request、input、Provider error、blocked/failed 都立即停止；只 inspect，不追加提示、不 resume、不重新 start。E052 Run `d142ad7a-9502-4b4a-8af1-cfa5ed6ca015` 正是按此规则在 `shell.execute("dir /b .")` 处停止，证明 Approval Boundary 没有被验证流程绕过。

E053 Run `fb4e0b98-e660-4083-aa40-4dba8ad993e5` 展示允许的正向 one-shot：一次 start 后只 inspect 同一 Run；仅批准精确 `src/math.js` patch 和 canonical `node + args + cwd + timeoutMs` validation；最终必须由 persisted Evidence、semantic validation、State Machine、外部测试与 Git diff 共同验收。终态 Run 不 resume，canary 不重跑。

搜索 Feature 的正向检查为：Tool input schema → workspace 目录边界 → 固定 Ripgrep 参数/无 shell → JSON match 映射与确定排序 → Invocation result → Evidence → cited finish。必须额外用 packed `@nexora/runtime` consumer 真正执行搜索，并对同一夹具采集至少五次当前引擎样本；不能只验证依赖存在。E055 Run `48a7d43d-e347-42f3-a863-c771a61021c9` 展示 search → read → 两项 cited Evidence → semantic validation → success。

E056曾用“模型删要求”的合法Schema Action验证set_plan自然语言门禁；该门禁因误判已由E058删除，只作为历史测试方法保留，不能再作为当前验收标准。

E058后不再要求Runtime在set_plan理解自然语言。应验证：模型从Capability/Decision投影选择Tool；否定中提到的Tool不成为required；若Plan漏动作，最终validator读取全部原始输入并产生`validation.failed`，无`run.succeeded`；write/execute仍必须Approval。

E058真实canary Run `3f651a7f-7dd0-41f1-83b8-541756b9b2ca` 展示自然语言正向链：原始输入要求字面量搜索且未指定Tool → 模型Plan绑定`filesystem.search`/`filesystem.read` → canonical query保持`[abc].*` → search返回`literal.txt:1` → read取得正文 → 两项Evidence被finish引用 → semantic validation对照原始输入 → `succeeded/VALIDATED`。全程0 retry、无write/execute Invocation。

E059正向输出检查：成功转换后必须从同一snapshot投影`RunResult.summary`，CLI直接序列化；不得另行inspect、总结Evidence或润色。真实Run `55147bd3-4983-400c-b9df-9d75e1fa89b7`的CLI summary与持久化Result逐字一致，且只执行一次read。

E060正向验证检查：先由`validateCompletion`完成Plan/Evidence确定性门，再确认semantic payload只有`inputs/proposedSummary/facts`，verdict只有`passed/issues`。真实Run `f4687e39-d46b-4836-bba5-bcce5c908a8e`经list/read后一次validation通过，0 retry/0 rejection；不因discovery策略或digest元数据产生语义失败。

E061正向检查：先确认每个Tool Contract五层完整；模型只基于Capability/Decision选择最小行动；Runtime校验active输入并处理Approval；Tool返回Facts；Runtime用该Tool factsSchema校验后才保存Invocation与Evidence；完成仍经过cited deterministic gate和原始输入semantic validation。Facts不合Schema必须是Tool failure，不能出现`tool.succeeded`或Evidence。

E062–E064正向检查：TTY自然语言命令不得在首个waiting直接退出；Approval前必须展示`pendingRequest.action`；拒绝可附理由并在下一Decision前成为inputHistory；长时间waiting后resume必须进入新活跃段而非立即Duration失败。非TTY仍应返回waiting/exit 2。

E065–E077正向检查：Provider decide/validate 只可对同一无副作用请求最多重试两次；一次成功重试不生成第二个 Tool Effect，耗尽才进入既有`blocked/PROVIDER_UNAVAILABLE`并由显式resume恢复。相同Run/Plan/Step/Tool/canonical input的已持久化 Invocation 必须在Approval和Effect前成为`action.rejected`。E077 的 OpenAI-compatible wire projection只能从同一`ModelDecisionContext`缩减输入历史、当前Contract/Plan/Progress/Evidence、紧凑Capability目录、active Tool详情和有界Observation；它不改变公开Provider Contract、Tool Schema、canonical input、Invocation、Evidence或完成门。E076固定release UAT在Read/Search、并发Literal Search、Mutation和Denial四个场景连续3/3通过，并逐Run反查SQLite三表、Artifact和Git；这是1.1 `done_locally`的固定验收证据。

E078是对E076/E077的交错基准表征，不是新的运行路径或发布门。80个样本保留全部失败和timeout；它支持E077较低输入Token和较低墙钟P50，不支持关于决定性可靠性优势或尾延迟改善的声明。具体统计只记录在`reports/2026-07-28-e078-provider-stability.md`。

调试始终先 `nexora inspect <run-id> --json`，不要直接修改 SQLite。

## 2. 逆向 SOP：从结果追溯到原始事实

# 逆向 SOP：失败定位、审计与恢复

用途：从一个最终输出、异常或“声称已完成”的 Run，反查到原始输入、Plan、Model Action、Tool Effect、Evidence、状态提交和具体代码断点。

## A. 先确定真实结论

1. 执行 `nexora inspect <run-id> --json`。
2. 读取 `snapshot.status/stopReason/lastError`。只有 `succeeded` 是成功；waiting、blocked、failed 和仍为 running 都不是成功。
3. 若 CLI 输出与 SQLite snapshot 冲突，以 snapshot 为状态权威，并记录 CLI 映射缺陷。
4. 检查 terminal Event：成功必须同时存在 `validation.passed` 和 `run.succeeded`；缺任一项即不可验收。

## B. 从结果反查证据链

按以下顺序逐级反查，任一断链就是首个故障位置：

1. `snapshot.result.evidenceIds`
2. `validation.passed.payload.evidenceIds` 与此前 `validation.requested.payload.evidenceIds`
3. `snapshot.evidence[]`
4. Evidence 的 `planVersion/stepId/checkId/subjectRef/invocationId`
5. `toolInvocations[]` 的 tool/input/status/result/error/fencingToken
6. protected Invocation input 是否与此前 Pending Approval Action 的 canonical input 相同
7. 对应决策轮的 Tool Capability/Decision投影与active-only inputExample是否完整，`toolObservations[]`是否来自最近completed Invocation，digest/preview是否有界
8. `currentPlan.orderedSteps[].acceptanceChecks[]`
9. `taskContract` 与 `goalDigest`
10. `inputHistory` 的原始输入和补充输入

核对规则：

- Result 只能引用真实存在的 Evidence；
- Result、`validation.requested/passed` 和 `run.succeeded` 必须引用同一组 Evidence IDs；
- 该集合必须覆盖当前 Plan 每个 required Check，不能依赖未引证的 Run Evidence；
- Evidence 必须绑定当前或被保留的 Plan Step/Check；
- Tool Evidence 对应的 Invocation 必须为 succeeded；
- 非零命令、failed/unknown Invocation 不能满足成功 Check；
- Plan 的完成步骤不能在后续版本被改写。

## C. 重建时间线

按 `run_events.sequence` 排序，定位最后一个成功持久化边界：

```text
run.created
→ model.requested
→ plan.set | action.rejected | run.waiting
→ tool.started
→ tool.succeeded | tool.failed | tool.result_unknown
→ validation.requested
→ validation.passed | validation.failed
→ run.succeeded | run.failed | run.blocked
```

Event 只用于审计，不反向覆盖 snapshot。若日志显示请求已发出但没有后续 Event，检查 Lease/Fencing、进程中断和 Store 事务回滚。

遇到 `action.rejected` 时：

1. 读取 `payload.diagnostic.kind/actionType/issues[]`，先定位 Schema 路径或状态拒绝原因；
2. 读取 `payload.detailsArtifact`，按 digest 打开 `<dataDir>/artifacts/<sha256>`（默认 `.nexora/artifacts/<sha256>`）；
3. 将原始 JSON 与当轮 `ModelDecisionContext.actionContract`、workspace、active Step 和 Tool inputExample 对比；
4. 下一次 `model.requested` 必须能在 `snapshot.lastError.message` 看到相同结构化诊断；
5. 原始 Action Artifact 和 Event 只用于审计，不能视为已接受 Action 或 Tool Evidence。

## D. 从数据断点定位代码

| 现象 | 首查数据 | 首查代码 |
| --- | --- | --- |
| 输入未被理解 | `inputHistory`, `taskContract` | `#setPlan`, Provider Prompt |
| CLI 报 MODEL_CONFIG_ERROR | 启动目录 `.env`、显式 `NEXORA_MODEL_*`、launch cwd | CLI `loadCliEnvironment`, `openAICompatibleProviderFromEnv` |
| Action 连续拒绝 | `action.rejected.payload.diagnostic/detailsArtifact`, `lastError` | `RuntimeActionSchema`, `runtimeActionContract`, `#rejectAction` |
| Plan 不一致 | `currentPlan`, `stepProgress` | `#setPlan`, `assertCompletedStepsUnchanged` |
| 工具未执行 | `pendingRequest`, Invocation 是否存在 | `#callTool`, Approval 分支 |
| 重复 Action 再次请求批准或泄漏唯一键异常 | 相同 `idempotencyKey` 的 Invocation、`action.rejected`、repair budget | `#callTool` 的 duplicate check、`#rejectAction` |
| 非法 Tool input 却请求批准 | `action.rejected`, `approval.requested`, Pending input | `#callTool` 的 Tool Schema parse/canonicalization 顺序 |
| 批准内容与执行输入不同 | Pending Action input 与 Invocation `inputJson` | `#callTool`, `resume` persisted Action 重校验 |
| Plan 选错 Tool | 初始 Context 的 Capability/Decision边界、Plan Check binding | `#decisionContext`, built-in Tool Contracts, Provider Prompt |
| Tool 已成功但模型看不到结果 | Invocation `resultJson` 与下一轮 observation | `projectToolObservations`, `#decisionContext` |
| 工具重复执行 | Invocation ID/input/idempotent | `#recoverToolInvocation`, Store claim |
| 文件越界 | Invocation input/error | `workspacePath`, `writableWorkspacePath` |
| 命令失败却被认为成功 | exitCode/result/Evidence | `shell.execute`, `#executeToolInvocation` |
| Resume 报 busy/lost | lease owner/until/token | `acquireLease`, `renewLease`, `#withLeaseHeartbeat` |
| 有 Evidence 仍不能完成 | Step/Check 与引用 IDs | `validateCompletion`, Provider `validate` |
| 部分引证却成功 | finish/validation/Result Evidence ID 集 | `validateCompletion`, `#proposeFinish` |
| 错误成功 | Result、validation、terminal Event | `transitionRunStatus`, `#proposeFinish` |

## E. 恢复决策

1. `waiting/input`：追加明确输入，不覆盖历史输入。
2. `waiting/approval`：决定必须绑定 Pending Request ID；拒绝后不能执行 Effect。
3. `started + idempotent`：允许 Runtime 以原 Invocation 和输入恢复。
4. `started + non-idempotent`：先标 unknown 并 blocked，禁止自动重试。
5. `unknown`：用户只能选择 confirmed_succeeded、confirmed_failed 或 abandon_run，且必须绑定 Invocation ID。
6. failed/succeeded：终态不恢复；创建新 Run 需要新的开发/用户决策。

## F. 将故障变成回归测试

1. 保存最小 snapshot/Event/Invocation 事实，不复制密钥。
2. 写测试复现首个错误边界，而不是复现后续连锁症状。
3. 先确认 RED，再做最小修复。
4. 运行目标测试、Runtime 全套和静态门禁。
5. 更新本 SOP、数据流或验证报告中受影响的事实。

E049 canary 示例：Run `20c175df-1078-45c4-ba7a-e7f11af386d1` 有 7 次 Model 请求、6 次 Action rejection、0 Invocation、0 Evidence、0 Git diff；最后一次提交被 Fencing 拒绝。因此首个断点是 Provider Action Contract，后续断点是累计短调用 Lease 续租，而不是 Tool 或验证逻辑。该旧 Run 只保存泛化 `Invalid input`，不能事后猜测六个原始 JSON；E050 只改进新 Run 的逆向证据，不改写旧证据。

E051 的错误成功回归：当 read/patch/validation 三个 Evidence 均已持久化，但 finish 只引证 read Evidence 时，旧 `validateCompletion` 会静默返回全部 Run Evidence并成功。修复后应看到 `validation.failed` 的 `CHECK_EVIDENCE_NOT_CITED:<step>:<check>`，没有 semantic validation、Result 或 `run.succeeded`。非零 validation 则应先看到 `tool.failed/COMMAND_FAILED`、0 validation Evidence，再看到 `STEP_INCOMPLETE/CHECK_UNSATISFIED`。

E052 canary 示例：Run `d142ad7a-9502-4b4a-8af1-cfa5ed6ca015` 的时间线只有 `run.created → model.requested → plan.set → model.requested → approval.requested`。Pending Action 是 `shell.execute` / `command: "dir /b ."`，不属于批准的 Node validation；因此 0 Invocation、0 Evidence、Result null、Git diff 空、外部测试 exit 1。这里首个断点是 Provider 在 Plan 首步选择了越界 execute，而不是 Observation、Tool 或完成门；不得通过批准、追加提示或重试掩盖。

E053 成功反查示例：Run `fb4e0b98-e660-4083-aa40-4dba8ad993e5` 的 4 个 completed Step 分别绑定 4 个 Evidence 和 `filesystem.list/read/patch/shell.execute` Invocation；patch Pending/Invocation 都只指向 `src/math.js`，validation Pending/Invocation 都是 `{command:"node",args:["--test","test/verify.mjs"],cwd:".",timeoutMs:60000}`。Result 与 `validation.requested/passed` 引用相同 4 个 Evidence，外部测试 exit 0，Git 仅改 `src/math.js`，最终才有 `run.succeeded`。证据目录为 `agent-evaluation/runs/v1.1-e053-canary/2026-07-22T11-10-11Z/`。

E055 搜索反查示例：Run `48a7d43d-e347-42f3-a863-c771a61021c9` 的 Invocation `0f7238f6-2a5c-4920-adb5-44655638f516` 保存 canonical `{query:"export function add",path:"."}`，result 唯一匹配 `src/math.js:1` 且 `truncated:false`；下一 read Invocation 的内容 digest 对应 `return left - right`。两个 completed Step、两个 Evidence、Result、`validation.requested/passed` 使用同一 ID 集，随后才有 `run.succeeded`。若搜索失败，先查 Invocation 的 `SEARCH_ENGINE_ERROR/TOOL_TIMEOUT`，不得从 Event 或模型总结猜测成功。

E056/E057的 `TASK_CONTRACT_REQUIREMENT_MISSING/PLAN_REQUIREMENT_MISSING` 属于已删除规则的历史Run。E058新Run若漏动作，应在semantic validation看到基于原始输入的明确issue并回到修订循环；若出现这些旧错误码，说明运行的不是当前代码。

E058成功反查示例：Run `3f651a7f-7dd0-41f1-83b8-541756b9b2ca` 的原始输入要求字面量`[abc].*`和read；Plan选择search/read。Invocation `c76fd765-69b8-49e1-b0e4-4d53aafbd3b8` 保存canonical query并返回`literal.txt:1`，Invocation `e5caf278-008d-4f01-9d61-ed4971831f68`读取同一文件。两条Evidence ID与Result、validation Event及success一致；没有mutation Invocation或retry。

E059输出反查：若CLI成功却看不到答案，先比较最终stdout的`summary`与`inspect.snapshot.result.summary`。Run `55147bd3-4983-400c-b9df-9d75e1fa89b7`两者逐字相同，并引用Evidence `023d079d-e487-4703-a620-2e803e694e92`和read Invocation `a7501aeb-2d0e-4ed3-a1a5-f107ce6aab93`；不需要从Tool结果重建答案。

E060反查时把确定性失败与语义失败分开：`CHECK_EVIDENCE_NOT_CITED`等来自Runtime，不进入Provider；模型semantic issue只能引用原始输入、summary或plain facts。历史Run `16a078c2-dccc-43df-a486-960c72125b99`的Plan顺序/digest比较属于已删除旧边界；新Run `f4687e39-d46b-4836-bba5-bcce5c908a8e`只有一次`validation.requested/passed`。

E061反查顺序：从Result Evidence IDs定位succeeded Invocation及`resultJson` Facts，再定位Tool Contract的`evidence.produces/factsSchema`、调用时canonical input和Plan Check。选择错误时查看当轮Capability/Decision投影；执行失败看Effect、Invocation error；Facts Schema失败必须无Evidence。Run `04f5c0ce-02b3-43fc-a4e1-9804b17dd3bd`可反查为Plan v1、list/read两项Facts与Evidence、一次validation、0 rejection/retry。

E062–E064反查：Duration失败先区分活跃段与waiting墙钟；交互审批从Pending Action核对CLI展示内容；拒绝修正从`approval.denied.payload.reason → inputHistory → TaskContract.inputVersion → 下一Plan/Action`逐项追踪。Run `4df78cc9-e83f-45d6-8860-99601101ee9b`提供完整链路，且新shell Action仍未批准。

E065–E077反查：Provider异常先从`lastError.code/message`、`run.blocked`和随后`run.resumed`确认是否耗尽同一无副作用请求的有限重试；已成功的Invocation/Evidence必须保持原ID且不能被resume重放。重复Tool Action先比较canonical input和同一Run/Plan/Step/Tool的已持久化Invocation，再检查`action.rejected`与repair预算；不得把它误判为Approval或Tool执行失败。若怀疑E077决策投影导致选择异常，只比较当轮投影的输入历史、当前Contract/Plan/Progress/Evidence、Capability目录、active Tool详情、Observation和允许Action；这些投影均是进程内数据，不能成为新的持久化事实或绕过现有反查链。

E076/E078验收结论反查：E076固定12个Run是1.1本地完成的发布证据，必须逐项验证Run状态、Event、Invocation、Evidence、Artifact和Git；E078的80个交错样本只用于效率与稳定性表征。E078中一次Provider timeout已由有限重试成功，且五个跨组失败均保留；它们不能改写E076固定release UAT，也不能被用于宣称100% Provider成功率或尾延迟改善。
