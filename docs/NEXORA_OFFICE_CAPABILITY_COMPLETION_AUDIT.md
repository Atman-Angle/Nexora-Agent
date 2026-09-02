# Nexora Office Capability — Completion Audit

## Verdict

```yaml
feature: office-capability
office_capability_implementation: complete
office_capability_status: complete
full_production_acceptance: complete
office_capability_production_acceptance: complete
office_scope_validation:
  docx: passed
  xlsx: passed
  pptx: passed
  pdf: passed
existing_office_continuation:
  status: complete
  ordinary_desktop_attachments: passed
  docx: passed
  xlsx: passed
  pptx: passed
  later_turn_and_restart: passed
  real_microsoft_office_open: passed
mixed_reference_input:
  txt_md: passed
  docx_xlsx_pptx: passed
  office_binary_projection_to_filesystem_read: rejected
  reference_import_side_effect: none
regression:
  historical_accepted_full_suite: 577/580
  latest_complete_observation: 583/589
  latest_stable_affected_regression: 47/47
  office_induced_regressions: 0
  baseline_exceptions:
    - E053
    - E106
    - E122
external_acceptance:
  powerpoint_real_app_open:
    status: passed
    reason: real PowerPoint COM application opened the generated file and entered the editing window without repair or add-in errors
runtime_authority_contract_change: none
office_tool_contract: generated_and_imported_native_patch_paths_are_disjoint
provider_tool_argument_normalization: schema_driven_bounded_and_passed
feature_status_source: DEVELOPMENT.md
```

The Office capability itself is implemented and verified through the existing Host → Harness → Runtime path. It creates, revises, reopens, delivers and later exports real DOCX, XLSX, PPTX and PDF files without adding another Agent, Planner, Run state, Evidence system or Completion authority.

It also accepts an existing DOCX, XLSX or PPTX in the ordinary Desktop composer and continues that native file as the same kind of Deliverable. The Host stages and verifies generic attachment metadata; the model uses bounded internal tools; users only attach a file and describe the change. Native OOXML patching changes the selected paragraph/table, cell, slide/shape or inserted image while preserving unrelated package entries instead of flattening the source through Nexora's generated-document renderer. The resulting file participates in the existing immutable revision, projection, later-turn and restart-continuation path.

Workspace Office files and Host-verified Office attachments can also be read as bounded reference material through `document.read_source` without creating a manifest, revision or Deliverable. `filesystem.read` rejects binary/OOXML bytes instead of decoding ZIP data as UTF-8. `document.apply_patch` is reserved for Nexora-generated structured documents, while `document.apply_native_patch` has a separate native Office schema and narrowly normalizes canonical positive revision strings such as `"1"`.

The Office Capability implementation and Office-scope validation are complete. The current full regression is accepted at 577/580 with zero Office-induced regressions: E053, E106 and E122 are explicitly accepted as pre-existing baseline exceptions because each failure was independently reproduced on clean `HEAD` without Office changes. They are not fixed by this Feature and are not represented as fixed.

PPTX implementation, structural/package acceptance, and Microsoft PowerPoint real-application opening now pass. The same COM path that previously returned `CO_E_SERVER_EXEC_FAILURE` opened the generated file, exposed one editing window, and closed normally. No repair prompt or MathType/Add-in error appeared. Full production acceptance is complete.

## Requested wording clarification

The accepted Feature Spec now states:

```text
-> committed office artifact in Workspace
```

Production Acceptance verifies that requested structural/content elements supplied to the capability are preserved, without requiring a default post-generation semantic review. Mechanical file/package checks remain implementation behavior, not an LLM content audit.

## Requirement evidence

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| Real DOCX/XLSX/PPTX/PDF files | Passed | `e136-office-docx-artifact.test.ts`, `e137-office-multi-format-artifact.test.ts`, deterministic Desktop UAT and real-provider canaries reopen committed bytes. |
| General capability, no scenario workflows | Passed | Production registers `document.create`, `document.import`, `document.read_source`, `document.inspect`, generated `document.apply_patch`, native `document.apply_native_patch` and `document.export`; production code contains no report/minutes/sponsorship task branches. |
| Mixed Office reference input | Passed | E049 rejects OOXML bytes from `filesystem.read`. E138 reads TXT/MD normally and DOCX/XLSX/PPTX through bounded source inspection, exposes real content to the next model call, creates a new DOCX, and creates no reference Deliverable or import revision. |
| Existing Office attachment input | Passed | E138 stages a DOCX through the normal Desktop message contract, projects digest-bound Host metadata into the ordinary Run, imports and modifies it in that same Run. The composer supports picker and drag/drop chips through the same generic attachment boundary. |
| Native targeted preservation | Passed | E138 proves revision-stable target resolution, title/summary replacement, exact DOCX table-cell changes, paragraph insertion and grouped deletion while Appendix C and every unrelated package entry remain unchanged. It also proves an untouched XLSX worksheet/styles and PPTX slides 1–3 remain byte-identical. Failed/stale/wrong-format patches create no revision. |
| Desktop truthful outcome projection | Passed | Deliverable stage is derived from successful Invocation facts (`created`, `imported`, `modified`, `exported`). Import-only output is not labeled as task completion; terminal Delivery summaries and unfinished work render even without a formal Result; failed PDF conversion preserves the modified native revision as partial delivery. |
| Approval status reconciliation | Passed | E130 verifies that after Approval is granted, persisted Desktop Session state becomes `running` with no pending approval while the approved effect is still executing. Serialized snapshot emission prevents an older waiting snapshot from overwriting the newer state. |
| Existing-file continuation and restart | Passed | E138 commits revision 2 from the first conversation turn, recreates `DesktopRuntimeService`, reopens the Session and commits revision 3 to the same Deliverable. |
| Existing-file Microsoft Office UAT | Passed | Genuine non-Nexora DOCX/XLSX/PPTX inputs were modified by production code, then opened without repair in Word, Excel and PowerPoint 16.0 build 20326; requested and preserved elements were checked and every file closed normally. |
| Ordinary Nexora chain | Passed | E136/E137 assert Tool Invocation, persisted Evidence, Completion Gate and Desktop projection. |
| Create and targeted continuation | Passed | E135 and E137 prove revision-guarded block edits, changed/preserved regions and immutable prior revisions. |
| Restart continuity | Passed | E135 closes and recreates `DesktopRuntimeService`, reopens the same Session/Deliverable and commits another revision. |
| Lightweight default | Passed | Writes perform deterministic existence, digest, parse/package and preview checks. `document.inspect` summary returns no document body; no default semantic review call exists. |
| Later-format export | Passed | `document.export` records the exact source revision/digest, commits a new immutable revision and is traced through Runtime Evidence and Desktop projection. |
| Partial format success | Passed | One-format export Invocations preserve prior successful representations when a later export fails; Runtime remains non-success and Desktop labels the result as partial with committed files preserved. E137 also proves repeated Provider completion claims cannot turn a failed export into Evidence or a Result. |
| Truthful failures | Passed | E135/E136/E137 inject invalid input, unsupported format, missing resource, stale revision, traversal, symlink escape, renderer failure, file-write failure, timeout and cancellation. None produces false Completion. |
| Idempotency and recovery | Passed | Create, patch and export replay return equivalent facts; orphan-revision recovery advances only a fully validated revision; prior committed revisions survive failure/cancellation. |
| Runtime authority | Passed | Successful create/patch/export facts are attributable to Run, Invocation, Workspace, Deliverable and Evidence. Desktop and renderers do not write Run state or Completion. |
| Desktop delivery and boundary | Passed | E133 and Desktop UAT prove digest-verified preview/open paths, realpath/symlink containment, sandboxed preview and four format-aware file buttons. |
| Security | Passed | Bounded source/assets/cells/chart points, inert CSP preview, safe Workspace paths, no macros/VBA/ActiveX, no arbitrary embeddings, no external DOCX relationships and recursive validation of permitted PPTX chart workbooks. |
| Novel-task UAT | Passed | Three unrelated real-provider DOCX tasks use the same capability; the real-provider multi-format canary creates, continues and exports one unfamiliar operating-analysis Deliverable. |
| No acceptance cheating | Passed | Scenario names and test bodies occur only in tests/canaries; production contains no business-task workflow or hardcoded UAT document. |
| Microsoft PowerPoint real-app opening | Passed | PowerPoint 16.0 build 20326 opened the revision-3 PPTX in an editable window, rendered all 11 slides, and closed normally without repair prompt or MathType/Add-in error. |

## Final target verification

The final target command passed:

```text
pnpm vitest run
  tests/runtime/e121-provider-native-tool-protocol.test.ts
  tests/runtime/e133-desktop-workspace-links.test.ts
  tests/runtime/e135-editable-rich-document-artifact.test.ts
  tests/runtime/e136-office-docx-artifact.test.ts
  tests/runtime/e137-office-multi-format-artifact.test.ts
  tests/runtime/e138-existing-office-attachment-editing.test.ts

56 / 56 tests passed
pnpm typecheck passed
pnpm --filter @nexora/desktop build passed
```

The corrected real-provider multi-format canary passed three Runs:

```text
revision 1: XLSX + PPTX + PDF created from one logical Deliverable
revision 2: requested values/actions changed; unspecified blocks preserved
revision 3: DOCX added through document.export without changing content
final status: succeeded / COMPLETED
```

Final revision 3 files in the isolated canary Workspace:

| Format | Bytes | Mechanical/application evidence |
| --- | ---: | --- |
| XLSX | 9,154 | ExcelJS/package validation, independent `openpyxl` reopen with 3 worksheets and 53 populated cells, and Microsoft Excel read-only open succeeded. |
| PPTX | 152,664 | Open XML/package and embedded-workbook validation; independent `python-pptx` reopen found 11 slides, 31 text shapes and all requested updated elements; Windows identifies it as a Microsoft PowerPoint presentation and reads its title. |
| PDF | 20,388 | `pdf-lib` plus independent `pypdf` reopen, 2-page count and unencrypted-file validation. |
| DOCX | 9,575 | OPC/package validation, independent `python-docx` reopen with 8 paragraphs and 6 tables, and Microsoft Word read-only open succeeded. |

The deterministic Desktop UAT separately produced revision 2 with four visible format buttons and persisted Runtime evidence.

The current-code rerun on 2026-08-28 passed as Run `5e4cc1c7-3a17-4eb6-8037-ac3b40f887dd`: one Session, two Runs, one revision 2 Deliverable, two successful Office Invocations, two persisted Evidence records, and visible DOCX/XLSX/PPTX/PDF plus preview buttons. Its report and capture are `.tmp/desktop-document-uat.json` and `.tmp/desktop-document-uat.png`.

The persisted real-provider v7 Runtime database was also reopened read-only. It contains three `succeeded / COMPLETED` Runs, seven succeeded Office Invocations (`document.create`, `document.inspect`, `document.apply_patch`, `document.export`), Result-to-Evidence citations for every Run, and three `run.succeeded` events. Revision 3 validation records 3 XLSX sheets, 11 PPTX slides, 2 PDF pages and 36 DOCX paragraphs.

## Regression disposition

A current sequential `pnpm test` run (the repository's non-parallel test entrypoint) completed with 103 passing files and 577 passing tests out of 106 files and 580 tests. Every Office and packed-consumer test passed. Its three remaining failures were audited as follows:

1. E053: its HTTP stub parses everything after `[TOOLS]` as one JSON value, but the current Prompt has later sections; the stub returns HTTP 500 before exercising Office.
2. E106: the clean baseline requires 15,669 estimated input tokens against a fixed 15,616 hard limit.
3. E122: the clean baseline's expected `styles.css` working-set projection is empty.

E053/E106/E122 were reproduced with the same results in a detached, clean `HEAD` worktree containing no Office changes. The completion decision accepts them as pre-existing baseline exceptions. Office-induced regressions are therefore zero. These tests remain failing and are not described as repaired; this Feature does not expand scope to fix them.

The six formerly failing packed-consumer files were rerun after cache warm-up and passed 14/14 tests; they are no longer a blocker.

## Microsoft PowerPoint external UAT

The final external UAT ran on 2026-08-28 at 12:39:37 +08:00 against the real committed artifact:

```yaml
status: passed
office:
  product: Microsoft PowerPoint
  version: "16.0"
  build: "20326"
  path: C:\\Program Files\\Microsoft Office\\Root\\Office16
  architecture: x64
windows:
  product: Microsoft Windows 11 家庭版 中文版
  version: "10.0.26200"
  build: "26200"
  architecture: x64
artifact:
  path: D:\\Nexora-1.1\\.tmp\\office-multi-format-canary-v7\\deliverables\\quarterly-report\\revisions\\000003\\document.pptx
  sha256: 5e9f57e530dc77c5156b5d787580a28f779ed32df3abfbff45df328143a6ace0
  bytes: 152664
result:
  application_started: true
  opened_in_editing_window: true
  repair_prompt: false
  mathtype_or_addin_error: false
  slide_count: 11
  slide_count_correct: true
  primary_text: passed
  images: not_present_in_this_artifact
  tables: passed
  charts: passed
  layout_visual_check: passed
  closed_normally: true
com_harness:
  status: passed
  prior_error_recovered: CO_E_SERVER_EXEC_FAILURE
  real_file_opened: true
  normal_close: true
```

PowerPoint's own PNG export rendered all 11 slides. Visual inspection covered the cover, table, chart and key-items slides; text, table, chart and major layout were normal. The verified revision-3 artifact contains no picture shapes, so image compatibility is recorded as not present rather than inferred. The independent parser report remains at `.tmp/office-independent-parser-report.json` and carries the same PPTX digest and 11-slide result.

The previous `CO_E_SERVER_EXEC_FAILURE` was an environment/automation condition and is not a generated-PPTX compatibility defect. No Office implementation change was made.

The digest-bound independent parser result is persisted locally at `.tmp/office-independent-parser-report.json`.

## Existing Office continuation UAT

The continuation extension ran on 2026-08-28 at 16:24–16:31 +08:00. Inputs were genuine Microsoft Office files not generated by Nexora's renderers. The Excel input was first reopened normally in Excel before being admitted to the UAT; this prevents a defective fixture from being mistaken for a Nexora output defect.

```yaml
status: passed
environment:
  office_product: Microsoft Office
  office_version: "16.0"
  office_build: "20326"
  office_file_version: "16.0.20326.20100"
  office_architecture: x64
  windows_product: Microsoft Windows 11 家庭版 中文版
  windows_version: "10.0.26200"
  windows_build: "26200"
  windows_architecture: x64
workspace: D:\\Nexora-1.1\\.tmp\\existing-office-real-uat-20260828-v2\\workspace
results:
  docx:
    path: outputs/word-existing/revisions/000002/document.docx
    sha256: 6cd5b5fed1e5e7177adfcaedb5831739806a77247f1c52240cdf165a8ae9c976
    application_open: passed
    repair_prompt: false
    requested_change: passed
    preserved_chapter_and_table: passed
    normal_close: passed
  xlsx:
    path: outputs/excel-existing/revisions/000002/document.xlsx
    sha256: 630816cfb656379f144079b900c2de39c052ccaefed8c3c5a63204ef83f0190b
    application_open: passed
    repair_prompt: false
    requested_cell_b3: 135
    preserved_formula_c3: "=B3*2"
    recalculated_c3: 270
    preserved_other_sheet: passed
    normal_close: passed
  pptx:
    path: outputs/powerpoint-existing/revisions/000002/document.pptx
    sha256: 0aa98378843c083999ac7495a990368a868fa12f57126e7bf4d319b60bc38e44
    application_open: passed
    repair_prompt: false
    addin_error: false
    slide_count: 4
    requested_text_and_image: passed
    preserved_slide_1: passed
    normal_close: passed
```

The deterministic E138 chain separately proves ordinary conversation attachment input, Tool Invocation/Evidence/Completion, revision 2, later-turn revision 3 and restart continuity. Active content and attachment digest drift are rejected before import; stale, wrong-format and missing-target patches leave revision 1 unchanged. Imported native Office-to-PDF conversion currently returns `DOCUMENT_CONVERSION_UNAVAILABLE` and does not mutate the Deliverable; arbitrary high-fidelity conversion is an explicit non-goal rather than a false success.

## Failed-session remediation evidence

The two failed UAT Sessions were converted into generic regressions rather than scenario workflows.

- Multi-source generation: E138 reads TXT/MD with `filesystem.read` and DOCX/XLSX/PPTX with `document.read_source`, then creates and mechanically inspects a new DOCX in four model calls. No Office file is decoded as UTF-8, imported as a reference Deliverable, or routed through Shell/Python.
- Complex existing Word: generated-document and imported-native patch schemas are disjoint. The native batch supports exact text and table-cell replacement, paragraph insertion and grouped deletion, with every target resolved against the same input revision. Canonical `"1"` revision input is accepted; non-canonical strings remain invalid.
- Desktop truthfulness: import-only output is shown as pending modification, modified/exported/partial stages come from Invocation facts, and blocked/failed/cancelled Delivery summaries remain visible without a formal Result. Approval completion is serialized into the persisted Session summary.

The original complex DOCX from `D:\Nexora_test2` was replayed independently through the production implementation in an isolated Workspace:

```yaml
workspace: D:\Nexora-1.1\.tmp\existing-office-fix-uat-20260828
source_sha256: a8a447d5f5c9f03d90e63a916e5a14a6668f7aee8d6be8b7553a0bd5ce609e15
output: outputs/complex-fixed/revisions/000002/document.docx
output_sha256: 24db74671a48516efebef524669a0e2b38a8b7feeee7e56d639e077c6ac71fa4
revision: 2
requested_changes:
  title: passed
  summary_under_300_characters: 198
  required_summary_numbers_preserved: passed
  complaint_table_cells: passed
  three_action_items_inserted: passed
  appendix_b_removed: passed
  appendix_c_preserved: passed
preservation:
  revision_1_byte_identical_to_source: true
  changed_package_entries:
    - word/document.xml
  all_other_package_entries_byte_identical: true
word_real_app_open:
  status: passed
  office_version: "16.0"
  office_build: "16.0.20326"
  office_architecture: x64
  windows_version: "10.0.26200"
  windows_build: "26200"
  editable: true
  repair_prompt: false
  normal_close: passed
```

The latest complete serial suite observation was `583/589`. E053, E106 and E122 remained the accepted clean-HEAD baseline exceptions. The other three failures occurred while unrelated Runtime recovery source/tests were being changed by another active task; after rebuilding the stable package artifacts, the affected Provider recovery/continuation set passed `47/47`. No Office-induced regression was found.

## Provider Tool argument normalization and Session recovery

The failure in Desktop Session `052d5520-9e32-40f8-bafb-0d247dfcea1b` occurred after all reference sources were read: `qwen3.7-flash` supplied the `document.create.blocks` array as one JSON string twice. The authoritative Tool Schema rejected both calls with `Expected array, received string`, and the existing convergence behavior correctly stopped the Run at `NO_PROGRESS_DETECTED` without a Tool side effect.

The remediation is Provider-neutral and Tool-neutral. Before Runtime dispatch, each Provider Tool call is compared with that Tool's advertised Schema. A string is converted only when the Schema excludes string and explicitly requires an array, object or integer. Composite JSON is parsed at most once per encoded value, with fixed encoded-size, decoded-depth and node-count limits. The normalized value still passes through the complete existing Zod Tool Schema before an Invocation or side effect can exist. `model.turn` retains the normalized `arguments` plus `providerArguments`, `normalizedArguments` and the changed JSON-pointer paths for diagnostics.

E121 covers the requested negative cases: ordinary text, wrong composite type, malformed JSON, second-layer encoding, invalid nested fields, oversized input, over-deep input and JSON-looking values whose Schema is string. E138 replays the original `blocks: "[{...}, {...}]"` shape through the real `document.create` contract, commits and reopens a DOCX, records the original and normalized values, and completes with only one create and one inspect Invocation.

The real Session was then recovered through a bounded continuation. The first child `7bef84e1-33b7-44ee-b507-9f42d476dd80` was cancelled before execution when the temporary Host process closed; it produced no Tool Invocation or artifact and is not completion evidence. The retained recovery Run is:

```yaml
parent_session: 052d5520-9e32-40f8-bafb-0d247dfcea1b
recovery_run: e162066b-c26d-42ee-8ca0-cf69198dc7a5
status: succeeded
stop_reason: COMPLETED
model_calls: 6
tool_calls: 11
response_rejected: 0
run_blocked: 0
deliverable:
  manifest: D:\Nexora_Test_1_Raw_Materials\output\manifest.nexora.json
  docx: D:\Nexora_Test_1_Raw_Materials\output\revisions\000001\document.docx
  revision: 1
  sha256: 5ed63127ccbf22590e5061dcd1517b564ca983b2f6c32a84ba73ffc4d4fae961
  manifest_digest_match: true
  package_validation: passed
  document_inspect: passed
```

The live Provider emitted a valid array during recovery, so it did not require a normalization event; the exact malformed shape is proven by the deterministic real-Tool replay instead of being misreported as live evidence. After the first successful create, the live model made one redundant create call; it failed truthfully with `DELIVERABLE_ALREADY_EXISTS`, then performed `document.inspect` and completed. There was no repeated rejection, blocked state or additional failure loop. `NO_PROGRESS_DETECTED` behavior remains unchanged, as covered by E129.

The revision-1 package was mechanically valid but did not satisfy the original content Acceptance: it contained only 1,218 non-whitespace content characters and omitted several required facts. It was therefore not accepted as the final task result. Corrective continuation `789aeca5-f553-49d7-8ee7-70926cb03a51` revised the same Deliverable rather than creating another one:

```yaml
content_correction_run: 789aeca5-f553-49d7-8ee7-70926cb03a51
status: succeeded
stop_reason: COMPLETED
final_revision: 3
final_docx: D:\Nexora_Test_1_Raw_Materials\output\revisions\000003\document.docx
sha256: 243ac7ecd336d98bc2356a117ab03df589fad4a9440e4c6110e2698876bd5546
manifest_digest_match: true
package_validation: passed
document_inspect: passed
content_acceptance:
  non_whitespace_characters: 2503
  requested_range: 2500-3500
  execution_summary: passed
  key_data: passed
  main_problems: passed
  cause_judgment: passed
  q3_action_plan: passed
  four_week_pilot: passed
  fact_interview_unconfirmed_distinction: passed
  revenue_conflict_511_7_vs_512_0: passed
  conflict_amount_0_3: passed
  baseline_6_9_4_0_2_8: passed
  trackable_targets: passed
runtime:
  tool_failures: 0
  run_blocked: 0
  response_rejected: 6
```

The six correction-Run rejections were bounded and side-effect free: two missing exact `blockIds`, two invalid nested list encodings, and two bare completion texts that omitted `nexora_respond`. The Provider changed strategy after each repair window, both document patches committed successfully, and the Run completed without `NO_PROGRESS_DETECTED`.

The temporary cache-warm directory `nexora-office-npm-cache-warm` is outside the repository under the system Temp directory. Local policy prevented forced recursive cleanup; it is recorded as environment residue and is not a Feature completion blocker.

## Dependency and non-goal record

Pinned production dependencies are `docx@9.7.1`, `exceljs@4.4.0`, `pptxgenjs@4.0.1`, `pdfkit@0.20.1`, `pdf-lib@1.17.1`, `fflate@0.8.2` and the lightweight OOXML DOM dependency `@xmldom/xmldom@0.8.11`; all declare the MIT license.

The implementation does not claim unrestricted mutation of every Office structure, unrestricted formulas, WYSIWYG preview parity, collaborative editing, tracked-change semantics, macros/active content, arbitrary executable templates or high-fidelity native Office-to-PDF conversion. Macros, ActiveX, OLE and unsupported complex targets are rejected rather than silently damaged. Those remain explicit Feature non-goals rather than silently incomplete promises.
