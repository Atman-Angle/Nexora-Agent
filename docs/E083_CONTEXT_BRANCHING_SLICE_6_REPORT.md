# E083 Context Branching Slice 6 开发总结

日期：2026-08-07

分支：`codex/runtime-restructure`（包含 Slice 1–5 + 重构）

生命周期模式：`PLAN → DIRECT → RECOVER → VERIFY`

## 目标与边界

让用户能从父 Run 的确定 revision 创建**隔离的探索分支**：分支独立运行、独立上下文/Checkpoint/Rehydration/执行历史，不修改父路径；分支可被列出、读取、丢弃，并支持**显式、受控的合并**（把父分支认可的输入/Plan proposal/Artifact/摘要合并回来，而不是共享 authority）。

核心原则（用户拍板）：**Fork 创建新探索路径，不得把父 Run 的 Authority 变成共享可变状态**。Core 不感知"探索策略"；Harness 调用 Core 的 fork/merge 原语。

本 Slice 不实现：多 Agent 编排、并行 Agent 群、自动选择最佳分支、自动合并、Git 工作流、向量检索、历史 Revision Fork（Event Replay）、Context Pin、跨项目共享上下文。

## 用户审查后的核心架构决策

1. **仅当前 Revision Fork**：`requestedForkRevision === parent.currentRevision`；历史 Revision Fork（Event Replay、历史 Workspace Snapshot、历史 Artifact/Invocation 映射）不纳入 Slice 6。
2. **Fork Base 继承闭包（结构性，最先解决）**：`branch_fork_base` 持久化 `inheritedRefs`（fork 点之前父 facts 的 ref→digest），子分支通过 `buildAvailableContextRefs` / `resolveRehydratedFact` 的 `inherited` 回退读取父 Authority；fork 点之后父产生的任何内容对子分支不可见。**完成校验闭包**：父 Evidence 复制进子分支但引用父 run_id 下的 Invocation，`inheritedFacts`（fork 时冻结的父 Evidence→fact 投影）让子分支的 `proposeFinish` 语义校验无需读取父可变 Authority 即可自洽。
3. **Workspace 目录快照（非硬链接 CoW）**：fork 时把父 workspace 复制到 staging 目录 → 路径/symlink/大小校验 → 原子重命名 → `creating → active` 状态；重启清理 staging 并恢复 `creating` 分支。拒绝 symlink（复制会共享 inode）与硬链接 CoW。dataDir（共享 SQLite + 内容寻址 Artifact）排除在快照外。
4. **严格合并白名单**：只接受 inputs / Plan proposal / Artifact refs / 非 authority summary；Evidence、Invocation、Approval、完成状态、副作用**永不合并**。合并总是产生父的**新 revision**（`commitRun`，fencing + 乐观并发），不直接改父 snapshot；`planProposal: true` 只是把分支 Plan 作为父 Harness 重新规划的提案。
5. **`branches` / `branch_fork_base` 表进入 Core schema v5**：lineage/fork point/child_run 关联/状态需跨重启持久化，并受 Lease/Fencing 与事务约束。
6. **控制面 Lease**：fork/merge/discard 复用 `#withControlLease`（同步变体 `#withControlLeaseSync`），在父 Run 上获取控制 Lease 后才执行 fenced 写入；父 Run 活跃执行时拒绝（`RUN_BUSY`）。

## 实现

- `store/schema/v5-branches.ts`（新）：`branches`（branch_id, parent_run_id, fork_revision, fork_event_sequence, child_run_id, status, lineage_json, created_at）+ `branch_fork_base`（…… inherited_refs_json, inherited_facts_json）。
- `store/run-store.ts`：`createRunFromSnapshot`（深拷贝 snapshot，revision 0，status running）、`createBranch`（事务：child run + branches + branch_fork_base + parent `branch.created` 事件）、`listBranches` / `listAllBranches` / `getBranch` / `getBranchByChild` / `getForkBase` / `updateBranchStatus`；迁移升级到 v5。
- `store/branch-workspace.ts`（新）：`snapshotWorkspace`（拒绝 symlink，排除 dataDir，staging→`renameSync` 原子重命名）、`cleanupStagingWorkspaces`、`branchWorkspaceExists`、`removeDirectoryTree`（确定性递归删除，规避 Windows 上 `rmSync({recursive})` 在部分 profile 路径下静默失败的问题）。
- `context/rehydration.ts`：`buildForkBaseInheritedRefs`（父 evidence/input 层级 ref→digest）、`buildForkBaseInheritedFacts`（父 Evidence→fact 投影，供完成校验）、`buildAvailableContextRefs` 的 `inheritedRefs` 参数、`resolveRehydratedFact` 的 `inherited` 回退。
- `context/decision-context.ts`：`buildDecisionContext` 的 `forkContext?` 参数，构建 inherited 并传给 manifest/resolve；`runtimeActionContract` 过滤 `request_context`。`ForkContext` 类型移至 `contracts.ts`（避免循环依赖）。
- `context/compaction-flow.ts` / `request-model.ts`：`CompactionServices` / `RequestModelServices` 增加 `forkContext`，压缩后重建的决策上下文保留 inherited 边界。
- `contracts.ts`：`BranchStatusSchema`、`BranchRecordSchema`、`BranchForkBaseSchema`（含 `inheritedRefs` + `inheritedFacts`）、`InheritedFactProjectionSchema`、`ForkContext`。
- `runtime-types.ts`：`ForkOptions`、`BranchView`、`MergeDecisions`、`MergeOutcome`、`BranchHandle`；`RuntimeServices` 增加 `forkContext`。
- `validation.ts`：`proposeFinish` 语义校验对继承 Evidence 回退到 `forkBase.inheritedFacts`（不再抛出"无 succeeded Invocation"）。
- `runtime.ts`：`fork` / `listBranches` / `getBranch` / `discardBranch` / `mergeBranch` + `BranchHandle`；`#forkRun`/`#forkParentRun`（workspace 快照 → child snapshot + goalDigest 重算 → inherited refs/facts → createBranch → 登记 workspace → active）、`#executeBranchRun`（经 `#resumeRun`）、`#applyBranchMerge`（白名单 + 新 revision）、`#branchView`、`#recoverBranchWorkspaces`（creating 恢复/失败判定 + active workspace 重登记）、`#workspaceFor` / `#forkContextFor`；`#setPlan` workspace 校验改用 `#workspaceFor(run.runId)`。
- 关键修复：fork 时重定向 child `taskContract.workspace` 到快照根的同时**重算 `currentPlan.goalDigest`**，保持 `plan.goalDigest === digestTaskContract(taskContract)` 不变量（否则子分支完成校验因 `PLAN_GOAL_DIGEST_MISMATCH` 失败）。

## 测试证据

`tests/runtime/e083-context-branching.test.ts` 11 个定向场景：

1. forks a persisted branch from the parent's current revision with full lineage（branches 表 + child run + forkRevision/forkEventSequence/lineage + `branch.created` 事件）
2. inherits only the fork-point context through BranchForkBase（child snapshot 是 fork 点副本；inheritedRefs 暴露父 evidence refs）
3. gives the branch an isolated workspace directory snapshot（staging→原子重命名；dataDir 排除）
4. runs the branch independently without modifying the parent（child 自己的 invocation/evidence；父 revision/plan/progress/evidence 不变）
5. resumes a branch child after a runtime restart against its isolated snapshot（重启后 workspace 重登记 + 子分支完成校验）
6. lists, reads, and discards branches without disturbing the parent（discard → workspace 清理 + `branch.discarded` 事件）
7. rejects cross-branch refs: a branch only sees its own authority（B2 请求 B1 child 的 ref → `REF_UNAVAILABLE`）
8. rehydrates parent facts at the fork point via Fork Base inherited refs（子分支请求父 invocation ref → 完整内容恢复）
9. merges only whitelisted decisions and never touches parent authority（inputs/planProposal/artifacts/summary 接受；Evidence/Invocation/currentPlan 不变；`branch.merged` 事件；workspace 清理）
10. merges against the latest parent revision after the parent drifts past the fork（乐观并发）
11. rejects merging a discarded or already-merged branch

现有测试更新：`e049` / `e079` / `e080` 的 schema 断言更新为 v5 的 7 张表。

## 提交前验证结果（2026-08-07 实际运行）

- 定向：`vitest run tests/runtime/e083-context-branching.test.ts` → **11/11 通过**。
- 全量 runtime：`vitest run tests/runtime/ --no-file-parallelism` → **48 文件 193 测试 全部通过**。
- 静态与构建：`tsc --noEmit`、`eslint packages/runtime/src tests/runtime/e083-context-branching.test.ts`、`tsc -p tsconfig.build.json` → **全部通过**。
- 无提前实现 Slice 7：无向量检索 / 多 Agent / 自动分支搜索 / Git 工作流。

## 状态矩阵

```yaml
feature: e083-context-branching-slice-6
mode: VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: v5 (branches + branch_fork_base)
unit_test_status: passed
integration_test_status: passed
uat_status: passed
runtime_status: verified
security_status: verified
external_dependency_status: clear
artifact_status: committed
resolved_status: done_locally
```

## 下一 Slice

Context Pin 与历史 Revision Fork 仍是后续独立候选；未实现向量/语义检索、多 Agent 编排、自动分支选择/合并与完整 Overflow Recovery。