# TESTS.md — 验收与回归

## 1. 测试层级

```text
L0 Static
L1 Unit
L2 Contract
L3 Integration
L4 Feature Chain
L5 Recovery
L6 Security
L7 Agent Eval
L8 Desktop E2E
```

## 2. 每个 Feature 必须提供

```text
输入证据
执行证据
状态证据
持久化证据
结果证据
验证证据
```

## 3. Core Regression

每完成一个 Feature，加入：

```text
CR-001 Direct Mode
CR-002 Read File
CR-003 Search & Working Set
CR-004 Patch File
CR-005 Test & Verification
CR-006 Multi-round Fix
CR-007 Approval
CR-008 Context Compaction
CR-009 Recovery
CR-010 New Conversation UI
CR-011 Collapsed Workspace UI
CR-012 Expanded Code View UI
```

新 Feature 必须满足：

```text
当前 Feature Tests
+
全部既有 Core Regression
```

## 4. 禁止假成功

以下情况不得成功：

- Model 返回文本但未持久化；
- Tool 返回成功但副作用未知；
- 测试失败；
- Final 无 Evidence；
- API 成功但最终结果不可查询；
- UI 使用 Mock 代替真实链路；
- 生成结构合法但业务质量不合格。

## 5. 性能和质量声明

没有 Benchmark 或固定 Dataset，不得声明：

- 性能强悍；
- 成功率高；
- 质量优秀；
- 优于其他 Agent。
