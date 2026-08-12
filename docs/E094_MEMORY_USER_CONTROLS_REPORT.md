# E094 Memory User Controls

日期：2026-08-11
状态：done_locally

## 目标

为 Host 提供一个可直接绑定产品设置或管理界面的 Memory 用户控制面。所有动作保持 exact scope，不修改 Run Authority，也不在 Context 中增加第二套状态。

## 设计

- `MemoryControls.inspect` 返回完整 Record/Source/Lifecycle 与当前 recall eligibility；错误 scope 与不存在统一为 null。
- Correction 要求同 scope candidate，并在同一事务复用既有单前驱 Supersession。
- Invalidate、Delete、Clear Scope、Scope Recall enable/disable 都要求 operationId、actor、reason、occurredAt。
- Mutation 与 append-only audit event 原子提交；相同 operationId/command 幂等，不同 command 冲突。
- Delete/Clear audit tombstone 不保存 statement；export 只读取 exact scope 并稳定排序。
- Scope policy 在 `memory-v1.db` schema v2 持久化。禁用时 Context 不发布候选，Rehydration 也拒绝旧 Memory ref。

## 边界

底层 Memory Store CRUD 继续作为数据所有者原语兼容存在；Host 的用户动作应走 Controls。UI、账号认证、角色授权、远程 API、跨系统删除传播、secure erase 和 retention schedule 不属于本 Feature。

## 验证

E094 固定 7 个测试覆盖 inspect/explain、wrong-scope non-disclosure、原子 correction lineage、operationId 幂等/冲突、invalidate/delete tombstone、exact-scope clear、audit restart/export、scope disable/re-enable 的生产 Context 执行，以及 v1→v2 migration。E091–E094 共 29 tests、Context quality gate 80 tests、全量 65 files / 294 tests 均通过，无 skip 或 unhandled error；typecheck、lint、Runtime build 与 root build 通过，编译后公共 API 已确认。
