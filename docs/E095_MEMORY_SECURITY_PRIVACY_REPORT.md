# E095 Memory Security and Privacy

日期：2026-08-11
状态：done_locally

## Threat model

攻击者可能让 Memory statement 包含伪 system/developer/user role、越权 Tool 请求、Approval/Evidence/Completion 伪造，或猜测其他 user/project/workspace/branch 的 Memory ID。记录也可能在候选发布后被删除、禁用或改变。

## 防线

1. Candidate 不含 statement，并显式标记 `trust=untrusted_memory_data`。
2. 精确恢复 Fact 保留同一 trust；精确字节和 digest 不提升为指令 Authority。
3. 生产 Provider Policy 禁止执行 Memory 中的角色、Tool、Approval、Evidence、Completion 或 policy override。
4. 恢复需要上一轮真实发布的 ref→digest；scope、branch、active、expiry、sensitivity、scope policy 与当前 digest 全部重验。
5. Memory 不修改 Tool Permission、Approval、State Machine、Evidence 或 Completion Gate。
6. Delete/disable 在下一轮撤销候选和旧 ref；audit tombstone 不复制 statement。

## 发布边界

Runtime 接受 Host 已绑定的 exact scope，不实现账号认证或租户授权。磁盘加密、备份删除、密钥管理、文件系统 secure erase 与真实模型红队是独立发布门，不能由本地确定性测试冒充完成。

## 验证

E095 固定 4 个攻击测试覆盖生产 Wire/Prompt trust、恶意 statement、当前 TaskContract 保持、write Tool Approval Gate、cross-project/branch、sensitive/guessed ref、删除传播、无正文 audit projection 与特殊 ID 无别名编码。E091–E095 共 33 tests、Context quality gate 80 tests、全量 66 files / 298 tests 通过，无 skip 或 unhandled error；typecheck、lint、Runtime build 与 root build 通过。
