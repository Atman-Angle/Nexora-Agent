# Editable Work Artifact Workspace — Feature Spec

## Status

```yaml
capability: editable-work-artifact-workspace
feature: editable-rich-document-artifact
mode: PLAN
risk: L3
status: accepted
owner: Desktop Host
runtime_change: not_required_for_feature_core
harness_change: not_required_for_feature_core
migration: not_required
```

本 Spec 定义 `editable-work-artifact-workspace` 能力的第一个可独立验收 Feature：`editable-rich-document-artifact`。它只在该纵向能力形成生产闭环所需的范围内设计，不提前实现 Word、Excel、PowerPoint、多人协作或通用文档平台。

## 1. Outcome

用户在 Nexora Desktop 中沿用现有交互：

```text
选择 Workspace
→ 新建 Session
→ 输入一个办公类目标
→ Nexora 读取 Workspace 事实并执行任务
→ 交付一份包含文字、图片、表格、图表和专业排版的真实富文档
→ 用户在同一 Session 提出局部修改
→ Nexora 修改同一个逻辑产物，而不是重新创建一份无关文件
→ Desktop 在重启后仍能打开当前产物并继续修改
```

Feature Core 的正式产物是一个可离线打开的静态 HTML 富文档及其结构化源。HTML 是真实交付格式，不是 Conversation 中的一段 Markdown，也不是 Renderer 临时拼出的回答。

首个 Feature 必须证明：Nexora 能够可靠地创建、持续修改、验证和交付一个富内容工作产物。DOCX、PDF、XLSX、PPTX 只有在该闭环通过并出现对应真实需求后，才进入独立 Feature。

## 2. Product decision

Nexora Runtime 继续是通用可信执行内核。办公领域能力属于官方 Desktop Host：

- Desktop Renderer 负责产物发现、选择和安全预览；
- Desktop Host 注册富文档 Tool 并确定性生成文件；
- Harness 继续负责模型决策和 Tool 选择，不理解文档块、图表或主题；
- Runtime 继续拥有 Schema、Approval、Invocation、Evidence、恢复和 Completion；
- Workspace 文件是当前产物的外部事实；
- Renderer、Model 和 Host UI 均不得直接宣布产物修改成功。

Host 实现 Tool 不等于旁路 Runtime。所有创建和修改仍走唯一生产路径：

```text
User input
→ Harness decision
→ Runtime Action
→ Schema / Approval
→ Tool Invocation
→ Desktop Host document Tool
→ Workspace mutation
→ Evidence
→ Completion Gate
→ Desktop projection
```

## 3. Current repository reality

当前仓库已经具备：

- Desktop Workspace、Session 和 continuation Run；
- 同一 Session 的可验证 lineage 与有界 Context 重建；
- Workspace 受限文件读、写和 digest-guarded patch；
- Runtime Tool、Approval、Invocation、Evidence、Artifact 和 Completion Gate；
- Renderer 从成功的 `filesystem.write` / `filesystem.patch` Invocation 投影输出链接；
- 文本 Artifact 有界读取和 Workspace 文件安全打开；
- Electron `contextIsolation`、Renderer sandbox 和最小 preload bridge。

当前缺口是：

- 输出发现只按文件扩展名和通用文件写 Invocation 推断，不存在稳定的富文档语义；
- Desktop 只能打开文件或预览文本 Artifact，没有产物主视图；
- 模型可以写 HTML 文本，但没有受限结构 Schema、稳定块 ID、修订 CAS 或确定性布局验证；
- 后续 Run 虽然拥有上下文，但没有正式 Contract 区分“修改当前产物”和“新建另一产物”；
- 任意 HTML 直接渲染会扩大脚本、网络、导航、本地文件和 Electron bridge 攻击面。

因此，本 Feature 复用现有执行 Authority，但为 Desktop 增加一个最小、受限、可验证的富文档领域 Tool 集与 Output 投影。

## 4. External implementation research

本设计只借鉴成熟开源项目已经验证的结构，不复制其完整产品范围。链接固定到调研时的 commit。

### 4.1 ProseMirror document model

[`prosemirror-model`](https://github.com/ProseMirror/prosemirror-model/blob/6264de069d8439131e88f8ba06973551916184e4/src/README.md) 把文档表示为符合 Schema 的节点树，并将 DOM parsing / serialization 与内容模型分开。

采用原则：

- 当前文档必须是结构化、可校验的数据，不是任意 HTML 字符串；
- 节点类型、父子关系和属性有明确 Schema；
- 修改作用于结构节点，渲染是确定性派生过程。

不采用：

- 本 Feature 不引入 ProseMirror 编辑器、位置事务或其完整依赖；
- 当前 Renderer 不是 React 编辑器，用户也未要求首版直接 WYSIWYG 编辑；
- 首版用现有 Zod 定义满足业务需要的最小块 Schema，避免为未来编辑器提前引入框架。

### 4.2 BlockNote

[`BlockNote`](https://github.com/TypeCellOS/BlockNote/blob/19b9b19d1681867a6a0a5ca71c07a864d4e812b1/README.md) 验证了块式文档、嵌套、拖放和结构化 JSON 对现代文档体验的适用性，也展示了完整编辑器随之而来的 React、UI 和协作范围。

采用原则：

- 使用稳定 block ID 支持局部替换、插入、移动和删除；
- 块结构适合 Agent 精确修改，也适合 Renderer 做确定性预览。

不采用：

- 不引入 React、Mantine、Yjs、实时协作和 BlockNote XL；
- 不把首个 Agent 产物 Feature 扩张成通用 Notion 编辑器；
- MPL/GPL/商业许可范围不进入本 Feature 的生产依赖。

### 4.3 Office generation libraries

- [`docx`](https://github.com/dolanmiu/docx/tree/fda088d1da3772474bec9c40feb210cebb304f97) 可在 JS/TS 中生成包含段落、表格、图片、页眉页脚和样式的 DOCX；
- [`ExcelJS`](https://github.com/exceljs/exceljs/blob/5bed18b45e824f409b08456b59b87430ded023ab/README.md) 提供 XLSX 读取、写入、样式、公式和图片能力；
- [`PptxGenJS`](https://github.com/gitbrent/PptxGenJS/tree/3c9ec1b687c174952166f6a34b5e87ebf69fa469) 能从 Node/Electron 生成包含文本、表格、形状、图片、图表和母版的 OOXML 演示文稿。

结论：这些库证明后续 DOCX/XLSX/PPTX Feature 可以继续留在 Node Desktop Host，不要求安装 Microsoft Office 或 Python Runtime。当前 Feature 不安装它们，因为没有对应生产调用方，且三种格式具有不同的修改、验证和 round-trip 风险。

### 4.4 ONLYOFFICE Document Server

[`ONLYOFFICE DocumentServer`](https://github.com/ONLYOFFICE/DocumentServer/blob/f580eb58439432310943ece02c9730c6a21365e7/Readme.md) 提供完整文档、表格、演示和 PDF 编辑器，并通过独立服务、Web Apps、SDK 和集成层工作。

不采用原因：

- 引入独立 Document Server、部署与生命周期；
- 显著扩大包体、运行前提、网络面和故障面；
- AGPL、集成和商业许可需要单独法律审查；
- 当前业务只要求 Agent 创建和持续修改产物，不要求完整 Office 兼容编辑器或多人实时协作。

如果未来真实用户明确要求高保真 Office WYSIWYG 和多人协作，再以独立 Spike 比较 ONLYOFFICE、LibreOffice 和原生格式工具链；本 Spec 不为其预建接口。

### 4.5 Electron and untrusted content

[`Electron Security Checklist`](https://github.com/electron/electron/blob/main/docs/tutorial/security.md) 要求 untrusted content 禁用 Node integration、启用 context isolation 和 sandbox、限制导航与新窗口、设置 CSP，并谨慎处理 `shell.openExternal`。

本 Feature 的安全结论：

- 模型不能提交任意 HTML、CSS、SVG 或 JavaScript；
- Host 只接受结构化内容和受限主题 token；
- Host 负责 HTML escaping 和固定模板渲染；
- 预览不获得 preload API，也不执行脚本；
- 不加载远程字体、图片、脚本、样式或 iframe。

[`DOMPurify`](https://github.com/cure53/DOMPurify/tree/1a49d19d1f57f67e263a3c6213faf7b4e9db8d7a) 是成熟的 allow-list DOM sanitizer，但首版不接收任意 HTML，因此不增加该依赖。只有后续 Feature 明确支持导入 HTML 时，才单独评估 sanitizer、Trusted Types 和导入后的规范化 Contract。

## 5. Scope

### 5.1 Included

- 在现有 Desktop Session 中通过自然语言创建一个富文档产物；
- 文档包含标题、段落、列表、表格、指标卡、提示块、分栏、图片和静态图表；
- 受限主题 token 控制字体、颜色、间距、页面宽度和基础视觉风格；
- 每个结构块具有稳定 ID；
- 后续 continuation Run 可以 inspect 并局部修改同一文档；
- 修改使用 revision + source digest CAS，旧输入不能覆盖新版本；
- 每次成功创建或修改形成一个不可变 revision bundle；
- Desktop 在同一主区域增加 `Conversation | Output | Activity` 切换；
- Output 在 Desktop 重启后可恢复；
- 当前 revision 可以安全预览和通过系统应用打开静态 HTML；
- 文档创建和修改通过 Runtime Tool、Approval、Invocation、Evidence 和 Completion；
- 确定性结构验证、资源验证、渲染验证和 Electron UAT。

### 5.2 Simplified in Feature Core

- 同一 Session 可以产生多个富文档，但 UI 默认聚焦最近更新的一个；
- 富文档只支持静态 HTML，不支持脚本和交互组件；
- 图片只接受 Workspace 内已有 PNG、JPEG 或 WebP，并在 revision 中按 digest 快照；
- 图表只支持 `bar | line | pie`，由 Host 生成无脚本 SVG；
- 链接只允许 `http`、`https` 和 `mailto`，点击继续走现有受限 Host bridge；
- revision 数据保留，但首版不提供可视化 diff 或一键回滚 UI；
- 用户通过对话要求修改，不提供直接 WYSIWYG 编辑。

## 6. Non-goals

- DOCX、PDF、XLSX、PPTX 生成或编辑；
- 任意 HTML/CSS/JavaScript/SVG 执行；
- AI 图片生成、图库搜索或外部素材下载；
- 音频、视频、动画和交互式网页应用；
- 多人实时协作、评论、权限、云同步和分享链接；
- 通用模板市场、品牌资产管理或插件 Registry；
- Office 文件无损 round-trip；
- 用户直接编辑 revision 内部文件；
- Runtime Deliverable 表、第二套 Run 状态或第二个 Completion Authority；
- Harness 文档规划器、Office Prompt 特判或常驻文档 Schema 注入；
- 为后续格式建立通用 Artifact Engine 抽象；没有第二个真实实现前，代码留在 Desktop 应用内。

## 7. Terminology

### Deliverable

一个由 Desktop Host 领域能力管理、由 Workspace 文件承载的用户工作产物。Deliverable 不等于 Runtime Artifact。

### Runtime Artifact

Runtime 管理的 content-addressed 大内容或审计材料。它继续使用既有 digest Authority。本 Feature 不改变其 Contract。

### Source document

符合本 Feature Schema 的结构化 JSON，是一个 revision 的可编辑内容事实。

### Revision bundle

一次成功创建或修改产生的不可变目录，包含结构化 source、静态 preview、资源快照和 validation summary。

### Manifest

Deliverable 根目录中的小型原子指针，声明当前 revision、source digest 和 preview digest。Manifest 不保存 Run 状态、完成状态或完整文档内容。

### Output view

Desktop 对 Deliverable 当前 revision 的只读投影，不是新的文件 Store 或编辑 Authority。

## 8. User value flows

### 8.1 Create

```text
User submits office goal
→ Agent reads required Workspace facts
→ Agent calls document.create with validated structured content
→ Runtime requests/persists exact Approval
→ Desktop Host validates paths, document Schema, budgets and assets
→ Host builds immutable revision bundle in a temporary directory
→ Host deterministically renders and validates static HTML
→ Host commits revision and atomically creates manifest
→ Tool returns bounded facts and digests
→ Runtime persists Invocation/Evidence
→ Completion Gate accepts only when user goal and required output evidence are satisfied
→ Desktop projects the Deliverable in Output view
```

### 8.2 Incremental update

```text
User says “replace the revenue chart; leave other sections unchanged”
→ continuation Run receives prior user/Invocation/Evidence facts
→ Agent calls document.inspect for current outline and digest
→ Agent calls document.apply_patch with deliverable ref, expected revision/digest and exact block operations
→ Host rereads current manifest and fails on conflict
→ Host applies operations to a copy of current source
→ Host verifies stable IDs, preserved blocks, assets and layout
→ Host commits one new immutable revision and advances manifest
→ Runtime records exact changed block IDs and new digests
→ Desktop updates the existing Deliverable instead of adding a duplicate
```

### 8.3 Reopen

```text
Desktop restarts
→ Session list is recovered from Runtime Authority
→ successful document Tool facts identify Deliverable manifests
→ Desktop Host validates the manifest and current revision below the Workspace
→ Renderer receives a bounded Deliverable view
→ current Output opens without reconstructing state from chat text
```

### 8.4 Conflict

```text
Agent inspected revision N
→ current manifest advances to N+1 before patch
→ patch expectedRevision/sourceDigest no longer matches
→ Tool fails DELIVERABLE_CONFLICT with no mutation
→ Agent must inspect current state and prepare a new bounded patch
```

Runtime must not automatically replay the stale write.

## 9. Authority mapping

| Fact | Authority | Projection / consumer |
| --- | --- | --- |
| User goal and correction | Run input history | Harness, Desktop Conversation |
| Current plan | Run-owned Structured Plan | Harness, Desktop |
| Run status | State Machine + persisted Run | All observers |
| Document mutation intent/result | Tool Invocation | Evidence, recovery, audit |
| Current Deliverable revision | Workspace manifest | Desktop Host document Tool |
| Revision content | Immutable revision source JSON | document.inspect, renderer |
| Preview | Revision preview + digest | Output view |
| Included image bytes | Revision asset snapshot + digest | renderer/export |
| Completion | existing Completion Gate | Desktop terminal result |
| Session continuity | Runtime continuation lineage | Harness Context |

Rules：

- Manifest 不能修改 Run、Plan、Invocation、Evidence、Approval 或 Result；
- Session metadata 不保存文档内容或当前 revision 副本；
- Renderer 不缓存可反向写入的 Source document；
- Tool result 不能代替 manifest；manifest 也不能代替 Tool Invocation；
- Preview 损坏不改变已持久化 Run 状态，Desktop 必须显示产物不可用并提供真实错误；
- 只有 `status === "succeeded"` 的 Run 可以显示任务完成，非终态 Run 即使已有 preview 也只能显示“已产生草稿”。

## 10. Workspace layout

默认创建到用户可见的 `outputs/` 目录：

```text
outputs/
└── quarterly-review/
    ├── manifest.nexora.json
    └── revisions/
        ├── 000001/
        │   ├── source.json
        │   ├── preview.html
        │   ├── validation.json
        │   └── assets/
        │       └── revenue.png
        └── 000002/
            ├── source.json
            ├── preview.html
            ├── validation.json
            └── assets/
                └── revenue.png
```

约束：

- `document.create` 只接受 Workspace-relative output directory；
- 路径规范化、symlink/junction/reparse-point 和 Workspace escape 规则复用现有文件 Tool；
- revision 目录写入后不可修改；
- `manifest.nexora.json` 是唯一 current pointer；
- revision number 从 1 单调递增，但不是 Run version 或 Plan version；
- `preview.html` 是静态、离线、无脚本的真实交付文件；
- 用户删除整个 Deliverable 目录时，Workspace 外部事实为已删除，Desktop 不从旧聊天或 Host 缓存伪造恢复；
- 本 Feature 不自动垃圾回收历史 revisions。

## 11. Persisted contract

### 11.1 Manifest

```ts
type RichDocumentManifestV1 = {
  readonly schemaVersion: 1;
  readonly deliverableId: string;
  readonly kind: "rich_document";
  readonly title: string;
  readonly currentRevision: number;
  readonly currentRevisionPath: string;
  readonly sourceDigest: `sha256:${string}`;
  readonly previewDigest: `sha256:${string}`;
  readonly createdByInvocationId: string;
  readonly updatedByInvocationId: string;
};
```

`deliverableId` 由 Host 根据规范化 Deliverable 根路径确定性生成；模型不能指定任意 ID。绝对 Workspace 路径不得进入 manifest、Tool facts、Renderer Snapshot 或模型 Context。

### 11.2 Source document

```ts
type RichDocumentSourceV1 = {
  readonly schemaVersion: 1;
  readonly deliverableId: string;
  readonly revision: number;
  readonly title: string;
  readonly locale: string;
  readonly theme: RichDocumentThemeV1;
  readonly blocks: readonly RichDocumentBlockV1[];
};
```

### 11.3 Minimal block set

Feature Core 只定义以下块：

```text
heading     level 1..4 + inline runs
paragraph   inline runs
list        ordered/unordered + items
table       optional headers + rows + alignment
metric      label + value + optional delta/note
callout     info/warning/success + inline runs
image       Workspace asset ref + alt + caption + fit
chart       bar/line/pie + categories + series + labels
columns     two or three columns containing non-column blocks
divider
```

每个 block 都有非空、文档内唯一、稳定的 `blockId`。`columns` 不允许递归嵌套 `columns`。Feature Core 不定义任意 widget、HTML block、code execution block 或插件 block。

Inline content 使用结构化 text runs：

```ts
type InlineRunV1 = {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly code?: boolean;
  readonly href?: string;
};
```

不接受 Markdown 内嵌 HTML。`href` 只允许 `http`、`https`、`mailto`，且预览中的点击仍由 Host 校验。

### 11.4 Theme

主题只允许有限 token：

```text
page width
content max width
light/dark surface preset
primary/accent/text/muted/background colors
heading/body font family from Host allowlist
base font size
compact/comfortable spacing
square/rounded visual style
```

模型不能提交 CSS selectors、CSS declarations、font URL、data URL、animation 或 JavaScript。

### 11.5 Safety budgets

Host 在写入前执行可配置的保守上限，包括：

- document JSON bytes；
- block count 和最大 nesting depth；
- total text characters；
- table cells；
- chart points；
- asset count、single asset bytes 和 total asset bytes；
- rendered HTML bytes；
- path length 和 file count。

初始数值属于实现常量，不是长期公共 API。实现必须提供边界测试和用户可读错误；在没有真实负载数据前不声称支持无限文档或大型数据分析。

## 12. Tool contracts

Feature Core 只增加三个 Host-registered Runtime Tools，不建立 Registry。

### 12.1 `document.create`

Effect：`write`，幂等。

输入：

```ts
{
  outputDirectory: string;
  title: string;
  locale: string;
  theme: RichDocumentThemeV1;
  blocks: RichDocumentBlockV1[];
}
```

行为：

- 目标不存在时创建 revision 1；
- 目标已存在且属于另一 Invocation 时返回 `DELIVERABLE_ALREADY_EXISTS`；
- 同一 Invocation 重放且已提交时返回同一 revision 和 digests；
- 不覆盖任意已有目录或文件；
- 完整 validation 通过后才提交 manifest。

成功 facts：

```ts
{
  deliverableId: string;
  kind: "rich_document";
  manifestPath: string;
  revision: number;
  sourceDigest: string;
  previewDigest: string;
  blockCount: number;
  assetCount: number;
  validation: "passed";
}
```

### 12.2 `document.inspect`

Effect：`read`，cache mode 为 `until_mutation`。

输入支持：

```text
manifest path or deliverable ID
mode: summary | outline | blocks
optional exact block IDs
```

输出有界包含：

- current revision 和 source digest；
- title、theme summary、block outline；
- 请求的精确 blocks；
- preview/asset validation 状态；
- manifest 或 revision 缺失、损坏、digest mismatch 的稳定错误。

`summary` / `outline` 不返回完整长正文。精确内容通过 block ID 渐进读取，避免把整个文档永久塞入 Context。

### 12.3 `document.apply_patch`

Effect：`write`，按 Invocation 幂等。

输入：

```ts
{
  manifestPath: string;
  expectedRevision: number;
  expectedSourceDigest: string;
  operations: RichDocumentPatchOperationV1[];
}
```

允许操作：

```text
replace_block
insert_before
insert_after
remove_block
move_before
move_after
set_title
set_theme
```

规则：

- 所有 block 定位使用稳定 block ID，不使用数组 index；
- 一个调用中的 operations 按顺序应用并整体校验；
- 任一目标缺失、ID 重复、Schema 非法、预算超限或 asset 非法时，整个调用不提交；
- CAS 不匹配返回 `DELIVERABLE_CONFLICT`，不自动覆盖；
- patch 结果创建一个完整新 revision；
- 成功 facts 包含 changed、inserted、removed、moved block IDs 和 preserved block count；
- 用户要求“其他部分不变”时，Completion Evidence 必须能证明未涉及 block 的 canonical digest 保持一致。

### 12.4 Approval policy

Desktop Host 可以自动批准精确命名的 `document.create` 和 `document.apply_patch`，前提是：

- Runtime 已创建真实 Approval request；
- canonical input 已通过 Schema；
- output 和 asset paths 都被确定性限制在当前 Workspace；
- Tool 不执行 shell、网络、脚本或外部应用；
- Tool 幂等并实现本 Spec 的 revision commit protocol。

不得把该规则扩大为按前缀、模型声明、effect kind 或任意第三方 Tool 自动批准。CLI 和第三方 Host 默认行为不变。

## 13. Revision commit protocol

一次 write Tool 必须采用以下顺序：

```text
read and validate current manifest (patch only)
→ verify expected revision/source digest
→ build complete next source in memory
→ validate Schema and budgets
→ snapshot and validate assets
→ render preview into invocation-scoped temporary directory
→ validate preview and compute digests
→ atomically move temporary directory to immutable revision directory
→ atomically create/replace manifest pointer
→ return bounded Tool facts
```

Manifest 替换是 current revision 的 commit point。

Crash semantics：

| Crash point | Recovery |
| --- | --- |
| revision directory commit 前 | 无可见状态；删除临时目录后可重试 |
| revision directory 已存在、manifest 未前移 | revision 为 orphan，不是 current；同一 Invocation 可校验后复用 |
| manifest 已前移、Tool response 未持久化 | 重试按 Invocation ID 和 digests 识别已提交结果，不创建新 revision |
| manifest 或 revision digest 不匹配 | fail closed；不自动重建或宣布成功 |

Desktop 已有单 Workspace 单 Runtime 实例约束继续生效。Tool 实现使用按 deliverable ID 的进程内互斥，避免同一 Runtime 中两个写并发提交；不新增锁数据库或后台协调服务。

## 14. Deterministic rendering

Host renderer 必须是纯数据到静态文件的确定性转换：

```text
validated source + validated asset bytes + renderer version
→ preview.html + generated chart SVG
```

要求：

- 所有文本和 attribute 经过 context-correct escaping；
- Renderer 使用固定元素和固定 class，不拼接模型 CSS；
- chart SVG 由 Host 生成，模型只提供结构化 series；
- 图片被复制到 revision asset snapshot 或安全内联，不能继续引用可变绝对路径；
- HTML 包含严格 CSP：默认拒绝，禁止脚本、frame、object、网络连接和远程资源；
- 不存在 `<script>`、inline event handlers、`javascript:`、remote stylesheet、remote font 或 iframe；
- renderer version 进入 `validation.json`，同一 source 在同一 renderer version 下必须得到相同 digest；
- 使用系统字体 allowlist；字体缺失时采用声明的确定性 fallback，不联网下载。

Feature Core 的 chart 是静态 SVG，不引入浏览器图表 Runtime。只有交互图表成为独立验收要求时，才评估 Apache ECharts 等依赖及更严格的隔离执行环境。

## 15. Desktop UI

现有两栏产品形态保持。打开 Session 后，主区域 header 增加：

```text
Conversation | Output | Activity
```

规则：

- 没有真实 Deliverable facts 时不显示 Output 占位页；
- 第一次成功 `document.create` 后显示 Output；
- 非终态 Run 产生 revision 时标记“草稿已更新”，不显示任务完成；
- 同一 deliverable ID 的后续 revision 更新原条目，不追加重复链接；
- Output header 显示 title、kind、revision、last updated Run 和 validation 状态；
- 当前 Feature 预览只读，修改继续通过底部 Composer；
- 预览内容不接收 preload bridge，不得调用 Desktop API；
- 链接点击由 Renderer 提取 URL，再调用现有 `openExternal` schema 和协议 allowlist；
- 打开静态 HTML 文件继续使用 Workspace-relative path 和 Main 侧路径复验；
- 切回 Conversation 不卸载或修改 Runtime 状态；
- Renderer 只保存当前 tab 等展示偏好，不保存 deliverable current revision。

## 16. Desktop read projection

Desktop Snapshot 从已持久化的成功 Tool Invocation facts 投影有界 `DeliverableSummary`：

```ts
type DeliverableSummary = {
  readonly deliverableId: string;
  readonly kind: "rich_document";
  readonly title: string;
  readonly manifestPath: string;
  readonly revision: number;
  readonly sourceDigest: string;
  readonly previewDigest: string;
  readonly validation: "passed" | "unavailable";
  readonly sourceRunId: string;
};
```

投影规则：

- 只消费成功 `document.create` / `document.apply_patch` 的 schema-valid facts；
- 按 continuation chain 顺序处理，较新 revision 覆盖同 deliverable ID 的旧投影；
- Host 在真正打开 Output 时重新验证 manifest 和 revision，不盲信旧 Snapshot；
- sibling Session 或其他 Workspace 的 Deliverable 不可见；
- manifest 删除或损坏时显示 unavailable，不能回退到旧 preview 冒充 current；
- 大 source、HTML 和 asset bytes 不进入 Desktop Snapshot。

新增最小 IPC：

```text
readDeliverable(projectPath, manifestPath, expectedRevision, expectedPreviewDigest)
```

返回经过 Schema 校验的 bounded preview descriptor 或稳定错误。Renderer 永远不接收物理 `.nexora` Store 路径、Provider secret 或任意文件读取能力。

## 17. Harness behavior

Feature Core 不修改 Harness 生产逻辑。

现有机制已经提供：

- Provider-native Tool catalog；
- Tool decision metadata；
- continuation ancestor Invocation/Evidence projection；
- exact Context ref rehydration；
- working set 中的 read/write reuse；
- bounded repair 和 Completion proposal。

富文档 Tool contract 必须通过 `decision.useWhen` / `avoidWhen` 清楚表达：

- 创建新的富报告时使用 `document.create`；
- 修改已有富文档前先 `document.inspect`；
- 用户明确要求修改现有产物时避免创建另一个输出目录；
- 只需要解释或普通文本回答时避免创建 Deliverable。

只有测试证明模型仍无法稳定识别当前 Deliverable、continuation 丢失必要 refs 或 Tool catalog 明显退化时，才启动独立 Harness Feature；不得在本 Feature 中加入 Office Prompt 特判、隐藏计划或第二个文档 Agent Loop。

## 18. Failure semantics

| Failure | Stable result |
| --- | --- |
| output path escape / reparse point | `WORKSPACE_BOUNDARY_VIOLATION`; no mutation |
| target already exists | `DELIVERABLE_ALREADY_EXISTS`; no overwrite |
| manifest/source schema invalid | `DELIVERABLE_INVALID`; fail closed |
| expected revision/digest stale | `DELIVERABLE_CONFLICT`; inspect before new patch |
| block ID missing/duplicate | `INVALID_DOCUMENT_PATCH`; no revision |
| asset missing/changed/unsupported | `INVALID_DOCUMENT_ASSET`; no revision |
| safety budget exceeded | `DOCUMENT_BUDGET_EXCEEDED`; user-readable bounded details |
| render validation fails | `DOCUMENT_RENDER_FAILED`; no manifest advance |
| committed revision exists on retry | return same committed facts |
| effect outcome truly unknown | existing Runtime unknown Invocation recovery applies |
| preview missing after successful historical Run | show unavailable; do not change Run status |

Tool error messages必须指出最早被破坏的边界和安全的下一步，不允许通过默认空图片、删除未知块、重建整份文档或放宽 Schema 掩盖错误。

## 19. Security and privacy

### 19.1 Input boundary

- Tool input通过 Zod strict Schema；
- unknown fields、prototype keys、non-finite numbers 和非法 URL 被拒绝；
- 文本、表格、图表和主题都有尺寸与枚举边界；
- Model output 与 Workspace 文件均视为 untrusted data。

### 19.2 Filesystem

- 所有路径为 Workspace-relative；
- 解析后必须仍位于当前 Project；
- 拒绝 symlink、junction、reparse point 和绝对路径；
- 临时目录和最终 revision 都位于 Deliverable 根目录；
- create 不覆盖已有任意文件；patch 只写新的 revision 和 manifest；
- 打开路径时 Electron Main 再次验证 Project 与 canonical target。

### 19.3 Preview

- 不渲染用户/模型原始 HTML；
- 不执行 JavaScript；
- 不允许 remote resource、navigation、popup、download、clipboard、camera、microphone、geolocation 或 notification permission；
- 保持 `nodeIntegration: false`、`contextIsolation: true` 和 sandbox；
- CSP 和 URL allowlist 有确定性安全测试；
- preview 不能访问 preload 暴露的 `window.nexora`。

### 19.4 Secrets and sensitive data

- Provider secret 不进入 source、manifest、preview、Tool facts 或 Renderer；
- Workspace 图片原始路径不暴露绝对地址；
- validation 错误不回显任意文件内容；
- 文档内容按当前 Workspace 本地数据边界保存，本 Feature 不上传到新服务。

## 20. Validation

### 20.1 Structural validation

- manifest、source、patch operation 和 Tool facts 通过 strict Schema；
- block IDs 唯一且所有引用存在；
- columns 深度、table size、chart series 和 assets 满足边界；
- revision、deliverable ID 和 digests 相互一致。

### 20.2 Render validation

- HTML 可被 Chromium 加载；
- CSP 存在且没有 script/network capability；
- 所有 asset snapshot 存在并匹配 digest；
- 无缺失 block、未转义 content 或非法 URL；
- viewport 没有非预期横向溢出；
- heading、table、image 和 chart fixture 具有非零布局尺寸；
- light/dark preset 的关键文本对比度满足固定检查；
- renderer output digest 可重复。

### 20.3 Incremental preservation validation

每个 source block 计算 canonical digest。Patch validation 记录：

```text
changed block IDs
inserted block IDs
removed block IDs
moved block IDs
preserved block count
before/after source digest
```

未被 operation 触及的 block，其 canonical content digest 必须保持一致；move 只允许位置变化，不允许内容变化。该记录进入 bounded Tool facts 和 `validation.json`，成为“没有重新生成无关内容”的机械证据。

## 21. Test strategy

风险等级为 L3，因为该 Feature 新增自动批准的 Workspace 写 Tool、持久化领域文件、安全预览和跨 Run 修改语义。

### 21.1 Unit tests

- strict document/manifest/patch Schema；
- stable block ID uniqueness；
- all patch operations and atomic rejection；
- canonical block/source digests；
- deterministic renderer；
- HTML/attribute escaping；
- URL/CSP/font/theme allowlists；
- chart SVG generation；
- path/reparse-point boundary；
- budgets；
- idempotent replay and orphan revision recovery。

### 21.2 Runtime/Desktop integration

- Host 注册三个 Tool，但 Harness/Runtime 无领域特判；
- document write仍产生 Approval、Invocation、Evidence 和 Completion；
- Desktop 只自动批准两个精确 write Tool，shell policy 不变；
- create → inspect → patch 形成 revision 1 → 2；
- stale CAS 不产生新 revision；
- failure before commit 不前移 manifest；
- crash after commit / before Tool response 重试返回同一 revision；
- continuation Run能定位并修改 ancestor Deliverable；
- sibling Session、跨 Workspace 和伪造 deliverable ID 不可见；
- Desktop restart恢复 Output；
- 删除/损坏 manifest显示 unavailable，不伪造成功。

### 21.3 Security tests

固定恶意 fixtures：

```text
<script> and event handlers in text
javascript:/file:/data: URLs
remote image/font/style URLs
SVG with script
HTML closing-tag injection
CSS injection in colors/font names
prototype pollution keys
path traversal / absolute path / UNC path
symlink / junction / reparse point
oversized table/chart/text/assets
preview navigation, popup and permission request
```

所有 fixtures 必须被拒绝或以纯文本安全呈现，不能执行代码、联网或越过 Workspace。

### 21.4 Deterministic acceptance scenario

固定 Workspace 包含销售数据 fixture 和两张本地图片。Deterministic Provider 执行：

1. 创建“季度经营分析”，包含封面、4 个指标、趋势图、数据表、图片、结论和专业主题；
2. Run 成功并显示 Output revision 1；
3. 用户继续：“把趋势图从柱状图改为折线图，缩短结论，其他部分不要动”；
4. Agent inspect 当前文档并 patch 精确 block；
5. revision 2 中只允许目标 chart、结论 block 和必要 manifest metadata 变化；
6. Desktop 重启后打开 revision 2；
7. 再次继续并修改标题，形成 revision 3；
8. Activity 能追溯每次 Tool、Approval、Invocation、Evidence 和 Result。

### 21.5 Real Provider UAT

在显式配置真实 Provider 的环境执行同一业务目标，人工检查：

- 内容满足原始目标；
- 页面具有可用的信息层级和视觉排版；
- 图片、图表、表格均真实渲染；
- 第二轮按指定范围修改；
- Agent 没有创建无关 duplicate Deliverable；
- Desktop 可继续响应、切换 Session 和关闭重启。

真实 Provider UAT 只证明当前环境可用性，不替代确定性测试，也不用于宣称质量优于其他产品。

### 21.6 Required regression

- Runtime Tool/Approval/Invocation/Evidence/Completion focused suite；
- Session continuation and context projection suite；
- Desktop Workspace/session/markdown/output tests；
- Desktop deterministic UAT；
- Runtime、Harness、Desktop build/typecheck；
- targeted ESLint；
- 根据 `TESTS.md` L3 边界执行必要回归，不默认运行无关 benchmark 或全部 canary。

## 22. Module boundary

首个真实调用方只有 Desktop，因此实现保留在 `apps/desktop`，建议按职责放置：

```text
apps/desktop/src/deliverables/
  contracts.ts       strict manifest/source/patch schemas
  paths.ts           workspace containment and revision paths
  revisions.ts       commit, replay and recovery
  render.ts          deterministic static HTML/SVG renderer
  validation.ts      structural/render/preservation checks
  tools.ts           document.create/inspect/apply_patch
  projection.ts      Invocation facts → DeliverableSummary

apps/desktop/src/renderer/
  deliverable-view.ts
```

这只是责任边界，不预先规定 class hierarchy。没有第二个真实 Host 调用方前，不创建 `packages/artifacts`、`packages/office`、通用 exporter Registry 或 plugin API。

## 23. Dependency decision

Feature Core 复用：

- Node.js filesystem/crypto/path；
- 已有 Zod；
- 已有 Electron/Chromium；
- 已有 Runtime Tool builder 和 Desktop worker/IPC。

Feature Core 不新增生产依赖。

以下依赖只有独立 Feature 授权后才评估：

| Capability | Candidate | Trigger |
| --- | --- | --- |
| HTML import sanitation | DOMPurify | 必须导入任意 HTML，而非结构化 Source |
| Direct rich-text editing | ProseMirror or another maintained editor core | 用户需要 WYSIWYG，而不只是对话修改 |
| DOCX export | docx | 富文档闭环稳定且用户明确需要 Word |
| XLSX edit | ExcelJS or evaluated alternative | 出现带公式/图表的表格任务 |
| PPTX export | PptxGenJS | 出现可编辑演示交付任务 |
| Full Office editor | separate ONLYOFFICE/LibreOffice spike | 高保真 round-trip / collaboration 成为硬需求 |

采用任何新依赖前必须记录固定版本、许可证、维护状态、包体、Node/Electron 兼容性、安全公告、格式保真 fixtures 和卸载路径。

## 24. Migration and compatibility

- 不修改现有 Runtime SQLite schema；
- 不修改 Run、Plan、Invocation、Evidence 或 Result 公共 Contract；
- 不改变 CLI 和 package consumer；
- 旧 Workspace 没有 manifest 时继续只显示现有 file outputs；
- 新 manifest 使用显式 `schemaVersion: 1`；未知版本失败关闭，不猜测迁移；
- `workspaceOutputs` 保留旧文件链接投影，同时增加 schema-valid document Tool 投影；
- 只有 Feature 稳定且第二个 schema version 出现时才设计迁移器。

## 25. Rollout and rollback

实现阶段可通过 Desktop Host 内部 feature flag 控制 Output view 和 document Tools，但 flag 不进入 Runtime 或用户文档的长期 Contract。

Rollout 顺序：

```text
schemas/renderer deterministic tests
→ Tool revision/commit tests
→ Runtime/Desktop integration
→ security fixtures
→ deterministic Desktop UAT
→ explicit real Provider UAT
→ default enable
```

Rollback：

- 停止注册 `document.*` Tools；
- 移除 Output view 的富文档投影；
- 保留 Workspace 中已生成的静态 HTML、source 和 revisions；
- 保留 Runtime 中已有 Approval、Invocation、Evidence 和审计记录；
- 旧文件仍可通过现有 Workspace output link 打开；
- 不删除用户 Deliverable 或改写历史 Run。

## 26. Follow-on capability map

以下是同一产品方向的候选独立 Feature，不属于当前实现授权：

```text
editable-rich-document-artifact
→ evidence: users repeatedly need a portable paginated document
→ docx-pdf-document-export

editable-rich-document-artifact
→ evidence: users need formulas, ranges and charts over tabular data
→ editable-spreadsheet-artifact

editable-rich-document-artifact
→ evidence: users need slide-level storytelling and editable decks
→ editable-presentation-artifact

multiple real artifact engines
→ repeated shared revision/export friction
→ generic deliverable contract extraction, if justified
```

图片生成、品牌模板、组合交付、直接编辑、版本回退和多人协作分别需要自己的用户证据和 Acceptance，不能因为市场产品具备就自动进入路线。

## 27. Acceptance

Feature Core 只有在以下证据同时成立时才完成：

1. 用户能从现有 Desktop New Task 创建一个真实富文档，不选择新的 Office 模式；
2. 文档包含结构化文字、表格、本地图片、静态图表和主题排版；
3. Model 不能提交或执行任意 HTML、CSS、JavaScript 或 SVG；
4. 创建和修改经过现有 Runtime Approval、Invocation、Evidence 和 Completion；
5. `document.create` 重放不产生重复 Deliverable 或 revision；
6. 后续 continuation Run先 inspect，再按 stable block ID patch 同一 Deliverable；
7. stale revision/digest 不能覆盖当前文档；
8. Patch 原子失败，未涉及 block 的 canonical digest 保持一致；
9. Crash matrix 证明 manifest commit 前后均可确定性恢复，不产生双 current revision；
10. Output view 与 Conversation/Activity 共用现有主区域，没有第二套 Session 或 Run 状态；
11. Desktop 重启后能从 Runtime facts + Workspace manifest 恢复当前 Output；
12. 删除、损坏或跨 Workspace manifest 不能被旧缓存伪造为可用；
13. Preview 满足 CSP、sandbox、navigation、permission、path 和 malicious content 安全测试；
14. Renderer Snapshot 不包含完整 source、asset bytes、绝对路径或 secret；
15. Deterministic create → patch → restart → patch UAT 通过；
16. 真实 Provider UAT 在显式环境中完成，或明确记录为 external acceptance 而不伪装为本地通过；
17. L3 focused regression、build、typecheck 和 lint 通过；
18. `DEVELOPMENT.md` 只记录实际完成证据，并停止在本 Feature 边界。

## 28. Definition of done

以下内容必须一致：

- 本 Spec；
- Desktop public/user documentation；
- Host Tool schemas and decision metadata；
- Workspace persisted format；
- Renderer projection and security boundary；
- deterministic tests、crash tests 和 Desktop UAT；
- `DEVELOPMENT.md` 的实际状态。

测试通过、生成一份好看的 Demo、Model 输出 Final 或文件能在浏览器打开都不足以单独宣布完成。完成必须由真实 Workspace 文件、Tool Invocation、Evidence、incremental preservation、重启恢复和安全预览共同证明。
