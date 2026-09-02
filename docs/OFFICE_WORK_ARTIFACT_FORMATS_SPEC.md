# Office Work Artifacts — Production Feature Spec

## Status

```yaml
capability: editable-work-artifact-workspace
feature: office-work-artifact-formats
mode: PLAN
status: proposed
owner: Desktop Host
risk: L4
runtime_change: not_required_for_core
harness_change: not_required_for_core
migration: not_required
depends_on: editable-rich-document-artifact
```

本文定义 DOCX、XLSX、PPTX、PDF 真实办公文件产物的生产级实现范围。它是现有 `editable-rich-document-artifact` 的后续独立 Feature，不修改 Harness/Runtime 的核心 Authority，不把 Office 领域字段放入 Runtime。

## 1. Outcome

用户保持现有使用方式：

```text
选择 Workspace
→ 新建任务
→ 输入办公目标
→ Nexora 执行并生成真实办公文件
→ Desktop 自动显示 Output
→ 用户点击 Output 或文件后，在右侧打开预览/编辑 Dock
→ 用户通过 Dock 的格式化编辑控件或对话要求修改
→ Nexora 读取当前 revision 并只提交增量修改
→ 生成同一逻辑产物的新 revision
→ 用户可下载、打开原格式文件或继续修改
```

交付不是一段 Markdown，也不是临时 Python 脚本，而是 Workspace 中可被真实办公软件打开的 `.docx`、`.xlsx`、`.pptx` 或 `.pdf`，并同时保留可验证的结构化 Source、预览和 revision 历史。

## 2. Product decisions

### 2.1 Model does not generate executable conversion code

模型只输出受 Schema 约束的结构化 Authoring 操作。固定的 Host Renderer 使用成熟库生成文件：

```text
Model Authoring DTO
→ Host compiler + strict source validation
→ format-specific renderer
→ real office file + preview + validation
→ Runtime Invocation/Evidence/Completion
```

模型不得提交任意 Python/JavaScript、shell 命令、XML、HTML、VBA、宏或可执行模板。首版不执行模型生成的代码。

### 2.2 One logical Deliverable, multiple representations

一个用户产物可以有多个格式变体：

```text
Deliverable: quarterly-report
├── source revision 3
├── DOCX revision 3
├── XLSX revision 3
├── PPTX revision 3
└── PDF revision 3
```

它们共享同一逻辑 Deliverable 和 revision，但每种格式有自己的 Source/Renderer/validation。一个格式渲染失败不得伪造该格式已生成成功，也不得回滚其他已成功格式。

### 2.3 PDF is a publication format

PDF 在本 Feature 中是可预览、可下载、可打印的发布格式，不承诺无损原生编辑。用户编辑 PDF 时，系统修改可编辑 Source，再生成新的 PDF revision。PDF 文本选择、分页、字体嵌入和视觉快照必须验证。

## 3. Scope

### 3.1 Included

- DOCX 生成与结构化增量修改；
- XLSX 工作簿生成与结构化增量修改；
- PPTX 演示文稿生成与结构化增量修改；
- PDF 从已验证 Source/HTML/页面布局生成；
- 每种格式真实文件、静态预览、校验记录和 immutable revision；
- 同一 Session 内创建、inspect、patch 和重新导出；
- Desktop 右侧 Output Dock：预览、版本、验证状态、编辑入口、打开文件、下载路径；
- 未点击任何文件或 Output 时，Dock 最小化为窄条或隐藏，不挤压 Conversation；
- 结构化轻量编辑：文字、数字、单元格、表格行列、图片、图表数据、页面/幻灯片顺序和基础样式；
- 重新打开 Session 后恢复当前 Deliverable 和最新 revision；
- 文件生成、修改和导出均经过 Runtime Tool、Approval、Invocation、Evidence 和 Completion Gate。

### 3.2 Explicitly not included

- 完整 Microsoft Office/ONLYOFFICE 在线编辑器；
- 多人协作、评论、批注、修订跟踪和权限共享；
- 无损导入任意已有 DOCX/XLSX/PPTX 并完全保留所有隐藏 OOXML 特性；
- VBA、宏、外部链接自动执行、ActiveX、嵌入对象和 OLE；
- 模型生成并执行 Python/JavaScript；
- PDF OCR、扫描件版面重建、复杂表单签名；
- 任意 HTML/CSS/SVG/脚本导入；
- 无边界的超大 Workbook 或数百页演示文稿。

## 4. Format capability matrix

| Format | Canonical source | Renderer | In-app preview | In-app edit | Native app open |
| --- | --- | --- | --- | --- | --- |
| DOCX | document sections, paragraphs, tables, images, styles | fixed DOCX renderer | paginated HTML snapshot | structured text/table/style edits | yes |
| XLSX | workbook/sheets/cells/formulas/styles/charts | fixed XLSX renderer | safe HTML grid + chart snapshot | cell/formula/row/column/style edits | yes |
| PPTX | slides/shapes/text/images/charts/layout | fixed PPTX renderer | slide thumbnails + selected-slide preview | slide/shape/text/order edits | yes |
| PDF | page layout source or exported office source | fixed PDF exporter | sandboxed page preview | edit source, re-export PDF | yes |

Renderer libraries are product dependencies pinned and tested by the Host. The exact library is an implementation decision recorded in the implementation plan; no runtime installation or user-local Office installation is required for generation.

## 5. User experience

### 5.1 Default layout

The existing main area keeps its normal flow:

```text
┌──────────────┬──────────────────────────────┬──────────────┐
│ Sidebar      │ Conversation / Activity     │ Output Dock  │
│              │                              │              │
│              │                              │ preview      │
│              │                              │ metadata     │
└──────────────┴──────────────────────────────┴──────────────┘
```

Rules:

- Output Dock is closed/minimized by default when no output is selected;
- selecting an Output card, file link or `Open preview` expands the Dock;
- Dock width is user-resizable within safe bounds, default 360–440 px;
- on narrow windows it becomes a bottom sheet, never overlays the composer permanently;
- Conversation remains the primary surface; Output never replaces the normal Coding/Conversation flow;
- the last selected Deliverable/format is remembered per Session, but stale previews are revalidated by digest;
- closing the Dock does not close the Session or delete the file;
- clicking a file link opens the Dock first; explicit `Open in system app` uses the existing restricted Host bridge.

### 5.2 Output Dock states

```text
minimized
→ preview-loading
→ preview-ready
→ editing
→ exporting
→ unavailable / validation-failed
```

The Dock must show:

- file format and path relative to Workspace;
- current revision and source/file/preview digests;
- validation status;
- last changed block/sheet/slide/cell references;
- `Edit`, `Open in system app`, `Download/Reveal`, and `Close` actions;
- a clear distinction between “preview ready”, “file generated”, and “task completed”.

### 5.3 Editing model

首版“可编辑”指受约束的结构化编辑，不是完整 Office WYSIWYG：

- DOCX：选中段落、标题、表格单元格、图片或样式控件后编辑；
- XLSX：选中单元格、区域、行列或图表后编辑值、公式、格式和顺序；
- PPTX：选中 Slide/Shape 后编辑文本、位置、尺寸、顺序和图片；
- PDF：选中 Source 页面元素或通过对话修改，重新导出 PDF；PDF 预览画布本身不直接写 PDF 二进制。

Dock 编辑提交前显示受影响范围，提交后走与对话相同的 `inspect → patch → validate → render` 流程。UI 不能直接写 Workspace 文件。

## 6. Architecture and authority

```text
Renderer UI
  ↓ IPC (validated commands only)
Desktop Host format service
  ↓ Runtime Tool Invocation
Runtime / Harness
  ↓ model decision and continuation
Host Authoring compiler
  ↓
Format Source Store + fixed Renderer
  ↓
Immutable revision bundle + manifest
  ↓
Output projection / Dock preview
```

Authority rules:

- Runtime State Machine remains the only Run Status authority;
- Runtime Tool Invocation remains the only side-effect/recovery authority;
- manifest remains the current Deliverable revision pointer;
- format Source is the only editable content authority;
- office files and previews are derived outputs, never edit authorities;
- Renderer UI never declares success and never mutates Source directly;
- Host must return bounded facts and digests; large content goes to Artifact;
- all external inputs pass schema validation before compilation;
- no format-specific state machine is introduced.

## 7. Source contracts

Each format has a strict canonical Source schema and a smaller model-facing Authoring schema. The Authoring schema may accept safe shorthand such as strings for text and scalar values for cells, but compilation must be deterministic and the result must pass canonical validation.

### 7.1 DOCX source minimum

```ts
type DocxSourceV1 = {
  schemaVersion: 1;
  kind: "docx";
  title: string;
  sections: DocxSection[];
};
type DocxSection = {
  sectionId: string;
  blocks: (Heading | Paragraph | List | Table | Image | PageBreak)[];
  page: { size: "A4" | "A3" | "letter"; orientation: "portrait" | "landscape" };
};
```

Minimum support: headings, paragraphs, lists, tables, local images, page breaks, margins, header/footer text, theme styles and deterministic pagination hints.

### 7.2 XLSX source minimum

```ts
type XlsxSourceV1 = {
  schemaVersion: 1;
  kind: "xlsx";
  title: string;
  sheets: XlsxSheet[];
};
type XlsxSheet = {
  sheetId: string;
  name: string;
  frozenRows?: number;
  frozenColumns?: number;
  columns?: { width?: number; hidden?: boolean }[];
  cells: { address: string; value?: string | number | boolean; formula?: string; style?: CellStyle }[];
  tables?: XlsxTable[];
  charts?: XlsxChart[];
};
```

Rules: formulas are strings validated against the supported formula subset; external workbook references are rejected; cell addresses are canonicalized; merged cells, filters and charts are bounded and deterministic.

### 7.3 PPTX source minimum

```ts
type PptxSourceV1 = {
  schemaVersion: 1;
  kind: "pptx";
  title: string;
  theme: PptxTheme;
  slides: PptxSlide[];
};
type PptxSlide = {
  slideId: string;
  layout: "title" | "content" | "two_column" | "blank";
  elements: (TextShape | ImageShape | TableShape | ChartShape)[];
};
```

All shapes have stable IDs, bounded coordinates and explicit z-order. Off-canvas or overlapping content must be detected by layout validation.

### 7.4 PDF source minimum

PDF source reuses a validated page-layout model or a reference to a validated DOCX/PPTX/XLSX export. The PDF file itself is immutable per revision. PDF export must record source revision, renderer version, page count, embedded-font status and visual validation digest.

## 8. Revision and workspace layout

```text
outputs/
└── quarterly-report/
    ├── manifest.nexora.json
    └── revisions/
        └── 000003/
            ├── source/
            │   ├── document.source.json
            │   ├── workbook.source.json
            │   └── slides.source.json
            ├── files/
            │   ├── quarterly-report.docx
            │   ├── quarterly-report.xlsx
            │   ├── quarterly-report.pptx
            │   └── quarterly-report.pdf
            ├── previews/
            │   ├── docx.html
            │   ├── xlsx.html
            │   ├── pptx.html
            │   └── pdf.html
            ├── assets/
            └── validation.json
```

Constraints:

- revision directories are immutable after commit;
- manifest advances atomically only after all requested representations pass validation;
- a partial format batch returns per-format failure facts and does not claim a complete multi-format deliverable;
- `expectedRevision` and `expectedSourceDigest` are required for patches;
- generated file paths are Workspace-relative and never contain absolute paths;
- history is retained; no automatic deletion in this Feature.

## 9. Tool contracts

The Host adds format tools without changing Runtime contracts:

### `office.create`

Creates one bounded logical Deliverable and one or more requested formats. Input contains `outputDirectory`, `title`, `formats`, and format-specific Authoring payloads. It is idempotent by Invocation and never overwrites an unrelated existing Deliverable.

### `office.inspect`

Reads the current manifest and bounded projection for a selected format. It returns revision, digests, outline, sheet/slide metadata, and exact requested nodes. It never returns an unbounded workbook or presentation.

### `office.apply_patch`

Applies revision-guarded operations such as replace text, set cell, insert row, replace image, update chart series, move slide, or change style. It compiles and re-renders only the requested logical Deliverable revision; unchanged nodes are preserved.

### `office.export`

Generates a requested derived format from the current validated Source, for example PDF from DOCX/PPTX layout. Export is idempotent and reports the source revision it used.

All tools produce bounded facts: Deliverable ID, format, path, revision, source/file/preview digests, changed references, validation and renderer version.

## 10. Validation and safety

Before commit the Host must validate:

- canonical Source Schema and unknown-field rejection;
- stable ID uniqueness and patch target existence;
- Workspace asset existence, type, size and boundary;
- document/workbook/slide budgets;
- formula subset and external-reference rejection;
- page/slide geometry and overlap limits;
- renderer output can be reopened by a parser/library;
- preview digest matches preview bytes;
- generated file digest matches persisted file;
- no macros, scripts, external network references or active content;
- deterministic render repeatability for the same Source and renderer version.

PDF-specific checks include page count, non-empty pages, font fallback warnings and text/image bounds. XLSX-specific checks include sheet-name validity, formula parseability, cell-count limits and no broken chart references. PPTX-specific checks include slide count, shape bounds, readable text size and no off-canvas required content. DOCX-specific checks include package reopen, section/page count and table integrity.

## 11. Error and recovery semantics

- schema rejection: no side effect; return exact leaf paths and a minimal valid example;
- stale revision/digest: no side effect; require inspect before retry;
- missing image/font/resource: no commit for the affected format; report exact Workspace path;
- renderer failure: no success Evidence for that format; preserve prior revision;
- partial multi-format success: each format has explicit status; Completion requires the formats requested by the user;
- repeated identical invalid response: bounded `NO_PROGRESS_DETECTED` remains valid, but repair context must include format, node path and expected shape;
- crash after file write but before manifest commit: startup recovery either adopts a fully validated orphan revision or removes only the bounded uncommitted temporary directory.

## 12. Preview Dock security

- previews are generated by Host, not arbitrary user HTML;
- iframe preview has no Node integration, no preload API, no network, no script and a restrictive CSP;
- preview actions send typed IPC commands only;
- renderer cannot pass arbitrary filesystem paths or shell commands;
- `Open in system app` uses allowlisted Workspace file resolution and the existing Host bridge;
- Office files are never opened inside Electron with privileged handlers;
- downloaded/revealed files are the exact digest-verified revision bytes.

## 13. Implementation phases

### Phase A — shared format foundation

- format registry local to Desktop Host;
- manifest extension for representations;
- shared preview Dock and minimized behavior;
- Source/compiler/renderer validation interfaces;
- no Runtime schema changes.

### Phase B — DOCX

- create, inspect, patch, preview, system open;
- tables, images, pagination and visual regression;
- real Word/LibreOffice reopen test.

### Phase C — XLSX

- workbook/sheet/cell model;
- formulas, styles, tables and charts;
- ExcelJS/openpyxl-compatible reopen and recalculation checks.

### Phase D — PPTX

- slide/layout/shape model;
- image/chart support;
- PowerPoint/LibreOffice reopen and thumbnail regression.

### Phase E — PDF export

- export from validated source;
- page raster/text validation;
- preview and download verification.

Each phase is independently releasable and must not be marked complete by deterministic unit tests alone.

## 14. Acceptance criteria

### User flow

- user selects a Workspace, starts a normal task and receives a real requested file;
- normal Conversation/Coding UI remains intact;
- Output Dock is minimized when no output/file is selected;
- clicking Output expands the right Dock and loads the digest-verified preview;
- clicking Edit exposes only supported structured controls;
- applying an edit creates a new revision of the same Deliverable;
- reopening the Session restores the latest revision and Dock metadata.

### Document correctness

- DOCX opens in Word or LibreOffice without repair prompts;
- XLSX opens in Excel or LibreOffice without repair prompts and formulas remain valid;
- PPTX opens in PowerPoint or LibreOffice without repair prompts;
- PDF opens in standard viewers with expected page count and visible content;
- all requested images and charts appear in the correct locations;
- generated file bytes, source, preview and validation digests agree.

### Incremental editing

- patching one paragraph/cell/shape does not recreate a second logical Deliverable;
- changed references and preserved counts are persisted;
- stale patch is rejected without mutation;
- renderer failure leaves the prior revision usable;
- same Invocation replay returns the same facts.

### Production evidence

- unit tests for each Source and Authoring Schema;
- renderer round-trip tests for each format;
- visual regression snapshots for representative documents;
- Electron UAT for minimized/expanded Dock and system-open action;
- real-provider canary for create → inspect → patch → export;
- crash/restart recovery test;
- security test for traversal, macro/script injection, external links and untrusted preview content;
- `DEVELOPMENT.md` is marked complete only after real files are opened and verified.

## 15. Non-goal boundary for future work

If users later require full-fidelity Office import, simultaneous collaborative editing, comments, tracked changes or browser-native Office editing, that is a separate architecture decision involving an external editor service or dedicated native bridge. This Feature must not pre-build that infrastructure.
