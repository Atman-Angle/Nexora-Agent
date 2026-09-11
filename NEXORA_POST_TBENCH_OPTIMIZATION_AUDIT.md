# Nexora Post-Terminal-Bench Optimization Audit

> Audit date: 2026-09-04  
> Scope: current working tree, official Terminal-Bench 2.0 full-89 evidence, retained Runtime facts/trajectories, Runtime Acceptance, Fault Lab and regression evidence  
> Change boundary: audit and optimization spec only; no Runtime or Harness production code was changed

## 1. Executive Summary

Nexora's primary bottleneck has moved from **basic Runtime reliability** to **Harness capability and the model-facing control interface**. The Runtime now closes 87/89 official tasks cleanly, preserves the inspected Authority and Safety invariants, and has deterministic evidence for the critical recovery boundaries. The 20/89 external pass rate (22.47%) is therefore not explained by a generally unstable execution engine. It is also not evidence that every remaining failure is caused by the Harness.

The most defensible conclusion is narrower:

- Runtime reliability is sufficiently stable to freeze its authorities and begin bounded Harness optimization.
- The control protocol imposes a measurable capability tax: 61/88 projected runs attempted an effect before satisfying `TASK_CONTRACT_REQUIRED`; state rejection counts include 92 protected-mutation batch rejections, 26 unauthorized scope revisions, 24 invalid scope relations and 13 duplicated required outcomes.
- All 54 `FAILED_TASK` runs ended at `NO_PROGRESS_DETECTED` with `repeated_invalid_response`, repeat count 2. The current convergence implementation can combine two equal state rejection codes across intervening successful tool progress and fail immediately on the second occurrence.
- The full-89 evidence does **not** support the published claim that there was only one false-success candidate. There are five `SUCCEEDED + external=0` rows: three confirmed product-level false successes and two external-verifier infrastructure failures with indeterminate product outcome.
- The six `external=1 + FAILED_TASK` rows are valuable completion-friction samples, but they are not six proven Runtime defects. Three show clear control/completion friction, two are mixed model/Harness failures, and one exposes a mismatch between a narrower external verifier and the stricter Runtime-owned Plan.
- Context Engineering is architecturally sound and prompt caching is effective, but this Terminal-Bench cohort does not demonstrate a compaction/rehydration advantage: zero calls compacted and zero tokens were evicted. Dynamic-state duplication and provider-token underestimation remain real costs.

The three highest-value optimization targets are:

1. **Progress-anchored convergence with one structured repair turn**, while retaining a hard no-progress bound.
2. **A compact, deterministic next-legal-action and completion-blocker projection**, while retaining the Completion Gate unchanged.
3. **A model-facing protected-action/environment affordance**, so each turn states the exact action budget and known executable/workspace facts without weakening effect classification or Approval.

The first experiment should isolate progress-anchored convergence on a fixed repeated-state-rejection cohort, with the same model, provider, task images and budgets. It should proceed only if valid completion improves without any decline in Safety, Authority, closure, idempotency or false-success rate.

## 2. Audit Method and Evidence Precedence

This audit used the current worktree as the baseline. The repository already contained modified and untracked Runtime, Harness, reports and retained Harbor outputs; none were treated as disposable or overwritten.

Evidence precedence was:

1. official external verifier output and final consolidated machine data;
2. per-run SQLite Runtime facts, Events, Invocations, Attempts, Evidence and model-call telemetry;
3. retained model turns and Harbor artifacts;
4. current implementation;
5. narrative reports.

Where a report conflicts with final machine evidence, this audit uses the machine evidence and records the drift. The final cohort was reconstructed from the 88 available projections in these jobs, with later reruns replacing earlier rows:

- [`2026-09-04__02-56-40`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/)
- [`2026-09-04__09-08-07`](harness/nexora-bench/harbor/jobs-output/2026-09-04__09-08-07/)
- [`2026-09-04__09-51-53`](harness/nexora-bench/harbor/jobs-output/2026-09-04__09-51-53/)
- final aggregate: [`nexora-terminal-bench-full89-consolidated-v2.json`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/nexora-terminal-bench-full89-consolidated-v2.json)

The reconstructed row set exactly reproduces the v2 aggregate counts. `video-processing` is the one task without a Runtime projection and is retained as the infrastructure exception.

## 3. Current System State

### 3.1 Official full-89 result

| Measure | Result | Interpretation |
|---|---:|---|
| Official tasks | 89 | Complete official cohort |
| Runtime projections | 88 | One infrastructure exception |
| External pass | 20/89 (22.47%) | Official product-result score |
| Validated success | 14/89 (15.73%) | Runtime `SUCCEEDED` and external pass |
| Runtime `SUCCEEDED` | 19/89 | Includes five external non-passes |
| Clean execution closure | 87/89 (97.75%) | All except one dead-end and one exception |
| Unexpected Runtime dead-end | 1 | `nginx-request-logging`, `TOOL_RESULT_UNKNOWN` |
| Infrastructure exception | 1 | `video-processing` |

Final closure distribution:

| Closure | Count |
|---|---:|
| `FAILED_TASK` | 54 |
| `SUCCEEDED` | 19 |
| `BLOCKED_EXTERNAL` | 9 |
| `CANCELLED` | 5 |
| `UNEXPECTED_RUNTIME_DEAD_END` | 1 |
| No projection / infrastructure exception | 1 |

### 3.2 The required two-dimensional result table

The official result and Runtime terminal must be reported separately:

| External result | Runtime/closure result | Count | Meaning |
|---|---|---:|---|
| pass | `SUCCEEDED` | 14 | validated success |
| pass | `FAILED_TASK` | 6 | externally correct workspace, invalid Nexora completion |
| non-pass | `SUCCEEDED` | 5 | 3 confirmed false successes + 2 verifier-infrastructure indeterminate |
| non-pass | `FAILED_TASK` | 48 | product non-pass with bounded Runtime failure |
| non-pass | `BLOCKED_EXTERNAL` | 9 | external/provider block |
| non-pass | `CANCELLED` | 5 | cancelled before valid completion |
| non-pass | unexpected dead-end | 1 | Runtime recovery failure |
| non-pass | infrastructure exception | 1 | no projection |

This table prevents `SUCCEEDED`, external pass and validated pass from being conflated.

## 4. What Is Already Stable

The following boundaries have both implementation support and current deterministic or real-path evidence. They should be treated as guarded invariants, not optimization targets:

- State Machine ownership of Run status.
- Run-owned Structured Plan as the current-plan authority.
- persisted Tool Invocation/Attempt as the side-effect and recovery authority.
- Approval before protected effects.
- unknown non-idempotent effect confirmation semantics.
- Evidence provenance and digest checks.
- deterministic Completion Gate, including stale-evidence rejection.
- workspace containment.
- append-only event/audit provenance.
- no observed Authority bypass, unsafe invocation or duplicate non-idempotent effect in the final projections.
- Harbor external verifier as the product-result authority for Terminal-Bench.

Current supporting evidence includes:

- Fault Lab catalog v2.1.0 contains 28 named cases in [`fault-catalog.json`](harness/nexora-bench/fault-catalog.json). The current acceptance report records 28/28 and maps each case to an e-test pattern.
- The acceptance report records Bench 26/26 and Harbor Python 18/18; EDD-004 records the added native-toolchain bootstrap test.
- The final projections retain `runtimeIntegrity=1`, `authority=1` and `safety=1` for the inspected runs.
- [`completion-gate.ts`](packages/runtime/src/completion-gate.ts#L77) filters eligible evidence and checks provenance; lines 172-211 enforce required checks and emit `CHECK_EVIDENCE_STALE`.
- [`runtime.ts`](packages/runtime/src/runtime.ts#L2327) admits parallel calls only for idempotent reads, and its protected-mutation rule rejects an unsafe batch before execution.

There is a material evidence limitation: [`NEXORA_RUNTIME_ACCEPTANCE_REPORT.md`](NEXORA_RUNTIME_ACCEPTANCE_REPORT.md#L73) records the canonical `pnpm run test:runtime-harness-release` suite at 86/105, with 19 failures across eight files. The report attributes these to stale expectations for `blocked` versus current `failed` `NO_PROGRESS_DETECTED` semantics and records targeted suites as green. This audit did not rerun or silently reinterpret that red canonical gate. Therefore the stable claim is about the evidenced invariants and real projections, not an assertion that every repository regression command is green.

The EDD-001 through EDD-004 changes are supported as general fixes and should be preserved behind regression coverage:

- completion rejection repair guidance;
- acceptance of `/app/...` paths that are inside the workspace;
- Node/corepack bootstrap;
- native toolchain plus `/app` bootstrap.

## 5. Evaluation Metric Audit

### 5.1 `falseSuccess` is not valid for open Terminal-Bench tasks

The current field does not compare Runtime success to the official Harbor result:

- [`open-task.ts`](harness/nexora-bench/src/open-task.ts#L102) constructs open tasks with an empty internal grader: no files, commands, unchanged paths or authority requirements.
- [`runner.ts`](harness/nexora-bench/src/runner.ts#L411) grades that internal task and defines false success at line 419 as `Runtime succeeded && internal taskGrade failed`.
- [`verifier.py`](harness/nexora-bench/harbor/nexora_harbor/verifier.py#L75) copies the already-produced `task.falseSuccess`; it does not recompute against `externalResult`.

For normal open-task executions, the empty internal grader passes. Consequently every final projection has `falseSuccess=false`, including the five `SUCCEEDED + external=0` rows.

Required reporting semantics:

- `runtimeSucceeded`: whether the deterministic Runtime completion contract passed;
- `externalPassed`: whether Harbor's authoritative external verifier passed;
- `validatedSuccess`: both are true;
- `benchmarkFalseSuccess`: Runtime succeeded and the external product assertion actually failed;
- `externalIndeterminate`: the external verifier did not reach product assertions because its own setup failed.

Runtime `SUCCEEDED` means that persisted evidence satisfied the declared Runtime Plan/check contract. It cannot mean independent product correctness unless externally authoritative checks are integrated into that contract.

### 5.2 All five `SUCCEEDED + external=0` rows

#### `dna-insert`: confirmed product-level false success

The model authored and ran its own verification script. That script reported a primer-temperature delta of 0.282°C, so all declared Plan checks had successful Tool Results and Completion was accepted. The official verifier calculated forward 66.274364°C, reverse 59.311917°C and delta 6.962447°C, exceeding the required 5°C.

- First broken boundary: model reasoning/self-verification semantics.
- Runtime behavior: correct relative to its declared evidence contract.
- Harness contribution: possible check-quality affordance gap; unproven.
- Stronger-model expectation: likely improvement, but requires an A/B model comparison.

Evidence: retained trajectory and verifier artifacts under [`dna-insert`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/).

#### `mteb-retrieve`: confirmed product-level false success

The model produced HumanEval as the fifth-ranked item. The official expected item was `MTEB: Massive Text Embedding Benchmark`. Runtime accepted successful model-authored verification/readback commands.

- First broken boundary: task interpretation or embedding invocation semantics.
- Runtime behavior: correct relative to declared checks.
- Harness contribution: no confirmed Runtime defect.
- Stronger-model expectation: likely improvement; environment/invocation consistency remains a secondary hypothesis.

Evidence: retained trajectory and verifier artifacts under [`mteb-retrieve`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/).

#### `polyglot-c-py`: confirmed product-level false success

The official verifier required only `main.py.c` in `/app/polyglot` but found an extra generated binary, `cmain`. The final model summary acknowledged that Python execution was not possible and only the C path was verified. The Plan omitted an output-shape/cleanup criterion, yet the model overclaimed completion.

- First broken boundary: incomplete Plan/verification plus model overclaim.
- Runtime behavior: correct relative to declared checks.
- Harness contribution: a concise outcome/checklist affordance may help; this is a hypothesis.
- Stronger-model expectation: likely improvement, though strong models can also omit negative/cleanup requirements.

Evidence: retained trajectory and verifier artifacts under [`polyglot-c-py`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/).

#### `extract-elf`: external result indeterminate

The Runtime completed and produced `extract.js`. The Harbor verifier failed while downloading CPython from GitHub after three retries. It did not reach an assertion failure.

- Classification: verifier infrastructure failure, not demonstrated product false success.

Evidence: retained verifier output under [`extract-elf`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/).

#### `pytorch-model-recovery`: external result indeterminate

The Runtime completed with detailed verification. The Harbor verifier timed out while downloading/extracting `nvidia-cusparselt-cu12` and did not produce a task assertion result.

- Classification: verifier infrastructure failure, not demonstrated product false success.

Evidence: retained verifier output under [`pytorch-model-recovery`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/).

### 5.3 Narrative report drift

[`NEXORA_RUNTIME_RELEASE_ASSESSMENT.md`](NEXORA_RUNTIME_RELEASE_ASSESSMENT.md#L62) names only `sanitize-git-repo` as a false-success candidate. In the final consolidated evidence, `sanitize-git-repo` is a validated external pass. The same report retains an earlier 14 `BLOCKED_EXTERNAL` figure and says 21 tasks remain pending, while final v2 has 9 blocked and a completed 89-task cohort. [`NEXORA_RUNTIME_ACCEPTANCE_REPORT.md`](NEXORA_RUNTIME_ACCEPTANCE_REPORT.md#L69) likewise still says the full-89 cohort is in progress.

These reports are valuable historical records but are not the final metric authority.

## 6. Failure Cluster Analysis

### 6.1 Aggregate execution pressure

Across the 88 projected tasks:

- 1,002 model calls; median 8 per task; maximum 38.
- 851 Tool calls; median 7 per task; maximum 76.
- Plan sizes: 0 steps (13 tasks), 2 (3), 3 (20), 4 (14), 5 (13), 6 (16), 7 (7), 8 (1), 9 (1).

Observed rejection-code totals:

| Rejection code | Count |
|---|---:|
| `PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME` | 92 |
| `TASK_CONTRACT_REQUIRED` | 61 |
| `TASK_SCOPE_REVISION_REQUIRES_NEW_USER_INPUT` | 26 |
| `PLAN_SCOPE_RELATION_INVALID` | 24 |
| `PLAN_SCOPE_REQUIRED_OUTCOME_DUPLICATED` | 13 |
| `PLAN_SCOPE_REQUIRED_OUTCOME_UNCOVERED` | 9 |
| `EXECUTION_UNIT_OBSERVATION_BARRIER` | 7 |
| `FINAL_CONTROL_REQUIRED` | 4 |
| `MUTATION_VERIFICATION_REQUIRED` | 3 |
| `PLAN_REMOVE_INVALID` | 2 |
| `PLAN_UNCHANGED` | 2 |

These counts show friction exposure, not causal attribution. One model mistake can produce multiple rejections, and one task can appear in several clusters.

### 6.2 `NO_PROGRESS_DETECTED`

All 54 `FAILED_TASK` rows ended with:

- `stopReason = NO_PROGRESS_DETECTED`;
- diagnostic kind `repeated_invalid_response`;
- repeat count 2.

Terminal repeated-issue clusters among those 54 were dominated by protected-action batching (34), followed by scope revision (7). Smaller terminal clusters included two completion `response_rejected` cases, one mutation-verification case, one duplicated-required-outcome case and one invalid scope relation; five runs terminated after repeated schema errors.

Within the 48 `external=0 + FAILED_TASK` rows, 36 encountered `PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME` at least twice somewhere in the run. This is a high-signal candidate cohort, not proof that all 36 would have passed without the rule or with better guidance.

### 6.3 Six `external=1 + FAILED_TASK` rows

| Task | What happened | Attribution | Confidence |
|---|---|---|---|
| `distribution-search` | `dist.npy` passed externally; producing step remained active; two plan revisions were rejected as duplicated required outcomes | Plan repair/control affordance friction | high |
| `modernize-scientific-stack` | all four steps completed; completion rejected twice for stale check evidence despite successful intervening reads and Python verification; execute invalidated earlier reads | completion ordering + convergence friction | high |
| `cancel-async-tasks` | correct `run.py` existed; cleanup verification relied on unavailable git; repair attempts hit scope-revision and invalid-removal rules | Plan repair/environment-verification friction, with model contribution | high |
| `sparql-university` | all steps completed and external verifier passed; model continued local validation after missing rdflib/tooling and attempted invalid scope changes | mixed model noncompliance and verification affordance | medium |
| `kv-store-grpc` | dependencies, files, persistent server, process inspection and live SetVal/GetVal all succeeded; model then rewrote identical `server.py` twice and failed duplicate-invocation convergence | mixed model repetition and control/progress projection friction | high |
| `git-leak-recovery` | model recovered and wrote the secret, but the projected Plan still showed purge and preservation checks unfinished; it batched two `git` executes and failed on the second occurrence | external verifier was narrower than Runtime-owned Plan; model did not finish its own Plan | high |

Raw evidence is in the corresponding trial directories. Two particularly diagnostic databases are:

- [`git-leak-recovery/runtime-v1.1.db`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/git-leak-recovery__JVnvaQJ/artifacts/logs/artifacts/nexora-run-data/runtime-v1.1.db): events 39 and 89 contain the two protected-batch rejections; successful recovery/read/write activity occurs between them; event 90 fails the run.
- [`kv-store-grpc/runtime-v1.1.db`](harness/nexora-bench/harbor/jobs-output/2026-09-04__02-56-40/kv-store-grpc__e6ujzYp/artifacts/logs/artifacts/nexora-run-data/runtime-v1.1.db): live RPC validation and process inspection succeed; events 146 and 163 reject an identical already-succeeded `filesystem.write`; event 164 fails the run.

### 6.4 How much of the 69 external non-passes shows Nexora friction?

There is no honest single causal count in the current one-model, one-treatment dataset.

- **Strict confirmed lower bound:** 1/69, `nginx-request-logging`, is a confirmed Runtime recovery-policy dead-end.
- **Not valid product failures:** 2/69 (`extract-elf`, `pytorch-model-recovery`) are external-verifier infrastructure-indeterminate.
- **Confirmed product false successes:** 3/69 (`dna-insert`, `mteb-retrieve`, `polyglot-c-py`) are primarily model/check-definition failures. They expose the limit of model-authored checks but do not prove a Runtime defect.
- **High-signal friction exposure:** 36/69 were `FAILED_TASK` rows that encountered the protected-batch rejection at least twice. Adding the separate dead-end gives 37/69 external non-passes with obvious Runtime/Harness interaction friction. This is a candidate cohort, not 37 caused failures.

The range that should guide planning is therefore **1 confirmed Nexora-caused external failure, with 37/69 high-signal friction-exposed failures requiring A/B attribution**. Reporting all 54 `FAILED_TASK` rows as Harness-caused would overstate the evidence.

## 7. Model vs Harness vs Runtime Attribution

| Failure class | Model limitation | Harness friction | Runtime defect/policy | Confidence |
|---|---:|---:|---:|---|
| Wrong domain result accepted by model-authored checks (`dna-insert`, `mteb-retrieve`) | high | low/unknown | none shown | high |
| Missing negative/output-shape criterion (`polyglot-c-py`) | high | medium hypothesis | none shown | high |
| Protected calls batched despite explicit rejection | medium-high | high: prompt permits up to eight calls while policy admits one protected effect | policy is safe; interface mismatch | high |
| Scope/replan rejection loops | medium | high: exact relation/coverage/removal protocol is costly | no authority defect shown | high |
| Stale-evidence completion loops | medium | high: legal verification ordering is hard to infer | convergence can terminate too early | high |
| Duplicate successful invocation (`kv-store-grpc`) | high | medium: progress projection did not redirect to exact remaining blocker | safe duplicate guard behaved correctly | high |
| Narrow external verifier vs stricter Plan (`git-leak-recovery`) | medium | low | none; Runtime correctly retained unfinished outcomes | high |
| Provider/network dependency failure | low | low | none | high |
| `TOOL_RESULT_UNKNOWN` dead-end | low | medium | confirmed recovery-policy defect/capability gap | high |
| Long-context decision degradation | unknown | medium hypothesis: duplicated state | token meter underestimation is confirmed | medium |

Would a stronger model make failures disappear?

- Likely to improve: domain calculation, task interpretation, schema compliance, avoiding an admitted extra artifact, obeying “one protected action” after a rejection, and duplicate-action avoidance.
- Likely to remain as unnecessary friction: two equal rejection codes separated by authoritative progress still terminate at repeat 2; stale-evidence ordering remains implicit; Plan repair requires exact internal relations/IDs; `shell.execute` remains classified as a protected non-idempotent execute even for observational commands; duplicated dynamic state remains costly.
- Unknown until controlled A/B: how much of the 36-task protected-batch cohort converts to external pass under a stronger model alone.

## 8. Harness Capability Bottlenecks

### 8.1 The model sees state, but must derive the next legal action

[`prompt.ts`](packages/harness/src/prompt.ts#L234) projects overlapping dynamic representations:

- `originalTaskContract`: continuation, all user inputs and derived Task Contract;
- `currentPlanAndChecks`: full Plan, progress, removable steps, active Invocations and all Evidence;
- `observationsAndRepair`: observations, repair, rehydrated facts and memory candidates;
- `controlState`: phase and outcome summaries;
- hybrid `currentState`, `recentTrajectory` and `workingSet`;
- `latestUserInput`, duplicating the latest item from input history.

This does not create a second code-level Authority, but it creates duplicated model-visible state. The model must reconcile broad outcomes with exact step/check IDs, infer which evidence became stale, infer the one permitted protected action, and decide whether Plan revision is legal.

[`planControlState()`](packages/harness/src/prompt.ts#L426) returns objective strings and generic phase guidance. It does not return:

- the exact active step and check IDs;
- the exact unmet Completion Gate blockers;
- which evidence became stale after which mutation/execute;
- the precise next legal control/tool action;
- the protected-action budget for the current Provider turn.

The strongest evidence is `modernize-scientific-stack`: the needed facts were present and successfully refreshed, but their ordering left earlier read evidence stale. Generic “check required validation facts” guidance did not encode the legal order.

### 8.2 Plan authoring and repair tax

The initial `nexora_update_plan` contract asks a model to produce a goal, Task Scope, task shape, required outcome IDs/descriptions/sources, assumptions, exclusions, completion criteria, resolution mode, ordered tasks, kinds, supports and checks. Revisions must preserve coverage and relations and remove existing steps by exact ID.

The Authority is justified. The model-facing authoring burden is not shown to be minimal:

- 61/88 tasks first crossed an effect boundary before establishing the required contract.
- scope relation, coverage and duplication rejections occurred 46 times in aggregate.
- scope revision requiring new user input occurred 26 times.
- externally correct `distribution-search` and `cancel-async-tasks` were unable to convert their current state into an admissible repaired Plan/completion.

The optimization target is a deterministic projection/compiler or constrained repair operation over Runtime-owned data, not a second Plan store and not removal of Plan Authority.

### 8.3 Tool affordance mismatch

[`shell.execute`](packages/runtime/src/execution/tool-runtime/index.ts#L328) accepts one native executable with explicit arguments, has effect kind `execute`, and is non-idempotent. [`command-resolution.ts`](packages/runtime/src/execution/tool-runtime/command-resolution.ts#L48) forbids shell/script wrappers. The contract explicitly rejects pipelines, redirections, compound expressions and built-ins.

Those restrictions are defensible. The interface still taxes terminal/coding work:

- common read-like commands such as `python3 -c ...`, compiler checks and `which` are protected execute effects;
- an execute after read checks can stale prior verification;
- more than one protected call in a Provider turn is rejected wholesale;
- the response schema can contain multiple tool calls, so the transport affordance and Runtime admission policy do not align;
- models spend turns discovering interpreters, packages, paths and shell semantics.

A generic “read-only shell” is unsafe unless effects can be credibly enforced. Safer affordances are a deterministic environment inventory and an explicit per-turn action budget.

## 9. Runtime Friction and Capability Tax

### 9.1 Convergence is bounded correctly but segmented too broadly

[`runtime.ts`](packages/runtime/src/runtime.ts#L2957) sets `minimumRepeats=2` for `repeated_invalid_response` and fails immediately at lines 2969-2970. Unlike other no-progress modes, it does not provide a warning/probation turn.

[`#noProgressDiagnostic`](packages/runtime/src/runtime.ts#L3125) collects up to eight state rejections after the last user-input resume. The `probationResolved` event helps segment later invocation analysis, but line 3141's state-rejection filter is bounded only by `lastInputResume`, not by successful authoritative progress or `probationResolved`. [`repeatedRejectionIssue`](packages/runtime/src/runtime.ts#L4193) counts equal issue fingerprints anywhere in that segment and returns once a count reaches two.

Therefore:

1. a state rejection occurs;
2. one or more Tool Invocations succeed and create new facts;
3. the same state code occurs later in a different local situation;
4. Runtime can still fail immediately as repeat 2.

`git-leak-recovery` demonstrates this across events 39 and 89. `modernize-scientific-stack` demonstrates successful verification between two stale-evidence completion rejections. Bounded convergence should remain, but its equivalence window should be experimentally tied to an authoritative-progress anchor.

### 9.2 Safety rules are not the optimization target

The following would increase benchmark freedom by weakening real guarantees and are rejected:

- allowing arbitrary protected batches;
- classifying arbitrary commands as reads from model declaration alone;
- replaying unknown non-idempotent effects;
- accepting stale check evidence;
- bypassing Approval;
- treating ordinary text as completion;
- letting the model mutate Run/Plan state directly.

The opportunity is to make the safe path obvious and executable in fewer decisions.

## 10. Context Engineering Assessment

### 10.1 What the cohort demonstrates

Across 88 runs:

- stable-prefix estimate was exactly 6,962 tokens on every call;
- 1,002 model calls were retained;
- prompt-cache attempt statuses were 994 `partial_hit`, 3 `miss`, 59 `unsupported`, 0 full hits and 0 disabled;
- 11,229,568 of 25,775,304 cache-eligible input tokens were reported cached (weighted 43.57%); median per-task cached ratio among 86 tasks with comparable data was 56.14%;
- initial measured input median was 8,380.5 tokens;
- final measured input median was 15,692 tokens;
- mean measured growth was 10,167 tokens;
- actual provider input median was 20,428.5 tokens;
- no task compacted, no call compacted and no tokens were evicted.

Prompt caching is a demonstrated operational advantage. Stable-prefix work should be preserved.

### 10.2 What the cohort does not demonstrate

Terminal-Bench supplies no empirical evidence here that automatic compaction, durable-fact selection or rehydration improved task decisions, because those paths never activated. Existing deterministic tests support their correctness, but calling them a Terminal-Bench capability advantage would exceed the evidence.

### 10.3 Confirmed risks

The estimator `nexora:utf8-bytes/4:v1` materially undercounts actual DashScope/qwen input. `fix-ocaml-gc` sequence 21 measured 87,554 input tokens but the provider reported 125,088 input and 4,774 output, totaling 129,862 against a 131,072 context window. `sanitize-git-repo` repeatedly used roughly 90k-103k actual input tokens.

This is a near-window reliability risk even though no cohort call compacted. Provider-aware calibration or a conservative safety margin is warranted before interpreting “within budget” as ample headroom.

The main capability hypothesis is that duplicated dynamic representations reduce useful information per token and decision quality. That hypothesis needs an A/B projection experiment; token reduction alone is not success.

## 11. Tool, Planning and Completion Assessment

| Area | Current value | Confirmed cost | Required direction |
|---|---|---|---|
| Tools | explicit schemas, containment, Approval, durable effects | terminal conventions do not map naturally; protected-call batching common | environment inventory + exact current action budget |
| Plan | durable scope and progress authority | high initial/revision schema burden; exact relation rules consume turns | deterministic authoring/repair projection over same authority |
| Evidence | durable, provenance-bound | successful command can prove only that command exited, not semantic truth | improve check selection and blocker projection, not evidence relaxation |
| Completion Gate | correctly rejects missing/stale checks | legal refresh order and exact blockers are implicit | project blockers and required order directly |
| Convergence | prevents infinite invalid loops | second equal state code can terminate despite intervening progress | re-anchor equivalence and add one bounded repair turn |

## 12. Architecture Findings

1. **Harness/Runtime boundary is mostly sound.** Runtime owns deterministic state, effects, Approval, Evidence and completion. Harness compiles model-visible context and provider interaction.
2. **Guidance is partly implemented in Runtime rejection payloads.** This is appropriate when guidance describes a violated deterministic contract. General strategy and concise navigation belong in Harness projection.
3. **Harness is not a second Authority, but it exposes an implicit navigation state machine.** `controlState`, coding phase, hybrid current state and repair directives overlap. Their derivation should remain deterministic and non-authoritative, but their presentation should be consolidated.
4. **Reliability has created a capability tax.** The tax is visible in Plan authoring, exact repair constraints, protected-call cadence, stale-evidence ordering and convergence segmentation.
5. **Most complexity is justified at the durable boundary.** The most removable complexity is duplicated projection and model-authored protocol ceremony, not persisted authorities.
6. **No evidence supports a rewrite.** The appropriate next phase is controlled interface experiments around the existing authorities.

## 13. KEEP / OPTIMIZE / EXPERIMENT / DO NOT TOUCH

### KEEP / FREEZE

- State Machine, Run, Plan, Invocation/Attempt and Evidence ownership.
- Approval and unknown-effect handling.
- Completion Gate correctness and stale-evidence rejection.
- workspace containment and append-only provenance.
- duplicate non-idempotent protection.
- typed closure semantics.
- Harbor external verifier authority.
- cache-stable system prefix.
- EDD-001-004 behavior and regressions.

### OPTIMIZE

- model-visible current control state, exact next legal action and Completion blockers;
- convergence segmentation after authoritative progress;
- bounded repair affordance after a state rejection;
- Plan authoring/repair ergonomics without changing Plan Authority;
- environment/capability introspection;
- alignment between Provider-turn tool-call affordance and protected-action admission;
- provider-aware context budget calibration;
- metric projection for validated success, benchmark false success and external indeterminate.

### EXPERIMENT

- deduplicated dynamic context;
- deterministic initial-Plan compilation or a constrained Plan patch format;
- check-quality prompts/checklist projection;
- stronger-model comparison on fixed failure clusters;
- a credibly enforced class of observational execution, only if effect enforcement can be proven.

### DO NOT OPTIMIZE YET / DO NOT TOUCH

- task-specific prompts, task-ID branches or verifier leakage;
- Terminal-Bench-specific Tool behavior;
- global budget increases;
- weakening Completion, Approval, Authority, containment or idempotency;
- automatic replay of unknown non-idempotent work;
- broad Runtime rewrite;
- adding a second Plan/progress/evidence store;
- special-case fixes for low-frequency domain failures before a general A/B signal exists.

## 14. Prioritized Optimization Opportunities

### P0-1 — Progress-anchored convergence and one bounded repair turn

- **Problem:** equal state rejection codes can terminate on the second occurrence even after successful authoritative progress.
- **Evidence:** Runtime lines 2957-2970 and 3125-3157; all 54 failed tasks ended as repeat-2 invalid responses; `modernize-scientific-stack` and `git-leak-recovery` contain intervening progress.
- **Root cause hypothesis:** state-rejection equivalence is scoped to user-input resume rather than the most recent authoritative-progress anchor, and the invalid-response path skips probation.
- **Affected layer:** Runtime convergence policy plus Harness repair projection.
- **Expected benefit:** fewer false-negative closures and more successful completion repair without raising global budgets.
- **Regression risk:** medium-high; a weak equivalence rule could permit loops or repeated unsafe intent.
- **Complexity:** medium.
- **How to evaluate:** Experiment A below, fixed cohort and repeated trials; inspect Events, physical effects and terminal causes.
- **Go:** statistically meaningful valid-completion gain, no safety/authority regression, no duplicate non-idempotent effect, bounded calls remain bounded.
- **No-Go:** longer runs without valid-completion gain, any invariant regression, or merely shifting stop reason.

### P0-2 — Deterministic next-legal-action and completion-blocker projection

- **Problem:** generic phase guidance leaves the model to derive exact active IDs, stale checks, verification order and formal completion action from several overlapping structures.
- **Evidence:** prompt projection at lines 234-288; `planControlState` at lines 426-464; `modernize-scientific-stack`, `distribution-search`, `cancel-async-tasks` and `kv-store-grpc`.
- **Root cause hypothesis:** facts exist but are not compiled into a small actionable navigation view.
- **Affected layer:** Harness prompt compiler, using Runtime-owned facts read-only.
- **Expected benefit:** fewer completion/replan loops, lower tokens and better conversion of already-correct workspaces.
- **Regression risk:** medium; an incorrect projection could misdirect the model or appear authoritative.
- **Complexity:** medium.
- **How to evaluate:** Experiment B with Gate and convergence unchanged.
- **Go:** fewer invalid controls and higher valid completion on the target cohort with identical external results/invariants.
- **No-Go:** blocker projection disagrees with Gate facts, hides unfinished outcomes, or increases false success.

### P0-3 — Explicit protected-action budget and environment inventory

- **Problem:** models batch protected effects and repeatedly discover interpreter/tool/path facts through protected executes.
- **Evidence:** 92 protected-batch rejections; 36 external-non-pass failed tasks encountered the code at least twice; `shell.execute` contract/policy mismatch.
- **Root cause hypothesis:** the safe rule is textually present but not represented as immediate turn-level affordance; environment facts are expensive to obtain.
- **Affected layer:** Harness projection and a read-only Host/Runtime capability descriptor.
- **Expected benefit:** fewer rejected turns and less environment-discovery churn, while preserving Approval/effect rules.
- **Regression risk:** low-medium if inventory is observed and freshness-bound; high if commands are reclassified by assertion.
- **Complexity:** low-medium for projection, medium for trustworthy inventory.
- **How to evaluate:** Experiment C.
- **Go:** protected-batch rejection rate drops materially without fewer required approvals, hidden effects or external-pass regression.
- **No-Go:** models treat inventory as permission, facts become stale, or effect classification weakens.

### P1-1 — Reduce Plan authoring/repair ceremony over the same authority

- **Problem:** models spend turns producing and repairing exact scope/outcome/step/check relations.
- **Evidence:** 61 `TASK_CONTRACT_REQUIRED`; 46 relation/coverage/duplication rejections; 26 scope-revision rejections; externally correct Plan-repair failures.
- **Root cause hypothesis:** too much canonical bookkeeping is delegated to probabilistic output instead of deterministic compilation/patching.
- **Affected layer:** Harness control contract and Runtime validation adapter; Plan store remains unchanged.
- **Expected benefit:** more execution turns reach useful work, fewer accidental scope changes.
- **Regression risk:** high; automatic compilation could omit or mutate user requirements.
- **Complexity:** medium-high.
- **How to evaluate:** Experiment D on simple and complex stratified tasks, with exact Task Contract diff auditing.
- **Go:** lower planning rejections and equal requirement preservation/Completion integrity.
- **No-Go:** any dropped acceptance criterion, silent scope change or second authority.

### P1-2 — Context deduplication and provider-aware budget guardrail

- **Problem:** dynamic facts are repeated and measured input underestimates actual provider tokens.
- **Evidence:** zero compaction despite near-window calls; 87,554 measured versus 125,088 actual on the largest call; overlapping prompt segments; caching otherwise effective.
- **Root cause hypothesis:** a compact canonical navigation view can improve useful information/token; provider-specific calibration can trigger protection before the true limit.
- **Affected layer:** Harness context compiler and provider telemetry/budgeting.
- **Expected benefit:** lower input cost, more context headroom and possibly better decisions.
- **Regression risk:** medium-high for deduplication if causal facts disappear; low for a conservative budget margin.
- **Complexity:** medium.
- **How to evaluate:** Experiment E for projection; separately validate estimator error distributions before changing compaction thresholds.
- **Go:** equal or better decisions and recall with lower actual tokens; no cache-ratio collapse; no missing actionable fact.
- **No-Go:** lower tokens with worse completion/repair, lost provenance, or unstable cache prefix.

### P2 — Check-quality affordance

- **Problem:** Runtime can prove that declared checks ran but not that a model-authored check matches the user's semantics.
- **Evidence:** `dna-insert`, `mteb-retrieve`, `polyglot-c-py`.
- **Root cause hypothesis:** a concise coverage projection for positive, negative, cleanup and independent checks may reduce overclaim.
- **Affected layer:** Harness planning guidance.
- **Expected benefit:** fewer product-level false successes.
- **Regression risk:** medium; extra ceremony may reduce capability and still cannot create an independent oracle.
- **Complexity:** low for a prompt experiment, high for a general verifier.
- **How to evaluate:** fixed false-success and matched-control cohort; official external assertions remain hidden and authoritative.
- **Go:** confirmed false-success rate declines without completion-rate collapse or benchmark-specific leakage.
- **No-Go:** only longer Plans/checks, verifier mimicry, or no generalization.

## 15. Proposed Falsifiable A/B Experiments

All experiments use frozen task images, provider configuration, model, budgets, approvals and official verifiers. Run repeated trials with seeds/order recorded. Compare validated success, external pass, Runtime closure, rejection codes, model/tool calls, actual tokens, wall time, Safety/Authority grades, physical-effect counts and confirmed false success. Do not combine treatments in the first pass.

### Experiment A — Progress-anchored repeated-state convergence

- **Hypothesis:** a material subset of repeat-2 failures occurs because two equal state errors are counted across intervening authoritative progress.
- **Change:** reset only state-rejection equivalence at a precisely defined authoritative-progress anchor and allow one structured repair turn before hard failure.
- **Invariant:** same Gate, Approval, effect admission, idempotency and finite maximum repair count.
- **Cohort:** all terminal repeated-state clusters, with focused analysis of `modernize-scientific-stack`, `git-leak-recovery`, `distribution-search` and matched failures without intervening progress.
- **Success:** more valid completions/external passes and fewer progress-separated terminations, with no additional repeated physical effect or unbounded tail.
- **Falsifier:** longer trajectories but unchanged valid outcomes, or any Authority/Safety/idempotency regression.

### Experiment B — Exact completion blocker projection

- **Hypothesis:** false-negative completion is partly caused by having the facts but lacking an exact ordered repair action.
- **Change:** add one compact derived structure containing active step/check IDs, current Gate issues, evidence freshness, and the exact legal next control/action. Remove no existing data in phase 1.
- **Invariant:** Completion Gate code and facts remain unchanged; projection is explicitly derived and non-authoritative.
- **Cohort:** six `external=1 + FAILED_TASK` rows plus matched successful tasks with multi-check completion.
- **Success:** at least two target rows convert to valid completion across repeated trials, completion/state rejections fall, confirmed false success does not rise.
- **Falsifier:** model ignores the projection, Gate disagreement appears, or success shifts only through omitted requirements.

### Experiment C — Per-turn protected-action affordance

- **Hypothesis:** making the current action budget machine-prominent reduces protected batches beyond what prose already achieves.
- **Change:** project `protectedActionsRemainingThisTurn`, allowed read batching, and a freshness-bound environment inventory; do not change admission.
- **Invariant:** protected effects, Approval and shell restrictions remain identical.
- **Cohort:** the 36 external-non-pass failed rows with two or more protected-batch rejections, stratified by task type and trajectory length.
- **Success:** at least 50% reduction in protected-batch rejections and lower median model calls, with no safety or external-pass regression.
- **Falsifier:** rejection rate is unchanged, turns merely serialize without outcome gain, or inventory creates incorrect assumptions.

### Experiment D — Constrained Plan patch versus full Plan rewrite

- **Hypothesis:** exact full-object Plan revision causes avoidable relation/coverage/removal errors.
- **Change:** expose a constrained patch operation for one active-step/check repair, deterministically compiled into the same canonical Plan and validated by the same rules.
- **Invariant:** no new Plan store, no automatic scope expansion, no dropped required outcome, same Plan version/audit trail.
- **Cohort:** scope revision, relation, duplicated-outcome and invalid-removal clusters; include clean successful controls.
- **Success:** planning rejection rate falls by at least 40%, requirement-preservation diff is exact, validated success does not decline.
- **Falsifier:** hidden scope changes, ambiguity in patch application, or lower rejection count without useful execution gain.

### Experiment E — Deduplicated dynamic context

- **Hypothesis:** replacing overlapping state copies with one canonical navigation view improves decision quality per actual provider token.
- **Change:** remove one duplication class at a time, beginning with `latestUserInput` versus input history and `recentTrajectory` versus tool observations; retain stable prefix.
- **Invariant:** all authoritative facts and provenance remain retrievable; no compaction-policy change in this experiment.
- **Cohort:** longest-context quartile plus matched short tasks.
- **Success:** lower actual input tokens and equal-or-better valid action/completion rate; prompt-cache weighted ratio does not materially regress.
- **Falsifier:** missing causal facts, more repeated actions/rejections, or token savings without decision improvement.

## 16. Recommended Next Development Phase

Proceed to a **bounded Harness Optimization phase**, not a broad implementation program.

Recommended order:

1. Freeze the final full-89 reconstruction, cross-product metric definitions and a fixed diagnostic subset.
2. Resolve the reporting metric defect so each trial exposes Runtime success, external pass, validated success and infrastructure-indeterminate status separately.
3. Run Experiment A alone. It has the clearest code-level mechanism and direct trajectory counterexamples.
4. If A passes, run B and C independently. These target already-correct workspaces and the largest rejection cluster without changing authorities.
5. Defer Plan-patch and context-reduction changes until the smaller experiments establish an effect size.
6. Run a stronger-model control arm before attributing the residual domain/schema failures to Harness design.

The phase should stop if any treatment weakens Safety, Authority, Approval, Evidence, Completion integrity, containment or idempotency. Benchmark gain is subordinate to those invariants.

## 17. Direct Answers

- **Primary bottleneck:** Harness capability/model-control ergonomics, with one confirmed Runtime recovery dead-end; basic Runtime reliability is no longer the main bottleneck.
- **How many of the 69 external non-passes show Nexora friction:** 1 is strictly confirmed Nexora-caused; 37/69 are high-signal friction-exposed (36 repeated protected-batch rows plus the separate dead-end), but current evidence cannot claim that friction caused all 37 failures.
- **Failures likely to persist with a stronger model:** progress-separated convergence termination, implicit stale-evidence ordering, exact Plan repair ceremony, protected-action/tool affordance mismatch, context-budget underestimation and the recovery dead-end.
- **Failures likely to improve mainly with a stronger model:** domain calculation/interpretation errors, schema compliance, obvious output-cleanup omissions and repeated identical actions. This remains a hypothesis until a controlled model A/B.
- **Three best optimization targets:** convergence anchoring/repair probation; exact next-legal-action and completion-blocker projection; protected-action/environment affordance.
- **Modules to freeze:** State Machine and all durable authorities, Approval, Evidence provenance, Completion Gate correctness, containment, idempotency/recovery safeguards, Harbor external verifier and stable cache prefix.
- **Is Context Engineering already a demonstrated advantage:** prompt caching is; compaction/rehydration is not demonstrated by this cohort because it never activated. Durable-context correctness is supported deterministically, not by this Terminal-Bench result.
- **Is there a reliability capability tax:** yes. Its strongest evidence is Plan/control rejection volume, protected-call cadence, stale-evidence ordering and repeat-2 convergence across progress.
- **Should Nexora enter Harness Optimization:** yes, through isolated, falsifiable experiments.
- **First experiment:** progress-anchored convergence with one bounded structured repair turn, fixed model/provider/cohort, with all safety and completion invariants unchanged.

## 18. Evidence Index and Limitations

Primary sources:

- [`NEXORA_TERMINAL_BENCH_REPORT.md`](NEXORA_TERMINAL_BENCH_REPORT.md)
- [`NEXORA_RUNTIME_ACCEPTANCE_REPORT.md`](NEXORA_RUNTIME_ACCEPTANCE_REPORT.md)
- [`NEXORA_EDD_LOG.md`](NEXORA_EDD_LOG.md)
- [`NEXORA_RUNTIME_RELEASE_ASSESSMENT.md`](NEXORA_RUNTIME_RELEASE_ASSESSMENT.md)
- [`packages/runtime/src/runtime.ts`](packages/runtime/src/runtime.ts)
- [`packages/runtime/src/completion-gate.ts`](packages/runtime/src/completion-gate.ts)
- [`packages/runtime/src/execution/tool-runtime/index.ts`](packages/runtime/src/execution/tool-runtime/index.ts)
- [`packages/runtime/src/execution/tool-runtime/command-resolution.ts`](packages/runtime/src/execution/tool-runtime/command-resolution.ts)
- [`packages/harness/src/prompt.ts`](packages/harness/src/prompt.ts)
- [`harness/nexora-bench/src/open-task.ts`](harness/nexora-bench/src/open-task.ts)
- [`harness/nexora-bench/src/runner.ts`](harness/nexora-bench/src/runner.ts)
- [`harness/nexora-bench/harbor/nexora_harbor/verifier.py`](harness/nexora-bench/harbor/nexora_harbor/verifier.py)

Limitations:

- The cohort uses one primary model/provider configuration. It cannot independently identify model versus interface treatment effects.
- Several task outcomes depend on network/package infrastructure.
- Rejection counts measure exposure and may overlap; they are not additive causal failure counts.
- External verifiers can be narrower than the Runtime-owned Plan, as `git-leak-recovery` shows.
- No automatic compaction occurred, so Context Engineering conclusions about compaction are necessarily non-causal.
- Existing reports document targeted green regressions, but the canonical release suite remains recorded as 86/105. This audit did not modify code or rerun that gate.

This audit is the end of the authorized work. Implementation should begin only after human review selects an experiment and preserves the stated invariants.

