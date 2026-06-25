# Nexora Loop Starter v1.2

这是 Nexora 从 0 开发时使用的精简 Loop 开发包。

## 核心原则

- 根目录只保留少量长期真相文档。
- 所有 Feature 全部放入 `specs/`。
- 当前准备开发的 Feature 使用 `status: ready`。
- 后续 Feature 使用 `status: outline`，只定义目标、依赖、链路和验收方向。
- 每轮只读取当前 Feature，不一次加载全部 Spec。
- 每次只推进一个纵向 Feature。
- 当前 Feature 未完成时不得进入下一个 Feature。

## 开发时优先读取

1. `AGENTS.md`
2. `PROJECT.md`
3. `ARCHITECTURE.md`
4. `LOOP.md`
5. `DEVELOPMENT.md`
6. 当前 Feature Spec
7. 相关代码和测试

## 当前 Feature

```text
F001 — Direct Mode
```

## 目录

```text
AGENTS.md
PROJECT.md
ARCHITECTURE.md
LOOP.md
DEVELOPMENT.md
TESTS.md
specs/
docs/
.agents/skills/
```


## v1.2 更新

- 增加最小 Monorepo 项目目录规范；
- 明确目录只随当前 Feature 生长，不提前生成空模块；
- 将 F001 补全为可直接执行的 ready 级 Spec；
- 增加 F001 的最小 Contracts、SQLite 表、CLI、Fake Model、状态迁移、测试与禁止范围。
