# E096 Memory Performance and Rebuild

日期：2026-08-11
状态：done_locally

## 目标与边界

本 Feature 为现有 exact-scope SQLite Memory 召回建立固定性能基线，并证明派生索引丢失不会造成数据 Authority 丢失。它没有增加向量检索、缓存服务、第二数据库、模型排序或新的公开 API。

## 固定数据集

- dataset：`memory-performance-rebuild-v1`
- 10 个独立 scope，每个 500 条，共 5,000 条 active Memory Record
- 数据写入 `memory-v1.db` 后 close/reopen，再进行 3 次 warmup 和 20 次记录样本
- 完整 Context build 使用真实 `MemoryStore`、`RunStore` 与生产 `buildDecisionContext`
- 目标 scope 每次读取 500 条，最终候选继续受最多 6 条、768 estimated tokens、4 KiB 限制
- 环境：Windows x64、Node v24.11.1、pnpm 11.7.0、Intel Core Ultra 9 185H（22 logical CPUs）

## 本地基线

当前验证运行记录：

| 指标 | p50 | p95 | max |
|---|---:|---:|---:|
| exact-scope Memory query | 8.95 ms | 18.10 ms | 24.31 ms |
| complete Context build | 22.45 ms | 31.82 ms | 34.28 ms |

附加数据：Context 最大 4,153 bytes，Memory 数据库 4,804,608 bytes，模型调用 0，估算 Provider 费用 0 USD。这里的数值是当前机器上的可复现参考基线，不是跨机器 SLA；测试只使用 2,000 ms 作为明显失控的安全上限。

## 派生索引恢复

测试在关闭 Store 后删除以下全部派生索引：

- `memory_records_scope_status_updated`
- `memory_records_scope_type_updated`
- `memory_control_events_scope_time`

重新打开 schema v2 数据库时，Store 不再因 `user_version` 已是当前值而跳过索引确认，而是在 Authority 表上事务化执行幂等 `CREATE INDEX IF NOT EXISTS`。验证结果为：三个索引全部恢复，Record 与 bounded candidates 前后逐项一致，status 查询计划重新命中 `memory_records_scope_status_updated`。

## 验证结论

E096 2 tests、E091–E096 35 tests、Context quality gate 80 tests、全量 67 files / 300 tests 通过，无 skip 或 unhandled error；typecheck、lint、Runtime build 与 root build 通过。真实 Provider 的质量、Token、调用、延迟和实际账单不属于本 Feature，保留给 `real-provider-continuity-canary`。
