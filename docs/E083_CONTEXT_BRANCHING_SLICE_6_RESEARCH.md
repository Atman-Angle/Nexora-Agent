# E083 Context Branching / Fork Slice 6 调研方案

日期：2026-08-07
分支：`codex/runtime-restructure`（HEAD `2e57b63`，Slice 5 完成，工作树干净）
类型：调研与方案定义（不修改代码、不创建 migration、不编写测试、不实现）

---

## 1. 当前仓库与 Slice 1–5 的相关事实（证据）

### 1.1 仓库状态
- 分支 `codex/runtime-restructure`，HEAD `2e57b63`（`feat(runtime): add context rehydration via request_context`），工作树干净。
- Slice 1–5 已独立提交，报告在 `docs/E078…E082_*.md`。
- 源码结构（重构后）：`providers/`、`context/`、`store/`、`execution/`、`runtime.ts`、`runtime-lease.ts`、`runtime-helpers.ts` 等。

### 1.2 Authority 边界（证据：`store/schema/v1-core.ts`、`store/run-store.ts`）
- **`run_id` 是唯一隔离边界**。`runs`、`run_events`、`tool_invocations`、`model_calls`、`context_checkpoints` 全部 `FOREIGN KEY (run_id)`；不同 run 之间零共享可变状态。
- **Revision 是 run 内单调递增整数**。`#commitRunInTransaction`（`run-store.ts:752`）断言 `row.revision === previous.revision` + `#assertFencing`，提交后 `revision + 1`。乐观并发。
- **Event 是 append-only**，`run_events.sequence` 单调递增，`UNIQUE (run_id, sequence)`。
- **幂等键 run 内唯一**：`UNIQUE (run_id, idempotency_key)`（`v1-core.ts:44`）。不同 run 幂等键空间独立。
- **Artifact 全局内容寻址**：`ArtifactStore` 按 `sha256:<hex>` 寻址，跨 run 共享、不可变，不 FK run_id。

### 1.3 Slice 1–5 关键机制
- **Projection**（`context/projection.ts`）：每轮从权威事实重建有界决策输入，`projectRunContext` 只暴露未覆盖输入。
- **Eviction**（`context/eviction.ts`）：确定性收缩 toolObservations，生成 `invocation:/evidence:/artifact:` 引用。
- **Compaction**（`context/compaction.ts`）：`context_checkpoints` 表（plan_version、revision、summary、digest、source_digests、covered_invocations），`commitCheckpoint` 替换同 run 旧 checkpoint，`isCheckpointValid` 校验 source digests。
- **Rehydration**（`context/rehydration.ts`）：`request_context` 是 Harness 控制动作（`type ModelAction = RuntimeAction | RequestContextAction`），不进 `RuntimeActionSchema`/state-machine/`#handleAction`；`availableContextRefs` manifest 校验；`context.rehydrate_requested/rehydrated` 事件对做崩溃恢复。
- **Lease/Fencing**（`runtime-lease.ts`）：`LeaseManager` 持有 in-process lease + heartbeat；`fencing_token` 保护所有写（commitRun/commitCheckpoint/recordRunEvent）。
- **State Machine**（`state-machine.ts`）：`running/waiting/blocked/cancelled/failed/succeeded`，转换表固定；`succeeded` 需 passed validation + result。
- **Completion Gate**（`validation.ts`）：`proposeFinish` 解析明确引证的 persisted Evidence，覆盖全部 required Checks。

### 1.4 Harness 与 Runtime Core 职责划分（证据：`runtime.ts`、`context/`、apps）
- **Runtime Core**：状态机、`run-store`、`runtime-lease`（Lease/Fencing）、`execution/`（callTool/recoverToolInvocation）、approval、recovery、completion gate（validation）。
- **Harness**：`#runLoop` 编排（识别 request_context 等控制动作）、`context/` 管线（projection/eviction/compaction/rehydration）、`request_context` 处理、`context.rehydrate_requested/rehydrated` 事件。
- apps（CLI、research-agent）通过 `createRuntime`/`RuntimeEngine` 使用 runtime 包，不直接写 Core Store。

### 1.5 现状缺口
- **无父子概念、无 branch 实体、无 fork 记录、无合并**。
- `RunEngine` 公共 API（`runtime-types.ts`）只有 start/resume/openRun/close + RunHandle（inspect/wait/result/subscribe/input/approve/deny/resume/cancel）。
- 无跨 run 的"分支导航/合并"概念。

---

## 2. 推荐的 Slice 6 目标

让用户能从父 Run 的某个确定 revision 创建**隔离的探索分支**，分支独立运行、独立上下文/Checkpoint/Rehydration/执行历史，不修改父路径；分支可被列出、读取、切换、丢弃，并支持**显式、受控的合并**（把父分支认可的输入/Plan/Artifact/分支摘要合并回来，而不是共享 authority）。

核心原则：**Fork 创建一条新探索路径，不把父 Run 的 Authority 变成共享可变状态。**

目标用例：
- 在父 Run 的某个 revision 上，分支尝试"改动 Plan 后的另一条路径"。
- 分支独立推进（输入、调用工具、产生分支自己的 Plan/Evidence/Checkpoint）。
- 用户查看分支结果，决定丢弃或把认可的结论合并回父分支。

---

## 3. 推荐的 Runtime Core / Harness 职责划分

### Runtime Core 只提供最小稳定能力
1. **Fork 原语**：`store.createRunFromSnapshot(parentSnapshot, forkPoint)` —— 从父当前 snapshot 深拷贝出一个 revision 0 的 child run（含 inputHistory/taskContract/currentPlan/stepProgress/evidence 副本），并原子登记 `BranchForkBase`（inherited refs + digests）。
2. **持久化 Branch 元数据表**：`branches` + `branch_fork_base`（Branching 必须跨重启，故落在 Core schema v5）。
3. **条件合并原语**：在父分支上基于 fencing + revision 的新 commit（复用现有 `commitRun`），并校验合并来源（Artifact digest、Plan proposal 来源、branches 状态）。
4. **Artifact 全局访问**：复用 `ArtifactStore`。
5. **事件记录**：`recordRunEvent`（复用）记录 branch.created/merged/discarded。
6. **Workspace 目录快照原语**：staging 复制 → 路径/符号链接/大小校验 → 原子重命名 → creating 状态恢复清理（FileSystem 与 SQLite 无法同一事务，故 creating 是必要中间态）。

### Harness 提供编排与策略
- Fork 决策（何时、从当前 revision fork）。
- 分支导航（list/read/switch/discard）。
- 分支摘要生成（复用 Compaction）。
- 合并策略（白名单选择、Plan proposal 转交给父 Harness 重新规划、来源校验）。
- 分支的 request_context/Rehydration 由现有 context/ 管线覆盖，但需注入 `BranchForkBase` 的 inherited facts 读取边界（见 2.5）。

**判据**：Core 不感知"探索策略"；Harness 调用 Core 的 fork/merge 原语。

---

## 4. 需要拍板的架构决策及各方案取舍

### 决策 1：分支表示为 Child Run、独立 Branch 实体，还是 Harness 层 Context Fork？
**推荐：独立 `Branch` 实体 + 关联 `child_run`。**
- 取舍 A（纯 Child Run）：复用全部 run 隔离，但无法表达 lineage、fork point、合并状态。
- 取舍 B（独立 Branch 实体）：`branch_id` 记录 `(parent_run_id, fork_revision, fork_event_sequence, child_run_id, status, lineage)`，`child_run_id` 指向实际承载执行的 Run。**推荐**——既复用 run 隔离，又表达父子/合并。
- 取舍 C（Harness 内存 Context Fork）：不持久化，无法跨重启导航/恢复，违背"重启后的分支恢复和导航"验收。

### 决策 2：Fork 绑定 Run Revision、Event Sequence、还是 Checkpoint？
**推荐：绑 `(parent_run_id, fork_revision, fork_event_sequence)`，不绑 Checkpoint。**
- revision 是权威版本号（`#commitRunInTransaction` +1），天然稳定。
- event sequence 是 append-only 权威历史的确定点。
- Checkpoint 是 Prompt 派生缓存（`isCheckpointValid` 会失效重建），不能作权威 fork 锚点。

**第一版约束（用户补充）：只能从父 Run 当前已持久化 Revision Fork。**
- `requestedForkRevision === parent.currentRevision`。Fork 总是从父当前的 `RunSnapshot`（含其 Invocation/Event/Artifact 引用）deep copy 出 child。
- 从任意历史 Revision Fork 需要额外机制（历史 Snapshot、完整 Event Replay、对应 Revision 的 Workspace Snapshot、历史 Artifact/Invocation 映射），**不纳入 Slice 6**。
- 记录 `fork_event_sequence`（= 该 revision 最后事件的 sequence）供审计/校验，但第一版 child 的继承边界由 `fork_revision` 定义。

### 2.5 Fork 快照闭合：BranchForkBase 与 inherited / local facts（用户补充，结构性）

问题：child 深拷贝 `evidence / currentPlan / stepProgress` 后，这些记录内部的 `invocation:<id>` / `artifact:sha256:` / `event:<seq>` 引用仍指向 **parent_run_id** 的 Invocation/Artifact/Event。child 的 Rehydration、审计、验证若只按自身 `run_id` 查找，会找不到这些 fork 前的事实——"child 独立运行"与"完整继承 fork 状态"无法同时成立。

**新增 `BranchForkBase`（持久化，与 branches 表同库）：**
```text
BranchForkBase
- parent_run_id
- fork_revision
- fork_event_sequence
- inherited_refs_json     # fork 前从父继承的 sourceRefs → digest（来自父 snapshot 的 evidence/plan/input 引用）
```
每个 Branch 关联一个 BranchForkBase。语义：
- **inherited facts**：fork 前从父继承，**只读**（child 无权修改/删除）；
- **local facts**：fork 后由 child 的 Run 自己产生（child `run_id` 下的 invocation/evidence/checkpoint/event）。

**Rehydration / 审计 / 验证的读取边界**：
- child 自己的 facts（local，按 `child_run_id`）；
- Fork Base 明确公开、且位于 `fork_event_sequence` 之前的父 facts（inherited，按 `parent_run_id` + inherited_refs 读取，只读）；
- **不能读取父 Run 在 fork 点之后产生的任何内容**（`run_events.sequence > fork_event_sequence` 一律拒绝）。

实现提示：`buildAvailableContextRefs` / `resolveRehydratedFact` / `buildCompactionAuthority` 需要知道 child 的"可读宇宙"= child authority ∪ Fork Base inherited refs；Manifest 只包含这两部分，且 inherited 部分 digest 以 fork 点为准（fork 后父 digest 漂移不追溯）。

### 决策 3：父分支 Fork 后继续变化时，子分支是否保持固定快照？
**推荐：是，子是 fork 点的不可变快照（deep copy）。**
- 核心原则要求不共享可变 authority。child 一经创建，其 snapshot 是 fork 点副本，父后续变化不进入 child。
- 父分支的 Checkpoint（`context_checkpoints`）不复制给 child（child 独立产生自己的 checkpoint），避免共享 Prompt 缓存。
- fork 后父的新 Invocation/Event/Evidence 属于父，child 既不可见也不可继承（见 2.5 读取边界）。

### 决策 4：分支能否执行 Tool，尤其有外部副作用的 Tool？
**推荐：能，但受 workspace 隔离约束（见决策 5）。**
- 分支要"探索替代方向"，需调用工具验证假设。
- 分支的 `tool_invocations` 独立记录（child run 权威），幂等键空间独立。
- write/execute 工具在分支同样触发 approval（复用现有 protected action 机制）。
- **副作用 Invocation 不直接合并回父**（见决策 6/7）。

### 决策 5：分支的 Workspace、Invocation、Evidence、Artifact、Approval 如何隔离？
**（用户拍板）Workspace 采用独立目录快照；失败则只读降级。**
- **Invocation/Evidence/ModelCall/Checkpoint/Event**：通过 child `run_id` 天然隔离（全部 FK run_id）。**推荐**。
- **Artifact**：全局内容寻址、不可变、跨 run 共享。分支产生的新 artifact 是全局的，仅 child 引用；删除分支不删除父仍引用的 artifact（content-addressed 天然满足）。**推荐**。
- **Workspace（用户拍板：目录快照，非抽象 CoW）**：
  - 流程：创建 `branch_id` → 将父 workspace 复制到 staging 目录 → 校验路径、符号链接、文件数量与大小上限 → 原子重命名为分支 workspace → 创建 child run 与 branches 记录 → `branch.status = active`。
  - **不使用硬链接模拟 CoW**（子分支写入可能通过同一 inode 修改父文件）。
  - 文件系统与 SQLite 无法共享同一事务，因此需要 `creating` 中间状态 + 启动恢复清理（见 Branch 状态）。
  - 无法可靠创建快照时，分支降级为只读（`allowedActions` 不暴露 write/execute 工具，或工具执行拒绝 mutation）。
- **Approval**：child run 独立 pendingRequest；目录快照可写时 write/execute 同样要求 approval；只读模式下无 write/execute。

### Branch 状态（用户补充，至少）：`creating | active | merged | discarded | failed`
`creating` 是"文件系统已完成但 SQLite 事务可能未提交"的中间态；启动时对 `creating` 分支做恢复清理（删除半成品 staging/workspace 或完成提交），满足"cancellation/crash/restart 不留下半完成分支"。

### 决策 6：受控合并允许合并什么？
**（用户拍板）严格白名单：**
| 内容 | 是否允许合并 | 说明 |
|---|---|---|
| 用户输入（fork 后分支新增输入） | 允许（显式） | 作为父分支下一轮的受控 input 追加 |
| Plan proposal | 允许（显式） | 分支 Plan 作为父 Run 的 **merge proposal / 新输入**，由父 Harness 重新规划并产生父自己的 Plan Revision；**不直接覆盖父 `currentPlan`** |
| Artifact 引用 | 允许 | 全局内容寻址，父可直接引用 |
| 分支摘要 / Compaction 结果 | 允许 | 仅作为 Prompt 派生缓存，非 Authority |
| currentPlan 直接覆盖 | **禁止** | 父 Plan Revision 只能由父自身规划产生 |
| Evidence | **禁止** | 分支 Evidence 不能证明父完成；父 Run 必须通过自身执行与验证链重新产生 Evidence |
| Invocation / Approval / 完成状态 / 副作用事实 | **禁止** | 已发生副作用不能伪装未发生或被重复执行 |

### 决策 7：如何避免合并重复执行 Tool、错误继承 Evidence、覆盖父状态？
- 合并总是产生父的**新 revision**（走 `commitRun`，fencing + revision 乐观并发），不直接改父 snapshot。
- Artifact 引用合并前校验 digest 存在性。
- Evidence/副作用不合并；父分支如需分支事实，显式重新执行工具（在父分支产生自己的 invocation/evidence）。
- 幂等去重：若父分支已有相同 `idempotency_key` 的 invocation，拒绝合并该来源。
- **父分支漂移检测**：合并若父 revision 已前进（fork 点之后父又变化），需基于最新 revision 或显式接受漂移并对齐。

### 决策 8：Branching 主要位于 Harness，Core 最少提供什么？
Core 最少：fork 原语（createRunFromSnapshot + 隔离 workspace 快照/CoW 或只读约束）、branches 表持久化、fencing 条件 commit、artifact 全局访问、事件记录。
Harness：fork 决策、导航、合并策略、分支摘要。

### 决策 9：是否需要新增持久化结构、公共 API、事件、migration？
**（用户拍板）需要，schema v5，branches 表落入 Runtime Core。**
- **持久化**：`branches` 表（`branch_id, parent_run_id, fork_revision, fork_event_sequence, child_run_id, status, lineage_json, created_at`）落入 Core schema v5，因为 lineage/fork point/child_run 关联/状态需跨重启持久化，并受 Lease/Fencing 与事务约束。可选 `branch_merges` 表记录合并历史。
- **migration**：schema v5（新增 branches 表）。
- **公共 API**：`RuntimeEngine.fork(runId, options)`、`listBranches(runId)`、`getBranch(branchId)`、`discardBranch(branchId)`、`mergeBranch(branchId, options)`；`BranchHandle`（inspect/run/input/approve/cancel/merge/discard）。
- **事件**：`branch.created`、`branch.discarded`、`branch.merged`、`branch.merge.rejected`。
- **RunStatus**：不改（分支用独立 child run，复用现有 running/waiting/blocked/...）。
- **职责（用户拍板）**：分支创建、导航、合并策略由 Harness 编排；Core 只提供最小持久化原语。

### 决策 10：如何保持 Lease、Fencing、Recovery、Completion Gate、Authority 边界？
- child run 是独立 run：Lease/Fencing 完全复用（独立 lease、fencing_token）。
- Recovery：child run 未知副作用独立 recovery，不污染父。
- Completion Gate：child run 的 propose_finish/validation 独立，不关联父；分支 succeeded ≠ 父 succeeded。
- Authority：fork 深拷贝快照（不共享可变状态）；合并只产生父新 revision。

---

## 5. 明确的范围边界与非目标

方案必须遵守（用户给定）：
- 父 Run、子分支、不同分支不能共享可变 Authority；
- 创建/运行/删除分支不隐式修改父 Run；
- 父分支后续变化不悄悄进入已创建的子分支；
- 合并必须显式触发，不自动发生；
- 分支摘要不能成为 Authority；
- 未验证结果不能进入父 Run；
- 分支 Evidence 不能直接证明父 Run 已完成；
- 已发生外部副作用不能通过合并伪装成未发生或被重复执行；
- 删除分支不删除父仍引用的 Artifact 或事实；
- Runtime Core 只保留必要持久化、隔离、可信执行能力；
- 分支导航、探索策略、交互优先属于 Harness。

本 Slice 不扩展为：多 Agent 编排、并行 Agent 群、自动选择最佳分支、自动合并、Git 工作流实现、向量检索或新 Memory 系统、跨项目/跨用户共享上下文、任意历史状态修改、完整分布式工作流引擎。

---

## 6. 完整、可测试的验收标准

1. 能从父 Run 的确定 revision 创建可持久化 branch（`fork` 后 `branches` 表有行，child run 存在）。
2. branch 记录明确的 `parent_run_id`、`fork_revision`、`fork_event_sequence`、`lineage`。
3. branch 只看到 fork 点允许继承的上下文（inputHistory/plan/evidence 是 fork 点副本）。
4. 父分支和不同子分支的输入、Plan、Checkpoint、Rehydration 互不影响（各自独立 run_id）。
5. branch 重启后可从同一 fork 状态恢复（child run resume）。
6. branch 可被列出、读取、切换、丢弃。
7. branch 运行不修改父 Run 的 revision/Plan/Evidence/Invocation/完成状态。
8. 跨分支引用和未授权数据访问被拒绝（branch 的 manifest 只含自身 authority）。
9. stale revision / 失效 Lease / Fencing 不能创建或合并 branch（复用 fencing + revision 校验）。
10. 合并必须显式指定来源分支、目标分支、合并内容（白名单）。
11. 合并冲突、父分支漂移、来源失效能被检测并拒绝。
12. 未验证 Evidence、失败 Invocation、未知副作用不能进入父分支。
13. 合并不重复执行已发生的 Tool 副作用（幂等去重 + 副作用不合并）。
14. 分支摘要和 Checkpoint 删除后仍可从 Authority 数据恢复（child run 独立重建）。
15. cancellation、crash、restart、concurrency 不留下半完成分支（分支事件原子化）。
16. Slice 1–5、Approval、Recovery、Completion Gate、外部消费者不回归（全量测试）。
17. 没有提前实现多 Agent 或自动分支搜索。

---

## 7. 预计涉及的模块和持久化变化

- `store/schema/v5-branches.ts`（新）+ `store/run-store.ts`：`createRunFromSnapshot`（含 BranchForkBase 登记）、branches CRUD、merge 校验、fencing 条件 commit。
- **schema v5 新增表**：`branches`（branch_id, parent_run_id, fork_revision, fork_event_sequence, child_run_id, status, lineage_json, created_at）+ `branch_fork_base`（branch_id, parent_run_id, fork_revision, fork_event_sequence, inherited_refs_json）+ 可选 `branch_merges`。
- **Workspace 目录快照（新，用户拍板）**：fork 时把父 workspace 复制到 staging 目录 → 路径/符号链接/文件数量/大小校验 → 原子重命名 → creating 状态恢复清理。实现位置：`runtime.ts` 新增 fork workspace 原语，`execution/tool-runtime` 的 workspace 解析层注入分支 workspace 根。失败则分支降级只读。
- `context/`：分支摘要（复用 compaction）、分支 request_context（复用 rehydration + BranchForkBase inherited-facts 读取边界）。
- `runtime.ts` + `runtime-types.ts`：`fork/listBranches/getBranch/discardBranch/mergeBranch` + `BranchHandle`。
- `runtime-control-error.ts`：可能的 `BRANCH_*` 错误码。
- `docs/`：E083 开发报告（实现阶段）。
- 测试：`tests/runtime/e083-context-branching.test.ts`（实现阶段）。

---

## 8. 主要风险与可能破坏的现有不变量

1. **Fork 快照闭合（用户补充，结构性）**：child 的 evidence/plan 引用 fork 前的父 invocation/artifact/event，按父 run_id 存储。必须用 `BranchForkBase` 定义 inherited facts 读取边界，否则 child 的 Rehydration/审计/验证无法自洽。这是必须第一优先解决的结构性风险。
2. **Workspace 目录快照生命周期（用户补充）**：文件系统与 SQLite 无法同一事务，`creating` 中间态 + 启动恢复清理是"崩溃不留下半分支"的必要机制；硬链接模拟 CoW 会共享 inode，禁止使用。
3. **fork 深拷贝成本**：大 snapshot 深拷贝可能较重。缓解：只拷贝到 fork 点，revision 归 0；可评估只拷贝必要子集。
4. **合并语义边界**：Evidence/副作用/currentPlan 不合并，用户可能误以为"分支成功=父成功"。缓解：Completion Gate 分离 + Plan 仅作 proposal + 明确文档/API。
5. **父分支漂移**：fork 后父变化，合并时 revision 冲突。缓解：乐观并发 + 显式漂移检测。
6. **Checkpoint 重建**：child 的 checkpoint 独立，不复制父 checkpoint；child 从 Authority 重建。
7. **幂等键冲突**：child run 独立幂等键空间，无冲突；但合并 artifact 时需校验。

---

## 9. 推荐实施顺序

1. **Fork 快照闭合（结构性，最先）**：定义 `BranchForkBase` + inherited/local facts 读取边界；`buildAvailableContextRefs` / `resolveRehydratedFact` / `buildCompactionAuthority` 感知 child 的可读宇宙。→ 验收 3、8、14。
2. **Fork 原语（Core）**：`createRunFromSnapshot`（仅当前 revision）+ schema v5 `branches`/`branch_fork_base` 表 + `fork` API + `branch.created` 事件。→ 验收 1–2、5。
3. **Workspace 目录快照**：staging 复制 → 校验 → 原子重命名 → creating 状态恢复清理；失败则只读降级。→ 验收 15、7。
4. **分支运行**：child run 复用现有 `#runLoop`/resume（天然隔离）。→ 验收 4、7。
5. **分支导航**：`listBranches/getBranch/discardBranch` + `branch.discarded` 事件。→ 验收 6、15。
6. **合并（白名单 + 校验）**：`mergeBranch`（输入/Plan proposal/Artifact/摘要）+ 漂移/冲突检测 + `branch.merged` 事件。→ 验收 8–13。
7. **分支摘要/Rehydration 集成**：child 独立 checkpoint/rehydrate（含 Fork Base inherited 边界）。→ 验收 14。
8. **验收测试 + 全量回归 + 文档 + 独立提交**。→ 验收 15–17。

---

## 10. 是否具备进入开发阶段的条件

**`conditionally_ready`（用户结论）** —— 主体方案已确认，但三项结构性前提待确认后才可进入开发：

待确认：
1. **Fork Base 的继承闭包**：inherited facts 读取边界（`fork_event_sequence` 之前、Fork Base 明确公开的父 facts）在 `buildAvailableContextRefs`/`resolveRehydratedFact`/`buildCompactionAuthority` 的完整实现与测试。
2. **仅当前 Revision Fork**：`requestedForkRevision === parent.currentRevision`；历史 Revision Fork（Event Replay、历史 Workspace Snapshot、历史 Artifact/Invocation 映射）不纳入 Slice 6。
3. **目录快照生命周期**：staging 复制 → 原子重命名 → `creating` 状态恢复清理的闭环；失败降级只读。

这三项确认（实现第一步验证 + 定向测试）后再标记为 `ready`。

其余已确认方案（保持不变）：
- 独立 `Branch` 实体关联 child run；
- `branches` / `branch_fork_base` 表进入 Core schema v5（受 Lease/Fencing 与事务约束）；
- Harness 负责编排，Core 提供最小 Fork/持久化/条件提交原语；
- 严格合并白名单（输入 / Plan proposal / Artifact 引用 / 非 Authority 分支摘要；禁止 currentPlan 直接覆盖、Evidence、Invocation、Approval、完成状态、副作用事实）；
- child 独立 Lease、Fencing、Recovery、Completion Gate；
- Workspace 目录快照（非硬链接 CoW），失败只读降级。