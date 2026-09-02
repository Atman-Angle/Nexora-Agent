# Nexora Office Work Artifacts - Production Feature Spec

**Status:** Proposed production feature  
**Owner:** Desktop Host Office Service  
**Risk:** L4  
**Scope:** DOCX, XLSX, PPTX, and derived PDF

## 1. Feature Contract

Nexora shall let a user select a Workspace, create a normal task, request an office deliverable, inspect it in the existing Desktop flow, make structured semantic edits, and export real `.docx`, `.xlsx`, `.pptx`, and `.pdf` files. Conversation remains the primary surface. The Output/Edit Dock is a projection and intent surface, not a file-writing authority.

This feature is proposed. It must not be represented as implemented by the completed `editable-rich-document-artifact` feature.

## 2. Repository Baseline

The current repository is the architecture source of truth:

- `ARCHITECTURE.md` defines Runtime State Machine, Tool Invocation, Evidence, Artifact, and Completion Gate ownership.
- `packages/runtime/src/store/artifacts.ts` is the content-addressed Runtime Artifact authority.
- `packages/runtime/src/store/run-store.ts`, `packages/runtime/src/execution/runtime-execution.ts`, `packages/runtime/src/completion-gate.ts`, and `packages/runtime/src/runtime.ts` own invocation persistence, recovery, evidence, and Run completion.
- `packages/runtime/src/execution/tool-runtime/index.ts` owns the existing bounded Workspace filesystem tools.
- `apps/desktop/src/deliverables/contracts.ts`, `authoring.ts`, `tools.ts`, `rich-document.ts`, and `projection.ts` implement the current Host-owned rich-document bundle, CAS patching, manifest projection, asset snapshots, and HTML preview.
- `apps/desktop/src/runtime-service.ts` registers Host tools and exposes validated deliverable reads through the existing Runtime/IPC path.
- `apps/desktop/src/main.ts`, `preload.cjs`, `renderer/app.ts`, and `renderer/styles.css` implement the current Electron bridge and Conversation/Activity/Output UI.

The repository currently has no generic reusable Office Deliverable/Revision Store and no Office binary renderer. This feature introduces a Host-level Office format layer by extending persistence patterns proven by `rich-document.ts`; it does not claim that a generic abstraction already exists.

## 3. Current Nexora Capabilities Reused

Reuse Runtime schemas, permissions, approvals, Invocation idempotency, lease/fencing, crash recovery, Evidence, Artifact storage, Completion Gate, Workspace boundary checks, and existing typed IPC. Reuse Host atomic manifest writes, immutable revision directories, CAS checks, asset digesting, orphan recovery, and deliverable projection patterns. Do not duplicate these as an Office workflow engine.

## 4. Product Outcome

The result is a persistent, standard `.docx`, `.xlsx`, `.pptx`, or `.pdf` file with stable revision history, inspectable Source, right-side preview/edit surface, explicit validation, provenance, and repeatable semantic edits without regenerating from the original prompt. The output is not merely chat text, Markdown, temporary HTML, or model-generated conversion code.

## 5. User Flow

```text
Choose Workspace -> New normal task -> Ask for office work
-> Harness selects an Office Tool
-> Runtime validates and executes the Invocation
-> Host commits Source and renders requested Representations
-> Output Dock displays preview and validation
-> User requests or performs a structured edit
-> inspect Source -> apply semantic patch -> commit next revision
-> rerender affected Representations -> preview/open/download
```

If no file is selected, the Dock is minimized. Selecting Output or a file expands it on the right; narrow windows use a bottom-sheet fallback.

## 6. Scope

The initial production scope includes canonical Sources and deterministic generation for DOCX, XLSX, and PPTX; PDF publication derived from a validated Source; bounded inspect and semantic patch; immutable assets; package and visual validation; retryable Representations; right-side Dock; and Runtime Evidence/Completion integration.

## 7. Explicit Non-goals

No direct PDF binary editing, macros/VBA/active content, arbitrary OOXML mutation, formula execution sandbox, full Microsoft Office WYSIWYG clone, collaborative multi-user merge, cloud-drive synchronization, uncontrolled Python/shell/code execution, or new Runtime Office state machine.

## 8. Architecture Boundary

```text
Renderer -> typed IPC -> Desktop Host Office Service
         -> Runtime Tool contract -> Harness -> Runtime
Host Office Store -> Source bundle -> pinned Renderer
                 -> Office files + UX previews
```

Runtime/Harness core Authority is unchanged. Office schemas, compilers, renderers, and persistence live in Desktop Host. Renderer never writes Workspace, SQLite, ArtifactStore, or Office bundles directly.

## 9. Authority Model

- Runtime State Machine is the only Run Status authority.
- Runtime Tool Invocation is the only side-effect, idempotency, and recovery authority.
- Runtime Evidence and Completion Gate remain authoritative for mechanical completion.
- Logical Deliverable is a user-level aggregation only.
- Each editable format has its own canonical Format Source.
- Office binaries and previews are derived Representations.
- `manifest.nexora.json` is a mutable current projection only; historical records are immutable.
- Runtime ArtifactStore is reused for large payloads, reports, and audit content, not as Office Source authority.
- Dock/UI has no write, completion, or Source authority.

## 10. Deliverable, Source, Representation, and Asset Model

```text
Logical Deliverable
└── Deliverable Revision N
    ├── DOCX Format Source (optional)
    ├── XLSX Format Source (optional)
    ├── PPTX Format Source (optional)
    ├── Page Layout Source (optional)
    ├── immutable assets
    ├── Representation Attempts
    ├── previews
    └── validation reports
```

DOCX, XLSX, and PPTX never assume a shared universal Source. A conversion creates and validates the target format's own Source. A Representation identifies its source format, source digest, renderer version, Attempt, file digest, preview digest, and validation references.

## 11. Revision Semantics

A Deliverable Revision is first a committed immutable Source snapshot, not a promise that every requested file rendered successfully. A revision may contain any subset of Format Sources. Example: revision 3 has DOCX=A, XLSX=B, PPTX=C; a DOCX-only edit creates revision 4 with DOCX=A' and immutable references to B and C.

Source commit requires Source Validation, verified asset snapshots, a durable immutable bundle, and atomic manifest advancement. Representation generation occurs after commit. A failed renderer does not remove successful Representations or invalidate the Source revision. Retrying the same Source/Representation appends a new immutable Attempt and updates only the manifest projection; it does not create a new Source revision.

Representation status is evaluated against the effective Source and dependency lineage, not only the numeric Deliverable Revision. `ready` means the latest successful Attempt passed required validation and its `sourceFormat`, `sourceDigest`, required asset digests, required intermediate Representation digests, renderer/export versions, and compatibility options match the current effective Source. `failed` means the current Source Attempt failed. `pending` means generation or validation is incomplete. `stale` means the historical file may still be valid, but its provenance no longer represents the current effective Source or dependencies. `absent` means no Attempt exists.

When a Source changes, all Representations depending on that Source become `stale`; their historical Attempts remain readable by selecting the historical Deliverable Revision. Unchanged formats are not mechanically invalidated: if their effective Source digest, assets, dependency lineage, and renderer compatibility still match, their existing Representation remains current `ready`. A stale Preview follows the stale Representation and cannot satisfy current required-format completion. Session restore recomputes status from manifest plus immutable provenance and never trusts a stale cached flag. PDF staleness is derived from both its upstream Source digest and any intermediate Office Representation digest.

For a multi-format request, any required format that is failed or incomplete prevents successful Run Completion. Optional format failure is visible and may allow completion under the existing Completion Gate contract.

## 12. Asset Semantics

Before Source commit, every referenced Workspace asset is boundary-checked, read, size-limited, media-type checked, and hashed. The revision stores a content-addressed snapshot at `revision/assets/<digest>.<ext>`. Source stores stable asset identity, digest, media type, and revision-relative reference, never only a mutable Workspace path. Historical revisions remain rebuildable after the original file changes or disappears.

Retention is transitive. Any Source or Asset reachable from a current or historical Deliverable Revision through direct or transitive immutable references is retained. This feature adds no Office garbage collection, reference-counting GC, compaction, or per-object cleanup. Revision history, referenced Sources, referenced Assets, Representation Attempts, previews, and validation reports remain retained. Deleting an entire Deliverable uses existing Workspace deletion semantics and is outside per-object retention guarantees.

## 13. Provenance

Every Representation traces:

```text
Logical Deliverable -> Deliverable Revision -> Format Source
-> Source revision/digest -> renderer version -> render/export Invocation
-> asset digests -> file/preview digests -> validation reports
```

PDF additionally records its complete dependency lineage. For an Office source:

```text
Logical Deliverable -> Deliverable Revision -> Canonical Source
-> Source digest -> Office renderer version -> intermediate Office Representation digest
-> PDF exporter version -> export Invocation -> PDF digest -> validation reports
```

For Page Layout Source, the lineage is `Page Layout Source -> PDF renderer version -> export Invocation -> PDF digest`; no fictitious intermediate Office file is created. Source provenance identifies the editable Source and its assets. Representation dependency lineage identifies the exact derived files, renderer/export versions, invocations, and digests used to produce a Representation. This feature reuses Runtime Artifact/Evidence references and digests; it does not create a second generic provenance graph.

## 14. Format Capability Matrix

| Format | Edit authority | Primary Representation | Preview | PDF relationship |
|---|---|---|---|---|
| DOCX | DOCX Source | OOXML package | paginated HTML/raster | may publish PDF |
| XLSX | XLSX Source | OOXML workbook | bounded grid/raster | may publish PDF |
| PPTX | PPTX Source | OOXML deck | slide projection/raster | may publish PDF |
| PDF | upstream Source | publication PDF | page raster/text projection | never direct patch authority |

## 15. DOCX Source Contract

The Source supports stable IDs for document, sections, headings, paragraphs, lists, tables, images, page breaks, headers/footers, theme styles, and margins. It enforces bounded text, nesting, style references, table dimensions, valid assets, and deterministic ordering. Output must reopen in a conforming OOXML reader and contain no active content.

## 16. XLSX Source Contract

The Source supports workbook, sheets, stable cell identities/addresses, scalar values, a declared formula subset, styles, row/column dimensions, freeze panes, tables, filters, and static charts. Sheet names, addresses, formulas, and number formats are canonicalized. External links, macros, unsupported functions, and active content are rejected. All supported formulas are structurally validated by Host and recalculated by the pinned bundled LibreOffice Calc process before the XLSX Representation becomes `ready`.

## 17. PPTX Source Contract

The Source supports presentation, slides, layouts, text/image/table/chart shapes, coordinates, dimensions, and z-order. Every element has a stable ID. Source Validation rejects invalid geometry, unreadable text constraints, unsupported media, and unbounded shape counts. Visual Validation checks clipping, overlap, overflow, and font fallback.

## 18. PDF Export Model

PDF is a Derived Publication Representation. It is exported only from a validated DOCX/XLSX/PPTX Source or validated Page Layout Source. “Edit PDF” means `inspect source -> patch source -> validate -> re-export PDF`. No PDF binary patch authority exists.

## 19. Tool Contracts

The initial release exposes only four Runtime tools.

### `office.create`

Creates a Logical Deliverable and one or more initial Format Sources. Inputs include Workspace-relative destination, title, requested/required formats, and format-specific Authoring DTOs. It commits Source before rendering.

### `office.inspect`

Returns a bounded Source projection, current revision, Representation statuses, validation summaries, provenance, changed-node metadata, and exact Artifact refs for larger payloads. It never returns unbounded files inline.

### `office.apply_patch`

Applies bounded semantic operations to one canonical Format Source after CAS checks. It commits a new Deliverable Revision, preserving immutable unmodified Source references and assets, then rerenders affected Representations.

### `office.export`

Requests or retries a Representation for an existing Source revision. It appends an immutable Attempt and may update the current manifest projection. It never edits Source and never creates a Source revision solely for retry.

Format differences stay in Host DTOs, compilers, validators, and renderers, not in a proliferation of Runtime tools.

## 20. Patch and Inspect Semantics

`office.apply_patch` is a Source-level semantic patch. It does not physically patch OOXML packages and does not promise minimal binary diffs. “Preserve unchanged” means stable IDs and semantic Source nodes remain unchanged; full deterministic package rerender is allowed.

Typed operations cover DOCX node/text/table/style edits; XLSX cell/formula/style/row/column/table/chart edits; and PPTX slide/shape/text/image/order edits. PDF operations target its upstream Source.

## 21. Concurrency and CAS

Every patch includes `deliverableId`, `expectedDeliverableRevision`, `format`, `expectedSourceRevision`, `expectedSourceDigest`, and typed operations. Stable target identity is mandatory (`nodeId`, `sheetId` plus cell address, `slideId`, etc.). Where a node may remain present but change meaning, an expected value/hash or anchor is required. Parent tokens and a second concurrency protocol are not introduced unless repository evidence shows existing CAS is insufficient.

## 22. Workspace Persistence

```text
<workspace>/deliverables/<deliverable-id>/
  manifest.nexora.json
  revisions/<deliverable-revision>/
    sources/<format>/<source-revision>/source.json
    assets/<digest>.<ext>
    representations/<format>/attempts/<attempt-id>/file.<ext>
    previews/<format>/<attempt-id>/...
    validation/<attempt-id>/source.json
    validation/<attempt-id>/package.json
    validation/<attempt-id>/visual.json
    provenance/<attempt-id>.json
```

Historical Source, assets, files, previews, Attempts, validation, and provenance are immutable. Only the manifest/current projection is mutable and atomically written. The exact layout may reuse rich-document conventions, but must preserve these boundaries and immutable cross-revision Source references.

## 23. Output, Preview, and Edit UX

The Dock extends the current Desktop Output view. It shows format, path, Deliverable Revision, Source/Representation status, renderer version, source/file/preview digests, all validation phases, warnings/errors, changed nodes/sheets/slides/cells, and actions: Edit, Open in system app, Reveal/Download, Retry. `Open in system app` delegates to the Windows default file association for the file extension; it does not force LibreOffice and does not require Nexora to select the user's Office application.

HTML, Grid, Slide, and raster previews are UX projections only. Editing is structured rather than a full Office clone. UI sends typed IPC intents through the existing bridge; Host validates and invokes the Runtime tool path. No iframe or renderer code receives filesystem authority.

## 24. Renderer and Parser Dependency Decisions

The repository does not currently include Office libraries or a Windows packaging configuration. The frozen production dependency decision is:

```text
DOCX generation                 -> docx (pinned version)
DOCX/XLSX/PPTX package reopen   -> yauzl + fast-xml-parser (pinned versions)
XLSX generation                 -> ExcelJS (pinned version)
XLSX formula structural check   -> Host-owned supported-formula grammar and reference validator
XLSX recalculation              -> bundled LibreOffice Calc headless, pinned version
PPTX generation                 -> PptxGenJS (pinned version)
Office visual rendering/export  -> bundled LibreOffice headless, pinned version
PDF structural validation       -> pdf-lib (pinned version) plus Host page/resource checks
PDF page/raster validation      -> pdfjs-dist + @napi-rs/canvas (pinned versions) in the Host worker
```

LibreOffice is a **bundled dependency** distributed inside the Windows Desktop package under an application-controlled resources directory. Users do not install Microsoft Office or LibreOffice. The Host resolves an absolute executable path from packaged resources; it never depends on system `PATH`. The external process is launched through the existing controlled child-process/supervisor boundary with `windowsHide`, bounded stdout/stderr, timeout, memory/output budgets, and a temporary job directory. A renderer crash cannot crash Desktop, modify Source, or make an unvalidated file current. Every output is reopened and validated by Host before manifest advancement.

Bundled LibreOffice is Nexora's internal headless backend for rendering, XLSX recalculation, PDF export, and automated validation. It is not user-facing Office software, is not the only compatibility standard, and is not required for the user to open or edit the resulting files. The formal compatibility targets for DOCX, XLSX, and PPTX include supported Microsoft Word, Microsoft Excel, and Microsoft PowerPoint releases. Nexora always delivers standard files that can be opened through the operating system's normal application associations.

The initial Microsoft Office compatibility baseline is the current Microsoft 365 Desktop Apps release on a Nexora-supported Windows version. Each Nexora release records one exact tested Microsoft 365 update channel, product version/build, Windows version/build, architecture, and test date in its UAT evidence. Office 2021, Office 2024, additional channels, and older builds are outside the initial compatibility claim until separately added to the tested matrix.

Renderer versions are pinned in the repository lockfile and release manifest. CI, UAT, and production use the same LibreOffice major/minor and Node package lockfile. A renderer upgrade creates new Representation Attempts and never rewrites historical Attempts. License approval is required for all pinned packages and bundled LibreOffice before release.

Determinism is defined at three levels. Canonical Source JSON and its digest are byte-deterministic. Host-generated OOXML is normalized for timestamps, core metadata, stable IDs, relationship ordering, ZIP entry ordering, and declared render options where the selected libraries expose reliable control; Package Validation also computes a normalized semantic digest over canonicalized OOXML parts. Persisted file digest always identifies the exact stored bytes, but LibreOffice-produced XLSX/PDF bytes are not required to repeat byte-for-byte because producer metadata and document IDs may vary. For those outputs, the production guarantee is identical canonical Source and assets plus pinned versions/options produce the same normalized package semantics, recalculated values, page count, and visually equivalent raster result within fixed comparison tolerances. File digest is integrity evidence, not the sole determinism claim.

**Platform packaging blocker:** prove the bundled LibreOffice distribution and pinned PDF.js/Canvas worker can be packaged, launched by absolute path, timed out, and isolated on a clean supported Windows machine with no Microsoft Office or LibreOffice installed. Pass criteria: the signed Desktop installer contains the pinned executable and required runtime files; a minimal probe completes and fails cleanly on timeout/crash; Desktop remains alive; stdout/stderr and output budgets are enforced; and CI/UAT use identical LibreOffice binary hashes and lockfile versions. Failure blocks every Office production scope and forbids silent fallback to system applications or `PATH`.

**Per-scope production gates:** Scope A additionally requires DOCX generation, reopen, package validation, and visual rendering with the pinned stack. Scope B additionally requires XLSX supported-formula validation, bundled Calc recalculation, cached-value inspection, and XLSX visual validation. Scope C additionally requires PPTX generation, reopen, package validation, and slide visual rendering. Scope D additionally requires PDF export from a validated upstream Representation, PDF.js raster validation, and complete PDF lineage. A scope cannot be released until its own gate passes; later-scope gates are not prerequisites for earlier scopes beyond the shared platform packaging blocker.

## 25. Validation Model

```text
Source Validation -> Package Validation -> Visual Validation
```

Source Validation checks schema, stable IDs, formulas, geometry, budgets, styles, and asset digests. Package Validation reopens files, checks OOXML relationships/media/content types, rejects active content, and verifies parser consistency. Visual Validation renders trusted pages/slides/sheets and checks pagination, clipping, overflow, overlap, missing glyphs, and font fallback.

XLSX formula policy is fixed: the Host validates only the declared formula subset and valid intra-workbook references; external workbook references and unsupported functions are errors. For every XLSX Representation and every XLSX-to-PDF export, the generated workbook is opened and saved once by the bundled pinned LibreOffice Calc headless process with recalculation enabled. The recalculated workbook bytes and digest are the final XLSX Representation; its Attempt records both pre-recalculation and final digests. Formula cached values shown in Grid Preview and used for PDF export come only from that validated recalculated workbook. Recalculation failure is a blocking Representation error, never a warning. No formula result is promised for an unsupported formula because such a Source is rejected before commit.

Each phase is `not_run | passed | passed_with_warnings | failed`. An issue has `phase`, stable `code`, `severity: warning | error`, optional `target`, and user-readable `message`.

## 26. Warning and Error Semantics

Source blocking errors prevent Source commit and manifest advancement. Package/Visual blocking errors fail only that Representation; Source and other Representations remain. Warnings permit `ready` with `passed_with_warnings`, visible in Dock and Evidence. Required Representation failure blocks Completion; optional failure is explicit but may not block Completion.

## 27. Idempotency

Create, patch, export, and retry use Runtime Invocation operation identity. Identical operation/input replay returns the recorded outcome; conflicting reuse is rejected. Manifest writes are atomic. Attempts are never overwritten, and physical paths derive from immutable Attempt identity. Unknown non-idempotent effects follow Runtime recovery rules and are never blindly replayed.

## 28. Error Semantics

Errors fail at the earliest violated boundary: invalid DTO, Workspace escape, CAS mismatch, missing asset, Source Validation, renderer timeout, package invalidity, visual failure, unsupported capability, or budget exceeded. Errors identify the affected Source revision/Attempt and whether retry is safe. No default or fallback path may conceal corruption.

## 29. Crash and Restart Recovery

Runtime handles Tool crash, replay, unknown effect, leases, and fencing. Host reports only domain facts: Source complete/incomplete, asset digest match, Attempt complete/incomplete, file digest match, and validation completeness.

If Source commit crashes, a fully validated orphan revision may be recovered; only bounded uncommitted temporary data may be cleaned. A legal committed Source is never deleted. If rendering crashes, Source remains valid and the Attempt is incomplete/failed; retry appends a new Attempt on the same Source revision. No Office-private recovery engine is created.

## 30. Security

All paths are Workspace-relative and checked against active project/workspace roots. Assets, files, previews, and parsers are size/time limited. Renderer processes are sandboxed where supported, do not execute macros or active content, and do not accept arbitrary commands from model or UI. Electron retains `contextIsolation`, `nodeIntegration: false`, `sandbox: true`, and navigation/new-window restrictions. Secrets and uncontrolled model code are excluded from artifacts and provenance. MIME/type and extension mismatches are rejected.

## 31. Resource Budgets

Initial production limits, increased only after benchmark evidence:

- DOCX: 50 sections, 500 blocks, 20,000 table cells, 100 images, 2 MiB Source.
- XLSX: 20 sheets, 100,000 populated cells, 50 tables, 20 charts, 100 columns/sheet, 4 MiB Source.
- PPTX: 100 slides, 100 shapes/slide, 100 images, 4 MiB Source.
- PDF: 100 pages, 20 MiB output.
- Assets: 10 MiB each, 50 MiB total per revision.
- Patch: 32 operations, 16 inserted nodes/rows/shapes per operation.
- Inspect: 64 KiB or 100 projected nodes/cells/elements; larger content uses Artifact refs.
- Preview: bounded lazy page/slide loading; no unbounded iframe content.

The LibreOffice process receives the same operation deadline and output/asset budgets as the Host Attempt. Its stdout/stderr capture is bounded; excess output is truncated into diagnostics and cannot become a Source or Representation.

## 32. Release Scopes

- Scope A: DOCX Source, four tools, immutable assets, package validation, Dock projection.
- Scope B: XLSX Source, declared formula subset, recalculation policy, grid/visual validation.
- Scope C: PPTX Source, slide rendering, overlap/font validation.
- Scope D: PDF publication, source-directed PDF editing, retry, and multi-format completion.

These are product release boundaries, not a coding walkthrough or permission to alter Runtime Authority.

## 33. Production Acceptance Criteria

1. A normal task creates every supported required format as a real reopenable file without Microsoft Office installed.
2. Source revision, Attempt, renderer version, digests, assets, and three validation phases are inspectable.
3. Representation failure preserves Source and all other successful Representations.
4. Retrying a Representation does not create a Source revision.
5. Semantic patch preserves unchanged stable IDs/content and rejects stale or ambiguous targets.
6. PDF edits route through upstream Source and re-export.
7. Restart recovery is idempotent and never deletes committed Sources.
8. Required-format failures prevent Runtime Completion; warnings remain visible without falsely failing completion.
9. Dock minimizes when unused, opens on selection, supports edit/open/reveal/retry, and has no write authority.
10. Existing rich-document artifacts and ordinary coding flows remain compatible.
11. `ready`, `failed`, `pending`, `stale`, and `absent` are recomputed from effective Source/dependency provenance after restart; stale history remains openable but never satisfies current required-format completion.
12. A PDF report exposes its upstream Source, intermediate Office Representation digest when present, exporter version, Invocation, and final PDF digest.
13. XLSX `A1=100`, `A2=200`, `A3=SUM(A1:A2)` is recalculated to cached value `300` by the pinned bundled LibreOffice path before XLSX or PDF is published.
14. A clean Windows machine without Microsoft Office or LibreOffice installed passes the bundled-renderer blocker criteria.
15. A revision that transitively references an older Source or Asset can still be inspected, rerendered, and validated after restart.
16. `Open in system app` uses the Windows default association and does not force or require LibreOffice.
17. The generated DOCX, XLSX, and PPTX satisfy the supported Microsoft Word, Excel, and PowerPoint compatibility UAT without repair prompts.

## 34. Required Test, UAT, and Canary Evidence

Required evidence includes Source/patch schema and property tests; deterministic compiler/render snapshots; OOXML reopen and relationship/media tests; PDF parser tests; visual raster checks; asset mutation/deletion rebuild tests; CAS races; duplicate Invocation/retry; crash/restart/orphan recovery; traversal/permission tests; and multi-format Completion Gate tests.

UAT covers create, inspect, edit, retry, open/reveal, optional-versus-required output, warning display, narrow-window Dock fallback, Windows default-association opening, and ordinary coding regression. A licensed, supported Windows test environment with Microsoft Word, Excel, and PowerPoint must additionally verify: DOCX opens without a repair prompt and its primary text, images, tables, and pagination are usable; XLSX opens without a repair prompt and its formulas, recalculated cached values, tables, and charts are correct; PPTX opens without a repair prompt and its primary slide layout, text, images, and charts are correct. This Microsoft Office UAT environment is a production compatibility test environment, not a terminal-user prerequisite. LibreOffice automated validation alone cannot establish Microsoft Office fidelity. Canary records renderer version, platform, file digests, validation, duration, and resource use. Preview alone is not evidence of Office fidelity.

The acceptance suite must include: (A) DOCX A ready plus PDF ready, then DOCX A' makes both old Representations stale; (B) DOCX A' with unchanged XLSX B keeps XLSX current ready without mechanical rerender; (C) complete PDF intermediate-file lineage; (D) XLSX recalculation and cached-value inspection; (E) renderer crash after Source commit with retry on the same Source revision; (F) clean Windows bundled-renderer execution with no Microsoft Office or LibreOffice installed; (G) restart of a revision with transitive Source/Asset references followed by inspect, rerender, and validation; and (H) licensed Microsoft Office compatibility runs for DOCX, XLSX, and PPTX as specified above. Clean Windows without Office must still complete Nexora's own generation, validation, and PDF export path.

## 35. DEVELOPMENT.md Completion Gate

This feature may be marked complete only when `DEVELOPMENT.md` names it as current, records accepted scope/risk, links actual Invocation/Evidence/Completion and Host artifact evidence, records dependency/license/deployment decisions, and cites automated, UAT, and canary evidence. The completed rich-document feature remains historical and outside this gate.

## 36. Future Boundary

Future styles, formulas, charts, themes, collaboration, or formats require new Source contracts and validation evidence. They must preserve Runtime as sole Run Status/Invocation/Evidence/Completion authority; Host as Office compiler/renderer owner; immutable Source/assets; derived-only Representations; and the converged Tool Surface. Preview or derived binaries may never become edit authority, and no second Office workflow/state engine may be introduced.

## 37. Freeze Declaration

```yaml
architecture_frozen: true
production_spec_ready: true
renderer_decision: bundled-pinned-libreoffice
office_installation_required: false
source_gc: disabled
representation_retry_creates_source_revision: false
run_completion_authority: runtime-completion-gate
```

The clean-Windows bundled-renderer spike is a release gate for implementation, not an unresolved product choice. No later implementation work may substitute a system Office installation, PATH lookup, direct PDF patching, a second provenance graph, or a second Runtime Authority without a separately authorized architecture change.
