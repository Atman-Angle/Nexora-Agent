# Open Source Package Release Spec

```yaml
feature: open-source-package-release
mode: DIRECT
risk: L2
spec_status: approved
development_authorization: approved
implementation_status: complete
release_version: 0.1.0
license: Apache-2.0
depends_on:
  - context-eviction-reference-retention
  - constrained-context-completion-capacity
target_status: release_ready
```

## Goal

把已经可打包运行的 `@nexora/runtime` 与 `@nexora/harness` 收尾为可审计、可重复发布的
开源 npm 包：许可证明确、CI 可复现、tarball 可由包外 Consumer 安装运行、版本与发布步骤
有单一权威路径。

## Current State

- 仓库与两个发布包均使用 Apache-2.0，并在公开 metadata/README 中保持一致；
- CI 已覆盖 Ubuntu 全量质量门禁和 Windows packed external consumer；
- 两个包的公开 metadata、README、tarball manifest gate 和 D4/D5 包外 Consumer 已实现；
- 发布 SOP 已固定版本、pack、Runtime-first publish、provenance、tag 和 registry consumer 顺序；
- 首发版本固定为 `0.1.0`，仓库所有者已确认拥有 npm `@nexora` scope 发布权限；
- 包尚未发布到 npm，本机 npm 身份认证与实际 publish 仍是外部发布门禁；
- 本地完整回归 93/93 files、446/446 tests 通过；clean checkout GitHub CI 证据仍待合并后获得。

## Scope

1. 根许可证与 README/package metadata 对齐；
2. GitHub Actions 执行 install、typecheck、lint、build、目标回归和 packed consumer；
3. 校验两个 tarball 只包含声明的公共产物、类型、README/License 和 package metadata；
4. 固定 `@nexora/harness -> @nexora/runtime` 的发布依赖版本，不向 npm 发布 `workspace:*`；
5. 定义版本升级、changelog、tag、GitHub Release、npm provenance/dry-run/publish 顺序；
6. 从全新目录安装已发布或本地 tarball，通过正式 exports 跑完整可信闭环。

## Resolved Owner Decisions

- **License：** Apache-2.0；
- **npm scope ownership：** 仓库所有者确认拥有 `@nexora` scope 发布权限；
- **首发版本：** `0.1.0`。

本机登录、2FA/provenance 验证和实际 publish 仍属于需单独授权的外部写入。

## CI Contract

远端只保留 `main`，因此 workflow 至少在 `push: main` 和手动触发时运行；若临时 PR 被使用，
也允许 `pull_request` 验证，但合并后删除远端 Feature branch。

必需 Jobs：

```text
install --frozen-lockfile
→ typecheck
→ lint
→ build
→ release regression gates
→ pack @nexora/runtime + @nexora/harness
→ install tarballs in an external temp consumer
→ typecheck and execute consumer
```

至少覆盖 Node 20；Windows 特有的 pack/SQLite/路径行为必须保留一个 Windows gate。不得在 CI
注入真实 Provider 密钥，真实 Provider canary 属于单独授权的 External Acceptance。

## Package Contract

- npm tarball 不包含源码工作区、报告、凭据、`.env`、内部数据库或本地开发状态；
- `exports` 之外的内部路径保持不可导入；
- Runtime/Harness 版本与依赖关系可由干净 npm install 解析；
- package metadata 包含 license、repository、homepage、bugs、engines 和 publish config；
- `npm pack --dry-run`/tarball manifest 进入可审查证据；
- 发布脚本不得绕过测试门禁或自动 force push。

## Acceptance

### Release-ready（仓库内完成）

- 许可证选择已明确并在所有公开入口一致；
- CI 在 clean checkout 绿色；
- 两个 tarball 的 manifest、类型、exports 和依赖正确；
- D4 package consumer 从 tarball 安装、typecheck、运行并得到 persisted succeeded Result；
- E080/E106 已修复，完整回归无已知失败；
- README 不再声称“无许可证/尚不可安装”，但在真正发布前仍诚实标注 npm 状态；
- DEVELOPMENT、PROJECT、TESTS 和发布 SOP 状态一致。

### Published（外部写入，需单独授权）

- npm 身份、scope、2FA/provenance 验证通过；
- 先 publish Runtime，再 publish Harness；
- 全新仓库通过 `npm install @nexora/runtime @nexora/harness` 运行包外验收；
- Git tag、GitHub Release、npm 版本和 tarball digest 一致；
- npm 页面与 GitHub License/README 更新完成。

## Non-goals

- 官方 GUI、托管 SaaS、插件市场；
- OTel、RBAC、远程执行或 MCP；
- 新 Provider、Store Adapter 或 Workflow DSL；
- 为首发包改变 Runtime Authority、安全边界或公开行为；
- 未经用户明确授权直接 publish npm、创建 Release 或使用凭据。

## Development Order

1. 解决 License/版本/scope 三个决策；
2. 补 package metadata 和 tarball manifest gate；
3. 补 GitHub Actions，并让 packed external consumer 成为硬门禁；
4. 在 clean checkout 完成 release-ready 验证；
5. 用户单独批准后执行 npm publish、tag 和 GitHub Release；
6. 从公网 registry 做全新 Consumer 验收。
