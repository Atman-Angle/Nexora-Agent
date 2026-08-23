# Recoverable Session Execution Spec

Status: Ready for implementation

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

模型多次在一个 Turn 中返回四个页面写入。Runtime 在第一个 protected mutation 产生 Approval 后停止该批次；批准后只完成当前 Action，剩余 sibling 没有作为待继续工作保留。下一轮模型容易重新提交完整批次，造成：

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
- 9 次 Model Call 和 9 次 Tool Invocation；
- 每次实际输入约 395K–405K tokens；
- 5 个首轮 Attempt 以泛化的 `PROVIDER_ERROR` 失败；
- Provider 调用通常耗时约 50–82 秒；
- 最终 `DURATION_BUDGET_EXCEEDED`。

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

进程退出或 Desktop 卡死后，旧 Provider Attempt 可能仍显示为 `started`，让用户误以为任务仍在执行或继续 Resume 可以复用它。重开 Runtime 必须把无活动 Lease 的 started Attempt 确定性标记为 `interrupted`，保留审计事实，不自动重发 Provider 请求，也不把它作为有效进展或完成依据。

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
| P0 | mutation batch 重发 | Approval 在第一个 mutation 停止批次，未执行 sibling 没有稳定投影 | Harness + Runtime execution |
| P1 | Patch Conflict 后持续 read/patch | repair context 没有强制一次重新观察后收敛到 finish、single patch 或 full write | Harness |
| P1 | 简单 Workspace 问题先直接回答 | current mutable workspace fact 与 grounded direct response 边界不清 | Harness + Completion integration |
| P1 | 400K Context 重复发送 | ancestor Runs 长期保持 full，只有接近容量边界才收缩 | Harness Context |
| P1 | Provider 错误无法判断 | Attempt 只暴露泛化错误码，Activity 无具体分类 | Provider Adapter + Runtime audit |
| P1 | Provider 有流但被误判超时，或结束后空转重试 | idle timeout 与 execution progress 未分离；空输出没有有界 repair | Provider Adapter + Harness |
| P1 | mutation 后继续 read/patch，未验证即循环 | 没有资源/目标级 postcondition 和一次验证窗口 | Harness + Runtime execution |
| P1 | Completion rejection 重复整轮执行 | 缺少一次性结构化 completion repair，重复 issue set 未计为 no-progress | Runtime Completion + Harness |
| P1 | 重启后遗留 started Attempt 误导恢复 | Attempt 生命周期和 reopen projection 不一致 | Runtime Store + Host |
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

## 5. Scope

### 5.1 Grounded Workspace decision

当用户问题依赖当前 Workspace 的可变事实，例如文件内容、路由、链接、构建结果或 Git 状态：

1. 如果当前 Model View 已有未失效的精确 Tool Fact，可直接回答。
2. 否则第一次决策必须选择最小只读 Tool，不能先提出无 Evidence 的完成。
3. 该规则基于“所需事实是否存在且仍有效”，不使用中文/英文关键词分类，也不增加意图识别模型。
4. Completion Gate 继续拒绝缺失 Evidence 的完成，不增加宽松旁路。

### 5.2 Read observation reuse and repeat bounding

物理 read cache 不足以解决逻辑重复读取。本 Feature 增加以下确定性规则：

1. 相同 canonical read/input 在没有相关 mutation、resume invalidation 或明确 freshness 要求时，继续复用已有成功 payload，不重复 I/O。
2. Harness 在 Model View 中只保留该资源最新、完整且未失效的 observation，并明确标记其 digest/有效性；不同时投影多个等价 read 结果。
3. Provider 再次请求相同有效 observation 时，Runtime 可以记录 cached Invocation，但该调用不计为新进展。
4. 同一有效 observation 的第二次语义重复进入一次 `READ_ALREADY_AVAILABLE` repair；忽略 repair 后再次请求则进入 `NO_PROGRESS_DETECTED`。
5. 对同一资源交替 read/mutation 的 churn 继续使用资源级判断，但 Resume 不得清空已经持久化的 churn 事实。
6. 真正改变资源 digest 的成功 mutation、明确的 freshness 检查或 Run reopen 后必要的安全校验可以使后续 read 成为有效进展。

不新增独立 Read Store；仍使用 Invocation、Evidence 和现有 read-cache 数据。

### 5.3 Protected mutation batch policy

首版不新增持久化 Batch Queue，也不在 Pending Approval 中保存一套平行 sibling 状态。

采用最小 fail-fast 规则：

1. 一个 Provider Turn 可以包含多个 read Tool Call。
2. 一个 Provider Turn 最多接受一个需要 Approval 的 mutation/execute Tool Call。
3. 如果响应包含多个 protected mutation，Harness 在任何 Effect 前拒绝该响应，并返回结构化 repair：一次提交一个 mutation，或在同一已完整读取文件上合并为一次 `filesystem.write`。
4. 不允许执行第一个 mutation 后静默丢弃剩余 sibling。
5. 已成功 mutation 在下一轮必须以完成事实投影，模型不得重新提交相同 Tool/input。

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

No-progress 诊断和 repair warning 必须跨普通 Resume 保留，只有新用户输入、materially different action 产生新事实，或新 continuation Run 才能建立新的收敛窗口。

### 5.6 No-progress recovery

当 Run 因 `NO_PROGRESS_DETECTED` blocked：

1. `RunHandle.resume()` 不能无条件重新开放原策略。
2. Runtime 公开允许的恢复动作：
   - `continue_with_input`：用户提供纠正信息，在同一 Run 恢复；
   - `continue_as_new_run`：由 Host 在同一 Session 创建 continuation Run；
   - `cancel`。
3. Desktop 显示简洁的原因、重复资源以及：
   - 输入纠正信息；
   - `重新规划并继续`；
   - `结束任务`。
4. 不再显示没有语义的单一 `Resume`。
5. 新 Run 的 recovery projection 必须包含原目标、最新用户输入、成功事实、未完成 outcome、最近失败、churn 资源和“不要重复旧策略”的确定性 repair。
6. 新 Run 不继承旧 Run 的 no-progress 计数作为自身预算，但旧诊断必须在 Context 中可见。
7. 同一 Session 的恢复 Run 再次因相同资源/意图 no-progress blocked 时，不提供一键继续；必须新输入或结束。

### 5.7 Session continuation Context tiers

完整 Session Authority 继续可访问，但每次 Provider Call 不再默认把所有 ancestor Run 以 full payload 投影。

默认确定性层级：

1. 当前 Run：full，受本次 Provider budget 约束；
2. 直接 Parent：保留用户输入、正式 Result/Delivery、未完成状态、关键 Tool/Evidence；大型 payload 为 fragment/ref；
3. 更早 Ancestor：默认 compact/reference，只保留目标、用户修正、正式结果、失败、关键 Artifact/Evidence 和未解决约束；
4. 当前任务明确点名旧事实时，通过现有 ref/rehydration 恢复；
5. 最近修改且当前任务继续处理的资源可以作为 working set 保留，不得把整个旧 Run transcript 一并 full 注入。

该层级适用于普通 continuation，不只在接近模型硬窗口时触发。Provider hard window 和可选 Active Context Target 仍继续生效，不新增固定 128K 全局阈值。

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

每个 Attempt 至少公开：分类、Attempt number、开始/结束、耗时、retryable 和是否收到部分响应。HTTP status、Provider request ID 或脱敏错误摘要只在真实存在时记录；不得伪造，也不得把 API Key 或原始敏感响应暴露给 Renderer。

同一个 logical Model Call 继续使用已有有限 retry。Retry 成功不创建新的 Tool Effect；耗尽后进入明确 blocked 原因。

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

1. 每次拒绝记录稳定 issue set、所需 Evidence 类型、关联目标/资源和最小下一动作。
2. 相同 issue set 的第一次拒绝允许一次最小 repair；该 repair 不得重新注入完整旧 Transcript。
3. 同一 issue set 再次拒绝计为 no-progress，进入已有 bounded recovery，而不是再次调用相同 `finish` 策略。
4. 新 Evidence、Validation 或用户约束会使 issue set 改变并重新允许完成判断。

### 5.13 Provider stream liveness and Attempt lifecycle

复用现有流式 Provider Adapter，不新增后台 watchdog：

1. response-header timeout 只适用于首个响应；收到首个有效响应后使用 streaming idle timeout。
2. 每个完整 SSE frame 续期 idle timer；reasoning/content delta 和合法 heartbeat 都算 transport liveness。
3. idle timer 只在连续没有 frame 时触发；Provider 持续输出但没有 execution progress 时，仍由 empty-turn/no-progress 规则收敛，不能靠 heartbeat 无限延长 Run。
4. logical Model Call 的有限 retry 不复制已经产生的 Tool Invocation；流式取消、解析失败和超时必须结束当前 Attempt，再由同一 Call 的 retry 语义处理。
5. `started → completed/failed/interrupted` 必须是持久化单向生命周期。Runtime reopen 时，无活动 Lease 的 `started` Attempt 只转为 `interrupted`，不自动执行或计入 progress。

### 5.14 Context meter authority

Context Meter 展示当前 Provider Model Call 的真实输入与模型声明窗口，不把多个 Turn 的 token 相加为“当前窗口”，也不把 Project 下多个 Session 相加。完整 Session 历史仍由 Runtime Authority 保留；每次 Call 由 Harness 生成有界 Model View。

1. UI 的“已用 / 窗口”来自最近一次实际 Provider Request 的 token meter；缺少精确 tokenizer 时明确标记 estimated。
2. 自动 eviction/compaction 是 Model View 变化，只在 Activity 记录，不重复插入 Conversation。
3. 新 continuation 必须保留当前 Session 的正式目标、成功事实、未完成 outcome 和必要 Evidence；压缩不能把上一个 Turn 的有效事实丢掉。
4. Context tiering 的验收同时检查事实连续性和 Provider 输入下降，不能只检查 token 数。

## 6. Runtime and UI flow

```text
User input
→ Harness checks whether mutable Workspace facts are already authoritative
→ smallest read if required
→ Provider returns at most one protected mutation
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
- 使 convergence diagnostic 跨普通 Resume 保留；
- no-progress 公开 allowed recovery actions；
- 为 budget extension 投影“是否有新进展”；
- 为重复 Completion issue、empty turn、mutation postcondition 和 Attempt reopen 提供现有 Event/Inspection 的最小派生事实；
- 不新增第二个状态机或 Batch Queue。

### Harness

- grounded Workspace fact 判断；
- mutation batch fail-fast；
- read-already-available 和 Patch Conflict repair；
- continuation 默认 tiering；
- recovery projection。
- empty-turn repair、completion repair 和 mutation 后一次验证约束；

### Provider Adapter

- 归一化已有错误类型；
- 保持 logical call 内有限 retry；
- 区分首响应超时、流式 idle timeout、持续 liveness 和空响应；
- 不增加 Provider-name 特判。

### Desktop Host / Renderer

- 根据 Runtime stop reason 和 allowed actions 显示对应 Composer；
- 不拼接 Context、不判断 Tool 是否重复、不创建恢复状态；
- no-progress 和无进展 duration 不显示通用 Resume。
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

1. 当前 Workspace 文件/路由问题在没有有效 Fact 时，第一次决策调用最小 read，不先触发 `COMPLETION_EVIDENCE_REQUIRED`。
2. 一个“修复 Solutions Learn More 链接”的确定性任务在不超过 6 个 Model Call、8 个 Tool Invocation 内完成。
3. 同一 canonical read/input 在资源 digest 未变化时只物理执行 1 次；大文件 range continuation、明确 freshness 检查和 mutation 后的一次验证读取必须有独立可审计原因。
4. 普通修复接近一次读取批次、一次修改、一次验证，不要求精确固定 Tool 数量。

### Mutation batch and conflict

5. 多 protected mutation 的 Provider 响应在任何 Effect 前被拒绝并收到 one-at-a-time repair；不存在只执行第一个后丢弃 sibling。
6. 相同成功 mutation 不因 retry、Resume 或 continuation 重放。
7. 同一 Patch intent 第二次冲突后 block；不会继续无限 read/patch。

### No-progress and recovery

8. no-progress diagnostic 跨普通 Resume 保留。
9. `NO_PROGRESS_DETECTED` 后不能使用无输入的通用 Resume 重新执行原策略。
10. recovery Run 获得原目标、成功事实、失败和重复资源，但不会获得完整旧 transcript 或旧 reasoning。
11. 相同资源和意图再次 no-progress 后必须要求新输入或结束。

### Context and Provider

12. 长 Session 的新 continuation 默认将更早 ancestors 降为 compact/reference，不等到接近硬窗口。
13. 基线形状 Session 的 continuation Provider input 相比旧 Run 至少降低 50%，同时保留最新用户目标、成功文件事实和未完成工作。
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

- grounded direct response：缺少 Workspace Fact 时第一次选择 read；已有有效 Fact 时可直接回答；
- repeated read：同 digest observation 只物理执行一次，repair 后再次重复则 block；
- resource churn：read/write 交替在有界窗口内 block，Resume 不清空诊断；
- mutation batch：两个 protected sibling 在 Effect 前 fail-fast；
- patch conflict：一次 read/repair 后成功或第二次 conflict block；
- recovery continuation：只投影有界事实，不重放成功 Invocation；
- context tiering：direct parent compact、older ancestor reference、点名 ref 可恢复；
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
3. 复现 `aabaab...`：长 Session + Provider transient failures，Context 明显低于旧基线，有限重试后成功或明确 blocked，不出现连续通用 Resume。

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
4. 调整 continuation tiering；
5. 增加 Provider error 分类和 Desktop 投影；
6. 完整回归和 UAT。

优先复用已有 Event、Invocation、Evidence、Model Call、Provider Attempt 和 continuation projection。若现有字段足以表达，不做数据库迁移。任何失败都保留原 Run 和审计事实；回滚只关闭新策略，不删除历史。

只有实现、复现用例、完整回归、Desktop UAT 和文档一致时才能标记 `done_locally`。当前仅为可实施 Spec，不代表问题已经修复。
