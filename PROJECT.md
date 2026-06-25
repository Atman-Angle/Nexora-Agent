# PROJECT.md — Nexora 产品与范围

## 1. 定义

Nexora 是：

> 可直接使用的通用桌面 Agent，同时也是可被其他 AI 应用复用的 Agent Runtime。

它不是普通聊天应用，也不是单纯的 IDE 插件。

## 2. 核心需求

Nexora 必须稳定完成：

```text
理解目标
→ 保持任务状态
→ 选择正确上下文
→ 调用模型决定下一步
→ 调用工具执行真实动作
→ 获取真实结果
→ 验证是否完成
→ 保存证据和产物
→ 中断后恢复
```

## 3. 第一阶段最重要的六件事

```text
目标不丢
状态不乱
上下文不漂
动作可执行
结果可验证
中断可恢复
```

## 4. 三种任务模式

### Direct Mode

简单问答、总结、翻译、结构化生成。

### Tool Mode

单次或少量明确工具操作。

### Agent Mode

多步骤开发、调试、验证和恢复任务。

## 5. 完成定义

必须区分：

```text
执行成功
持久化成功
交付成功
验证成功
业务结果合格
```

模型不能自行宣布成功。

## 6. 唯一真值

```text
Task 原始目标 → Task Store
Run 状态 → State Machine + Run Store
任务进度 → Progress Ledger
过程历史 → Event Store
Tool 副作用 → Execution Record
正式结果 → Artifact Store
恢复位置 → Checkpoint Store
文件事实 → Filesystem / Git
```

## 7. 可复用要求

垂类应用只能通过：

```text
Agent Definition
Harness
Tool
Context Provider
Validator
Skill
Artifact Renderer
Adapter
```

接入，不得修改 Core 领域逻辑。

## 8. v1 暂不做

- 固定多 Agent 链；
- Workflow 编辑器；
- Skill 市场；
- Cron / Channel / Remote Node；
- 云端多租户；
- 自动生产发布；
- 自我修改；
- 默认向量数据库；
- 全 Rust 重写。
