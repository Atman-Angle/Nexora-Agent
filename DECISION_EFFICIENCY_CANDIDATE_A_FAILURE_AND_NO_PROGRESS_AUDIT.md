# Candidate A Failure Attribution + `NO_PROGRESS_DETECTED` Audit

**Date:** 2026-09-09  
**Repository reality:** `D:\Nexora-1.1`, branch `codex/harness-optimization-production-baseline`, HEAD `95b51415ef7f6c177b491a3e1c822699020c9af3`  
**Audit mode:** evidence-first, no production behavior change  
**Candidate A status:** `CONTROLLED_A_B_FAILED_NO_GO`  
**Production default:** `toolCatalogProjection = full`

## 1. Executive decision

Candidate A remains **NO-GO**. Its hard correctness/stability gate failed even though the 45 both-success pairs reduced median actual input tokens by 30.84%.

The evidence does **not** support either of these stronger conclusions:

1. the complete Prompt Tool Catalog is behaviorally indispensable; or
2. Candidate A removed Tool decision facts that were unavailable elsewhere.

The current OpenAI-compatible projection places `name`, `description`, `inputSchema`, `useWhen`, `avoidWhen`, `nonGoals`, effect kind, and `evidence.produces` in the Provider-native function definitions. Provider function bytes and digest were identical in both arms. Candidate A removed a second Prompt copy of those facts, not their only copy.

The strongest cross-arm root cause is instead:

```text
model creates a circular or delivery-only Plan outcome
→ Completion Gate correctly requires a verifiable Step and exact Evidence binding
→ Harness advertises an unfinished Step as "removable" even when Task Scope forbids remove-only repair
→ model follows an invalid or incomplete repair direction
→ repeated Plan/state rejection after useful Tool work is already complete
→ NO_PROGRESS_DETECTED
```

Candidate failures occur more often than Control failures in the mutation/protected sample, so loss of stable-Prompt salience or reinforcement remains a plausible Candidate-specific contributor. It is not proven: all per-Tool decision facts remained Provider-visible, Control produced the same failure family, and the paired discordance is only 3 Candidate-only failures versus 1 Control-only failure (exact two-sided McNemar `p = 0.625`). This is enough for a conservative NO-GO gate, but not enough for a causal claim that duplicated Tool decision text must remain.

For the observed Candidate/Control failures, `NO_PROGRESS_DETECTED` is a **terminal symptom and bounded safety mechanism**, not the first cause. It correctly stops repeated rejected Plan repairs that add no new authoritative fact. Raising its threshold would only spend more calls on the same loop.

There is, however, one separate confirmed progress false negative in current production code: recovery persists the event `tool.reconciled`, while no-progress progress detection and warning clearing check the nonexistent `tool.recovered`. This is a foundation-level defect, but it was not exercised by the Candidate failure runs.

**Recommendation:** authorize an independent Plan/Completion Obligation + Progress Signal Coherence Spec before any new token-optimization candidate. Do not start Candidate A2 yet. After that foundation is verified, rerun the same paired baseline; only then decide whether a narrowly scoped A2 should retain compact stable-Prompt control/decision guidance while removing schema-shaped duplication.

## 2. Evidence base and limitations

### 2.1 Evidence inspected

- `docs/evidence/decision-efficiency-candidate-a-ab-disabled.json`
  - 100 real-provider runs;
  - 50 Control and 50 Candidate;
  - 10 lanes, 5 interleaved repetitions;
  - all 50 paired invariants valid.
- `docs/evidence/decision-efficiency-candidate-a-ab-analysis.json`.
- `docs/evidence/decision-efficiency-candidate-a-tool-catalog-audit.json`.
- `DECISION_EFFICIENCY_CANDIDATE_A_TOOL_CATALOG_SPEC.md`.
- Current Runtime/Harness/Decision Efficiency source, especially:
  - `packages/runtime/src/runtime.ts`;
  - `packages/runtime/src/completion-gate.ts`;
  - `packages/runtime/src/runtime-helpers.ts`;
  - `packages/runtime/src/execution/runtime-execution.ts`;
  - `packages/harness/src/prompt.ts`;
  - `packages/harness/src/context/decision-context.ts`;
  - `packages/harness/src/providers/openai-compatible.ts`;
  - `harness/nexora-bench/src/decision-efficiency.ts`.

### 2.2 Controlled A/B facts

| Measure | Control | Candidate | Interpretation |
|---|---:|---:|---|
| Successful tasks | 48/50 | 46/50 | Candidate fails hard non-regression gate |
| Response rejections | 15 | 20 | Candidate has more rejected decision work |
| Mutation success | 4/5 | 3/5 | Candidate regression, small sample |
| Protected success | 4/5 | 3/5 | Candidate regression, small sample |
| False success | 0 | 0 | Completion protection held |
| Unknown function calls | 0 | 0 | No Tool-name/schema selection failure |
| Approval requested/granted | 17/17 | 17/17 | Approval integrity held |
| Duplicate mutation metric | 0 | 0 | No recorded duplicate mutation |
| Max successful Model Calls | 5 | 8 | Candidate has one clear successful detour |
| Prompt Tool segment | 16,190 bytes | 118 bytes | 16,072-byte structural reduction |
| Provider functions | 16,168 bytes | 16,168 bytes | byte/digest identical |

The structural audit covers 16 built-in functions (3 controls + 13 Runtime Tools). The A/B runner forbids delegation, so its actual first-request function list contains 15 functions and excludes `nexora_delegate_workers`. Candidate A therefore has no behavioral evidence for delegation selection.

### 2.3 Limits on attribution

- The Provider applied implicit cache hits even when Nexora requested cache-disabled mode. Token evidence is warm implicit-cache evidence, not cold-cache evidence.
- The saved A/B report contains Model turns, Provider responses, Tool invocations, counts, and final state, but does not retain each full `response.rejected` diagnostic/event payload. Exact rejection codes are directly visible in some subsequent model repair text; elsewhere they are reconstructed from the rejected action plus the current deterministic Runtime checks. Those cases are identified as inferred rather than observed payloads.
- The cohort uses one Provider/model (`openai-compatible`, `qwen3.8-flash`) and five repetitions. It is decisive for the Candidate's conservative release gate, not for general model/provider causality.
- The worktree is heavily mixed and the Candidate spec/evidence files are untracked. The current working tree is the audit baseline, but this is not a clean, independently committed Git delivery.

## 3. Deterministic representative-run selection

The aggregate analysis includes all 100 runs. Trajectory deep-dives use these predeclared rules:

1. include both arms of every Candidate-only failure pair;
2. include both arms of every Control-only failure pair;
3. include both arms of every both-failed pair;
4. include every successful Candidate in mutation/protected whose Model Calls or Tool invocations exceed the minimum successful trajectory for that lane, plus its paired Control;
5. for normal comparison, sort by `lane + repetition` and select the first pair with both arms succeeded, equal Model Call counts, equal Runtime Tool-invocation sequence, and zero response rejection;
6. normal pairs cover mandatory mutation/protected/recovery and the empirically relevant similar-tool, multi-call, plan-read, and coding lanes. Direct-read, read-only, and request-input remain in the full aggregate but add no anomalous trajectory evidence.

### 3.1 Failure and anomalous-success runs

| Run ID | Arm | Lane / task | Rep | Terminal outcome | Selection rule |
|---|---|---|---:|---|---|
| `6944b18a-7812-4aa6-8530-d349c6c3fb0b` | Control | read-versus-mutation / mutation | 2 | succeeded / COMPLETED | Candidate-only failure pair |
| `d0f71b3a-a136-4266-a84d-e91b220a8d06` | Candidate | read-versus-mutation / mutation | 2 | failed / NO_PROGRESS_DETECTED | Candidate-only failure |
| `9a1a0f96-f105-4fe8-954b-1b4f5debc2d3` | Control | read-versus-mutation / mutation | 4 | failed / NO_PROGRESS_DETECTED | Control-only failure |
| `c46d308b-80e9-466b-b67c-0369fbad6f34` | Candidate | read-versus-mutation / mutation | 4 | succeeded / COMPLETED | Control-only failure pair |
| `046f4839-801a-4abc-96af-1b2da7a571e8` | Control | read-versus-mutation / mutation | 5 | succeeded / COMPLETED | Candidate-only failure pair |
| `6cf7fb11-b7d3-4287-b3de-4222d4276dee` | Candidate | read-versus-mutation / mutation | 5 | failed / NO_PROGRESS_DETECTED | Candidate-only failure |
| `a1630b8f-f757-4c09-ba4f-57a05546c49f` | Control | protected-destructive-operation / protected | 4 | succeeded / COMPLETED | Candidate-only failure pair |
| `ae751703-6e1c-49f1-8b5e-26b45e3cc624` | Candidate | protected-destructive-operation / protected | 4 | failed / NO_PROGRESS_DETECTED | Candidate-only failure |
| `b95f06df-af00-406a-a4b0-72518481bba5` | Control | protected-destructive-operation / protected | 5 | failed / NO_PROGRESS_DETECTED | Both-failed pair |
| `00df6010-2429-4847-9765-8109836ca0a6` | Candidate | protected-destructive-operation / protected | 5 | cancelled / CANCELLED | Both-failed pair |
| `9bea0615-d0d1-49cf-b52e-d64027e3af60` | Control | read-versus-mutation / mutation | 3 | succeeded / COMPLETED | Abnormal Candidate pair |
| `2a2c3580-3ee5-4b85-9588-9286837c4df1` | Candidate | read-versus-mutation / mutation | 3 | succeeded / COMPLETED | Candidate lane maximum: 8 calls |
| `f8680cf4-d318-4de0-839b-a2cd3bb48272` | Control | protected-destructive-operation / protected | 1 | succeeded / COMPLETED | Abnormal Candidate pair |
| `a1827519-55d9-4606-b56f-ee3ed7d82ab2` | Candidate | protected-destructive-operation / protected | 1 | succeeded / COMPLETED | 5 calls and 2 protected executions vs lane minimum 3/1 |
| `0bd3d206-e73d-4b85-aa7a-a2d897d376e9` | Control | protected-destructive-operation / protected | 2 | succeeded / COMPLETED | Abnormal Candidate pair |
| `97428d5e-990c-4854-a802-c26337f125e2` | Candidate | protected-destructive-operation / protected | 2 | succeeded / COMPLETED | 6 calls and 2 protected executions vs lane minimum 3/1 |

### 3.2 Normal successful comparisons

| Run ID | Arm | Lane / task | Rep | Terminal outcome | Selection rule |
|---|---|---|---:|---|---|
| `ff337d29-a182-4c08-80f5-3a12a32809dd` | Control | read-versus-mutation / mutation | 1 | succeeded / COMPLETED | First normal pair in lane |
| `0cf7ae53-7f69-45b3-b737-84fdfdccd26f` | Candidate | read-versus-mutation / mutation | 1 | succeeded / COMPLETED | First normal pair in lane |
| `efdaff0b-281f-41a6-828f-eb2a867d67ce` | Control | protected-destructive-operation / protected | 3 | succeeded / COMPLETED | First normal pair in lane |
| `8920465a-07bc-4560-80e2-ef53e1037072` | Candidate | protected-destructive-operation / protected | 3 | succeeded / COMPLETED | First normal pair in lane |
| `8ec13936-9cb5-416b-8ee1-a0b2f767470c` | Control | recovery | 1 | succeeded / COMPLETED | First normal pair in lane |
| `8b0aaadd-8886-476e-9084-f0630460e68a` | Candidate | recovery | 1 | succeeded / COMPLETED | First normal pair in lane |
| `01028edd-5ce1-42d5-8ed3-d341456cf766` | Control | similar-tool-selection | 1 | succeeded / COMPLETED | First normal pair in lane |
| `9e78dd43-7909-4744-a7ea-b73d8104656e` | Candidate | similar-tool-selection | 1 | succeeded / COMPLETED | First normal pair in lane |
| `5c409c68-b0cf-4463-aa45-8bd5d531db34` | Control | multi-call-batch | 1 | succeeded / COMPLETED | First normal pair in lane |
| `99a9a491-a31c-41d7-9d65-bd7a11e4c8f4` | Candidate | multi-call-batch | 1 | succeeded / COMPLETED | First normal pair in lane |
| `cea91cf9-cd6a-4759-9aa3-7ce6f2607b99` | Control | control-versus-runtime-tool / plan-read | 1 | succeeded / COMPLETED | First normal pair in lane |
| `d83ddb80-ed15-44bd-b0f2-d1602e380829` | Candidate | control-versus-runtime-tool / plan-read | 1 | succeeded / COMPLETED | First normal pair in lane |
| `c8709fec-30c6-4eb4-b6b7-e9ade3b86b17` | Control | coding-filesystem | 1 | succeeded / COMPLETED | First normal pair in lane |
| `b5068889-bca2-4969-a920-a26393384697` | Candidate | coding-filesystem | 1 | succeeded / COMPLETED | First normal pair in lane |

## 4. Reasonable shortest paths and system friction

The reasonable path is defined by required outcomes, not by demanding one exact Tool sequence. The successful normal pairs establish that the current Runtime can complete these tasks with the following call counts.

| Lane | Required outcome path | Empirical normal Model Calls / Tool invocations |
|---|---|---:|
| mutation | Plan → inspect digest → patch → verify current file → complete | 5 / 3 |
| protected | Plan → approval-backed execute → complete | 3 / 1 |
| recovery | failed read establishes absence → search → successful read → complete | 4 / 3 |
| similar-tool | search → read exact result → complete | 3 / 2 |
| multi-call | two independent reads in one response → complete | 2 / 2 |
| plan-read | Plan → read → complete | 3 / 1 |
| coding | Plan → write → verify read → complete | 4 / 2 |

### 4.1 Excess work in representative runs

| Run | Normal calls | Actual calls | Extra calls | Semantic attribution |
|---|---:|---:|---:|---|
| mutation Candidate r2 | 5 | 10 | +5 | Plan repair, repeated Plan rejection, duplicate read, rejected no-op patch |
| mutation Candidate r3 | 5 | 8 | +3 | repair replan, rejected Plan response, duplicate verification read |
| mutation Control r4 | 5 | 9 | +4 | completion rejection plus repeated remove/recreate Plan repair |
| mutation Candidate r5 | 5 | 9 | +4 | unnecessary Task Contract/Plan rewrite, then repeated remove repair |
| protected Candidate r1 | 3 | 5 | +2 | replan and second `node --version` execution |
| protected Control r1 | 3 | 5 | +2 | rejected Plan repair and second execution |
| protected Control r2 | 3 | 5 | +2 | rejected Plan repair and second execution |
| protected Candidate r2 | 3 | 6 | +3 | rejected replan, accepted rebind, second execution |
| protected Candidate r4 | 3 | 10 | +7 | report-Step repair and two rejected completion attempts |
| protected Control r5 | 3 | 9 | +6 | circular Plan-creation outcome and seven rejected repairs |
| protected Candidate r5 | 3 | 6 attempted | +3 before cancellation | completion/rebind loop, then Provider attempt cancelled at duration boundary |

The extra calls are not necessary domain work. They are largely Nexora-created control friction around Plan representation, Evidence binding, and legal repair projection.

## 5. First trajectory divergence

### 5.1 Mutation Candidate r2 — candidate-only failure

Reasonable external work completed in the first four calls: Plan, read, patch, post-patch read. The initial Plan nevertheless split “report the verified final content” into a separate required outcome/Step with no independent Tool-backed check. That is the first material divergence.

The next six calls attempted Plan removal/replacement, another identical read, and a no-op patch from `CANDIDATE-B` to `CANDIDATE-B`. Four responses were rejected. The final workspace was already correct and contained the verified digest. The duplicate read returned the same authoritative observation; it did not add a new fact.

- Root cause: invalid/circular Plan outcome encoding plus incomplete legal repair projection.
- Amplifier: repeated Plan rejection and one rejected no-op mutation strategy.
- Terminal symptom: `NO_PROGRESS_DETECTED`.

### 5.2 Mutation Control r4 — control-only failure

The initial Control Plan also created a separate `Report final content of target.txt` Step without a Tool check. Read → patch → read succeeded, and the first completion text accurately described the final file. The Completion Gate rejected it because the report Step remained unverifiable/incomplete.

The model then repeatedly removed that Step using its exact id, recreated a report Step, and retried completion. The remove-only action conflicts with Task Scope's requirement that every required outcome keep exactly one `required_outcome` binding. Five responses were rejected.

- Root cause: same Plan/Task Scope/Completion mismatch as Candidate failures.
- Amplifier: the decision context's false “removable” affordance.
- Terminal symptom: `NO_PROGRESS_DETECTED`.

This Control-only failure is direct counterevidence to attributing the failure family solely to Candidate A.

### 5.3 Mutation Candidate r5 — candidate-only failure

The first response established a three-Step Plan and batched the initial read. The next response unnecessarily attempted a new full scope/Plan containing an added reporting outcome even though no new user input allowed Task Contract revision. The model then repeated the read, performed the correct patch, and verified it. All required workspace effects were complete by the fifth Provider response.

Subsequent calls repeatedly attempted to remove or rewrite the report/verification Step. Five responses were rejected; no new workspace fact followed the successful verification.

- Root cause: an unnecessary post-Plan Task Contract/Plan rewrite that introduced delivery as an executable obligation.
- Amplifier: rejected remove-only repair.
- Terminal symptom: `NO_PROGRESS_DETECTED`.

### 5.4 Protected Candidate r4 — candidate-only failure

The initial Plan separated:

1. execute `node --version` and capture output; and
2. report the exact version verbatim, with no Tool check.

The approved `shell.execute` succeeded once with `v24.11.1`. The model then tried to remove/recreate the report Step, proposed accurate completion twice, and eventually created a new report Step bound to `shell.execute` without executing a fresh check under that new Step/check identity. Seven responses were rejected.

- Root cause: delivery-only Step plus exact Step/check Evidence binding after replan.
- Amplifier: false remove affordance and non-specific `STEP_UNVERIFIABLE` repair guidance.
- Terminal symptom: `NO_PROGRESS_DETECTED`.

### 5.5 Protected Control r5 — both-failed pair, Control arm

The first Plan represented “create the requested Plan” as its own required outcome/Step. Plan creation is the control operation that establishes the Plan; it does not create ordinary Tool Evidence satisfying a Step inside itself. This circular Step became the first divergence.

The model attempted several Plan revisions before and after the one successful approved `shell.execute`. The command result was correct, but the Plan remained unfinishable; seven repair responses were rejected.

- Root cause: circular meta-Plan outcome.
- Amplifier: repeated state repair without one legal projected obligation.
- Terminal symptom: `NO_PROGRESS_DETECTED`.

### 5.6 Protected Candidate r5 — both-failed pair, Candidate arm

The initial Plan created a no-check report Step. `shell.execute` succeeded and the model proposed the correct `v24.11.1` completion. After rejection, it replaced the report Step with a `shell.execute` verification check, but did not execute a fresh invocation bound to that new Step/check before trying completion again. The sixth Provider attempt was cancelled at the duration boundary and usage telemetry was incomplete.

- Root cause: same delivery-Step/Evidence-rebinding problem.
- Amplifier: Provider latency/duration after the artificial repair detour.
- Terminal outcome: `CANCELLED`, not `NO_PROGRESS_DETECTED`.

This pair shows that evaluation/provider trajectory instability coexists with the Plan/Completion issue.

### 5.7 Abnormal successful trajectories

- Mutation Candidate r3 completed the correct read/patch/read by call 4, but its initial Plan had a separate no-check report Step. It needed two replans, one rejected response, and a duplicate final read before completion at call 8. Decision Efficiency counts the accepted replan as `plan_progress`, but the user-visible task had already reached the same external state as the five-call Control.
- Protected Candidate r1 and r2 each executed `node --version` twice. The second execution existed only because the report outcome was removed/rebound to a new `shell.execute` check. Approval protection remained intact, but the extra protected execution was system-induced work.
- The paired Control r1/r2 runs also executed the command twice. This again makes Plan/Completion stability a cross-arm prerequisite rather than a Candidate-only issue.

## 6. Candidate A failure attribution

### 6.1 What Candidate A did not lose

Current source and wire evidence establish that Provider function descriptions contain:

```text
canonical Tool name and purpose
useWhen
avoidWhen
nonGoals
effect kind
evidence.produces
inputSchema as Provider parameters
```

All Provider function bytes, order, aliases, descriptions, parameters, and digest were identical between arms. Therefore “the Candidate lacked Tool decision information” is false if “lacked” means not present anywhere in the Provider request.

Tool selection also remained correct:

- no unknown function call in either arm;
- direct-read, similar-tool, read-only, multi-call, plan-read, recovery, and coding all passed 5/5 in both arms;
- mutation failures still selected `filesystem.read` and `filesystem.patch` correctly;
- protected failures still selected `shell.execute` correctly;
- Approval requests/grants remained 17/17 per arm.

### 6.2 Most likely causes, ranked

| Cause | Assessment | Evidence strength |
|---|---|---|
| Plan/Task Scope/Completion representation mismatch | Primary cross-arm root cause | High: every no-progress failure has this first divergence; Control reproduces same family |
| Rejection/recovery false affordance | Primary amplifier | High: `removablePlanSteps` lists every unfinished Step, while Runtime rejects removal that uncovers a required Scope outcome |
| Model decision failure after correct rejection | Contributing cause | High: models repeatedly choose remove/rewrite instead of legal rebind + fresh check or completion-ready Plan |
| Stable-Prompt salience/reinforcement loss | Possible Candidate-specific contributor | Medium-low: Candidate has 3 vs 1 asymmetric failures and more initial no-check report Steps, but all facts remain Provider-visible and sample is small/mixed |
| Provider/model trajectory variance | Material secondary factor | Medium-high: Control-only and both-failed pairs, crossed repetition outcomes, one duration cancellation |
| Tool schema/name/parameter loss | Not supported | High counterevidence: Provider schemas identical; zero unknown calls |
| Threshold too low | Not supported | High counterevidence: after the last useful Tool result, failed runs repeat rejected/non-executable actions without new facts |
| Detector itself caused these failures | Not supported | High: it fires after the loop exists; it does not create the invalid Plan or rejection |

Candidate A failed its release gate because it did not demonstrate stable non-regression. The most honest causal classification is **mixed causes with insufficient evidence for Candidate-specific attribution**. The candidate-specific signal is compatible with reduced salience of duplicated stable-Prompt control guidance, but not with actual absence of Tool decision facts.

## 7. Tool Catalog information-value split

| Information class | Where it exists now | Audit conclusion |
|---|---|---|
| Tool name/purpose | Prompt catalog + Provider function description | Mechanically duplicated; no observed selection loss in 8 stable lanes |
| Input schema | Prompt `inputSchema` + Provider `parameters` | Mechanically duplicated; zero unknown/invalid function-name failures; general safe removal still unproven in high-risk Plan control |
| `useWhen` / `avoidWhen` / `nonGoals` | Prompt catalog + Provider function description | Not deleted from the request; stable-Prompt repetition may have salience value, currently unknown |
| effect kind | Prompt catalog + Provider function description | Mechanically duplicated; Approval behavior unchanged; no evidence that Prompt copy caused protected failures |
| `evidence.produces` | Prompt catalog + Provider function description | Mechanically duplicated, but possible relevance to constructing Tool-backed Plan checks is not causally isolated |
| control/runtime `kind` | Prompt-only catalog wrapper | Structurally unique but no observed routing failure attributable to its removal |
| canonical runtime name vs Provider alias | Prompt canonical name; Provider-safe alias | Alias decoding worked in all runs; no unknown call |
| global execution/safety/Authority policy | stable system Prompt | Retained in both arms; not tested for removal and must not be inferred redundant |
| control-state/next-obligation projection | dynamic Prompt context | Not part of Candidate's Tool definition removal; this is where a confirmed false repair affordance exists |

### 7.1 Confirmed pure duplication

The structural audit confirms duplicate source facts for every included Tool: description, schema, decision guidance, non-goals, effect, and produced Evidence description. Their duplicate byte representation is real.

Behavioral evidence supports safe omission only within the observed stable lanes and model/provider configuration. It does not prove that every duplicated byte is safely removable for all control/high-risk behavior.

### 7.2 Information with observed behavioral value

No per-Tool semantic fact was uniquely removed, so the A/B cannot prove that one fact's *availability* caused a behavior change. The only behaviorally plausible value exposed by the failures is the **placement/reinforcement** of `nexora_update_plan` and Evidence/check guidance in the stable system Prompt. That value remains `unknown`, not proven.

### 7.3 Unknowns

- whether compact stable-Prompt Plan/decision guidance restores high-risk stability;
- whether Provider descriptions alone are sufficient on another model/provider;
- whether `evidence.produces` or control schema repetition specifically affects Plan check construction;
- cold-cache token savings;
- delegation behavior;
- whether larger paired repetitions would preserve the 3:1 discordant direction.

## 8. Current `NO_PROGRESS_DETECTED` semantics

`NO_PROGRESS_DETECTED` is not one generic counter. Current Runtime derives several deterministic diagnostics from recent persisted Events and Invocations.

### 8.1 Facts Runtime treats as authoritative progress

For repeated state-rejection windows, `isAuthoritativeProgressEvent` recognizes:

```text
tool.succeeded
tool.failed
tool.recovered        # defect: actual event is tool.reconciled
validation.passed
recovery.confirmed_succeeded
recovery.confirmed_failed
branch.merged
```

Why `tool.failed` counts: a new failure observation may change the legal next action. Repeating the same Tool strategy with the same observation is separately bounded, so one new failed fact is not equivalent to unlimited retry.

### 8.2 Facts/actions not treated as authoritative task progress

```text
Tool Invocation prepared/started without outcome
Approval requested or granted
response.rejected
duplicate or no-effect action
repeated read with the same strategy and same observation
formal Plan wording/Step-id changes by themselves
ordinary completion text rejected by Completion Gate
Evidence/stepProgress as standalone event classes
```

Accepted `plan.set` is not authoritative outcome evidence. It does act as a convergence anchor and, after a warning, can earn one empirical Tool attempt to prove that the strategy changed.

Approval is a permission fact, not completion progress. The protected effect after Approval is the progress-bearing outcome.

### 8.3 Detection families and trigger conditions

| Diagnostic | Detection rule | Termination behavior |
|---|---|---|
| repeated invalid/schema/state response | same issue twice after the latest authoritative progress, or three times in one input segment | schema/invalid response can terminate on second repeat without a warning-only extra turn |
| repeated Tool result/failure | same Tool/input strategy and same observation three consecutive completed invocations | warning, then bounded opportunity for a materially different strategy |
| equivalent Plan | at least three no-op `plan.set` events after the last accepted Plan/Tool attempt | warning then bounded repair |
| repeated response rejection | same exact rejection message three times, or repeated structured issue | warning/repair, then failure if no changed legal path |
| resource churn | same resource reaches at least four reads and three mutations | warning with resource/read/mutation counts and one bounded alternative |

The loop checks ordinary budgets before convergence. Minimum iterations are two for repeated invalid responses and three for other diagnostic families.

### 8.4 Reset and segmentation

- Persisted new user input starts a new input segment.
- Generic Resume does not reset no-progress history.
- A materially different authoritative Tool observation breaks an exact repeated-action run.
- A successful probation/repair attempt can persist `execution.no_progress.probation_resolved` and establish a new segment boundary.
- An accepted Plan alone does not reset the authoritative repeated-state window; it must lead to an executable attempt or successful completion.
- A continuation from a no-progress parent inherits the exhausted strategy signature unless new authoritative progress is proven.

## 9. Decision Efficiency vs Runtime progress

| Fact | Decision Efficiency | Runtime no-progress | Assessment |
|---|---|---|---|
| successful write/execute | `state_change` | authoritative progress | aligned |
| unique successful read | `evidence_read` when not classified by a check role | authoritative Tool outcome; repeat logic also compares observation | substantially aligned |
| Tool-backed verification / `validation.passed` | `verification` | authoritative progress | aligned |
| accepted non-no-op Plan | always `plan_progress` | intent/anchor, not authoritative progress | deliberate mismatch; can become DE false positive |
| failed Tool with new failure fact | `failed_tool` waste, not Effective Action | authoritative progress | deliberate semantic mismatch; failure can change next action |
| `tool.reconciled` | `recovery` | not recognized because Runtime checks `tool.recovered` | confirmed defect / progress false negative |
| recovery confirmation | `recovery` | authoritative progress | aligned |
| accepted completion | `completion_delivery` | terminal success, no further convergence needed | compatible |
| rejected completion/response | waste/no Effective Action | no progress | aligned |

In the A/B failed runs, Decision Efficiency reports accepted Plan revisions as Effective Actions even when they only re-express the same report obligation or create a new unsatisfied check. For example, mutation Candidate r2 has two `plan_progress` actions yet ends with four rejected repairs and no completion. Protected Candidate r4 also has two `plan_progress` actions but seven rejected responses. Here, Decision Efficiency is overly generous; Runtime is not missing task progress.

The two systems should not be mechanically unified. The correct direction is to reuse Runtime facts and distinguish:

```text
accepted Plan intent
vs
legally executable next obligation
vs
authoritative outcome progress
```

## 10. Progress false negatives and false positives

### 10.1 Candidate failure trajectories

No progress false negative is demonstrated inside the selected Candidate/Control failure loops.

- The mutation files had already reached and been reread as `CANDIDATE-B` before the loop.
- The protected command had already produced `v24.11.1` before the loop.
- Later duplicate reads returned the same digest/content.
- Rejected Plan removals and no-op patches created no new legal state or Evidence.
- Accepted replans did not by themselves satisfy their newly created checks.

For these runs, the detector is working as intended once the loop exists.

### 10.2 Confirmed code-level progress false negative

**Classification: `progress false negative` (confirmed, not exercised by Candidate failures).**

The actual unknown-effect reconciliation path persists `tool.reconciled` and can:

- resolve an Invocation from unknown to succeeded/failed;
- add new Evidence;
- update `stepProgress`;
- return the Run to running.

Decision Efficiency recognizes `tool.reconciled` as `recovery`. Runtime's no-progress code and `projectNoProgressRepair` instead check `tool.recovered`, which is not a persisted Runtime event type and has no emitter in the repository. Consequently a meaningful reconciliation can fail to reset the state-rejection progress anchor and can leave a stale no-progress warning projected to the model.

This is exactly the class of false negative requested by the audit: unknown state becomes known, Evidence is persisted, and a Plan obligation may complete, while the detector's named progress event does not match reality.

### 10.3 Possible false-positive accounting

Decision Efficiency currently classifies every accepted non-no-op Plan as `plan_progress`. In the selected runs, some of those revisions are only formal repair or create new unsatisfied checks. This is a Decision Efficiency effective-action false positive relative to task progress, not a Runtime progress false negative.

No evidence supports broadening Runtime progress to count every Plan update, Approval, repeated read, or repair action.

## 11. Rejection → recovery information quality

### 11.1 What the model currently receives

The current decision context exposes:

- full current Plan and `stepProgress`;
- Completion Gate blockers with `code`, `stepId`, optional `checkId`, detail, and a coarse next action (`plan`, `execute`, `refresh`, `collect`, or `resolve`);
- recent Tool observations/Evidence;
- rejection issues and recovery text;
- a derived control phase and repair directive;
- `currentPlanAndChecks.removableSteps`.

This usually answers “what failed” and preserves completed Tool facts. It does not consistently answer “which next action is both legal under Task Scope and capable of producing applicable Evidence.”

### 11.2 Confirmed false affordance

`removablePlanSteps` returns every non-completed Step as removable. It does not inspect whether the Step is the sole `required_outcome` binding for a Task Scope outcome.

Runtime `#setPlan` then rejects a remove-only Plan that leaves that Scope outcome uncovered. The system therefore tells the model that a Step is removable and later rejects removal of that same Step unless a valid replacement is supplied.

This is visible in the failure trajectories: the model cites `STEP_UNVERIFIABLE`, uses exact persisted Step ids, and explicitly says the final report should move to assistant completion text. The intended semantic repair is reasonable, but the projected affordance is incomplete because Task Scope still requires the report outcome to remain covered.

### 11.3 Missing next-obligation precision

For `STEP_UNVERIFIABLE`, the Completion projection says only `nextAction: plan`. There is no dedicated repair directive for that code; the generic fallback says to use rejection details and choose a different legal action. It does not deterministically state the joint constraints:

```text
do not remove the sole required-outcome binding
replace/rebind it in the same Plan revision if needed
old Evidence is still persisted but may not satisfy a new Step/check identity
after rebind, execute the newly named check once
then submit completion without another Plan rewrite
```

The model sometimes discovers this path, but often only after several rejected turns. This is a Harness/decision-context usability problem built from facts Runtime already owns. It does not require a longer free-form Prompt or a second state authority.

### 11.4 Protection mechanisms

Approval, idempotency, duplicate protection, unknown-effect recovery, and Completion Gate should not be weakened. In this cohort they prevent false success and unauthorized execution. The defect is the absence of a reliably projected legal route after correct rejection, not the rejection itself.

## 12. Why simple tasks stop progressing

The domain tasks are simple; their control representations are not.

The protected task needs one executable observation. The mutation task needs one read, one patch, and one verification read. But the current model-visible contract can transform ordinary delivery wording and meta-instructions into additional required Scope outcomes. Every such outcome then needs exactly one Plan binding, every completion Step needs a required non-semantic check, and Evidence is tied to Plan version/Step/check identity.

Once the model makes the first Plan error, the repair problem becomes harder than the original task:

1. completed effects must remain immutable;
2. required Scope outcomes cannot be dropped;
3. completed Steps cannot be changed;
4. a new Step/check cannot automatically claim old Evidence merely because it references the same Tool result;
5. final assistant delivery is non-authoritative until Completion Gate accepts it;
6. the projected “removable” list is broader than remove-only legality.

The model then spends calls manipulating the representation instead of advancing the task. Runtime sees repeated rejected responses after the last authoritative Tool fact and correctly terminates.

Thus the simple task does not fail because it needs more reasoning depth or a higher retry threshold. It fails because an early Plan encoding mistake enters a narrow, poorly projected recovery space.

## 13. Final classifications

### 13.1 Candidate A

```text
Primary cross-arm cause:
  Plan/Task Scope/Completion representation mismatch
  + rejection/recovery false affordance

Candidate-specific contributor:
  possible stable-Prompt salience/reinforcement loss
  (insufficient causal evidence)

Secondary contributor:
  Provider/model trajectory variance and warm implicit-cache environment

Not supported:
  Provider Function Schema missing Tool definitions
  general Tool-selection failure
  Approval/idempotency/Completion protection failure
  threshold too low
```

### 13.2 `NO_PROGRESS_DETECTED`

For the observed A/B no-progress failures:

```text
root cause:        no
amplifying factor: bounded termination of an already-created repair loop
terminal symptom: yes
classification:   working as intended after rejection/recovery-induced loop
```

For current production recovery semantics outside these runs:

```text
classification: progress signal incomplete
specific defect: tool.reconciled is omitted because code checks tool.recovered
```

Overall classification is therefore **mixed**, with the distinction that must not be blurred: correct termination in the Candidate failures, confirmed incomplete recovery progress signaling elsewhere.

## 14. Recommended next Candidate and Spec decision

### 14.1 Recommended next work

Recommend an independent **Plan/Completion Obligation + Progress Signal Coherence** Spec with these boundaries:

1. derive legal repair affordances from existing Task Scope/Plan/Evidence facts;
2. distinguish `removable`, `replace-required`, and `completed/immutable` Steps;
3. project one deterministic legal next obligation after `STEP_UNVERIFIABLE`, scope-coverage, and check-rebinding rejection;
4. decide explicitly how delivery-only user outcomes relate to Tool-verifiable Plan Steps and Completion Gate, without weakening the gate;
5. recognize the actual `tool.reconciled` event as recovery progress and clear stale warnings;
6. refine Decision Efficiency `plan_progress` so accepted Plan intent is not automatically equated with effective task progress;
7. reuse current Runtime facts and preserve one progress authority;
8. keep Approval, idempotency, duplicate-effect protection, unknown-effect safety, and Completion Gate unchanged unless the Spec separately authorizes a contract decision.

Required evidence should replay the exact mutation/protected failure shapes, prove no duplicate protected execution is needed, verify recovery reconciliation progress, and show that identical rejected/no-effect work still terminates at the current bound. The goal is to reduce entry into no-progress, not increase the threshold.

### 14.2 Candidate A2

Do not authorize A2 immediately. The present A/B did not isolate loss of decision facts because those facts remained in Provider function descriptions. A future A2, if still warranted after the foundation fix, should be a new controlled specification that separates:

```text
schema-shaped duplication removal
from
compact stable-Prompt control/decision guidance
```

It should rerun the same interleaved paired lanes plus delegation, use a stable Plan/Completion baseline, retain the production default as `full`, and require the same hard correctness gates. The audit does not pre-approve its design.

### 14.3 Is an independent Spec worthwhile?

**Yes for the foundation issue; not yet for A2.**

The foundation issue affects general Agent execution correctness in both arms, produces repeated protected operations even in successful runs, creates a false model affordance, and includes a confirmed recovery progress false negative. It has higher product value than another token experiment.

## 15. Audit state matrix

```yaml
feature: decision-efficiency-candidate-a-controlled-ab
mode: AUDIT
scope_status: stable
spec_status: aligned
implementation_status: complete
migration_status: not_applicable
unit_test_status: passed
integration_test_status: passed
uat_status: failed
runtime_status: verified
security_status: release_gate
external_dependency_status: unverified
artifact_status: mixed
resolved_status: abandoned
candidate_a_decision: NO-GO
production_default: full
```

Interpretation:

- the reversible experiment implementation and controlled run exist;
- the production-promotion Definition of Done is not satisfied;
- Provider cold-cache behavior remains unverified;
- Candidate A is abandoned/NO-GO, not promoted;
- production remains on the verified full catalog.

## 16. Verification executed during this audit

Passed on the current worktree:

```text
tests/runtime/e129-bounded-execution-convergence.test.ts        33/33
tests/runtime/e122-objective-plan-progress.test.ts               4/4
tests/runtime/e152-decision-efficiency-candidate-a-tool-catalog.test.ts 2/2
harness/nexora-bench/tests/decision-efficiency.test.ts            3/3
tests/runtime/e049-recovery.test.ts                               6/6
```

Total focused checks: **48/48 passed**.

`pnpm typecheck` was also executed and remains red with the 19 pre-existing errors already recorded in `DEVELOPMENT.md`. No production code was changed in this audit. The real-provider A/B was not rerun; the complete saved 100-run evidence was analyzed instead.

## 17. Final answer to the audit questions

1. Representative runs were selected deterministically and are listed with both arms above.
2. First divergence is almost always the Plan representation, not the final no-progress event.
3. Simple lanes need 2–5 Model Calls; failures spend 4–7 extra calls on control repair.
4. Candidate A's most likely release failure is mixed: cross-arm Plan/Completion instability plus possible Candidate salience loss and Provider/model variance.
5. Decision/effect/evidence guidance is important, but the A/B did not remove its Provider-visible availability; only its duplicate Prompt placement.
6. Description/schema/use/avoid/non-goals/effect/produces are mechanically duplicated. Lane-bounded behavior supports partial redundancy, not universal deletion.
7. Runtime progress is outcome/event based, not a raw counter; exact semantics and reset rules are documented above.
8. Candidate failures show no progress false negative, but `tool.reconciled` versus `tool.recovered` is a confirmed production-code false negative.
9. Correct rejection plus an incomplete/false repair affordance creates artificial loops.
10. Simple tasks stop because Plan repair becomes harder than the domain work after one encoding error.
11. `NO_PROGRESS_DETECTED` is the terminal symptom in these failures, not the root cause; it correctly bounds the loop.
12. The next candidate should address Plan/Completion obligation projection and recovery progress coherence, not token reduction.
13. An independent foundation Spec is justified. Candidate A2 should wait for its evidence.
