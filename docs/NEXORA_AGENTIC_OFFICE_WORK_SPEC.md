# Nexora Agentic Office Work - Production Architecture / Feature Spec

**Status:** Proposed replanning baseline  
**Architecture status:** repository-grounded, not implemented  
**Owner:** Desktop Host + Harness integration  
**Product target:** agentic office work, not template-driven file generation

## 1. Repository Findings

The repository already contains a general Agent Loop. `packages/harness/src/agent-loop.ts` implements the semantic turn cycle: bounded decision context, model response parsing, plan control, skill selection, Runtime tool compilation, repair, replan, and finish proposal. `packages/harness/src/agent.ts` wires the loop to Runtime ports and optional Skill catalog.

Runtime owns mechanical authority. `packages/runtime/src/execution/runtime-execution.ts` validates tool input, approval, invocation identity, idempotency, leases/fencing, execution, artifact capture, and recovery. `packages/runtime/src/completion-gate.ts` validates evidence, required checks, unresolved effects, and completion; it never calls a model.

Workspace tools already exist in `packages/runtime/src/execution/tool-runtime/index.ts`, including bounded filesystem read/list/search/write/patch and controlled process execution. Process execution captures bounded output into the existing ArtifactStore and terminates process trees on cancellation or timeout.

Harness already has planning and context infrastructure in `packages/harness/src/planning.ts`, `prompt.ts`, `context/*`, and `working-context.ts`. Skill discovery and trust/digest checks exist in `packages/harness/src/skills.ts` and the documented Skill contract. Skills are strategy/instruction data, not permissions or tools.

Desktop integrates Runtime through `apps/desktop/src/runtime-service.ts`, `runtime-worker.ts`, `runtime-worker-client.ts`, `main.ts`, and `preload.cjs`. The renderer is a projection of Conversation, Activity, Evidence, and Output state. It cannot access Runtime stores directly.

The current rich-document capability is Host-owned in `apps/desktop/src/deliverables/contracts.ts`, `authoring.ts`, `tools.ts`, `rich-document.ts`, and `projection.ts`. It proves immutable revision bundles, asset snapshots, manifest validation, CAS patching, and HTML preview for a custom rich document. It is not a generic Office engine and does not generate DOCX/XLSX/PPTX/PDF.

The current package manifests contain TypeScript, Vitest, Electron, Zod, Runtime/Harness packages, and SQLite support, but no Office generation libraries, Office parser, LibreOffice package, Electron release configuration, or production Office sidecar. MCP is described as a future/non-current extension in `ARCHITECTURE.md`; it is not assumed available to this feature.

## 2. Current Agent Execution Model

The real current flow is:

```text
User Input
 -> Runtime Run / Task Contract
 -> Harness buildDecisionContext
 -> Provider decision
 -> parseModelResponse
 -> optional Plan / Skill control
 -> Runtime Tool Action
 -> Invocation + Worker execution
 -> normalized facts / Artifact / Evidence
 -> next bounded context
 -> repair, replan, or finish proposal
 -> Runtime Completion Gate
```

This is already an agent loop because the model can choose tools, inspect observations, revise a plan after authoritative failure, and continue until the deterministic gate accepts or blocks completion. The model does not own Run status, Plan persistence, Invocation, Evidence, or completion.

## 3. Existing Capabilities Reusable

Office work must compose the following existing capabilities rather than create business-specific workflows:

- Workspace-relative filesystem read/list/search/write/patch;
- controlled process execution and managed process supervision;
- Runtime ArtifactStore for large payloads, diagnostics, and reports;
- Invocation idempotency, approval, cancellation, timeout, lease/fencing, and recovery;
- Evidence and Completion Gate;
- Harness Plan, repair, context eviction, continuation, and provider transport;
- Skill catalog and digest-verified instruction loading;
- Desktop Conversation, Activity, Output projection and typed IPC;
- Host rich-document persistence patterns for immutable bundles, asset snapshots, CAS, and previews.

## 4. Critical Gaps

### Agent/Harness gaps

No Office-specific gap requires a second Agent Loop. The required gap is a bounded capability catalog and prompt descriptors that let the existing loop discover Office capabilities and observation contracts.

### Tool/capability gaps

There are no production Office Source/compile/render/inspect/validate capabilities. Existing generic filesystem tools can move files but cannot guarantee Office semantics, provenance, or validation.

### Code execution gaps

Controlled process execution exists, but there is no Office Capability SDK, code-mode policy, or sandboxed ephemeral execution contract that restricts generated code to approved capabilities.

### Observation gaps

Current Output is mainly rich-document HTML. There is no bounded DOCX structure/page observation, XLSX formula/cache/chart observation, PPTX slide/layout observation, or PDF page/raster observation usable by the Agent Loop.

### Desktop gaps

There is no generic Office Output/Edit Dock, Office file association action, external renderer packaging, or Microsoft Office compatibility UAT harness.

### Deployment gaps

`apps/desktop/package.json` has no release packager and the repository does not currently ship a headless Office renderer. Bundled-renderer packaging is a release blocker, not an assumed capability.

## 5. Product Definition

Nexora shall accept an open-ended office goal, autonomously gather permitted Workspace facts, use general tools and code where useful, select Office capabilities, generate a real document/workbook/deck/publication, inspect the generated result, critique it against the task, repair it, and finish only through existing Runtime Evidence and Completion mechanisms.

The product must generalize to novel tasks such as research reports, sponsorship proposals, financial analysis workbooks, interview reports, supply-chain risk decks, training trackers, and investment comparisons without adding a dedicated workflow, template, or business-specific tool for each task.

## 6. Design Principles

1. The Agent chooses composition; Office capabilities expose primitives and verifiable operations.
2. A Skill supplies domain method and quality heuristics, never authority or permissions.
3. Code is useful for data transformation and calculations only through a restricted Capability SDK.
4. Every write is an Invocation with idempotency, approval, recovery, and Evidence.
5. The Agent must observe real generated artifacts, not infer success from a successful write call.
6. A fixed renderer and validators provide mechanical truth; previews are projections.
7. New office scenarios use composition. New code is justified only by a genuinely missing primitive.
8. No Office-specific Run state machine or Completion authority is introduced.

## 7. Agentic Office Architecture

```text
User Goal
  -> General Harness Agent Loop
     -> Workspace/Search/MCP(if later enabled)/Code capabilities
     -> Office Capability catalog
        -> Source primitives or controlled Code Mode
     -> Office compiler/renderer/validator in Desktop Host
     -> bounded observations (structure, data, visual, validation)
     -> critique/repair/replan
  -> Runtime Invocation/Evidence/Completion Gate
  -> Desktop Output/Edit Dock
```

The Office layer is a capability provider inside the existing loop, not a workflow engine. Logical task planning remains Harness-owned; Office compilation and file fidelity remain Host-owned.

## 8. Harness Changes

Harness changes are limited to generic capability exposure:

- add versioned Office capability descriptors to the existing tool contract projection;
- expose input/output schemas, effect kind, budgets, observation types, and when-to-use guidance;
- include selected Office Skill digests in the existing prompt strategy manifest;
- allow the existing loop to request inspect/critique after a mutation;
- preserve existing response routing, Plan revision rules, context eviction, and finish controls.

Harness must not contain DOCX XML, XLSX cell storage, PPTX layout state, PDF bytes, or a second Office plan/recovery loop.

## 9. Skill Model

Skills remain strategy-only packages loaded by the existing `SkillCatalog`. Example Skills may teach report structure, executive presentation quality, financial-model conventions, or document review heuristics. They may recommend which capabilities to use and what to inspect, but cannot register tools, grant permission, execute code, write files, assert completion, or override current Run facts.

Skills are optional. A novel office task must remain executable with the general capability catalog even when no task-specific Skill exists. Skill package and instruction digests are recorded through the existing Harness prompt strategy manifest.

## 10. Tool and Capability Model

The production surface is capability-oriented and intentionally small:

### General capabilities

Reuse existing filesystem, search, Artifact, process, and (when separately implemented) MCP capabilities.

### Office capabilities

Expose a small set of generic operations:

```text
office.create_source
office.inspect_source
office.apply_patch
office.render
office.inspect_representation
office.validate
office.export
```

These are Host capabilities registered through the existing Runtime Tool contract. They are not separate `docx.*`, `xlsx.*`, or `pptx.*` Runtime state machines. Format-specific schemas are selected by a `format` discriminator and validated by Host.

The Agent may call general tools before or between Office calls. A successful Office mutation does not imply task completion; the capability must return verifiable facts and recommended observation refs.

## 11. Code Execution / Code Mode Decision

The selected architecture is **Hybrid with restricted Code Mode**.

Structured Office primitives are the default for edits that require stable inspectable semantics: paragraphs, tables, cells, formulas, sheets, slides, shapes, images, styles, and charts. They provide CAS targets, bounded diffs, and reliable observation.

Code Mode is allowed for data cleaning, statistical calculation, batch transformation, chart data preparation, and conversions that cannot be expressed efficiently as primitives. Generated code runs in a temporary sandboxed process and may call only a versioned Nexora Capability SDK for input data, calculation, assets, and an output Source/Artifact. It cannot import arbitrary network clients, access secrets, escape the Workspace, execute shell commands, emit raw Office files as authoritative output, or bypass Runtime Invocation.

Code output is an intermediate fact or Source proposal. Host validates and commits it through the same Source, Representation, Asset, Invocation, Evidence, and Completion boundaries. Arbitrary model-generated Python/JavaScript/shell/XML/VBA is not executed.

## 12. Office Primitive / IR Decision

Use **format-specific canonical Source models behind one capability interface**, not one universal Office IR. DOCX, XLSX, and PPTX have materially different semantics; forcing them into a universal tree would lose formulas, workbook references, slide geometry, and format fidelity.

The common interface covers identity, inspect, patch, render, validate, and provenance. Each format owns its Source schema, stable IDs, compiler, renderer, and validators. PDF is a publication Representation or a separately validated Page Layout Source; it is never an editable binary Source.

The existing rich-document Source/bundle implementation is reused as a persistence and CAS pattern, not copied as a pretend generic Office model.

## 13. Artifact Observation and Repair Loop

Every Office mutation is followed by an observation contract chosen by the Agent and enforced by Host:

```text
Create/Patch
 -> Source observation
 -> Package observation
 -> Visual observation
 -> Agent critique against task/plan
 -> targeted patch or finish proposal
```

Minimum observations:

- DOCX: extracted headings/paragraphs/tables/images, page count, page raster, overflow and missing-glyph issues;
- XLSX: sheet dimensions, values, formulas, recalculated cached values, tables/charts, rendered-sheet samples, formula/reference issues;
- PPTX: slide text/images/shapes/charts, rendered slides, clipping/overlap/font issues;
- PDF: page count, text/resource sanity, raster pages, source and intermediate lineage.

Large observations are stored as Runtime Artifacts and projected into bounded Context refs. The Agent may inspect a failed or suspicious Representation and patch the Source; it may not patch a derived binary.

## 14. Context Strategy

Reuse Harness `decision-context`, rehydration, eviction, continuation, and budget logic. Office observations are classified as current tool facts, required verification facts, or helpful previews. Full files and large tables never enter the model prompt inline; they become bounded fragments or Artifact refs.

The context projection must preserve the latest Source digest, current Representation statuses, validation failures, changed targets, and required completion checks. Older visual pages and verbose diagnostics are evictable when the existing token policy requires contraction. No Office context store or summary authority is added.

## 15. Runtime Authority Integration

Runtime remains the sole authority for Run Status, Action Schema, Approval, Tool Invocation, side-effect recovery, Evidence, and Completion. Office Host returns domain facts only: Source committed/uncommitted, Representation Attempt status, digests, validation results, and observation refs.

Office required-output checks are expressed through existing task completion requirements and tool Evidence. The Completion Gate decides whether required checks are satisfied, rejects unresolved or stale evidence, and blocks completion after a required Office failure. Office code must not mutate Run snapshots directly.

## 16. Desktop Integration

The existing Desktop bridge and renderer projections are extended, not replaced. The Output Dock is minimized when no deliverable is selected and opens on the right when a file or Output result is selected. It displays Source revision, current Representation status, validation phases, provenance, changed targets, and actions for structured Edit, Retry, Open in system app, Reveal, and Download.

`Open in system app` uses Windows default file association. LibreOffice, when bundled, is an internal headless backend and is not forced on the user. The renderer sends typed IPC intents; Host performs all reads/writes and Runtime tool dispatch.

## 17. Security and Sandbox

Workspace paths are resolved and boundary-checked by Host/Runtime. Office parsers and renderers receive bounded files, CPU/time/memory budgets, and temporary directories. Active content, macros, external links, embedded scripts, and unsafe relationships are rejected or stripped according to the format contract.

Documents are untrusted content. Text inside documents, spreadsheets, PDFs, Skills, or imported files cannot act as system/developer instructions, permissions, Tool calls, approvals, or completion evidence. Prompt injection is treated as data and must be surfaced as untrusted content when relevant.

Code Mode has no secret access, no unrestricted network, no arbitrary child process, and no direct authoritative Office-file write. Electron keeps `contextIsolation`, `nodeIntegration: false`, `sandbox: true`, and navigation/new-window restrictions. External renderer crashes are isolated from Desktop.

## 18. Recovery

Use Runtime Invocation recovery for all Office effects. Host persists immutable Source and Attempt facts before exposing success. A Source commit crash may recover a fully validated orphan or clean bounded temporary data; it never deletes a committed Source. A renderer crash leaves Source valid and the Attempt failed/incomplete; retry uses the same Source identity and a new Attempt.

Unknown non-idempotent effects are not blindly replayed. Host exposes enough completion/file-digest facts for Runtime recovery to decide whether the effect is complete, retryable, or requires user intervention. There is no Office-private recovery reducer.

## 19. Validation

Validation is layered and independently observable:

```text
Source Validation -> Package Validation -> Visual Validation
```

Source validates schema, IDs, formulas, geometry, assets, budgets, and semantic references. Package validation reopens files, checks relationships/media/content types, rejects active content, and verifies parser consistency. Visual validation uses the pinned Host rendering stack to detect pagination, clipping, overlap, missing glyphs, unreadable text, and font fallback.

Bundled LibreOffice, if selected by the release packaging gate, is an internal renderer/recalculator/exporter, not the sole compatibility standard. DOCX/XLSX/PPTX compatibility must also be tested in a licensed supported Microsoft 365 Desktop Apps environment. Clean Windows without Office must still run Nexora generation, validation, and PDF export.

## 20. Eval and Novel Task Generalization

The release Eval set must contain novel tasks with no task-specific template or workflow:

- badminton-club sponsorship proposal;
- property-fee analysis workbook;
- supply-chain risk deck from five source files;
- formal research report from interviews;
- operating analysis report from CSV;
- personal training tracker;
- investment comparison report from multiple PDFs.

Each Eval records the selected capabilities, Source/Representation lineage, observations, repairs, Runtime Evidence, final completion decision, resource use, and human quality score. Passing means the Agent composes existing capabilities without feature-specific code. A missing primitive may be added only when multiple tasks demonstrate that the current capability contract cannot express it.

## 21. Production Acceptance

1. An open-ended office goal can complete through the existing Agent Loop without a dedicated business Workflow.
2. The Agent can read permitted files, calculate/transform data, create an Office Source, render, inspect real output, repair it, and finish through Runtime Completion.
3. DOCX, XLSX, PPTX, and PDF outputs are standard files; required formats are validated and provenance-traceable.
4. A successful write without subsequent required observation cannot satisfy the Office completion checks.
5. Structured patches are CAS-protected; derived binaries and previews are never edit authority.
6. Code Mode is sandboxed, capability-limited, bounded, and incapable of bypassing Runtime.
7. Renderer failure preserves Source and supports safe retry without a second state machine.
8. Current and stale Representations are recomputed from Source/dependency provenance after restart.
9. Microsoft 365 Desktop Apps UAT verifies DOCX/XLSX/PPTX open without repair prompts and preserves primary text/data/layout; LibreOffice validation alone is insufficient.
10. Novel-task Eval passes without scenario-specific templates or workflow code.
11. Clean Windows without Microsoft Office completes Nexora's own generation, validation, and PDF export path.
12. Existing coding, rich-document, Runtime, and Harness regression suites remain green at the applicable risk level.

## 22. Incremental Release Boundaries

### Foundation

Capability descriptors, Office observation contracts, Host Source/Representation persistence, and Agent-loop integration using existing Runtime tools.

### DOCX capability

DOCX Source, structured edits, package/visual observation, repair loop, and Microsoft 365 Word UAT.

### XLSX capability

Workbook Source, supported formula subset, pinned recalculation policy, tables/charts, grid/visual observation, and Microsoft 365 Excel UAT.

### PPTX capability

Slide Source, images/charts/layout observation, repair loop, and Microsoft 365 PowerPoint UAT.

### PDF publication

Validated upstream export, complete intermediate lineage, PDF parser/raster observation, and source-directed PDF edits.

These are capability release boundaries, not business workflows and not new Runtime state machines.

## 23. Explicit Non-goals

No per-scenario workflow engine, template catalog as the primary intelligence, universal Office IR, direct PDF binary patching, unrestricted code execution, arbitrary OOXML mutation, macro/VBA execution, cloud collaboration/CRDT, hidden second Artifact/Evidence/Invocation store, forced Microsoft Office installation, forced LibreOffice user experience, or completion based solely on renderer success.

## 24. Repository Evidence

The architecture decisions above are grounded in these symbols and paths:

- Agent semantic loop: `packages/harness/src/agent-loop.ts::runAgentLoop`;
- Harness wiring and Skill validation: `packages/harness/src/agent.ts::createAgent`, `packages/harness/src/skills.ts::SkillCatalog`;
- Prompt/tool strategy: `packages/harness/src/prompt.ts::ProviderToolContract`, `packages/harness/src/planning.ts`;
- Context projection/eviction: `packages/harness/src/context/decision-context.ts`, `context/projection.ts`, `context/eviction.ts`;
- Runtime Invocation and recovery: `packages/runtime/src/execution/runtime-execution.ts::callTool`, `executeToolInvocation`;
- Completion authority: `packages/runtime/src/completion-gate.ts::validateCompletion`;
- Artifact authority: `packages/runtime/src/store/artifacts.ts::ArtifactStore`;
- Workspace/process capabilities: `packages/runtime/src/execution/tool-runtime/index.ts`, `managed-process.ts`;
- Desktop Runtime bridge: `apps/desktop/src/runtime-service.ts`, `runtime-worker.ts`, `runtime-worker-client.ts`, `main.ts`, `preload.cjs`;
- Existing Host deliverable persistence: `apps/desktop/src/deliverables/rich-document.ts::createRichDocument`, `patchRichDocument`, `readRichDocumentPreview`;
- Existing output projection: `apps/desktop/src/deliverables/projection.ts::projectDeliverables`, `apps/desktop/src/renderer/app.ts`;
- Current status boundary: `DEVELOPMENT.md` records `editable-rich-document-artifact` as completed and DOCX/XLSX/PPTX/PDF as out of scope for that feature;
- Current dependency/deployment gap: `apps/desktop/package.json` has no Office libraries or release packager; `pnpm-lock.yaml` contains no pinned Office renderer dependency.

## 25. Architectural Decisions Compared with Mature Agents

Nexora adopts the mature pattern shared by Codex/OpenHands/Goose-like systems: one general loop, typed tools, bounded observations, explicit approvals, sandboxed execution, and iterative repair. It adopts Skill-as-instruction rather than Skill-as-authority, matching the repository's existing Skill contract.

Nexora rejects a business workflow per document type because it would fail novel-task generalization and duplicate Harness planning. It rejects raw code-first Office generation as the default because binary writes are difficult to inspect, recover, permission, and semantically patch. It rejects a large native Tool API because tool count and format coupling would make the Agent brittle. It rejects a universal Office IR because format semantics differ materially. The selected Hybrid keeps structured primitives for durable edits and restricted Code Mode for computation and transformation.

## 26. Final Recommendation

```yaml
recommended_architecture: hybrid_agentic_office_capability
why: >
  Reuse Nexora's existing general Agent Loop and Runtime authority while adding
  a small Host-owned Office capability catalog, format-specific Sources,
  restricted Capability-SDK Code Mode, real artifact observation, and repair.
reuse:
  - Harness Agent Loop, Plan, Skills, Context, Provider transport
  - Runtime Invocation, Approval, Recovery, Artifact, Evidence, Completion Gate
  - Workspace/filesystem/search/process capabilities
  - Host rich-document persistence, CAS, asset and preview patterns
new_capabilities:
  - Office capability descriptors and format-specific Source compilers
  - DOCX/XLSX/PPTX/PDF render, inspect, validate, and provenance adapters
  - bounded artifact observation and Office repair checks
  - restricted Code Mode with Nexora Capability SDK
  - Desktop Office Output/Edit Dock and renderer packaging
rejected_alternatives:
  - prompt-to-file template workflows
  - raw unrestricted code-first generation
  - large format-specific native Tool surface
  - universal Office IR
  - Office-private workflow, recovery, or completion state machine
production_blockers:
  - clean-Windows packaging and isolation spike for the pinned headless renderer
  - Office package reopen and visual validation benchmark
  - licensed Microsoft 365 Word/Excel/PowerPoint compatibility UAT
  - Code Mode sandbox and capability-boundary proof
  - novel-task generalization Eval
first_release_boundary: >
  Foundation plus DOCX capability, including real observation, repair,
  Runtime Evidence/Completion integration, and clean-Windows packaging gate;
  XLSX/PPTX/PDF follow as capability scopes without changing the architecture.
```
