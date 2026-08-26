# Recoverable Session Execution Spec

Status: Reviewed - scope revised before implementation

Feature: `recoverable-session-execution`

Mode: `PLAN`

Risk: `L3`

Primary owners: Runtime, Harness, Desktop Host, Provider Adapter

Evidence baseline: `D:\Nexora testspace`, Session containing Runs `a8db8614-71fa-45b8-ac7e-b6f270a366ee`, `b992e967-82b2-4bf3-a82e-85e17508c895`, and `aabaab8e-5fc7-4fa3-9a9c-ab8372f21ee2`

## 1. Outcome

Nexora 必须能以有界、可恢复的方式完成普通 Workspace 修改任务。对于一个已经定位到具体页面和链接的简单修复，Agent 应接近：

```text
读取必要文件
→ 一次有目标的修改
→ 一次验证
→ 输出结果
```

它不得因为长 Session、多个 Tool Call、Patch Conflict、Provider 暂时失败或一次无进展阻断，放大为几十次 Model Call、反复读取同一文件、重复修改和不断要求用户 Resume。

本 Feature 同时修正执行收敛和恢复语义。单独修改 Resume UI 不能解决根因。

## 2. Triggering evidence

### 2.1 Workspace 问题被无依据直接回答

Run `a8db8614-71fa-45b8-ac7e-b6f270a366ee`：

- 用户询问当前网站为什么需要登录才能查看 Solutions；
- 第一次 Model Turn 没有读取 Workspace，直接提出完成；
- Completion Gate 以 `COMPLETION_EVIDENCE_REQUIRED` 拒绝；
- 第二次 Model Call 使用 `nexora_respond` 成功，但仍未读取当前文件；
- 两次调用分别携带约 353K input tokens，共耗时约 103 秒。

问题不是 Completion Gate 太严格，而是 Harness 对“当前 Workspace 可变事实”的 grounding 边界不够明确，导致额外轮次和可能错误的结论。

### 2.2 同文件反复读取、修改和 Patch Conflict

Run `b992e967-82b2-4bf3-a82e-85e17508c895`：

| Measure | Persisted result |
| --- | ---: |
| Model calls | 29 |
| Tool invocations | 27 |
| Read/list invocations | 21 |
| Write/patch invocations | 6 |
| Provider active time | 1,656.2 seconds |
| Provider output tokens | 39,789 |
| Actual input per call | about 354K–372K |
| `PATCH_CONFLICT` | 2 |
| duplicate Action rejection | 4 |
| `NO_PROGRESS_DETECTED` | 4 |
| explicit no-progress Resume | 4 |

`solutions.html` 被持续 read / patch，最终 resource churn 达到 19 次。Runtime 能识别重复，但阻断发生后通用 Resume 又重新开放同一策略，因而只是把无限循环拆成多段。

### 2.3 多 mutation Tool Call 在 Approval 边界被部分消费

模型多次在一个 Turn 中返回多个页面写入。Runtime 当前对 write/execute/mixed batch 采用 serial Approval 边界：第一个 protected mutation 进入 Approval 后停止当前执行段。批次已经持久化 `batchId` / `batchOrdinal`，并有 `execute_step.completed` 与 crash-recovery 逻辑；但本轮没有足够证据证明 Approval 后所有未执行 sibling 都能被 Harness 稳定投影并一次性复用。因此不能把“sibling 必然丢失”写成已确认事实，必须用 adversarial test 验证。

如果 sibling 没有稳定投影，下一轮模型可能重新提交完整批次，造成：

```text
第一个写入成功
→ 原批次剩余项丢失
→ 模型重发整个批次
→ 已成功项被 duplicate guard 拒绝
→ 重新读取并再次尝试
```

这是 Tool batch、Approval 和下一轮 Context 之间的收敛缺口，不应只归因于模型质量。

### 2.4 Provider 慢、失败和 Duration Block

Run `aabaab8e-5fc7-4fa3-9a9c-ab8372f21ee2`：

- 用户输入只有“继续”，但继承前序长 Session；
- 15 次 Model Call 和 14 次 Tool Invocation；
- 25 个 Provider Attempt，其中 10 个首轮 Attempt 以泛化的 `PROVIDER_ERROR` 失败，随后重试成功；
- 每次实际输入约 395K–407K tokens；
- Provider 调用通常耗时约 50–82 秒；
- 期间发生 2 次 budget block / extension，最终 succeeded。

Context 没有超过一百万 token 模型窗口，但已经显著放大延迟、成本和 Provider 失败概率。仅按模型硬窗口治理 Context 不足以保证日常任务可用。

### 2.5 空转 Model Call 和流式超时边界

Activity 中还出现过只返回 `execute`、`let's go` 或重复公开进度文字的 Model Call。它们没有新增用户事实、Tool Effect、验证结果或完成依据，却继续消耗 Provider 时间和上下文。

这类空转不能被“模型正在思考”或正常流式心跳掩盖。另一方面，Provider 只要持续收到有效 SSE frame（包括 reasoning/content delta 或协议允许的 heartbeat），就不应被误判为 idle timeout。必须区分：

- **transport liveness**：流仍有数据，续期 idle timer；
- **execution progress**：产生新事实、Tool Effect、验证或可审计结果；
- **empty turn**：流结束但没有有效公开输出、Tool Action、Plan 变化或结果。

空转只允许一次结构化 repair；继续收到同类空转后必须进入已有 no-progress 诊断，不得通过增加 Duration 或无条件 Resume 无限重试。

### 2.6 修改后继续读写，未进入验证和完成

`b992...` 的核心浪费不只是同一文件重复 read，还包括 mutation 后没有形成稳定的“目标已满足 / 需要验证 / 仍未满足”事实。模型在一次修改成功或被拒绝后又重新 read、patch，导致 read/write churn。

对于同一资源和同一目标，成功 mutation 后的下一步必须优先是一次明确验证或完成判断：

```text
read
→ one mutation
→ one validation
→ finish / one bounded repair
```

如果验证已证明目标满足，不得再次 mutation；如果验证失败，repair 必须引用新的 digest 或新的错误事实。没有新事实时不得重新读取和重写。

### 2.7 Completion Gate 被拒绝后的重复整轮执行

`COMPLETION_EVIDENCE_REQUIRED`、缺少 Artifact 或缺少 Validation 时，当前执行可能把“完成被拒绝”当作普通模型轮次，重新发送长 Context 并重复之前的读取策略。Completion rejection 必须产生结构化、一次性的 repair fact，明确缺少的 Evidence 类型和最小补救动作；同一 issue set 的第二次拒绝不得重新开放整套旧策略。

### 2.8 重启后的 started Attempt 和恢复误导

进程退出或 Desktop 卡死后，旧 Provider Attempt 曾可能造成恢复歧义。当前 `RunStore.acquireLease()` 已将无活动 Lease 的 `started` Provider Attempt / Model Call 标记为 `interrupted`，并写入对应审计事件；这里应作为 reopen regression，而不是全新生命周期设计。仍需验证 Desktop 不把 `interrupted` 误投影为正在执行，也不自动重发 Provider 请求。

### 2.9 既有收敛审查中的相关问题归属

此前 `BOUNDED_EXECUTION_CONVERGENCE_SPEC.md` 还记录过以下问题。它们不能因为本 Spec 聚焦 Session 恢复就从需求记录中消失：

| 已审查问题 | 本 Spec 处理方式 |
| --- | --- |
| delegated Child 复制 Parent 已用预算，创建后零 Model Call 即 blocked | 既有 BEC 实现已修复；本 Feature 只保留 Child fresh-budget、重启和 blocked recovery 回归，不重新设计 Worker budget |
| blocked Child/Branch 使 Parent 反复 completion reject，Host 没有可执行恢复 | 既有 BEC 实现提供 Worker Observation/allowed actions；本 Feature 要求 Session continuation 继续使用该投影，禁止退化成通用 Resume |
| read-only Worker 被用于 mutation assignment | 既有 BEC 实现已禁止 Desktop 隐式 delegation；mutation Worker policy 仍是明确的后续范围，不在本 Feature 临时补一套角色系统 |
| internal Worker Run 混入 Desktop Session 列表 | 既有 BEC 实现已按 lineage 过滤；本 Feature 将其作为 Session projection 回归条件 |
| `branch.created` 重复、Plan proposal churn | 既有 BEC 实现已增加唯一生命周期/语义 no-op 约束；本 Feature 的 no-progress 判定必须继续把它们视为无进展 |
| 任何 mutation 都使所有 read cache 失效 | 既有 BEC 实现已改为资源级失效；本 Feature 只修复逻辑层重复请求和 Resume 后重新读取，不能退回全局失效 |
| 大窗口下 Context 容量安全但累计成本过高、自动压缩重复展示 | 既有 Context Feature 已提供 deterministic eviction/compaction；本 Feature 补充 continuation tiers、事实连续性和 Activity-only 自动压缩验收 |
| repeated extension、patch conflict、同资源 read/mutation churn | 属于本 Feature 的未完成执行收敛范围，必须按本 Spec 的 bounded repair、postcondition 和 quality gate 处理 |

这张表是范围边界，不表示所有历史问题都需要新增 Runtime 状态；已实现项通过回归证明，未实现项才进入本 Feature 的最小改动。

## 3. Root-cause matrix

| Priority | Problem | Root cause | Required owner |
| --- | --- | --- | --- |
| P0 | blocked 后反复 Resume、再次进入相同循环 | no-progress Resume 只做 `blocked → running`，没有策略变化或新的恢复边界 | Runtime + Desktop Host |
| P0 | 同一文件被重复读取和修改 | successful observation 被保留但未成为足够强的“已有事实”；Resume 重置收敛窗口 | Runtime + Harness |
| P0 | mutation batch 重发风险 | Approval 在第一个 mutation 停止批次；sibling 是否被稳定复用尚未由当前 acceptance 覆盖 | Harness + Runtime execution |
| P1 | Patch Conflict 后持续 read/patch | repair context 没有强制一次重新观察后收敛到 finish、single patch 或 full write | Harness |
| P1 | 简单 Workspace 问题先直接回答 | current mutable workspace fact 与 grounded direct response 边界不清 | Harness + Completion integration |
| P1 | 400K Context 重复发送 | ancestor Runs 长期保持 full，只有接近容量边界才收缩 | Harness Context |
| P1 | Provider 错误无法判断 | Attempt 只暴露泛化错误码，Activity 无具体分类 | Provider Adapter + Runtime audit |
| P1 | Provider 有流但被误判超时，或结束后空转重试 | idle timeout 与 execution progress 未分离；空输出没有有界 repair | Provider Adapter + Harness |
| P1 | mutation 后继续 read/patch，未验证即循环 | 没有资源/目标级 postcondition 和一次验证窗口 | Harness + Runtime execution |
| P1 | Completion rejection 重复整轮执行 | 缺少一次性结构化 completion repair，重复 issue set 未计为 no-progress | Runtime Completion + Harness |
| P1 | 重启后 Attempt 投影误导恢复 | Runtime Store 已实现 `started → interrupted`，剩余风险在 Host/回归验证 | Runtime Store + Host regression |
| P2 | Plan / filler 输出反复改变但没有事实进展 | 文字和无效 Plan proposal 没有被纳入 no-progress 语义 | Harness + Runtime Plan |
| P2 | Duration extension 继续放大停滞 | Host 只看预算类型，不检查自上次恢复以来是否有有效进展 | Runtime projection + Desktop Host |
| P2 | 用户输入“继续”效果不可预测 | 新 Run 能继承旧 lineage，但没有显式恢复事实说明前一策略已失败 | Harness continuation |
| P2 | Worker/Branch/Plan 的既有修复可能回归 | Session 恢复只关注 root Run，未验证 lineage、Child budget、Plan no-op 和资源级 cache 仍然有效 | Runtime + Harness regression |

## 4. Existing authority and invariants

1. Run Snapshot 和 State Machine 继续唯一修改 Run Status。
2. Run-owned Structured Plan 继续是唯一当前 Plan。
3. Tool Invocation 继续是副作用、重复判断和恢复判断的唯一 Authority。
4. Evidence、Artifact 和 Completion Gate 不由 Harness 或 Desktop 伪造。
5. Session 仍是多个用户可见 Run 的 Host 投影，不新增 Session Runtime 状态。
6. Context 由 Harness 从完整 Runtime Authority 派生；收缩只改变 Model View。
7. Approval 继续绑定 exact canonical Action；恢复不能绕过 Approval、Schema、幂等或 unknown Effect 处理。
8. 已成功的 Tool Effect 不因 retry、Resume、continuation 或 Runtime reopen 重放。
9. Provider private reasoning、Renderer state 和失败 Attempt 临时输出不能成为恢复指令或事实。

## 4.1 Repository audit decision matrix

以下结论来自当前 Runtime / Harness / Provider / Desktop 代码和已执行的 focused tests，不是对原设计假设的默认采纳。

| Area | Current repository reality | Gap | Decision |
| --- | --- | --- | --- |
| A. Grounding | Harness 已有 direct-response/completion eligibility、Tool catalog 和 `AUTONOMOUS_INPUT_REPAIR_REQUIRED`；不使用关键词路由。真实 Run `a8db...` 仍先直接回答，说明 Model View 的 Workspace fact 边界不足。 | 缺少“当前可变事实不足时先取最小 observation”的可验证约束。 | 保留方向；复用现有 eligibility/repair，补 grounding regression，不新增 Tool Planner。 |
| B. Progress / Repair | 已有 `RepairContext`、`execution.no_progress.warning`、`NO_PROGRESS_DETECTED`、recovery projection。没有独立 `ProgressFact` 或统一 allowed-actions Contract。 | `READ_ALREADY_AVAILABLE`、empty turn、completion issue-set 需要落入现有 repair/diagnostic 语义。 | 部分接受；改术语和派生规则，不新增三套状态类型。 |
| C. Continuation history | `parentRunId`、lineage projection、ancestor rehydration、compaction reuse 已实现并有 E131 回归。no-progress 计算仍从最近 `run.resumed` 开窗。 | 普通 Resume 会清空当前收敛窗口，可能跨 continuation 重放旧策略。 | 部分接受；沿现有 Event/lineage projection 保留诊断，不新增 Session Recovery 状态。 |
| D. Recovery authority | Runtime inspection 已公开 unknown Tool recovery 和 Worker recovery；普通 blocked/no-progress 仍由 Desktop 按 `stopReason` 映射通用 Resume。 | 多 Host 可能对 no-progress 得出不同操作，且 Desktop 暴露无语义 Resume。 | 部分接受；先复用现有 stopReason、inspection 和 continuation API；只有多 Host 需要时再扩展 action projection。 |
| E. `RunHandle.resume()` | API 已支持 input、approval、recovery、budget extension；continuation 由 Host 创建，不是 `resume()` 自动创建。 | `NO_PROGRESS_DETECTED` 仍可无输入恢复，混淆 retry 与 replan。 | 部分接受；限制 no-progress 空 Resume，保持 API 兼容，不做全面方法拆分。 |
| F. Protected mutation admission | `execute_step` 已全量 preflight；read batch 并发，write/mixed serial Approval；`batchId/batchOrdinal` 和 crash recovery 已存在。 | Approval 后 sibling 的稳定复用没有本 Feature 的 adversarial acceptance。 | 部分接受；先补测试，无法证明 sibling 可恢复时才启用 fail-fast。 |
| G. Provider diagnostics | Provider 已区分 response-header、stream idle、Attempt max duration；SSE frame 会续期 idle；Harness 内部 retryable 存在。公共 Attempt 只有 generic `errorCode`。 | timeout/HTTP/invalid/cancelled/partial response 的持久化分类不足。 | 有效变更；只做 additive diagnostics，不新增 Provider 特判。 |
| H. Recovery Context | Runtime Authority → Harness projection → Model View 已成立；repair、continuation、history、eviction、rehydration 已存在。 | 需要补 no-progress/completion/mutation repair 的最小投影；禁止新 Recovery Store。 | 已实现基础，部分扩展；只扩展现有 projection。 |
| I. Successful Invocation replay | duplicate/idempotency、unknown effect recovery、resource-level read cache 已实现；read 在 mutation/freshness 后可合法再次执行。 | 逻辑层仍可能让模型重发已成功 action。 | 保持原则；补“自动 replay 禁止、基于新事实的后续调用允许”的回归。 |
| J. Call limit | Runtime 有 generic budgets，但没有 Solutions 专属固定上限。E129/E131/E084 等已有 deterministic regression 风格。 | 需要防止 scenario bound 被误做成产品硬限制。 | 接受为 fixture regression target，不新增 Runtime task class。 |

### Existing implementation versus this Feature

以下能力已经由仓库代码和 focused tests 证明，进入本 Feature 的 regression gates，而不是主要实现范围：

- Child fresh budget、Worker recovery、root-only Session projection；
- continuation lineage、ancestor projection、rehydration、deterministic eviction/compaction；
- resource-level read-cache invalidation、duplicate/idempotency、unknown non-idempotent Effect recovery；
- Plan semantic no-op、Branch lifecycle uniqueness；
- Provider response-header/idle/max-duration timeout 行为、SSE heartbeat liveness；
- Runtime reopen 将无活动 Lease 的 started Model Call / Provider Attempt 标为 `interrupted`。

本 Feature 的最小实现范围只保留：

1. no-progress 诊断跨普通 Resume 的保留，以及禁止其无输入通用 Resume；
2. mutation 成功后的单次 validation/finish 收敛和同资源重复 read/patch 限制；
3. protected mutation sibling 的确定性 admission/recovery（先测试，后决定 fail-fast）；
4. Completion rejection 的现有事实派生 repair 和重复 issue-set bounded recovery；
5. Provider Attempt 的稳定错误/重试诊断投影；
6. Desktop 对 no-progress、无进展 duration 和 stale Attempt 的准确恢复入口。

不在本 Feature 中重新实现上述已完成能力，也不新增第二套 Run、Session、Context、Recovery 或 Progress Authority。

## 5. Scope

### 5.1 Grounded Workspace decision

当用户问题依赖当前 Workspace 的可变事实，例如文件内容、路由、链接、构建结果或 Git 状态：

1. 如果当前 Model View 已有未失效的精确 Tool Fact，可直接回答。
2. 否则 direct response / completion 当前不具备资格；Model 必须先取得完成该判断所需的最小 grounding fact。具体使用哪个只读 Tool 由 Model 根据现有 Tool contract 决定，Harness 不按关键词强制路由到某个 Tool。
3. 该规则基于“所需事实是否存在且仍有效”，不使用中文/英文关键词分类，也不增加意图识别模型或 Tool Planner。
4. Completion Gate 继续拒绝缺失 Evidence 的完成，不增加宽松旁路。

### 5.2 Read observation reuse and repeat bounding

物理 read cache 不足以解决逻辑重复读取。本 Feature 增加以下确定性规则：

1. 相同 canonical read/input 在没有相关 mutation、resume invalidation 或明确 freshness 要求时，继续复用已有成功 payload，不重复 I/O。
2. Harness 在 Model View 中只保留该资源最新、完整且未失效的 observation，并明确标记其 digest/有效性；不同时投影多个等价 read 结果。
3. 当前 Runtime 已有 `until_mutation` read cache、资源级失效和 `batchId` 持久化；本 Feature 不新增 cached Invocation 类型，也不把缓存命中伪装成物理 Tool 执行。
4. `READ_ALREADY_AVAILABLE` 如果需要落地，只能作为现有 `RepairContext` / no-progress diagnostic 的派生语义，不能新增 Tool failure taxonomy，除非实现阶段证明现有错误边界无法表达。
5. 对同一资源交替 read/mutation 的 churn 继续使用现有资源级诊断，但当前 `#noProgressDiagnostic()` 以最近 `run.resumed` 为窗口起点；跨普通 Resume 保留诊断是待实现缺口。
6. 真正改变资源 digest 的成功 mutation、明确的 freshness 检查或 Run reopen 后必要的安全校验可以使后续 read 成为有效进展。

不新增独立 Read Store；仍使用 Invocation、Evidence 和现有 read-cache 数据。

### 5.3 Protected mutation batch policy

首版不新增持久化 Batch Queue，也不在 Pending Approval 中保存一套平行 sibling 状态。

采用最小 admission 规则，优先在 Runtime/Harness 的现有 Action 边界上验证，不新增 Batch Queue：

1. 一个 Provider Turn 可以包含多个 read Tool Call。
2. Provider Turn 中的多个 protected mutation 必须由现有 Runtime batch 机制确定性恢复，或在任何 Effect 前被拒绝；不能只执行第一个后静默丢弃 sibling。
3. 未执行 sibling 必须能从现有持久化 Invocation / batch 事实中确定性重建；若不能，采用 one-at-a-time fail-fast repair。
4. 已成功 mutation 在下一轮必须以完成事实投影，模型不得重新提交相同 Tool/input。

这会增加少量必要 Model Turn，但避免 partial batch、重复 Effect 和整批重发。

### 5.4 Patch Conflict convergence

`PATCH_CONFLICT` / `CONTENT_CONFLICT` 后只允许一个有界 repair 窗口：

1. Repair Context 必须包含 path、错误分类、当前 digest（若 Tool 已安全返回）、find occurrence 和允许的恢复动作。
2. 如果当前完整内容尚不可见，只允许一次 read 当前文件。
3. 如果目标已满足，直接进入验证或完成，不再 mutation。
4. 如果目标仍未满足，只能选择：
   - 一次使用当前 digest 的 exact patch；或
   - 已知完整目标内容时一次 `filesystem.write`。
5. 同一 path/find/intent 第二次冲突后必须 block，不继续 read/patch 循环。

不增加复杂 AST patch、multi-file patch 或模糊匹配 Tool。

### 5.5 Progress and no-progress semantics

以下才算“新进展”：

- 新的用户事实或约束；
- 新资源或新 digest 的有效 observation；
- 成功且改变 authoritative state 的 mutation；
- 新的验证结果；
- Plan 中可验证 outcome 从未完成变为完成；
- 失败后选择了 materially different action 并产生新事实。

以下不算新进展：

- cached read；
- 同一资源、同一 digest 的重复 read；
- 重复成功 Action 被拒绝；
- 相同 Patch Conflict；
- 只改变措辞的 Plan；
- 相同完成拒绝；
- Provider reasoning 或公开进度文字。
- 只包含 `execute`、`let's go`、重复状态描述或空白的 Model Call。
- 流式 frame/heartbeat 本身；它只证明 transport liveness，不证明任务进展。
- 同一 Completion issue set 的再次拒绝。

这是目标语义，不是当前完整行为：当前诊断计算从最近 `run.resumed` 重新开始。实现必须在不新增第二套 Progress Authority 的前提下，让已有 warning/diagnostic 通过现有 Event/lineage projection 跨普通 Resume 可见；只有新用户输入、materially different action 产生新事实，或新 continuation Run 才能建立新的收敛窗口。

### 5.6 No-progress recovery

当 Run 因 `NO_PROGRESS_DETECTED` blocked：

1. 当前 `RunHandle.resume()` 对 `NO_PROGRESS_DETECTED` 仍执行无输入的 `blocked → running`，这是明确缺口；实现不得再把该路径当作普通 Resume。
2. 优先复用已有 `ResumeInput.input`、现有 continuation API 和 `cancel`，而不是先新增统一 `allowedActions` 类型：
   - 用户提供纠正信息，在同一 Run 恢复；
   - Host 在同一 Session 创建 continuation Run；
   - 结束任务。
3. Desktop 显示简洁的原因、重复资源以及：
   - 输入纠正信息；
   - `重新规划并继续`；
   - `结束任务`。
4. 不再显示没有语义的单一 `Resume`。
5. 新 Run 的 recovery projection 必须包含原目标、最新用户输入、成功事实、未完成 outcome、最近失败、churn 资源和“不要重复旧策略”的确定性 repair。
6. 新 Run 不继承旧 Run 的 no-progress 计数作为自身预算，但旧诊断必须在 Context 中可见。
7. 同一 Session 的恢复 Run 再次因相同资源/意图 no-progress blocked 时，不提供一键继续；必须新输入或结束。

### 5.7 Existing continuation projection and recovery facts (regression)

当前仓库已经实现 continuation lineage、ancestor projection、rehydration、deterministic eviction/compaction。本 Feature 不重新设计或调整 ancestor tiering 算法；只验证恢复事实能够沿现有 projection 进入后续 Model View。

回归要求：完整 Session Authority 继续可访问，但每次 Provider Call 不应默认把所有 ancestor Run 以 full payload 投影。

默认确定性层级：

1. 当前 Run：full，受本次 Provider budget 约束；
2. 直接 Parent：保留用户输入、正式 Result/Delivery、未完成状态、关键 Tool/Evidence；大型 payload 为 fragment/ref；
3. 更早 Ancestor：默认 compact/reference，只保留目标、用户修正、正式结果、失败、关键 Artifact/Evidence 和未解决约束；
4. 当前任务明确点名旧事实时，通过现有 ref/rehydration 恢复；
5. 最近修改且当前任务继续处理的资源可以作为 working set 保留，不得把整个旧 Run transcript 一并 full 注入。

上述层级是当前 continuation projection 的既有行为和回归基线。Provider hard window 和可选 Active Context Target 继续生效，不新增固定 128K 全局阈值。本 Feature 只向现有 projection 补充 no-progress、completion 和 mutation recovery facts。

### 5.8 Duration and extension quality gate

当达到 `DURATION_BUDGET_EXCEEDED`：

1. Runtime projection 必须显示本段 Provider active time、Tool time、有效进展和重复调用数量。
2. 如果自上次 start/resume/extension 后没有新进展，Desktop 主操作是提供新输入或创建恢复 Run；不得突出“Extend & Resume”。
3. 只有存在新进展且未出现同类 no-progress 诊断时，才允许一次显式 budget extension。
4. extension 不重置 usage、不清空 churn、不重放成功 Effect。
5. 再次达到 duration boundary 时必须要求新输入或新 Run，不允许连续一键 extension。

### 5.9 Provider Attempt diagnostics

复用现有 Model Call、Provider Attempt、Event 和 Artifact。错误归一化为稳定分类：

- `PROVIDER_CONNECT_TIMEOUT`
- `PROVIDER_IDLE_TIMEOUT`
- `PROVIDER_HTTP_ERROR`
- `PROVIDER_RESPONSE_INVALID`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_CANCELLED`
- `PROVIDER_ERROR`

当前 `ProviderAttemptSchema` 只有 `errorCode`，Harness 内部虽有 `retryable` 判断，但未持久化稳定分类、HTTP status 或 partial-response 标记。这里是最小 additive diagnostics 变更，不得把 Spec 中列出的分类误写成当前已存在 Contract。每个 Attempt 至少公开：分类、Attempt number、开始/结束、耗时、retryable 和是否收到部分响应。HTTP status、Provider request ID 或脱敏错误摘要只在真实存在时记录；不得伪造，也不得把 API Key 或原始敏感响应暴露给 Renderer。

同一个 logical Model Call 继续使用已有有限 retry。Retry 成功不创建新的 Tool Effect；耗尽后进入明确 blocked 原因。

Provider transport 成功和 Model response 被 Harness 接受是两个不同边界。Adapter 只归一化 transport payload；`toolCalls > 8`、字段缺失等 Model response Schema 错误必须进入现有 `response.rejected` / repair / no-progress 路径，不得转换为 `PROVIDER_UNAVAILABLE`。同一非法响应只允许一次 repair turn，第二次等价拒绝直接进入 `NO_PROGRESS_DETECTED`，且不得执行任何 Tool。

一个 logical Model Call 的有限物理 retry 耗尽后，当前进展窗口只允许一次显式 Provider Resume。该恢复段再次耗尽且没有新的 Plan、Tool Effect、Evidence、Validation 或用户输入时，Run 保持 blocked、`lastError.retryable=false`，普通 Resume 不再发起 Provider 请求。恢复连接后必须通过带新输入的 continuation Run 建立新窗口；不得增加独立 Retry Store 或重置已有 usage。

Provider streaming output 在 Harness 接受前只是临时 UI 投影。Attempt 失败或 Model response 被拒绝时必须发送 discard，Desktop 从持久化历史重建时也必须排除对应 rejected response；Provider Attempt Artifact 可保留审计材料，但不得重新显示为已接受的模型输出。

### 5.10 “继续”与模糊后续输入

不增加特殊关键词路由。对于任何短或模糊 continuation input：

1. Harness 读取 Parent 的正式状态和 recovery facts，而不是依赖旧 reasoning 猜测；
2. Parent terminal 且目标已完成时，模型应解释现状或请求具体新目标，不重新执行旧 mutation；
3. Parent cancelled/blocked/unfinished 时，使用 recovery projection 继续未完成 outcome；
4. 如果不存在唯一可恢复 outcome，使用现有 Input Request 请求用户明确，而不是遍历旧文件寻找工作。

### 5.11 Mutation postcondition and verification window

Runtime 不新增第二套任务状态，只从现有 Invocation、Evidence、Artifact 和 Validation 事实派生资源级收敛窗口：

1. 每个成功 mutation 必须公开 canonical target、result digest（若工具能提供）和可验证的 affected resource。
2. 同一资源/目标在 mutation 成功后，Harness 下一次决策优先要求一次验证 Tool 或基于已有 Evidence 的完成判断。
3. 验证通过后，该资源/目标在当前 Run 内视为已满足；重复 mutation 只能在新用户约束或新 digest 事实出现时重新开放。
4. 验证失败只允许一次 repair：读取当前状态（若 digest 不可用）并选择一次 exact patch、完整写入或结束。第二次相同 intent 的失败进入 `NO_PROGRESS_DETECTED`。
5. 多文件任务按资源分别收敛，但同一资源不得因为其他文件的进展而重新进入 read/patch 循环。

### 5.12 Completion repair boundary

Completion Gate 仍是唯一完成 Authority。Harness/Runtime 只增加结构化 repair 投影：

1. 当前拒绝事实是 `response.rejected`、`lastError` 和 details Artifact；`COMPLETION_EVIDENCE_REQUIRED` 不应被假设为已经稳定持久化的独立 issue-set Contract。实现应从这些现有 Authority 派生稳定 issue set，只有在无法跨 reopen 重建时才增加最小字段。
2. 相同 issue set 的第一次拒绝允许一次最小 repair；该 repair 不得重新注入完整旧 Transcript。
3. 同一 issue set 再次拒绝计为 no-progress，进入已有 bounded recovery，而不是再次调用相同 `finish` 策略。
4. 新 Evidence、Validation 或用户约束会使 issue set 改变并重新允许完成判断。

### 5.13 Provider stream liveness and Attempt lifecycle

复用现有流式 Provider Adapter，不新增后台 watchdog：

1. response-header timeout 只适用于首个响应；收到首个有效响应后使用 streaming idle timeout。
2. 每个完整 SSE frame 续期 idle timer；reasoning/content delta 和合法 heartbeat 都算 transport liveness。
3. idle timer 只在连续没有 frame 时触发；Provider 持续输出但没有 execution progress 时，仍由 empty-turn/no-progress 规则收敛，不能靠 heartbeat 无限延长 Run。
4. logical Model Call 的有限 retry 不复制已经产生的 Tool Invocation；流式取消、解析失败和超时必须结束当前 Attempt，再由同一 Call 的 retry 语义处理。
5. `started → completed/failed/interrupted` 必须保持现有持久化单向生命周期。Runtime reopen 的 `started → interrupted` 已实现，本 Feature 只补回归和 Host 投影验证，不重复设计。

### 5.14 Context meter authority

Context Meter 展示当前 Provider Model Call 的真实输入与模型声明窗口，不把多个 Turn 的 token 相加为“当前窗口”，也不把 Project 下多个 Session 相加。完整 Session 历史仍由 Runtime Authority 保留；每次 Call 由 Harness 生成有界 Model View。

1. UI 的“已用 / 窗口”来自最近一次实际 Provider Request 的 token meter；缺少精确 tokenizer 时明确标记 estimated。
2. 自动 eviction/compaction 是 Model View 变化，只在 Activity 记录，不重复插入 Conversation。
3. 新 continuation 必须保留当前 Session 的正式目标、成功事实、未完成 outcome 和必要 Evidence；压缩不能把上一个 Turn 的有效事实丢掉。
4. 既有 Context tiering 只做 regression：检查事实连续性、rehydration 和当前 baseline 稳定性；本 Feature 不要求重新调整 tiering 算法或预设新的 token 降幅。

## 6. Runtime and UI flow

```text
User input
→ Harness checks whether mutable Workspace facts are already authoritative
→ Model obtains the smallest required grounding fact if needed
→ Runtime/Harness applies the protected-mutation admission policy
→ Runtime Schema / duplicate / Approval / Invocation / Evidence
→ Harness receives latest authoritative observation
→ one validation or finish decision

Successful mutation
→ postcondition / validation
→ finish or one bounded repair

Repeated observation/conflict
→ one persisted repair window
→ materially different action or finish
→ otherwise NO_PROGRESS_DETECTED

Blocked recovery
→ corrective input OR continuation recovery Run OR cancel
→ never generic replay of the same strategy
```

Conversation 仍只显示用户能理解的 Tool、错误、恢复和结果；完整 Attempt、诊断 fingerprint、ID 和 timing 留在 Activity。

## 7. Minimal implementation shape

### Runtime

- 保持已有 Invocation/read cache/no-progress Authority；
- 使 convergence diagnostic 跨普通 Resume 保留；限制 `NO_PROGRESS_DETECTED` 的无输入 Resume；
- 为 budget extension 投影“是否有新进展”；
- 为重复 Completion issue、empty turn、mutation postcondition 和 Attempt reopen 提供现有 Event/Inspection 的最小派生事实；
- 不新增第二个状态机或 Batch Queue。

### Harness

- grounded Workspace fact 判断；
- mutation batch admission/recovery（先验证现有 batch persistence；仅在无法确定性恢复 sibling 时启用 fail-fast）；
- read-already-available 和 Patch Conflict repair；
- 将 recovery/no-progress facts 接入现有 continuation projection；
- recovery projection。
- empty-turn repair、completion repair 和 mutation 后一次验证约束；

### Provider Adapter

- 归一化已有错误类型；
- 保持 logical call 内有限 retry；
- 区分首响应超时、流式 idle timeout、持续 liveness 和空响应；
- 不增加 Provider-name 特判。

### Desktop Host / Renderer

- 根据 Runtime `stopReason`、inspection 和现有 recovery/continuation 入口显示对应 Composer；
- 不拼接 Context、不判断 Tool 是否重复、不创建恢复状态；
- no-progress 和无进展 duration 不显示通用 Resume；优先复用现有 continuation/input/cancel 入口，不先引入统一 `allowedActions`。
- 展示 empty turn、Completion 缺失依据和 stale Attempt 的具体恢复动作，不伪造“正在执行”。

## 8. Non-goals

- Workflow Engine、Scheduler 或新的 Supervisor；
- 第二套 Run/Plan/Session/Recovery/Context Authority；
- LLM summarizer、向量检索、Embedding 或新 Context 数据库；
- AST patch、模糊 patch 或 multi-file transaction Tool；
- 持久化 mutation Batch Queue；
- 自动无限 retry、budget extension 或 Resume；
- Provider-name 特殊策略；
- 通过关键词判断任务意图或安全风险；
- 放宽 Approval、Completion Gate 或 unknown Effect Recovery；
- 前端维护 Tool/Plan/Progress 状态；
- 将 Provider reasoning 当作 Evidence 或恢复指令。

## 9. Acceptance criteria

### Grounding and ordinary task convergence

1. 当前 Workspace 文件/路由问题在没有有效 Fact 时，第一次决策不得先 direct response / completion；Model 必须取得最小必要 grounding fact，测试不得预设具体只读 Tool，也不应先触发 `COMPLETION_EVIDENCE_REQUIRED`。
2. 一个“修复 Solutions Learn More 链接”的确定性任务在不超过 6 个 Model Call、8 个 Tool Invocation 内完成；这是 fixture regression bound，不是 Runtime 通用硬限制。
3. 同一 canonical read/input 在资源 digest 未变化时只物理执行 1 次；大文件 range continuation、明确 freshness 检查和 mutation 后的一次验证读取必须有独立可审计原因。
4. 普通修复接近一次读取批次、一次修改、一次验证，不要求精确固定 Tool 数量。

### Mutation batch and conflict

5. 多 protected mutation 的 Provider 响应要么在任何 Effect 前被拒绝并收到 one-at-a-time repair，要么由现有 batch 事实证明 sibling 可确定性恢复；不得只执行第一个后静默丢弃 sibling。
6. 相同成功 mutation 不因 retry、Resume 或 continuation 重放。
7. 同一 Patch intent 第二次冲突后 block；不会继续无限 read/patch。

### No-progress and recovery

8. no-progress diagnostic 跨普通 Resume 保留。
9. `NO_PROGRESS_DETECTED` 后不能使用无输入的通用 Resume 重新执行原策略。
10. recovery Run 获得原目标、成功事实、失败和重复资源，但不会获得完整旧 transcript 或旧 reasoning。
11. 相同资源和意图再次 no-progress 后必须要求新输入或结束。

### Context and Provider

12. 长 Session 的新 continuation 默认将更早 ancestors 降为 compact/reference，不等到接近硬窗口。
13. 基线形状 Session 的既有 continuation projection 在回归中保持当前 baseline：保留最新用户目标、成功文件事实和未完成工作，并维持 direct-parent compact / older-ancestor reference 行为；本 Feature 不要求重新实现 tiering 或预设新的 Provider input 降幅。
14. Provider timeout、HTTP、invalid response、unavailable、cancelled 可在 Attempt audit 中区分。
15. logical call retry 不产生重复 Tool Invocation；retry 耗尽后有明确 blocked 原因。
16. 持续 SSE frame 不触发 idle timeout；无有效输出的空转在一次 repair 后被阻断。
17. mutation 成功后必须进入一次 validation/finish 窗口；同一目标不重复 read/write。
18. 同一 Completion issue set 第二次拒绝后进入 bounded recovery，不重复整轮执行。
19. Runtime reopen 将孤儿 started Attempt 标为 interrupted，不自动 Provider 重放。

### Duration and Desktop

20. 无新进展的 Duration Block 不突出 Extend & Resume；用户可以提供新输入、创建恢复 Run或结束。
21. 有新进展时最多允许一次显式 extension，第二次 boundary 要求新输入或新 Run。
22. Desktop 继续保持两栏和同一 Conversation/Activity，不增加 Dashboard。

### Safety and durability

23. Approval、Schema、Invocation、Evidence、Completion、Context integrity 和 unknown Effect Recovery 回归通过。
24. Runtime reopen 后，read validity、no-progress diagnostic、Provider Attempt 分类和 continuation lineage 保持一致。
25. delegated Child fresh budget、blocked Worker recovery、root-only Session projection、unique Branch lifecycle、Plan semantic no-op 和资源级 read-cache invalidation 的既有 BEC 回归继续通过。

## 10. Verification plan

### Deterministic tests

- grounded direct response：缺少有效 Workspace Fact 时 direct response / completion 不得先行，Model 必须取得最小必要 grounding fact；已有有效 Fact 时可直接回答；测试不得预设某个具体只读 Tool；
- repeated read：同 digest observation 只物理执行一次，repair 后再次重复则 block；
- resource churn：read/write 交替在有界窗口内 block，Resume 不清空诊断；
- mutation batch adversarial：对两个 protected sibling 验证现有 batch persistence 在 Approval / reopen 后能否确定性恢复所有未执行 sibling；若能，验证无丢失、无重复 Effect；若不能，验证 Provider response 在任何 Effect 前 fail-fast；
- patch conflict：一次 read/repair 后成功或第二次 conflict block；
- recovery continuation：只投影有界事实，不重放成功 Invocation；
- continuation projection regression：direct parent compact、older ancestor reference、点名 ref 可恢复，并保留 recovery/no-progress facts；不重新调整 tiering 算法；
- Provider errors：connect/idle/HTTP/invalid/cancelled/unknown 分类；
- duration quality gate：有进展与无进展两条 UI/Runtime 路径；
- streaming liveness：持续 reasoning/heartbeat 不 idle timeout，空 turn 在 bounded repair 后停止；
- mutation postcondition：成功写入后验证一次并完成，不重读重写；
- completion repair：重复 issue set 不重新执行完整旧策略；
- orphan Attempt reopen：started Attempt 转 interrupted 且不重放；
- reopen：上述事实重启后稳定。

### Scenario regressions

1. 复现 `a8db...`：询问当前 Solutions 行为，必须先读取相关文件并给出有依据结论。
2. 复现 `b992...`：修复 Learn More 链接，在 acceptance bounds 内完成，不能重复读取 `solutions.html`。
3. 复现 `aabaab...`：长 Session + Provider transient failures，既有 continuation projection 保持事实连续性并接入 recovery facts，有限重试后成功或明确 blocked，不出现连续通用 Resume。

### Required validation

- typecheck、lint、build；
- focused Runtime/Harness/Desktop tests；
- complete L3 suite；
- deterministic Electron UAT；
- 使用授权 Qwen Provider 的一次基线形状 Canary，作为外部 acceptance，不是本地 Feature Core 的唯一证据。

## 11. Delivery and rollback

实现顺序：

1. 先补 deterministic counterexample tests；
2. 修复 read/progress/mutation batch 收敛；
3. 修复 no-progress 与 duration recovery；
4. 将 recovery/no-progress facts 接入现有 continuation projection，并执行既有 Context tiering 回归；
5. 增加 Provider error 分类和 Desktop 投影；
6. 完整回归和 UAT。

优先复用已有 Event、Invocation、Evidence、Model Call、Provider Attempt 和 continuation projection。若现有字段足以表达，不做数据库迁移。任何失败都保留原 Run 和审计事实；回滚只关闭新策略，不删除历史。

只有实现、复现用例、完整回归、Desktop UAT 和文档一致时才能标记 `done_locally`。当前仅为可实施 Spec，不代表问题已经修复。
