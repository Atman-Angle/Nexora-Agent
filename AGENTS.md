# AGENTS.md — Nexora AI 开发总规则

本文件只定义所有开发任务必须遵守的项目级规则。

- 产品目标与范围：`PROJECT.md`
- 架构边界与数据所有权：`ARCHITECTURE.md`
- 系统级数据流：`DATA_FLOW.md`
- 系统级正向与逆向流程：`SYSTEM_SOP.md`
- 单个 Feature 开发循环：`LOOP.md`
- 测试与验收策略：`TESTS.md`
- 当前开发状态：`DEVELOPMENT.md`

## 1. 现实基线

开始开发前先检查：

```text
git status --short
→ 当前 Feature 相关 diff
→ 未跟踪文件
→ 真实调用方
```

当前工作树是唯一现实基线。不得只依据 Git HEAD、旧 Spec、旧报告或旧测试。

已有改动部分实现当前目标时，先审计和验证；不得重复实现、覆盖或回退来源不明的改动。

## 2. 任务与边界

每次只处理 `DEVELOPMENT.md` 指定的当前 Feature。

不得：

- 提前实现后续 Feature；
- 顺手修复无关问题；
- 改变未授权的公开 Contract、数据 Authority 或安全边界；
- 为未出现的未来需求增加生产逻辑。

AI 可以自主决定局部实现，但不能改变 Goal、Scope、Invariants、Non-goals 和 Acceptance。

## 3. 最小实现

修改必须基于真实需求、失败、日志、接口数据、持久化事实或被违反的 Contract。

默认顺序：

```text
复用
→ 删除
→ 合并
→ 修正现有数据流
→ 最小修改
→ 最后才新增状态、抽象、依赖或基础设施
```

没有第二个真实调用方时，不提前抽象通用能力。

错误应在最早被破坏的边界失败，不得在下游通过默认值、兼容分支、补偿状态、第二路径或放宽断言掩盖问题。

## 4. 核心不变量

必须遵守 `ARCHITECTURE.md`、`DATA_FLOW.md` 和 `PROJECT.md`：

- State Machine 唯一修改 Run Status；
- Run-owned Structured Plan 是唯一当前计划；
- Tool Invocation 是副作用与恢复判断的唯一 Authority；
- Model、Tool 和 Host Application 不直接修改 Run；
- Runtime 不依赖具体 UI、Web 框架、CLI 或宿主应用；
- Host Application 不得绕过 Core Store、Approval、Evidence 或 Completion Gate；
- 外部输入必须经过 Schema 校验；
- 大内容进入 Artifact；
- 写操作必须有幂等与恢复语义；
- Core 不包含垂类业务字段；
- 不得引入第二套状态或第二个数据 Authority。

## 5. 验证与完成

验证强度由 `TESTS.md` 的风险等级决定，不默认对每个 Feature 执行完整 UAT 和全部回归。

测试通过只是证据之一。完成必须满足当前 Feature 的 Acceptance，并能由真实状态、数据和执行证据支持。

## 6. 必须暂停

出现以下情况时停止并请求决策：

- 公开 Contract、核心 Authority 或安全边界变化；
- 破坏性迁移；
- 新重量级依赖；
- 非幂等副作用状态未知；
- 同一根因连续失败三次；
- 工作区现实与 Feature 目标无法自行消解；
- 无法提供当前风险等级要求的完成证据。

完成后更新 `DEVELOPMENT.md` 并停止，不提前开始下一个 Feature。
