# Nexora Office Capability - Production Feature Spec

## Status and baseline

```yaml
capability: office
feature: office-capability
status: proposed
owner: Host capability, executed through existing Runtime/Harness
risk: L4
runtime-contract-change: not required for the product boundary
depends-on: editable-rich-document-artifact
```

This specification defines the user-visible capability and its completion boundary. It does not select a document library, serialization format, renderer, process model, or tool payload shape. Those are implementation decisions for a later authorized feature.

The current repository baseline is an editable Host-owned `rich_document` Deliverable. `apps/desktop/src/deliverables/tools.ts:37` registers exactly `document.create`, `document.inspect`, and `document.apply_patch`; `apps/desktop/src/deliverables/contracts.ts` validates bounded headings, paragraphs, lists, tables, metrics, callouts, images, charts, columns and themes. `apps/desktop/src/deliverables/rich-document.ts:78` creates immutable revisions, `:128` applies revision-guarded patches, and `:162` inspects the current revision. E135 proves the path end to end in `tests/runtime/e135-editable-rich-document-artifact.test.ts:117` through `:324`.

The baseline is not yet Office format support: the current tool contracts explicitly list DOCX, PDF, XLSX and PPTX as non-goals (`apps/desktop/src/deliverables/tools.ts:44`, `:149`).

## 1. Outcome

In an ordinary Nexora Session, a user can ask for an office result in outcome language:

> Use the files in this Workspace to make a formal report, analysis workbook, presentation, or PDF.

The existing Agent decides whether to read files, search, calculate, inspect an existing Deliverable, create a new representation, or apply a bounded revision. The user does not enter a separate Office Agent and does not need to name tools or a rendering technology.

The successful chain is:

```text
User goal
-> existing Agent Loop and available capabilities
-> Office capability when a real office artifact is required
-> committed office artifact in Workspace
-> Runtime Evidence and Completion Gate
-> Desktop Output projection and file delivery
```

The result is a real, usable standard file, not Markdown, chat text, a screenshot, or an uncommitted temporary file.

## 2. Capability boundary

The capability must cover one general logical Deliverable and its supported representations, with stable identity and revision history:

- create a new office artifact from user-provided or Workspace facts;
- inspect a bounded current representation or selected regions;
- modify an existing artifact by semantic targets, preserving unspecified content;
- continue editing in later turns and after Session restart;
- export a validated source into another supported representation;
- expose the resulting file, revision, validation state and Workspace-relative path.

The initial product boundary includes DOCX, XLSX, PPTX and PDF. “Supported” means the format can be produced, reopened by an appropriate parser/viewer, previewed or delivered, and revised through the supported source model. PDF is primarily a publication/export representation; editing changes its editable source and produces a new PDF revision.

The capability does not promise full-fidelity import of arbitrary Office files, WYSIWYG parity with Microsoft Office, collaborative editing, comments or tracked changes, macros/VBA/ActiveX/OLE, automatic external-link execution, OCR/layout reconstruction, unrestricted formulas or arbitrary executable template/code input.

## 3. Generalization and composition

Office is a general capability, not a catalogue of business workflows. The same bounded operations must support reports, meeting minutes, grant applications, resumes, operating analyses, forecasts, sponsor proposals and unfamiliar user-defined tasks without adding scenario-specific code or templates.

It composes naturally with existing capabilities:

| User need | Existing capability contribution | Office contribution |
| --- | --- | --- |
| “Use these PDFs and CSVs” | Workspace/files/search/read facts | assemble and publish a document, workbook or deck |
| “Calculate the trend” | coding or deterministic computation tools | place values, tables and charts into the artifact |
| “Update last month’s report” | Session continuity and Deliverable projection | inspect current revision, patch named content, preserve the rest |
| “Make a PDF from the deck” | existing Run and artifact delivery | export the validated current source |
| “Open the result” | Desktop Host bridge and Workspace boundary | provide the exact committed file |

The Agent remains free to answer in chat when no office artifact is required.

## 4. Lightweight default execution

The default path is:

```text
understand goal -> gather required facts -> create/modify -> mechanical commit checks -> deliver
```

The Agent must not automatically reread and semantically critique an entire artifact after every successful write. Additional inspect or repair is required only when the user asks for review/verification, a continuation edit needs current facts, generation or delivery fails, or the task itself contains validation requirements. Low-cost checks such as file existence, parseability, digest agreement and safe preview generation belong to the implementation boundary and do not constitute a second model review.

## 5. Authority and lifecycle

No second Agent Loop, Planner, Runtime, Completion system, Context system, Recovery system or Office state machine is introduced.

- Harness remains the sole model/provider loop. `packages/harness/src/agent.ts:44` is the composition entry point.
- Runtime State Machine remains the only Run Status authority.
- Runtime Tool Invocation remains the authority for side effects, idempotency, approval and recovery.
- The editable source/manifest is the logical Deliverable revision authority; generated office files and previews are derived outputs.
- Evidence and Result remain the only completion basis. `packages/runtime/src/completion-gate.ts:21` verifies evidence, artifact existence, required tools and completed progress.
- Desktop remains a projection and bridge. `apps/desktop/src/runtime-service.ts:440` configures the Agent with Host tools; the Renderer does not write Core Store or files directly.

Every create, patch and export must therefore produce bounded invocation facts, persist digests and remain attributable to the Run and Workspace that performed it.

## 6. Create, modify, continue, export

Create must produce one logical Deliverable with at least one requested supported representation. It must not overwrite an unrelated existing Deliverable and must be idempotent for the same Invocation.

Modify must require a current revision identity (or equivalent optimistic guard), target stable semantic nodes such as a paragraph, table region, cell/range, slide/shape or image, and commit a new immutable revision. Unspecified nodes remain unchanged. A stale revision is rejected without mutation.

Continue-edit must work from persisted Session/Workspace facts after restart. The Agent can inspect only the bounded outline or exact regions needed for the next edit; large bodies belong in Artifacts.

Export must identify the source revision used. A failed representation does not become a successful output, and a successful representation is not silently rolled back because another requested representation failed. Completion must reflect the formats the user actually requested.

## 7. Failure, recovery and security

The user-visible result must distinguish at least: success, partial success, unsupported capability, invalid input, missing data/resource, generation failure, file-write failure, timeout, cancellation, retryable failure and non-retryable failure. A final model sentence cannot turn a missing or corrupt file into success.

Required behavior:

- validate all external input before side effects; reject unknown or ambiguous fields;
- enforce Workspace path and symlink boundaries for source files, assets and outputs;
- bound file size, page/sheet/slide/cell counts, CPU, memory, duration and child processes;
- reject macros, scripts, active content, unsafe external references and arbitrary executable payloads;
- keep secrets out of source, artifacts, previews and generated files;
- use existing Approval for protected writes or system-open actions;
- on crash before manifest commit, recover only a fully validated bounded temporary revision or discard that temporary revision, preserving the prior revision;
- never automatically replay a non-idempotent operation with unknown effect;
- make cancellation terminate owned work and leave the last committed revision usable;
- serve previews through the existing sandboxed Desktop path with no privileged renderer access or arbitrary network/script execution.

These requirements extend existing protections rather than creating an Office-specific security authority. Current rich-document evidence includes traversal rejection and inert CSP validation (`apps/desktop/src/deliverables/rich-document.ts:669`, `:749`; E135 `:174`).

## 8. Desktop user effect

The normal Conversation and activity view remains primary. When an output exists, Desktop projects its metadata and provides a preview/open/download action through the existing Output surface (`apps/desktop/src/renderer/app.ts:202`, `:226`, `:970`). Office support must add format-aware metadata without creating a parallel Session or Run view.

The user can see: format, Workspace-relative path, current revision, validation state, and whether the file is preview-ready, generated, or the task is completed. Selecting an output may open a preview or the system application; closing the preview never deletes the artifact.

## 9. Production acceptance

The Feature is complete only when all of the following are demonstrated with real Workspace files and persisted Runtime evidence:

1. A normal Session can complete novel DOCX, XLSX, PPTX and PDF tasks without scenario-specific workflow code.
2. Each requested file opens in a standard viewer/editor without repair prompts and preserves the requested structural/content elements supplied to the Office capability, without requiring a default post-generation semantic review.
3. Create -> inspect -> targeted patch -> restart -> further patch preserves the same logical Deliverable and reports changed and preserved regions.
4. Stale patch, invalid input, traversal, unsafe content, timeout, cancellation, renderer failure and partial format failure produce truthful non-success semantics and no false Completion.
5. Replaying an idempotent Invocation returns the same facts; unknown non-idempotent effects are not replayed automatically.
6. Desktop preview/open/delivery uses digest-verified committed bytes and cannot access arbitrary paths or privileged APIs.
7. Tests include schema/contract, renderer round-trip, crash/restart, security, Desktop UAT and at least one real-provider canary spanning creation and continuation.

## 10. Capability gaps in the current repository

The following are real gaps, not assumptions about implementation:

- Current Deliverable contracts are `rich_document` only; no DOCX/XLSX/PPTX/PDF representation contract exists (`apps/desktop/src/deliverables/contracts.ts`).
- Current tools are limited to create, inspect and block-level patch and explicitly exclude the four Office formats (`apps/desktop/src/deliverables/tools.ts:44`).
- Current renderer and preview are deterministic HTML, not standard Office package generation or PDF export (`apps/desktop/src/deliverables/rich-document.ts:236`, `:669`).
- Desktop projection currently understands rich-document facts; format-specific open/download/preview metadata and representation selection are absent (`apps/desktop/src/deliverables/projection.ts`).
- E135 validates rich-document behavior only. There is no real-format round-trip, Office parser/viewer, export, formula, slide-layout or multi-representation evidence in the current test inventory.
- Current `DEVELOPMENT.md` explicitly records DOCX, PDF, XLSX and PPTX as out of scope and says later formats require separately authorized Features.

The minimum next feature work is therefore Host capability work plus tests and Desktop projection, while preserving the existing Harness/Runtime contracts and Completion authority. Runtime or public contract changes should be opened only when a concrete gap cannot be solved through existing Tool, Artifact, Approval, Workspace and Evidence ports.

## Non-goal decision

This document defines what “Office capability complete” means. It deliberately leaves library choice, source schema details, renderer architecture, process isolation mechanism and file layout to a subsequent implementation plan informed by the concrete format gaps and the repository's existing authority boundaries.
