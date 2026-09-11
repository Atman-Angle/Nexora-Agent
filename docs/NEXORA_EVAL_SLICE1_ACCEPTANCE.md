# Nexora Eval Suite — Slice 1.5 Acceptance / Failure Audit

## 1. Overall decision

**CONDITIONAL GO — READY_FOR_SLICE_2A.**

Slice 1 has no remaining blocking Eval-architecture defect after separating the Authority and Safety verdicts in this audit. It is not a release-ready V1 benchmark: there is no formal V2 Dataset, no host-level sealed sandbox, and no completed release cohort. The deterministic-provider completion incompatibility described below was subsequently fixed and verified as a separate Harness compatibility change.

This audit retained only the existing migration-pilot identifiers: `HB-WORLD-001`, `NB-RETRY-001`, `NB-RECOVERY-001`, and `NB-SAFETY-001`. It created no task package or Dataset.

## 2. Acceptance matrix

| Criterion | Status | Implementation evidence | Test evidence | Remaining gap |
|---|---|---|---|---|
| Task Contract v2 | PARTIAL | `contracts.ts`: V2 separates `agentVisible`, `execution`, `expectedOutcome`, `sealed`, and identity fields. | V2 parsing and identity tests. | It does not yet include every final Spec field (for example visible workspace/tool-catalog policy and full sealed reset/reference package). |
| V1 compatibility | PASS | V1 parser remains public; loader accepts V1 and V2. | Existing V1 lifecycle/component tests compile and run. | Formal report source-schema normalization has not yet been exercised with a V2 package. |
| Split contract | PARTIAL | `dataset-policy.ts` checks declared major-family representation and family difficulty coverage in validation/holdout. | Stratification test. | It does not enforce the final 24/18/18 quotas or matched per-family quotas; those belong to formal Dataset release validation. |
| Sealed grader | PARTIAL | V2 uses runner-only `sealed.graderRef`; fixture copy uses only `execution.fixture`. | Path-traversal rejection test. | No private grader process or host mount namespace. |
| Task Grader | PASS | Existing deterministic file, command, and unchanged-path grader. | Existing filesystem/lifecycle coverage. | V2 sealed package execution remains unexercised. |
| Runtime Grader independence | PASS | `suite-grader.ts` uses persisted RunView facts only. | Static dependency-boundary test plus stale-Evidence test. | It deliberately shares runtime schemas/types, not production decisions. |
| Authority Grader | PASS | `gradeAuthority` independently checks task-declared persisted Event/Invocation/Evidence/Artifact facts. | Suite unit coverage and report output include its verdict/checks. | Needs V2 task execution coverage. |
| Safety Grader | PASS | `gradeSafety` separately checks approval-before-mutation and forbidden Tools. | Approval-before-mutation test. | Forbidden paths and complete side-effect ledger need sealed V2 task integration. |
| ExpectedOutcomePolicy | PARTIAL | Explicit accepted terminals, stop reasons, and confirmation requirement are evaluated. | Expected-confirmation test. | Spec’s typed resume-predicate and mutation-count rules are not yet represented. |
| STRICT_PASS | PASS | V2 combines Task, Runtime, Authority, Safety, and ExpectedOutcome verdicts. | False-success and stale-Evidence tests. | V1 pilots intentionally retain legacy grade semantics. |
| Digest identity | PARTIAL | Fixture, task, grader, and tool catalog identities are validated/projected. | V2 identity/path test. | Dataset-wide fixture/grader directory digests are not yet release-gated. |
| Report v2 | PARTIAL | Newly emitted reports use schema version 2 and include strict fields/checks. | Report V2 test. | No JSON schema/reader migration implementation for external consumers. |
| Historical report compatibility | PARTIAL | Type accepts v1 and v2; existing test fixture remains v1-shaped. | Report test constructs a V1 report. | No explicit parser validates archived JSON reports. |
| Dataset validator | PARTIAL | `validateStratifiedSplits` is exported. | Stratification test. | Not wired as mandatory formal-release validation. |
| `firstBrokenBoundary` | PARTIAL | Report classifies authority, safety, runtime, outcome, and legacy failures. | Existing report/optimization tests. | Per-verdict boundary fields are not yet separately persisted; the task-level boundary is the authoritative first failure. |
| `unsupported_host_isolation` semantics | PASS | V2 report explicitly emits `unsupported_host_isolation`. | Report V2 test. | This is an honest limitation, not a security guarantee. |

## 3. Grader architecture

The implementation now has five distinct V2 verdicts:

1. **Task Grader** — sealed deterministic workspace checks in `grader.ts`.
2. **Runtime Grader** — `gradeRuntimeIntegrity`: Attempt→Invocation integrity, Evidence provenance/currentness, durable completion Result, and Result→Evidence integrity.
3. **Authority Grader** — `gradeAuthority`: only declared persisted Event, Invocation, Evidence-count, and Artifact-count expectations.
4. **Safety Grader** — `gradeSafety`: approval before protected mutation and declared forbidden-tool checks.
5. **ExpectedOutcomePolicy** — `gradeExpectedOutcome`: accepted terminal, accepted stop reason, and confirmation requirement.

`STRICT_PASS` is exactly the conjunction of all five. The V2 report retains each non-task verdict’s pass/fail and checks; task-level `firstBrokenBoundary` maps safety to `APPROVAL`, authority to `ACTION_CONTRACT`, and runtime-invariant failure to `EVIDENCE` before later outcome classification. Legacy `AuthorityGrade` remains for V1 compatibility and its historical hard gates; it is not reused as the V2 Safety verdict.

## 4. Runtime Grader dependency proof

`suite-grader.ts` imports only `@nexora/harness` public fact types (`RunInspection`, `RunView`, `RuntimeTool`), the Eval contract schemas/identifiers, and Eval Task Grader type data. Its import graph contains no production `CompletionGate`, recovery reducer, status-transition function, or Runtime instance.

Permitted shared dependencies are persisted schema/type definitions, IDs, digests, tool contracts, and authoritative persisted facts: Run snapshot, Plan-linked Invocation, Attempt, Evidence, Result, Approval Event, and Event sequence. The checker independently rebuilds its own referential/currentness/completion invariants from those facts. It does not ask production code whether a Run is complete.

## 5. `NO_PROGRESS_DETECTED` failure investigation

Affected telemetry scenarios are `HB-WORLD-001` and `NB-RETRY-001`.

| Stage | Observed chain |
|---|---|
| User task | Create `hello.txt` exactly / retry a transient read then persist and validate its result. |
| Plan and decisions | The deterministic scenario provider emits plan control, declared Tool calls, then a plain-text summary. |
| Tools and workspace | Required Tool Invocation(s) and Attempts succeed; the expected workspace state is created. |
| Evidence | Successful Tool Evidence is persisted. |
| Completion | Current deterministic runs emit the provider-native `nexora_respond` final control and pass the Runtime completion contract. |
| Convergence | Current deterministic runs complete as `succeeded` without response rejection or `NO_PROGRESS_DETECTED`. |

The historical observation was a Harness adapter incompatibility: ordinary final text was emitted after successful tools while the Runtime required provider-native completion control. The adapter in `harness/nexora-bench/src/scenario.ts` now emits `nexora_respond`; current deterministic runs of `HB-WORLD-001` and `NB-RETRY-001` pass with no `FINAL_CONTROL_REQUIRED` response rejection. The Runtime completion contract remains strict: ordinary assistant text cannot complete a Run.

This was not an Eval defect or a Runtime defect. It was a previously hidden deterministic Harness/test-adapter compatibility failure exposed by the benchmark’s strict terminal gate and is now resolved. Accepting plain text would still violate the Runtime contract.

The required separate follow-up record is:

```yaml
ROOT_CAUSE: Historical deterministic benchmark provider returned ordinary final text after successful tools instead of the required provider-native final completion control.
RESOLUTION: The adapter now emits exactly one valid final control using persisted evidence/results; focused deterministic verification passes.
EXPECTED_BEHAVIOR: The Runtime applies its unchanged Completion Gate after the valid provider-native final control.
AFFECTED_CONTRACT: Harness deterministic-provider response contract and existing FINAL_CONTROL_REQUIRED Runtime completion protocol.
MINIMAL_FIX_SCOPE: harness/nexora-bench/src/scenario.ts and focused deterministic scenario tests only; no Runtime, Eval Grader, fixture, or task expectation change.
REGRESSION_TEST_REQUIRED: HB-WORLD-001 and NB-RETRY-001 reach succeeded with correct Result/Evidence; a plain-text final response remains rejected and cannot be graded as success.
```

## 6. Eval defects vs. Runtime defects

- **Fixed Eval defect:** Authority and Safety had been combined as `Safety/Authority`. They are now independently graded, reported, and included in `STRICT_PASS`.
- **Not a Runtime defect:** the two `NO_PROGRESS_DETECTED` results. They are correct Runtime enforcement of a bad Harness final response.
- **Not fixed in this Slice:** host sandbox containment, because changing it would exceed the requested audit scope.

## 7. Isolation limitations

Current code establishes that the grader reference is resolved by the runner, is not copied with the fixture, is not inserted into the user instruction, and is not serialized by bench telemetry’s root input (which contains only instruction and expected terminal). The normal runner path grades after execution; it does not send grader material to the provider.

It does **not** prove Windows host-level process containment, absolute/path-traversal containment for arbitrary shell processes, repository isolation, private grader execution, or redaction of every possible error/Artifact route. The only accurate current report value is `unsupported_host_isolation`.

## 8. Must fix before Slice 2 execution evidence

1. Add a real V2 migration-pilot package with runner-resolved sealed material before claiming V2 end-to-end execution.
2. Add a report parser/validation contract before using V2 reports as external compatibility evidence.

## 9. May defer

- 60-task Dataset and release quotas.
- Real-provider benchmark and reliability cohort.
- Private/public holdout custody service.
- OS/container sandbox and shell mount namespace.
- Full directory-level release digests and fault catalog.

## 10. Slice 2A decision

**READY_FOR_SLICE_2A.** The next Slice may begin with the listed preconditions tracked explicitly. It must not count or release Dataset capability results until the deterministic Harness completion compatibility failure is resolved, and it must retain `unsupported_host_isolation` until a separately designed containment boundary exists.
