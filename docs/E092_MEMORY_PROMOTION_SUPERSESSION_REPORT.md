# E092 Memory Promotion and Supersession Report

日期：2026-08-11

Feature：`memory-promotion-supersession`

模式：`EXPLORE → DIRECT → VERIFY`

状态：`done_locally`

## 结果

Runtime Memory 现在具有一条可审计的内容生命周期：不可信内容先以 `candidate` 保存，再通过 explicit 或 verified promotion 进入 `active`。同 scope 的 exact type/statement/sensitivity 重复候选不会产生第二条 active Memory；candidate 会保留为 `superseded` 并指向既有记录。

更新与合并没有新增写路径。调用方先创建 replacement candidate，再调用同一个 `supersede`：一个 active predecessor 表示 update，多个表示 merge。SQLite 单事务同时激活 replacement、标记全部 predecessor 为 superseded，并写入 `supersedesMemoryIds` / `supersededByMemoryId` 双向 lineage。原 statement、scope、source provenance 和 ID 均不原地修改。

## 生命周期边界

- `promote` 只接受 candidate；explicit promotion 必须记录 `promotedBy/promotedAt`；verified promotion 还要求 record 已 verified；
- promotion 与 supersession 的相同请求可在重启后安全重试并返回相同结果；
- exact dedupe 不使用模型、全文或向量检索，source/verification 不参与内容相等判断，sensitivity 参与以避免安全级别折叠；
- `supersede` 接受 1–32 个唯一 active predecessor，固定按 Memory ID 排序并原子提交；
- 缺失、wrong scope、非 active predecessor、未改变 replacement、另有 active duplicate、时间倒退或并发 record drift 会整体失败；
- `revalidate` 只更新未到期 candidate/active，且要求 verified Evidence Contract；
- `expire` 只把 exact scope 内到期的 candidate/active 转为 expired；重复执行返回空结果；
- 通用 `setStatus` 只允许 archived/invalidated，不能激活、supersede 或 expire；superseded/expired 不能离开终止状态；
- Store 继续使用原 `memory-v1.db` v1 schema，生命周期 metadata 保存在 MemoryRecord JSON，没有新增数据库、表、索引或 Run Authority。

## 验证证据

- RED：E092 的 8 个场景全部因旧 Contract 不接受 `candidate` 而失败；
- E092 定向测试：1 file、8 tests 通过；
- E091 + E092 Memory 回归：2 files、16 tests 通过；
- 全量回归：63 files、281 tests 全部通过，无相关 skip；
- `pnpm typecheck`：通过；
- `pnpm lint`：通过；
- `pnpm --filter @nexora/runtime build`：通过；
- `pnpm build`：通过；
- 编译后公共 root export：真实临时 `memory-v1.db` 完成 candidate → promote → active，`MemoryLifecycleError` 可公开导入；
- D1–D5 packed package consumer 回归均通过。

## 未实现与剩余风险

本 Feature 不自动从模型输出提取 candidate，不判断语义冲突，不接入 Context recall，也不实现用户界面、删除传播或真实 Provider 验收。Exact dedupe 当前在 exact scope 内扫描 MemoryRecord；没有性能证据前未增加派生索引，规模指标与可重建索引仍留给 `memory-performance-rebuild`。

下一 Feature 是 `bounded-memory-recall`：只允许 active Memory 形成少量、可解释、有硬预算的 Context 候选，当前 Run Authority 必须始终优先。
