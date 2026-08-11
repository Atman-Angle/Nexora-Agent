# E093 Bounded Memory Recall

日期：2026-08-11
状态：done_locally

## 目标与边界

让 Runtime 在不使用 Embedding、向量库、全文索引或额外模型调用的前提下，从 Host 显式提供的 exact Memory scope 中发现少量相关记录；候选只负责导航，完整 `MemoryRecord` 必须经 `request_context` 精确恢复。Memory 不修改 Run Authority，Runtime 不拥有或关闭共享 Memory Store。

## 实现

- `memory/recall.ts`：NFKC、ASCII term 与中文双字 gram 的确定性相关性，零相关不召回；最多 6 条、768 estimated tokens / 4 KiB。
- `CreateRuntimeOptions.memory`：Host 显式注入 `{store, scope}`，没有隐式第二 Store 或 close ownership。
- `ModelDecisionContext.memoryCandidates`：公开 ref/type/reasons/hint/source/verification/lifecycle/sensitivity/record digest，不复制 statement。
- `request_context(memory:<id>)`：下一轮重新校验 exact scope、active、未过期、normal sensitivity 和发布 digest；任何漂移统一 `REF_UNAVAILABLE`。
- Production Wire、Eviction 与 projection digest 保留 Memory 候选；`RehydratedFact.kind` 增加 `memory`。

## Authority 顺序

最新 Input → 当前 TaskContract → 当前 Structured Plan / Progress / Evidence → Checkpoint / Rehydration → 明确标记的 Memory。Memory 内容即使成功恢复，也不能覆盖当前 Run Authority。

## 验证

E093 固定 6 个测试覆盖中英文相关性、确定性排序、零相关、生命周期/过期/sensitivity 过滤、exact scope、数量/Token/byte 硬上限、候选无 statement、按需精确恢复、active record digest drift 拒绝、Runtime restart、Host Store ownership、生产 HTTP Wire、Eviction 与 projection digest。E091–E093 共 22 个测试通过；Context quality gate 12 files / 80 tests 通过；全量 64 files / 287 tests 通过且无 skip/unhandled error；typecheck、lint、Runtime build 与 root build 均通过。

## 非目标

自动提取或晋升、语义冲突、向量检索、敏感 Memory、用户控制、删除传播、性能索引和真实 Provider 效果验收均属于后续独立 Feature。
