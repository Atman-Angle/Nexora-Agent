# E091 Runtime Memory Contract and Store Report

日期：2026-08-11

Feature：`runtime-memory-contract-store`

模式：`EXPLORE → DIRECT → VERIFY`

状态：`done_locally`

## 结果

Nexora 现在通过 `@nexora/runtime` 公开一个与 Context、Execution 平级的 Memory 子系统。Host 提供 `stateDir` 和稳定的 user/project/workspace/可选 branch scope；Runtime 在独立 `<stateDir>/memory-v1.db` 中提供严格 `MemoryRecord` 与 create/get/list/setStatus/delete/close。Memory 不进入 `runtime-v1.1.db`，也不修改 Run、TaskContract、Plan、Invocation、Evidence、Approval、Result 或 State Machine。

## Contract 与持久化边界

- `MemoryRecord` 包含 bounded statement、memoryType、scope、`{sourceRunId, ref, digest}`、verification、status、sensitivity 与时间字段；
- source ref 只接受 Runtime 已定义的 Input/Event/Invocation/Evidence/Artifact Authority ref 格式，digest 必须是 lowercase SHA-256；
- verified Memory 必须有验证时间与至少一个唯一 Evidence ref，unverified Memory 不得携带验证声明；
- SQLite 主键包含完整 user/project/workspace/branch scope 与 memoryId；branch 缺省通过内部空 key 表示，不改变公开 Contract；
- 相同 scope/ID/创建内容用 canonical digest 实现幂等，状态变化后原始 create 重试仍返回当前记录；相同 ID 的不同创建内容抛出 `MemoryConflictError`；
- 状态修改禁止时间倒退并使用原 record JSON 做乐观并发条件；猜错 scope 的 get/status/delete 统一返回不存在；
- 数据库启用 WAL、使用独立 schema version，并拒绝比当前 v1 更新的 schema；初始化失败会主动关闭连接。

## 验证证据

- RED：公开导出不存在时，E091 的 7 个初始场景全部因 `openMemoryStore is not a function` 失败；
- 定向：`tests/runtime/e091-runtime-memory-store.test.ts`，8/8 通过；
- 全量回归：62 files、273 tests 全部通过，无相关 skip；
- `pnpm typecheck`：通过；
- `pnpm lint`：通过；
- `pnpm --filter @nexora/runtime build`：通过；
- `pnpm build`：通过；
- packed public surface：tarball 包含 `dist/memory/*.js` 与 `*.d.ts`，编译后的 root export 可打开并关闭真实临时 `memory-v1.db`；
- 独立性：测试在 stateDir 放置 `runtime-v1.1.db` sentinel，完整 Memory CRUD 后内容逐字不变；close/reopen 后记录与状态保持。

一次并行执行 Runtime Build 与根 Build 时，Runtime Build 清理 `packages/runtime/dist`，导致根 TypeScript Build 同时读取声明文件失败。按仓库实际构建约束改为 Runtime Build 后再执行根 Build，两者均通过；该竞态没有被计入成功证据。

## 未实现与后续门禁

本 Feature 没有把 Memory 接入 Context，也没有实现自动提取、晋升、去重、Supersession、过期执行、用户控制、语义/向量检索或真实 Provider 验收。下一 Feature 必须独立激活；在 Context recall 之前，应先定义 Memory promotion 与冲突生命周期，避免未验证模型文本直接成为 active Memory。
