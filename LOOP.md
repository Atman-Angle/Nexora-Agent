# LOOP.md — Nexora Feature 开发循环

## 1. 开发单位

开发单位是一个可验证的行为或能力，不是预先规定的一组实现步骤。

正确：

```text
用户或系统行为
→ 受影响边界
→ 最小实现
→ 可观察证据
```

错误：

```text
先创建接口
→ 再增加状态
→ 再写 Adapter
→ 最后尝试联调
```

## 2. Feature Contract

每个 Feature 开始前只需定义：

```yaml
feature:
goal:
current_gap:
scope:
invariants:
non_goals:
acceptance:
risk: L1 | L2 | L3
affected_tests: []
```

Spec 不规定具体文件、类、函数或实现步骤，除非该方案本身属于已经确认的公开 Contract 或架构决策。

## 3. 开发循环

```text
Define
→ Inspect
→ Implement
→ Verify
→ Review
→ Record
→ Stop
```

### Define

确认 Feature Contract，尤其是 Goal、Scope、Invariants、Acceptance 和风险等级。

### Inspect

检查当前工作树、真实调用方和现有数据流。

- 缺陷修复：复现首个真实失败；
- 新能力：证明当前能力缺口；
- 简化重构：证明重复、错误职责或无调用方代码真实存在。

只调查解决当前目标所需的范围。

### Implement

AI 自主选择最小方案。

优先复用、删除、合并和修正现有路径；不得为未复现问题增加状态、抽象、兼容层或第二条执行路径。

### Verify

按 `TESTS.md` 的风险等级运行目标测试、相关回归或完整 UAT。

不是每个 Feature 都必须：

- 写完整 RED 套件；
- 跑全部 Core Regression；
- 执行真实 Provider canary；
- 做用户级验收；
- 更新全部系统文档。

### Review

检查：

- Diff 是否超出 Scope；
- 是否改变未授权边界或 Authority；
- 是否在下游补偿上游错误；
- 是否新增重复状态或无调用方抽象；
- 是否处理了未复现问题；
- 是否存在更少代码的实现；
- 完成声明是否有真实证据。

### Record

只记录：

```text
改变了什么
验证了什么
仍未解决什么
下一步是什么
```

更新 `DEVELOPMENT.md` 后停止。

## 4. Capability Integration

多个相关 Feature 共同形成一个完整能力后，执行一次 Capability Integration：

```text
真实入口 UAT
→ 正向走完整数据流
→ 逆向追完整证据链
→ 检查 Authority 与边界
→ 判断 Capability 是否完成
```

系统级 UAT 不重复分摊到每个内部 Feature。
