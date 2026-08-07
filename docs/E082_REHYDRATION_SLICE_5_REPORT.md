# E082 Rehydration Slice 5 开发总结

日期：2026-08-07

分支：`codex/runtime-restructure`（包含 Slice 1–4 + 重构）

生命周期模式：`PLAN → DIRECT → RECOVER → VERIFY`

## 目标与边界

让被 Slice 3 Eviction 淘汰、被 Slice 4 Compaction 压缩出当前 Prompt 的原始信息，在需要时通过稳定引用从 Authority Store 精确恢复，重新进入模型可见上下文。两种恢复路径：Harness 自动恢复 + 模型 `request_context`。

本 Slice 不实现：向量/语义检索、Context Pin、Context Branching/Fork、Summary 引用其他 Summary、完整 Overflow Recovery、修改权威状态（Run/Plan/Evidence/Invocation）。

## 用户审查后的核心架构决策

1. **`request_context` 是 Harness 控制动作，不是 Core Runtime Action**：`type ModelAction = RuntimeAction | RequestContextAction`。request_context 不进 `RuntimeActionSchema`、不进 `state-machine.ts`、不进 Core `#handleAction`；`#runLoop` 识别后由 Context 子系统（Rehydration）处理，重新投影并 continue，Run 状态不变。
2. **模型只能请求本轮已公开的 Ref**：`buildAvailableContextRefs` 构建 `availableContextRefs: Map<ref, digest>`（`toolObservations.sourceRefs` ∪ `contextCheckpoint.summary` 的 refs ∪ `run.evidence` 的 refs），`resolveRehydratedFact` 校验请求 ref ∈ manifest 且 digest 一致；模型无法猜测未公开历史。
3. **request_context 开放条件不绑定 call_tool**：`allowedActions(run, hasAvailableRefs)`，`hasAvailableRefs && run.currentPlan !== null` 时允许（制定/修改 Plan、判断完成、处理错误、理解约束阶段都可用）。
4. **自动恢复优先级（安全关键不让位）**：`harness_required`（unresolved/safety/当前错误/required Evidence/active Check 必需）→ `model_request` → `harness_helpful`（一般 reference 历史）。helpful 超预算时静默丢弃，不产生噪音；required/model_request 超预算才反馈 `REHYDRATION_BUDGET_EXCEEDED`。
5. **Rehydration 自身准入预算**（独立于 requestModel 整体预算）：`maxRefsPerRequest=8`、`maxRehydratedTokensPerTurn=4096`、`maxSingleFactTokens=2048`，避免"恢复大 Artifact → 整体阻塞"。
6. **崩溃语义（事件派生，不新增权威表）**：`context.rehydrate_requested`（requestId, refs）→ 成功注入后 `context.rehydrated`（requestId, refs）；resume 时从事件流重建无配对 rehydrated 的未消费请求。
7. **统一错误语义（不泄露跨 Run 对象）**：格式错误 → `INVALID_REF`；未公开/跨 Run/不存在/digest 漂移 → 统一 `REF_UNAVAILABLE`；准入拒绝 → `REHYDRATION_BUDGET_EXCEEDED`。

## 实现

- `providers/model-client.ts`：`RequestContextAction`、`ModelAction`、`RehydratedFact`（ref/kind/origin/digest/content/error）、`RehydrationError`、`RehydrationOrigin`；`ModelDecisionContext` 增加 `allowedActions`（含 request_context）、`actionContract: ModelAction[]`、`rehydratedFacts`。
- `context/rehydration.ts`（新）：`RequestContextActionSchema`、`parseRequestContextAction`、`isValidSourceRefFormat`、`buildAvailableContextRefs`、`resolveRehydratedFact`、`admitRehydratedFacts`（优先级 + 预算）、`autoRehydrateForActiveStep`（required/helpful 候选）、准入常量。
- `context/decision-context.ts`：`buildDecisionContext` 构建 manifest、决定 request_context 开放、准入注入 `rehydratedFacts`（required → model_request → helpful）、actionContract append request_context 示例；返回 `{ context, injectedRehydratedRefs }`。
- `context/eviction.ts`：`rebuildDecisionContext` 保留 `rehydratedFacts`（eviction 只收缩 toolObservations）。
- `runtime-helpers.ts`：`allowedActions(run, hasAvailableRefs)`。
- `store/run-store.ts`：`recordRunEvent`（append-only，fencing，不发 run commit）。
- `runtime.ts`：`#runLoop` 按 `ModelAction` 分发；`#handleRequestContext`（发 `context.rehydrate_requested` + 排队）；`#completeRehydrationRequest`（成功注入后发 `context.rehydrated` + 清空）；`#rebuildRehydrationRequests`（resume 重建）；瞬态 `#rehydrationRequests` Map。
- `providers/adapter.ts`：`DECISION_SYSTEM_PROMPT` 说明 request_context 与 rehydratedFacts 语义。

## 测试证据

`tests/runtime/e082-rehydration.test.ts` 6 个定向场景：

1. auto-rehydrates the full error of an unresolved safety failure as `harness_required`
2. restores a requested invocation via request_context without changing authoritative state（revision/stepProgress/evidence 不变）
3. refuses an unexposed ref as `REF_UNAVAILABLE` and a malformed ref as `INVALID_REF`
4. keeps `harness_required` facts when a large model request exceeds the rehydration budget
5. rebuilds an unconsumed rehydration request from events after resume
6. limits repeated request_context calls through the iteration budget

现有测试更新：`e065` context 字面量加 `rehydratedFacts: []`；`e077` finish 状态 contract 断言含 `request_context`。

## 提交前验证结果（2026-08-07 实际运行）

- 定向：`vitest run tests/runtime/e082-rehydration.test.ts` → **6/6 通过**。
- 全量 runtime：`vitest run tests/runtime/` → **47 文件 182 测试 全部通过**。
- 单命令全量：`vitest run --no-file-parallelism` → **50 文件 192 测试 全部通过**，无 skipped/todo/only。
- 静态与构建：`tsc --noEmit`、`eslint .`、`tsc -p tsconfig.build.json`、`node packages/runtime/scripts/build.mjs` → **全部通过**。
- 无提前实现 Slice 6：grep `vector|ContextPin|branch|fork` 在 `src/context/` 与 `runtime.ts` 无命中。

## 状态矩阵

```yaml
feature: e082-rehydration-slice-5
mode: VERIFY
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: n/a
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

Context Branching/Fork 与 Context Pin 仍是后续独立 Slice；未实现向量/语义检索与完整 Overflow Recovery。