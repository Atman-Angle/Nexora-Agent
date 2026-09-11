# Nexora Plan-Control Reliability Hardening Report

Date: 2026-09-03  
Scope: real qwen3.8-flash (DashScope) capability/reliability failures retained in
Harbor trial records, focused on `cap-env-coherent-mapping`.  
Overall finding: **one confirmed Nexora-owned RUNTIME progress/duplicate-guard
deadlock (fix implemented, regression added, validation pending) and one MODEL
plan/step attribution failure**. No Completion Gate, Safety, Evidence, or
Authority semantics were weakened.

## 1. Baseline V1 identity

The cohort, provider, harness and task inputs were frozen for the runs below.

| Dimension | Identity |
| --- | --- |
| Runtime commit (repo HEAD) | `529eaa2e0f8e6239b05656b753c18de727765bc2` (2026-09-02), plus uncommitted worktree (Harbor migration) |
| Provider | DashScope OpenAI-compatible `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Model | `qwen3.8-flash` (`.env` in repo root, adapter forwards only `NEXORA_MODEL_*` and `TAVILY_API_KEY`) |
| Task package | `datasets/nexora-core-v1/tasks/cap-env-coherent-mapping/task.json` (sha256 `956dc153dfa93a67...`), `scenario.ts` (`790c4e8f...`), `grader.json` (`db4133ef...`) |
| Harbor task | `harbor/datasets/nexora-capability-v1/cap-env-coherent-mapping` (`instruction.md` `877a3bd3...`, `tests/test.sh` `ea65e19c...`) |
| Runtime/harness snapshot | `execution/runtime-execution.ts` post-fix `562e619a...`; `runtime.ts` post-fix `1d35c60c...`; `runtime-helpers.ts` `7551f170...`; `completion-gate.ts` `36f86540...`; bench `runner.ts` `699cfdfb...`; `suite-grader.ts` `65029327...`; adapter `agent.py` `4ff9e699...` |
| Budget/tool policy | task.json `maxIterations 40 / maxModelCalls 40 / maxToolCalls 30 / maxRetries 3 / maxDurationMs 900000`; tools `filesystem.list/read/patch`, `shell.execute` |
| Completion gate | deterministic Runtime hard gate (never lowered) |
| STRICT_PASS | external outcome AND Runtime Integrity AND Authority AND Safety AND ExpectedOutcome |
| Evidence runs | Harbor real reliability job `2026-09-03__19-48-51` (3 attempts); baseline evidence `docs/evidence/NEXORA_REAL_PROVIDER_*_V1.json` |

## 2. Retained trajectories investigated

Job `2026-09-03__19-48-51`, task `cap-env-coherent-mapping`, real provider:

| Trial | Terminal | firstBrokenBoundary | External | Notes |
| --- | --- | --- | --- | --- |
| `5WuyoFc` | succeeded | none | pass | 1/1 strict |
| `H78vauW` | failed | CONVERGENCE | pass | Runtime progress/duplicate deadlock (below) |
| `ZM4BEEd` | failed | CONVERGENCE | pass | MODEL step/plan attribution (below) |

Fact bundles, telemetry JSONL and the persisted Runtime DB
(`runtime-v1.1.db`) under `jobs-output/2026-09-03__19-48-51/*` are the primary
evidence. Grading never consumes model self-description.

## 3. H78vauW trajectory and first broken boundary

Chronology from persisted Events/Invocations (all times UTC):

1. `11:49:31` run created; model reads root and `fixture/` files.
2. `11:49:54` Plan v1 set.
3. `11:49:57–11:50:05` patches `services.json` (`checkout -> payments-svc`)
   then `routes.json` (`/v1/login billing -> checkout`) with digest-guarded
   `filesystem.patch`; each mutation has a post-read verification.
4. `11:50:09–11:50:13` reads `routes.json` under an active Step and runs
   `node verify.mjs`; Tool result persisted: exit 0, `coherent mapping
   verified` (invocation `a400d029…`, plan v1, `step-204a…`, `checkIds: []`).
   Because no current Step check consumed this Tool result, Step progress did
   not change; the durable fact existed but Progress could not account it.
5. Plan advances/revisions; final Plan v2 requires
   `step-e698d8b6…` `Run the provided verifier and confirm it passes` with
   required check `check-1b89ce0b…` (`shell.execute` success).
6. `11:51:37` completion rejected:
   `STEP_INCOMPLETE:step-e698d8b6…, CHECK_UNSATISFIED:…check-1b89ce0b…`. The
   rejection names exactly the missing Step/check.
7. `11:51:42.148` the model resubmits the identical `node verify.mjs`.
8. `11:51:42.261` Runtime rejects: “Tool action duplicates an existing
   persisted Invocation with status succeeded; do not repeat it.”
9. `11:51:42.306` `NO_PROGRESS_DETECTED` (two invalid responses); Run failed.

Answers to the hardening questions for this trial:

- The model knew what remained: the Runtime rejection named the exact Step and
  check, and the model’s next action was precisely that command.
- The Runtime already owned the required durable fact (verify exit 0 after the
  last mutation); Progress could not consume it under the current Step because
  Evidence is Step/check-scoped and the earlier invocation was bound to a
  different Step with no check id.
- The resubmission was not a duplicate *effect*; it was the only action that
  could satisfy the required check, and the Runtime rejected it for
  side-effect safety even though the same durable result was already persisted
  and no later command/mutation could have changed state.

First broken boundary: **RUNTIME progress/evidence accounting + duplicate-guard
deadlock** (see fix in Section 5).

## 4. ZM4BEEd trajectory and classification

ZM4BEEd never completed Step `d1196a0f…` (route correction) or
`def06940…` (verifier):

- Route `filesystem.patch` was applied under the earlier Step `b596ad42…`
  without a binding check (`checkIds: []`), so Step `d1196a0f…`’s required
  mutation check `de9c3c4e…` stayed unsatisfied even though the route effect
  was durable.
- `node verify.mjs` was executed under `d1196a0f…` (again `checkIds: []`),
  not under the pending verifier Step `def06940…`.
- Completion attempts were correctly rejected
  (`STEP_INCOMPLETE` for both Steps); a Plan-scope revision attempt was
  correctly rejected (`TASK_SCOPE_REVISION_REQUIRES_NEW_USER_INPUT`).
- The model retried completion instead of revising the unfinished Step, and
  `NO_PROGRESS_DETECTED` fired.

Classification: **MODEL plan/step attribution failure**. The Completion Gate and
Authority semantics behaved correctly. The verification replay fix in Section 5
additionally makes a valid repair path available (revise the unfinished Step,
then resubmit the verifier), but this trial is retained as model-side evidence,
not evidence of a Runtime accounting defect.

## 5. Fix: verification replay for a duplicate execute

`packages/runtime/src/execution/runtime-execution.ts` (single-action
`call_tool` path) and `packages/runtime/src/runtime.ts` (`execute_step` batch
preflight, mirrored rule):

- When an `execute` Tool action is a duplicate of an earlier **succeeded**
  Invocation with identical input, and the **active** Plan Step explicitly
  requires that exact Tool result (`tool_result`, role `verification`,
  required, success), and no later succeeded command or mutation can have
  changed state, the Runtime no longer rejects the action.
- It binds the Step’s required check id to the resubmitted action and replays
  the persisted Tool result under the current Plan/Step **without physically
  re-executing the command** (`executeToolInvocation` replay path). A new
  Invocation record with current Plan version/Step is persisted, evidence is
  Step-scoped, and `completeSatisfiedSteps`/the Completion Gate consume it.
- Physical duplicate execution remains blocked; write duplicates remain
  rejected in both paths; approval flow is unchanged (each replay request still
  passes the protected-action approval boundary); Lease/Fencing and budgets
  are unchanged.

Contracts preserved: Completion Gate (not lowered), Approval ordering,
Evidence provenance/freshness, idempotency (no second side effect), duplicate
execute safety for arbitrary commands, STRICT_PASS composition, and
false-success/unsafe-invocation detection.

Regression: `tests/runtime/e146-verification-replay.test.ts` reproduces the
general failure class (verifier executed with no consumable check, completion
rejected, identical resubmission against the active verifier Step) and asserts
the run succeeds with exactly one physical Tool execution.

## 6. Verification status

Completed:

- `tests/runtime/e146-verification-replay.test.ts`: **passed** (1/1) after
  rebuilding `@nexora/runtime`/`@nexora/harness` dist;
- related Runtime suites: e049-approval 2/2, e053 tool/approval 4/4 passed;
  e049-plan-authority and two e049-completion-integrity failures reproduce
  identically with the Runtime change reverted, so they are pre-existing tree
  drift unrelated to this fix;
- bench suite: 23/23 passed; bench typecheck passed; Fault Lab 28/28 passed
  (failed = []);
- Harbor adapter Python tests: 7/7 (`scenario_id: auto` regression included);
- Harbor deterministic aggregate (corrected scenario mapping): smoke 10/10 and
  reliability 30/30 (10 tasks x 3), all component means 1.000, mapping
  task==scenario for all 30 trials (jobs `2026-09-03__23-41-06`,
  `2026-09-03__23-50-14`);
- Scoped `tsc -p tsconfig.json --noEmit`: no errors in changed files.

Pending:

- None for the verification-replay fix itself. Full frozen same-cohort real
  paired evaluation (10 tasks x 3 attempts) is **complete** (see Section 9).
  Remaining known limitations are model-side (data-ordered wrong-content
  completion, local-discovery completion/approval trials) and are documented
  in `NEXORA_EVALUATION_AND_HARDENING_REPORT.md`.

## 9. Focused real Before / After

Same frozen task/provider/model (`qwen3.8-flash`, job configs untouched except
Runtime code):

| Metric | Before (`19-48-51`) | After (`00-14-30`) |
| --- | ---: | ---: |
| External | 3/3 | 3/3 |
| STRICT_PASS | 1/3 | 3/3 |
| All-3 | false | true |
| Terminal | failed 2, succeeded 1 | succeeded 3 |
| firstBrokenBoundary | CONVERGENCE 2, none 1 | none 3 |
| False success / unsafe invocation | 0 / 0 | 0 / 0 |

Existing Before numbers for `cap-env-coherent-mapping` real reliability remain:
external 3/3 (5/5 including earlier singles), strict 1/3 (1/5 including
singles), false success 0, unsafe invocation 0.

### Full frozen cohort After (10 tasks x 3 attempts, real qwen3.8-flash)

All ten jobs completed with zero infrastructure exceptions:

- empirical strict pass rate 28/30 (0.933) versus Before 25/30 attempts
  (0.833; Before also included one container-setup ECONNRESET);
- external pass 29/30; the one external failure is a wrong-content completion
  on `cap-data-ordered-report` caught by the external gate (MODEL, not
  Runtime);
- All-3 achieved on 8/10 tasks (artifact, batch, serializer, coding,
  tax, env-coherent, env-config, mixed);
- `cap-local-discovery-handoff` 2/3 strict with external 3/3:
  COMPLETION_CONTRACT on two trials and one APPROVAL-required trial (model /
  approval-driver class, not the replay defect);
- Runtime Integrity / Authority / Safety means 1.0 across all ten jobs;
  false success 0, unsafe invocation 0;
- evidence: `docs/evidence/NEXORA_REAL_PROVIDER_HARDENING_AFTER_V1.json`.

## 7. Remaining limitations and recommendations

- ZM4BEEd shows a model-side failure mode where effects are applied under the
  wrong unfinished Step and the model does not revise the Step. The Runtime
  rejection text names the missing checks; if post-fix paired runs still show
  this class, a model-visible projection improvement (not contract weakening)
  is the next candidate.
- Mutations under a wrong Step still have no replay path: a write that already
  achieved a required outcome cannot be re-attributed to the Step that requires
  it. That is intentionally conservative (no safe write replay) and should be
  documented as a model-visible limitation.
- Provider failure counts were high in these trials (26/20 diagnostics);
  separate provider-availability metrics should be tracked independently from
  convergence failures in future projections.

## 7a. Performance / token / latency changes

The fix adds no physical execution and no extra Provider call: a replay reuses
the persisted Tool result, so it cannot increase model/tool/token counts
compared with the rejected duplicate action. Observed wall-clock evidence:

- Before (real, `19-48-51`, cap-env-coherent-mapping): three trials, two ended
  in `NO_PROGRESS_DETECTED` after repeated rejection cycles; one successful
  trial took ~36s of Runtime time, the failing trials ~2m+ each with 13 model
  calls and 16 Tool invocations.
- After (real, `00-14-30`, cap-env-coherent-mapping): three trials completed
  with the Harbor job reporting 2m54s total for the whole 3-attempt job; no
  terminal failure, no replayed duplicate deadlock.
- DashScope pricing is not configured, so USD cost is not reported; exact
  token/model-call telemetry for every After trial remains in each job's
  `nexora-runtime-telemetry.jsonl` and Runtime DB.

## 8. Next steps

1. Completed: e146 regression, deterministic Harbor aggregate 30/30, Fault Lab
   28/28, real focused and full ten-task After cohort (see Section 9).
2. Optional follow-ups: decide whether ZM4BEEd’s model-side class needs
   control-projection changes; human review of the ten tasks; real All-5 runs.
