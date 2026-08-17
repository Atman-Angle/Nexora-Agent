# Real Provider Baselines

## Durable native continuation correction (2026-08-17)

The earlier frontend samples below were executed with an incomplete OpenAI-compatible multi-turn protocol: after an
`assistant.tool_calls` response, Nexora executed the call but omitted the original assistant call and matching
`role: "tool"` result from the next request. They remain valid before-samples for false-success safety, but they are
not evidence that DeepSeek could not consume Tool results.

The corrected Harness now records normalized call ID/name/arguments as `model.turn` audit facts, derives the latest
fully resolved batch from durable Plan, Tool Invocation, HITL, Approval or rejection facts, and sends the standard
assistant/tool message sequence. The projection is limited to one eight-call batch, contracts large results to a
reference under input pressure, survives Runtime reopen, and is ignored by `structured_output`. Provider call IDs
remain audit/correlation data and do not enter Runtime Actions, Invocations, Plan authority or Completion.

The HTTP protocol suite covers Runtime Tool success/failure, Plan acceptance, rejected controls, HITL across reopen,
Approval denial, ordered batches, bounded large results, unchanged structured output and empty native responses.
Empty assistant responses now retain `finish_reason` in their error and receive three bounded physical Provider
attempts within one logical Model Call; they are never converted to text, Tool Calls or success.

Three post-fix real `deepseek-v4-flash-0731` frontend samples were retained as evidence:

| Run | Reasoning | Model / Tool calls | Result |
| --- | --- | ---: | --- |
| `a7d0dbbb-a742-49a4-8702-3ae0e7184f4c` | dynamic | 1 / 0 | First response was empty after a long generation. It predated the empty-response retry addition and ended truthfully blocked with no files. |
| `0e21aa22-b899-4ab8-8694-98afc8bf22b7` | dynamic | 4 / 1 | Plan and `filesystem.list` continued through valid native messages with zero response rejection. A later response hit exactly 16,384 output tokens and the following response was empty. |
| `9f04c1b7-7343-48a5-ae7e-86fd13219ce6` | off, process-local | 32 / 30 | All 32 responses and 30 Tool calls remained protocol-valid with zero response rejection. It wrote 10,149-byte HTML and 19,759-byte CSS, then exposed the existing objective-only Plan progress defect and exhausted the Tool budget before JavaScript/verifier creation. |

The last sample established a separate Runtime/Harness defect rather than a continuation failure: objective-only Plan
steps have no required checks, while `completeSatisfiedSteps()` currently treats `every([])` as satisfied. One Tool
result therefore marks every Plan step completed; an equivalent Plan revision then preserves those completed steps
and appends duplicates. The model subsequently alternated equivalent `filesystem.list` and `filesystem.read` calls.
This is recorded for a dedicated L3 Plan-progress Contract change because fixing it changes Run-owned Plan semantics;
no Prompt constraint, repeated-read ban, model switch or Provider-specific branch was added here. All real samples
ended with zero false success and no unauthorized effect.

Final repository evidence: root build, typecheck and lint pass; Runtime and Harness packages build; the
Runtime/Harness release set passes 16 files / 83 tests; Context quality passes 12 files / 65 tests; full Vitest passes
85 files / 397 tests; NexoraBench typecheck and 6 files / 14 tests pass; package consumers, restart reconstruction,
Approval, recovery, durable Journal and security/privacy regressions pass.

## Provider-native Tool Protocol acceptance (2026-08-17)

The production Provider contract now uses normalized native Tool Calls or strict structured output. The model-authored `ModelTurn.action`, `json_actions`, JSON-object emulation and Action repair loop are deleted. The real frontend canary asked `deepseek-v4-flash-0731` through the OpenAI-compatible adapter to create a responsive operations dashboard with navigation, KPIs, a filterable table, an accessible incident modal, persisted theme state, mobile behavior, keyboard handling, empty state and an independent Node verifier.

Native transport capability is real but not stable enough for this complex multi-turn task. Across three bounded samples, the Provider emitted genuine native `filesystem.list` calls with Provider call IDs, and Nexora persisted the corresponding Tool Invocations and Evidence. No response used or repaired a JSON Action. None of the samples wrote a frontend file or reached success, so the external syntax/verifier gates failed and Nexora reported `blocked/PROVIDER_UNAVAILABLE` with zero false success.

| Sample | Output budget | Model calls | Tool Invocations / Evidence | Decisive result |
| --- | ---: | ---: | ---: | --- |
| `a67158cd-e380-49c5-8b72-839a2d91f1e6` | 16,384 | 2 | 1 / 1 | First native list succeeded; the next attempt consumed 5,463 input and 16,384 output tokens but normalized to neither text nor a Tool Call and was rejected as an empty Provider response. |
| `6d6f3c5f-8222-4c42-a020-bedce44bab76` | 16,384 | 4 | 2 / 2 | Plan control plus two native lists succeeded; the fourth attempt consumed 6,250 input and the full 16,384 output-token budget, then failed before a valid response was formed. |
| `9726178b-700d-4f5d-974e-bb6dc294d5b6` | 32,768, process-local override | 2 | 1 / 1 | One native list succeeded; the next Provider attempt failed before returning usage. Raising the output budget therefore did not establish stable completion. |

The strict `structured_output` sample `298f935b-7b29-4df1-922f-cefe2f753edc` failed on its first request after 3,042 input and 16,384 output tokens. It produced no normalized response, Tool Invocation, Evidence or file effect and ended `blocked/PROVIDER_UNAVAILABLE`. The adapter did not downgrade to JSON-object mode or reinterpret content as a Tool Call. This model endpoint is therefore recorded as incompatible with Nexora's strict structured-output contract, rather than being assigned a fabricated success.

All four samples have zero response-repair loops, zero unauthorized effects and zero false success. They demonstrate the intended boundary: Provider-native calls remove failures caused by a model-authored `action` field, while Provider generation quality, output truncation and endpoint reliability remain external failure sources and are surfaced truthfully. The repository's deterministic protocol suite supplies acceptance for native null-content calls, strict Schema handling, Plan/HITL controls, audit IDs and all Runtime authority paths.

Final L3 repository evidence: root typecheck, lint and build pass; Runtime and Harness package builds pass; the Runtime/Harness release set passes 16 files and 76 tests; full Vitest passes 85 files and 389 tests; NexoraBench typecheck passes and its suite passes 6 files and 14 tests; `git diff --check` and the retired-production-protocol scan pass.

## Historical General Agent Prompt / Profile and Prompt Cache acceptance (2026-08-17)

This is the preceding `json_actions` Feature baseline and is retained as historical evidence, not the current production Provider contract. The report is `reports/general-agent-profile-cache-json-host-real-20260817/report.json` on the unchanged `nexora-core-v1` v11 Dataset digest `sha256:734b64ed1bce0bb2c46fbfb30e2449bd2ea828bf1c1875ce5387d3d1accd035f`. `HB-WORLD-001` ends `succeeded`, passes the independent grader, persists one Tool Invocation and one Evidence record, and has zero false success. Three Model Calls used one `json_actions + automatic` Transport, one Host Policy digest, no Profile, and one stable-prefix digest with zero strategy drift. The stable prefix is 1,291 compiler-estimated tokens. The Provider reported one miss followed by two partial hits: 4,616 cache-eligible input tokens, 2,048 cached input tokens, zero reported write tokens, and a comparable cached-input ratio of 44.37%.

The old Prompt baseline was executed from detached commit `7c66cba` with only response-usage logging added; the old Prompt, request body, unchanged `HB-WORLD-001` task, Provider and grader were not modified. It also passes with zero false success, but its four requests contain only 584, 739, 717 and 541 input tokens. The Provider returns no cached-token or cache-write field for any old request. This is retained as an ineligible/non-comparable baseline rather than fabricated as a zero hit ratio: the old request never reached the Provider's observed cache-reporting threshold, while the current stable prefix does and returns nonzero cached tokens.

Two diagnostic samples are retained rather than hidden. `reports/general-agent-profile-cache-real-20260817/report.json` uses the model's unsupported native Tool transport; all eight calls preserve one stable prefix and report 56.57% cached input, but every JSON Tool action is rejected and the Run fails with no Effect. `reports/general-agent-profile-cache-json-real-20260817/report.json` exposed that the Bench Host had no workspace-change policy: the model finished after one rejected action without any Invocation or Evidence, and the external grader correctly marked false success. The final Bench Host Policy fixes that strategy gap without changing Runtime authority or grader logic. An earlier `QB-MAXSUM-001` run at `reports/general-agent-profile-real-20260817/report.json` passes the full external/runtime gate but used the then-hidden fallback `json_actions + disabled` because the Bench observation wrapper dropped `provider.transport`; the wrapper now preserves Transport and is covered by a contract test.

L3 repository evidence after the implementation: root typecheck/build/lint pass; root Vitest passes 85 files and 386 tests; the Runtime/Harness release set passes 15 files and 66 tests; NexoraBench passes 6 files and 14 tests; Runtime and Harness packages build sequentially. The final verification results are summarized in this public baseline; local Feature tracking is not part of the published repository.

## Runtime / Harness boundary simplification acceptance (2026-08-14)

The final deterministic release report is `reports/2026-08-14T14-17-40-468Z/report.json` on `nexora-core-v1` v11, digest `sha256:734b64ed1bce0bb2c46fbfb30e2449bd2ea828bf1c1875ce5387d3d1accd035f`. All 16/16 external task contracts pass. Twelve Runs end `succeeded`; the safety, recovery and cancellation scenarios retain their expected waiting/failed/cancelled terminals. The report records 75 model calls, 72 Tool Invocations, 66 Evidence records, 510 Events, zero false success, zero Action rejection, zero unauthorized Effect and zero duplicate non-idempotent Effect.

v11 adds and preserves the following release evidence:

- `NB-CONVERGE-001` patches safely after verifier failure without a forced replan, proving the Plan is not a Tool whitelist.
- `NB-ARTIFACT-001` completes a long report without a default Validator call and proves one large Invocation payload entered Artifact storage.
- `NB-EXTENDED-001` completes 24 independent reads, 26 total Tool Invocations and two Runtime reopens before the verified aggregate write.
- `NB-BATCH-CANCEL-001` cancels a four-read batch after the first success, retaining one succeeded and three failed attempts plus one Evidence record.

The complete repository suite passes 85 files / 388 tests and the Bench suite passes 6 files / 11 tests. It covers Completion, Approval, Provider transient failure, deterministic context contraction, dynamic reasoning, more than 100 decisions, Memory/security, rehydration, multiple unresolved Invocations, durable crash recovery and observation deduplication.

### General execution-continuity acceptance

The final generic decision Prompt is 3,422 UTF-8 bytes with SHA-256 `586409576a576e72a49c2719b826b00085f36a2ad0ef517f506e47a5576e46a3`. It keeps original inputs authoritative, directs uncertainty through facts, Tools, bounded retry and alternate paths before user input, asks the model for only an optional goal plus ordered objectives instead of the internal completion-requirement DSL, and states the eight-call per-turn batch bound. Detailed legacy Plan requirements remain accepted for Provider compatibility. `e117-general-agent-continuity` covers premature input repair, genuine user-owned input, Plan-free semantic review, malformed optional Plan isolation, objective-only planning, safe repeated observation, current Evidence projection and malformed reviewer recovery without Provider blocking.

The retained real short-task report is `reports/2026-08-14T12-43-04-648Z/report.json`. `NB-CODE-001` and `QB-GCD-001` both end `succeeded/VALIDATED`, pass their independent graders, and produce the expected patched files. Together they use 13 model calls and 10 Tool Invocations, with zero Provider failure and zero false success. Neither task stops for unnecessary user input.

The earlier real long-task report `reports/2026-08-14T12-45-07-039Z/report.json` is retained as the before sample: `NB-LONG-001` took 222 seconds, 16 model calls and six Action rejections. The non-blocking protocol report is `reports/2026-08-14T14-18-22-795Z/report.json`: the unchanged task succeeds in 54 seconds with eight model calls, 11 Tool Invocations, 15 Evidence records, zero Action rejection, zero Provider failure and zero false success. The report and verification output are valid after the approval-time restart. The paired historical `NB-EXTENDED-001` failure remains retained rather than hidden: after its generic Prompt fix, `reports/2026-08-14T13-05-33-760Z/report.json` creates all 24 one-to-one read Checks, executes all 24 distinct reads, persists 24 Evidence records across a Runtime reopen, and writes `summary.txt`. It still ends failed because the model writes semantically correct count/total text in a format rejected by the hidden exact-format grader, then repeats an already succeeded write. The Run reports zero false success and persists a deterministic Delivery containing all 24 confirmed facts and the remaining validation work.

### Repeated real-Provider sample

The fixed task is `QB-MAXSUM-001`; every run uses the same v11 Dataset and is retained.

| Provider | Report | Run result | External grader | Model / Tool calls |
| --- | --- | --- | --- | --- |
| DeepSeek `deepseek-v4-flash-0731` | `real-deepseek-v11-1` | `succeeded` | pass | 5 / 3 |
| DeepSeek `deepseek-v4-flash-0731` | `real-deepseek-v11-2` | `succeeded` | pass | 6 / 5 |
| DeepSeek `deepseek-v4-flash-0731` | `real-deepseek-v11-3` | `blocked/PROVIDER_UNAVAILABLE` | pass | 10 / 7 |
| Qwen `qwen3.7-flash` | `real-qwen-v11-1` | `blocked/PROVIDER_UNAVAILABLE` at `PROVIDER_EXTERNAL` | fail | 1 / 0 |
| Qwen `qwen3.7-flash` | `real-qwen-v11-2` | `blocked/PROVIDER_UNAVAILABLE` at `PROVIDER_EXTERNAL` | fail | 1 / 0 |
| Qwen `qwen3.7-flash` | `real-qwen-v11-3` | `blocked/PROVIDER_UNAVAILABLE` at `PROVIDER_EXTERNAL` | fail | 1 / 0 |

DeepSeek therefore completes the full Runtime contract in 2/3 samples while the independent grader passes 3/3. The third sample retains one Action rejection and one repair recovery. Qwen is 0/3 because the first external Provider request fails each time, before any Tool Invocation. Every sample has zero false success, unauthorized Effect and duplicate non-idempotent Effect. Model overrides were scoped to their PowerShell child process and did not modify repository `.env`.

The harness-local `.env` contains Langfuse configuration even though the root `.env` does not. Read-only Public API verification found all six remote traces with bounded input/output and complete parentage (`MissingParents=0`):

- DeepSeek: `38e21c404107332e948d85da2f54d3f5`, `2ac10df49c84cd407509e9861f275fed`, `0074d17aed01bcf9fd159c206d69acfa` with 5, 6 and 10 Generation observations.
- Qwen: `2a07fb0129dcb5e58b9e4910a9e6ea17`, `3adb344c9a50bed454c451e89250eeb9`, `de960deb850101932b975ce0fc0108a5` with one Generation observation each.

These samples do not justify a combined Plan+initial-read response protocol: Qwen has no successful first response and DeepSeek full success remains 2/3, so Provider Schema stability is not established. They also do not justify Provider- or task-specific Runtime branches.

### S7 completion recheck

Two additional retained DeepSeek runs, `reports/s7-real-deepseek-20260814/report.json` and `reports/s7-real-deepseek-20260814-run2/report.json`, exercised the same v11 `QB-MAXSUM-001` entry after the final static and regression gates. Both external task grades failed and both Runs correctly ended `failed/ITERATION_BUDGET_EXCEEDED`: all 28 Provider calls returned successfully, three read Invocations succeeded across the isolated Runs, and repeated invalid optional Plan requirements were rejected without executing an unauthorized Effect. Bounded finalization persisted a non-empty model-generated `RunDelivery` for each Run, describing the unfinished repair and exact cause. Both samples have zero false success, unauthorized Effect and duplicate non-idempotent Effect.

These additional failures are retained rather than replacing the two successful DeepSeek samples above. They show the intended boundary of the Feature: model quality remains probabilistic, while invalid external data cannot bypass Schema and every bounded terminal outcome still produces a truthful Delivery. The byte-for-byte Prompt, reasoning policy, Memory selection and action compilation remain frozen by `e116-agent-runtime-strategy-parity`; the rechecks did not authorize a prompt or strategy change to improve individual samples.

### S7 execution-continuity fix and final acceptance

The failed rechecks above exposed mechanical coupling rather than an acceptable model-quality boundary. Optional malformed Plan metadata discarded usable Tool calls; a cached read rejected fresh reads in the same batch; Plan-free successful Invocations were omitted from the next Context; and Completion still required a Plan even though the execution Contract made Plan optional. The fix removes those contradictions without changing Prompt, reasoning, Memory selection or action compilation. Plan-free success still requires persisted Invocation-backed Evidence, and all Approval, unresolved Invocation, idempotency and non-idempotent recovery gates remain intact.

The retained final real report is `reports/s7-real-deepseek-final-continuity-20260814/report.json`. On the unchanged v11 `QB-MAXSUM-001`, DeepSeek `deepseek-v4-flash-0731` completed the full chain in four model calls and three successful Tool Invocations (`filesystem.read`, `filesystem.patch`, `shell.execute`). The Run persisted three Evidence records, a cited Result and a non-empty successful Delivery, ended `succeeded/VALIDATED`, and passed the independent grader. It has zero Action rejection, Provider failure, false success, unauthorized Effect and duplicate non-idempotent Effect. The final workspace independently passes `python verify.py`.

### Initial deterministic A/B retained for comparison

The deterministic comparison uses the same `nexora-core-v1` v10 Dataset with digest
`sha256:a072f92eeff68597ff0c00bc15005cdbe2d6b84dd8cbfaaef44712ca039e87e9`:

- Before: `reports/2026-08-13T16-46-45-616Z/report.json`
- After: `reports/2026-08-13T17-39-34-949Z/report.json`

Both runs resolve 13/13 tasks, validate 10/13, and report zero false success and zero Action rejection. Total model calls fall from 74 to 64 because each of the ten ordinary successful tasks no longer invokes the default Validator. Bench grading remains external and unchanged.

The retained real-Provider checks use the unchanged `QB-MAXSUM-001` task:

- DeepSeek `deepseek-v4-flash-0731`: `reports/2026-08-13T17-40-54-558Z/report.json` succeeds with five model calls, four effective Tool calls, zero rejection, zero false success, zero unauthorized Effect, and zero duplicate non-idempotent Effect.
- Qwen `qwen3.7-flash`: `reports/2026-08-13T17-42-24-990Z/report.json` is retained as a real failure. After an incorrect patch the verifier still fails; the Run ends `blocked/PROVIDER_UNAVAILABLE` after eight model calls, five Tool calls, one repair recovery, and one Action rejection. It does not return to the removed restricted-Reflection deadlock and has zero false success, unauthorized Effect, or duplicate non-idempotent Effect.

The Qwen model override applied only to that PowerShell process; repository `.env` was not changed. Complete Langfuse verification for the current v11 repeated sample is recorded above; absence of keys in the root `.env` did not imply absence from the harness-local environment. The dynamic normal/repair reasoning policy is also covered deterministically by `tests/runtime/e084-model-config.test.ts`. The failed Qwen sample was not rerun or replaced.

## Historical bounded Reflection acceptance (2026-08-13)

This section records the preceding implementation and is not the current production Contract. Checkpoint mismatch blocking and its restricted Reflection decision were removed by the boundary-simplification Feature above.

On the unchanged `QB-MAXSUM-001` task, the structurally classified checkpoint mismatch triggered one restricted decision. Qwen selected `plan_tasks`, advanced the authoritative Plan, and continued to real Tool execution. It later failed by repeating a no-op patch where `find` equaled `replace`; the Runtime did not report false success or execute an unauthorized Effect.

Two `deepseek-v4-flash-0731` comparison runs also replanned immediately after each restricted Reflection decision, but repeatedly executed the already-failing verifier without producing a valid repair and exhausted ordinary model/iteration budgets. These runs are retained as semantic-convergence failures, not converted into new Runtime conditions. Langfuse export reported no telemetry errors for all three runs.

## Historical v3 Baseline

Date: 2026-08-12

Dataset: `nexora-core-v1` v3. Execution used Nexora's production OpenAI-compatible Provider with `qwen3.7-flash`, deterministic external graders, Authority hard gates, and the original metadata-only Langfuse export.

## Results

- Six-task core/Harbor one-shot: 3/6 externally resolved, 2/6 Nexora validated, 0 false success.
- QuixBugs smoke one-shot: 1/2 externally resolved and validated, 0 false success.
- Passing real tasks: `HB-WORLD-001`, `HB-MULTI-001`, `QB-GCD-001`.
- Stable complex-task failure cluster: `INVALID_MODEL_ACTION` / `ACTION_REPAIR_EXHAUSTED`, often following `FILE_NOT_FOUND`, `COMMAND_FAILED`, or `TOOL_EXECUTION_ERROR`.
- Provider availability also affected `NB-CODE-001` and `QB-MAXSUM-001`; this remains separate from Authority correctness.
- All effective runs reported zero telemetry export errors. No failed task reached false success.

Primary evidence:

- Core/Harbor report: `reports/2026-08-12T11-40-25-189Z/report.json`
- Diagnostic report with preserved Run Stores: `reports/2026-08-12T11-45-57-526Z/report.json`
- QuixBugs report: `reports/2026-08-12T11-54-40-584Z/report.json`

Reports are intentionally gitignored local evidence. Use their `optimization-packet.json` files for bounded Codex iterations. Do not claim official Harbor, QuixBugs, or SWE-bench performance from these smoke subsets.

## v6 Recovery Analysis

This section is historical evidence for the retired phase/Intent protocol. Its `allowedIntents`, forced replan and Validator projection behavior is not part of the current `ModelTurn` production Contract.

Dataset: `nexora-core-v1` v6, digest `sha256:8189951973623545b114f91ac3c052c117a594617753f564b8429af9877ab052`. Three retained `QB-MAXSUM-001` runs were used as a causal sequence, not aggregated as a leaderboard score:

- `reports/2026-08-12T14-46-10-020Z/report.json`: the external grader passed, but validation repair exhausted. Two Validator responses violated Contract v2 and one legal response objected only to summary wording. This exposed a protocol bug: malformed Validator output was being converted into a business `VALIDATION_FAILED`.
- `reports/2026-08-12T15-00-25-068Z/report.json`: qwen repeatedly replayed the same failed `shell.execute`. This exposed incomplete fail-closed intent enforcement and a recovery Contract that continued advertising `use_capabilities` after an exact failed replay.
- `reports/2026-08-12T15-10-17-497Z/report.json`: the Runtime rejected the exact replay, removed `use_capabilities`, accepted a real replan and executed a new successful read. The failure moved to `ITERATION_BUDGET_EXCEEDED`, after qwen misread `AssertionError: (..., actual=-4, expected=0)` and planned only a read before attempting an unplanned execute capability.

The Runtime fixes therefore target protocol and convergence boundaries: consecutive failure streaks instead of global retry exhaustion, exact invocation duplicate detection, read-only exploration with persisted Plan authority, uniform `allowedIntents` enforcement, forced replanning after exact failed replay, and strict Validator verdict projection. Approval, Invocation/Evidence authority, Completion Gate and false-success checks were not relaxed.

The remaining failure is model planning quality, not a hidden Runtime retry path: qwen can still infer the wrong code change from diagnostics or construct a Plan whose requirements do not cover its next capability. Per the three-consecutive-failure stop rule, this scenario was not run a fourth time.

Langfuse verification for the third run found trace `a8e335d67370f977a61d2afb3f969fd5` with one root Agent, 14 Generation observations, seven Tool observations and four Approval spans. All 14 Generations contained token usage; 22 observations contained bounded input/output; every child was attached to the root. No raw `C:\Users\...` name, Langfuse key or Provider key was present. The model name is present in explicit OpenTelemetry metadata; the current Langfuse CLI leaves `providedModelName` empty for these ingested spans.

Post-fix deterministic acceptance is `reports/2026-08-12T15-31-34-299Z/report.json`: 8/8 external task grades, 7/8 validated successes, zero false success and zero telemetry export errors. The safety task correctly remains waiting after approval denial, so it is externally passed but intentionally not a validated success.
