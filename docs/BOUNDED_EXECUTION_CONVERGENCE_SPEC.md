# Bounded Execution Convergence Spec

Status: Implemented and verified locally; real-Provider acceptance pending explicit credential authorization

Feature: `bounded-execution-convergence`

Mode: `RECOVER -> CONTINUE -> VERIFY`

Risk: L3

Primary owners: Runtime, Harness, Desktop Host

Evidence baseline: Session `af54696b-cbde-46a1-822f-57ec9361c6f7`, Run `e17cb82c-fbba-43f7-86b0-039141695d6d`

## 1. Outcome

Nexora must make bounded, observable progress on an ordinary repository modification task. Repeating a model intention must not amplify without bound into repeated reads, Plan revisions, Tool Invocations, Provider calls, Worker Runs, token cost, or Desktop Sessions.

When execution cannot make progress, the Runtime must preserve the authoritative facts and move to a recoverable state that the Host can present and control. It must not continue asking the Provider to rediscover the same blocked condition.

This Feature repairs the interaction between capabilities that already exist:

- Run budgets and budget extension;
- Supervisor/Worker delegation and Branch recovery;
- Structured Plan authority;
- Tool Invocation/Evidence authority;
- read reuse and Context observation collapse;
- Session continuation and deterministic Context governance;
- Desktop Session projection.

It does not add a workflow engine, a second task state, a new Context store, a Dashboard, or a Provider-specific execution path.

## 2. Triggering evidence

The baseline Run was cancelled after 32.2 minutes while attempting a normal multi-page repair.

| Measure | Persisted result |
| --- | ---: |
| Model calls | 90 |
| Tool calls | 123 |
| Evidence records | 118 |
| Provider processing time | 1,109.1 seconds |
| Actual Provider input tokens | 10,300,617 |
| Provider output tokens | 65,503 |
| Context input, first / peak / final | 107,147 / 204,279 / 188,437 |
| `plan.set` events | 19 |
| Successful / failed patches | 9 / 5 |
| Approval requested / granted | 16 / 16 |
| Budget extensions | 4 |

File reads were concentrated on seven files: `pricing.html` 22 times, `solutions.html` 17, `about.html` 16, `login.html` 15, `signup.html` 15, `index.html` 13, and `features.html` 9. Of 107 reads, 34 reused a cached physical result and 73 executed physically. Context projection collapsed 118 successful Invocations to 27 unique Observations, so projection deduplication worked partially but did not prevent execution amplification.

The Run did not exceed the configured one-million-token Provider window. The current soft input limit was about 786,000 tokens, so automatic Context compaction correctly did not trigger under the existing capacity policy. The problem is cumulative cost and lack of convergence, not a single-request Context overflow.

### 2.1 Deterministic P0 failure

After the Parent had used approximately 50 iterations, 50 model calls, and 66 tool calls, it delegated five mutation assignments. Each Child received absolute limits of 12 iterations, 8 model calls, and 4 tool calls, but `createRunFromSnapshot()` copied the Parent's already-used counters into the Child.

Consequently, every Child reached `blocked / ITERATION_BUDGET_EXCEEDED` with zero Child model calls and zero Child tool calls. The Branches remained `active`, and Parent completion was rejected three times because five delegated Worker Runs were still active.

The conflicting implementation is:

- `packages/runtime/src/store/run-store.ts`: `createRunFromSnapshot()` copies `parent.budgetsUsed`;
- `packages/runtime/src/runtime.ts`: delegated Children replace only `budgets` with `compileChildBudgets(...)`;
- `packages/runtime/src/runtime.ts`: completion rejects while a non-terminal Child remains on an active Branch.

This is a correctness defect, not a prompt-quality issue.

## 3. Existing authority and invariants

The implementation must preserve these boundaries:

1. Run Snapshot and State Machine remain the only Run-status authority.
2. Run-owned Structured Plan remains the only current Plan.
3. Tool Invocation remains the authority for attempted and completed side effects.
4. Evidence and Artifact records remain the authority for verifiable results and large payloads.
5. Child Run remains the authority for Worker execution; Parent Worker Observation is a derived projection.
6. Branch remains the lineage and isolation boundary, not a second Run state.
7. Harness builds the Context view from persisted Runtime facts. Desktop never summarizes or owns model Context.
8. Session is a Host projection over one or more user-visible Runs. Internal Worker Runs are not Sessions.
9. Approval remains required for mutations according to the Tool contract. Efficiency work must not bypass it.
10. Budget extension raises absolute limits only. It never resets usage, replays side effects, or implies progress.

## 4. Root-cause and priority matrix

| Priority | Problem | Evidence | Root cause | Required owner |
| --- | --- | --- | --- | --- |
| P0 | Child immediately exhausts budget | 5 Children, 0 calls, all blocked | Parent usage copied into a Child with smaller absolute limits | Runtime/Store |
| P0 | Parent cannot finish or recover blocked Workers | three completion rejections | blocked Child keeps Branch active; Desktop exposes no Child recovery control | Runtime + Desktop Host |
| P0 | Mutation assignment compiled as read-only researcher | Worker prompt forbids mutation | default Worker role and assignment intent disagree | Harness policy + Host configuration |
| P0 | Worker Runs appear as ordinary Sessions | five internal Runs in Session navigation | Desktop imports every unmapped `listRuns()` result | Runtime projection + Desktop Host |
| P1 | repeated reads remain expensive | 107 read Invocations, 73 physical | any non-read Tool globally invalidates read reuse | Runtime execution |
| P1 | no-progress loop consumes budgets | 90 model / 123 tool calls | cache prevents some I/O, but no persisted progress detector bounds repeated decisions | Runtime/Harness |
| P1 | Plan churn | 19 `plan.set` events | no-op is narrow: only exact semantic digest, no current-version Invocation, and no error | Runtime/Harness |
| P1 | duplicate Branch fact | 10 `branch.created` for 5 Branches | creating-to-active transition emits `branch.created` again | Runtime/Store contract |
| P2 | Context is capacity-safe but cost-heavy | 10.3M aggregate input tokens | soft limit follows window capacity only; 1M window retains a large active projection for 90 calls | Harness Context policy |
| P2 | repeated extensions prolong a stalled Run | four extensions, 32.2 minutes | extension has no progress-quality preflight | Runtime projection + Host UX |
| P2 | patch conflict repair is costly | five `PATCH_CONFLICT` failures | exact single-match patch is weak for repeated multi-file edits | Tool ergonomics; deferred |

## 5. Scope

### 5.1 In scope

- fresh Child budget accounting for delegated Runs;
- deterministic handling and Host recovery of blocked Workers;
- explicit delegation eligibility and safe Desktop defaults;
- lineage-aware Run listing for Desktop Session synchronization;
- unique Branch lifecycle events;
- path-scoped read-cache invalidation where Tool contracts provide a trustworthy resource identity;
- persisted, bounded no-progress detection based on existing events and Invocation facts;
- semantically stable Plan reconciliation without a second Plan representation;
- cost/latency-aware Context soft target below the hard Provider capacity limit;
- progress evidence presented before another budget extension;
- deterministic tests, crash/reopen tests, Desktop UAT, and one authorized real-Provider UAT.

### 5.2 Non-goals

- a Workflow DSL, task graph scheduler, or model-independent planner;
- automatic editing of Plan progress in Renderer;
- exposing chain-of-thought or private Provider reasoning;
- a Worker topology Dashboard or Worker Sessions in the Sidebar;
- removing approval for mutations;
- automatic unlimited budget extension or Provider retry;
- a second Context database or Session transcript authority;
- Provider-name special cases;
- `batch_patch`, `replace_all`, or a new mutation Tool in this Feature;
- changing the Completion Gate to accept unverified work;
- deleting or rewriting historical Runs.

## 6. Required behavior

### 6.1 P0 — Child budget accounting

For a delegated Child, `budgetsUsed` starts at zero with a new `startedAt`. Its `budgets` are the Child's absolute limits compiled from Host policy and the Parent's remaining delegation envelope.

Parent usage is retained in the immutable Fork Base/audit history and must not be reinterpreted as Child usage. A manual exploratory fork may continue to inherit the documented fork semantics; delegated Child construction must be explicit so the two cases cannot accidentally share accounting behavior.

Required invariants:

```text
child.budgetsUsed.iterations = 0
child.budgetsUsed.modelCalls = 0
child.budgetsUsed.toolCalls = 0
child.budgetsUsed.retries = 0
child.budgetsUsed.startedAt = child.createdAt
```

`compileChildBudgets()` may cap a Child by the Parent's remaining envelope, but it must reject delegation before creating a Child if the resulting useful allowance is below the minimum required to perform one decision and the assignment's permitted Tool action. It must not silently compile a one-call Child that cannot satisfy its assignment.

### 6.2 P0 — Worker lifecycle and recovery

A Worker batch has four derived join conditions:

- `complete`: all Children are terminal and successful results are available;
- `recoverable`: one or more Children are blocked and have a supported recovery action;
- `terminal-partial`: one or more Children failed/cancelled and no Child remains active;
- `running`: at least one Child is executing.

These are projections from Child Run and Branch facts, not a persisted Worker outcome state.

When a Child becomes blocked:

1. the Branch may remain active so the same Child identity can resume;
2. Parent receives a Worker Observation containing the exact stop reason and delivery;
3. Parent must not continue through repeated completion rejection;
4. execution yields control through a supported recovery projection;
5. Host may resume the Child when the stop reason supports resume, or discard the Branch;
6. after all active Children are resolved, the same Parent resumes and observes the resulting batch.

The minimum public recovery projection must identify `parentRunId`, `branchId`, `childRunId`, Child status, exact stop reason, and allowed actions. Runtime remains the action authority. Desktop only invokes Runtime controls.

Existing active Branches must remain recoverable after restart. Startup must not automatically discard, rerun, or spend Provider budget.

### 6.3 P0 — Delegation eligibility

Delegation is allowed only when the Host supplies an explicit delegation policy whose Worker profile and Tool allowlist can perform the assignment class. The default Runtime library behavior may remain available for explicit consumers, but Desktop must not implicitly enable delegation merely because the Runtime default is `allowed`.

For the first implementation:

- Desktop sets delegation mode to `disabled` unless a complete Desktop Worker policy is configured;
- a read-only `researcher` Worker may receive only read/research assignments;
- a mutation assignment must not be sent to a profile whose role contract says not to modify state;
- Runtime validates profile existence and allowed Tool names before persisting `workers.delegation.accepted`;
- Runtime does not infer mutation intent from arbitrary natural language.

Supporting mutation Workers is a later explicit Host configuration task. It requires a named mutation-capable profile, permitted mutation Tools, independent approvals, and a defined merge policy. This Feature must not manufacture that policy from the baseline prompt.

### 6.4 P0 — User-visible Run projection

Runtime adds or extends a read-only Run summary projection with lineage classification sufficient to distinguish:

- root/user Run;
- manual branch Child;
- delegated Worker Child.

Desktop imports only root/user Runs as Sessions. It must not derive lineage by reading SQLite, `.nexora`, event payload internals, or title patterns.

Worker activity remains visible inside the Parent Session's Conversation/Activity projection. It does not create Sidebar entries.

### 6.5 P0 — Branch event uniqueness

Exactly one `branch.created` event is emitted for a Branch identity. The creating-to-active transition must use a distinct existing generic Runtime event or a new `branch.activated` event if consumers require the transition.

The chosen event schema must be made once at the Runtime contract boundary. Renderer must not deduplicate duplicate facts. Historical duplicate events remain readable and are not migrated.

### 6.6 P1 — Resource-scoped read reuse

The read cache remains opt-in through `execution.readCache.mode = "until_mutation"`.

Invalidation rules:

| Intervening fact | Reuse effect |
| --- | --- |
| same read, same canonical input, no invalidating mutation | reuse |
| filesystem mutation with trustworthy exact target | invalidate matching resource only |
| mutation of a different exact resource | keep unrelated resource reusable |
| shell command or mutation with unknown affected resources | invalidate all reusable reads |
| Run reopen/resume | invalidate according to existing durability rule |
| failed/refused mutation with no side effect | do not invalidate |
| unknown Tool outcome | invalidate conservatively |

Resource identity must come from Tool contract/input normalization or successful Invocation facts. The Runtime must not parse arbitrary shell text to guess affected files.

A reused result remains a real Invocation with `physicalExecution=false` and provenance to the original Invocation. It still counts as a Tool call because the model requested an action, but it participates in no-progress detection.

### 6.7 P1 — No-progress detection

No-progress detection is deterministic and Run-owned. It evaluates a bounded recent window of persisted facts; it does not ask another model to decide whether progress occurred.

Progress signals are:

- new user input;
- accepted Plan semantic change tied to new facts;
- first successful Invocation for a new canonical Tool/input fingerprint;
- changed successful result digest for an existing fingerprint after a relevant mutation;
- successful mutation with a new effect fingerprint;
- newly satisfied Acceptance Check or Step transition;
- new valid Evidence subject/digest;
- resolved Approval/Input/Recovery request;
- Validation state improvement;
- terminal Child or resolved Branch transition.

The following alone are not progress:

- another model call;
- exact or semantically equivalent `plan.set` no-op;
- cached read returning the same result digest;
- repeated successful read with the same canonical input/result;
- repeated rejected completion with the same issue set;
- repeated failed patch with the same target/base/result conflict fingerprint;
- public filler such as “execute” or “let's go”;
- budget extension.

On the first bounded repetition threshold, Harness receives a compact repair fact listing the repeated fingerprints and the latest authoritative state. It must choose a materially different action, request user input, or finish from existing evidence.

If the next bounded window still contains no progress, Runtime blocks the Run with proposed stop reason `NO_PROGRESS_DETECTED` and a persisted diagnostic summary. Resume requires explicit user action. A plain resume without new input may be permitted once; another identical stall blocks again without automatic extension.

`NO_PROGRESS_DETECTED` is a proposed addition to the public stop-reason contract and therefore a P0 contract decision before implementation. If maintainers reject the new reason, the alternative must be an existing generic blocked reason with the same structured diagnostic projection; it must not be encoded only in free-form text.

Initial thresholds are policy constants covered by tests, not user-facing tuning controls:

- repair after 3 equivalent no-progress action cycles;
- block after 2 failed repair windows;
- only the last bounded fingerprints are stored in the diagnostic event; full facts remain in existing authorities.

Thresholds must be calibrated against deterministic fixtures before release. They must not block a sequence that reads different resources or produces new result digests.

### 6.8 P1 — Plan stability

The current exact no-op condition is too narrow because it requires no Invocation for the current Plan version and no `lastError`. Plan identity must instead be reconciled against semantic objectives and Acceptance Checks while preserving the current Plan authority.

Required behavior:

- exact equivalent Plan proposals do not create a new Plan version;
- equivalent objectives retain Step IDs and valid progress;
- cosmetic wording changes do not duplicate completed objectives when objective identity is otherwise stable;
- new user input or genuinely changed objectives may create a new version;
- an error does not by itself force an unchanged Plan revision;
- Tool activity under the current version does not by itself force an unchanged Plan revision;
- every accepted/no-op proposal remains auditable, but UI progress is derived from the current Structured Plan only.

No second normalized Plan is persisted. Semantic fingerprints are derived from the proposal/current Plan at the Runtime/Harness boundary and may be included in event diagnostics.

### 6.9 P2 — Context capacity versus cost target

Session continuity remains complete at the authority layer. This Feature does not drop earlier Runs or replace the Session transcript with a frontend summary.

Harness distinguishes:

1. hard capacity: Provider context window minus reserved output;
2. capacity soft limit: existing safety threshold for deterministic eviction/compaction;
3. active cost target: a lower Host/Profile-provided target used to keep repeated decision calls affordable and responsive.

The active cost target is optional Provider model-profile policy, bounded above by the capacity soft limit. It is not a new Context authority. When exceeded, the existing deterministic projection/compaction pipeline reduces low-value historical payloads before the Provider call.

Facts retained at highest priority include:

- current user goal and latest user input;
- current Task Contract and Structured Plan;
- unresolved Approval/Input/Recovery requests;
- unknown or unresolved side effects;
- latest changed files and mutation outcomes;
- current validation failures and completion requirements;
- latest relevant Worker Observations;
- compact continuation summaries and references required to recover older facts.

Repeated read payloads, old successful Invocation bodies, consumed Worker batches, and superseded Plan proposal payloads may become fragment/reference while their authoritative records remain intact.

The policy must measure both single-call safety and per-Run amplification:

```text
aggregateInputTokens
modelCalls
uniqueObservationCount
readInvocationCount / uniqueReadFingerprintCount
physicalReadCount / uniqueReadFingerprintCount
planProposalCount / acceptedPlanVersionCount
providerActiveMs / runActiveMs / userWaitMs
```

Provider prompt-cache telemetry is recorded when supplied but never assumed. Missing telemetry is `unknown`, not zero.

### 6.10 P2 — Budget extension quality gate

Budget extension remains an explicit user control. Before Desktop offers it, Runtime inspection must provide:

- the exhausted budget and current/maximum usage;
- progress signals since the previous start/resume/extension;
- repeated-action diagnostics, if any;
- unresolved Worker/Approval/Input/Tool state;
- Provider active time and wall-clock segment time when available.

Desktop shows this as a concise Composer recovery state, not a Dashboard. If no progress occurred since the previous extension, the primary action is to provide corrective input or stop; extension remains available only as an explicit secondary action. Runtime does not auto-extend.

## 7. End-to-end data flow

```text
User goal
  -> Desktop Host starts root Run
  -> Runtime persists Input / Task Contract / Plan / Invocations
  -> Harness builds bounded Context from persisted facts
  -> Provider chooses public output or Runtime action
  -> Runtime validates action and executes through Tool authority
  -> convergence reducer compares new persisted facts with bounded recent fingerprints
       -> progress: continue
       -> first stall: inject persisted repair diagnostic into next Context
       -> repeated stall: block with structured recovery diagnostic
  -> optional delegation
       -> explicit Host policy validates profile/tool envelope
       -> delegated Child starts with zero usage and bounded absolute budget
       -> Child result/blocked state projects as Worker Observation
       -> Parent joins, or Host resumes/discards blocked Child
  -> Completion Gate validates authoritative Evidence
  -> Desktop projects root Run as Session and internal activity in its flow
```

## 8. Failure and recovery semantics

| Failure | Persisted state | Automatic behavior | User/Host action |
| --- | --- | --- | --- |
| insufficient useful Child allowance | Parent action rejected before Child creation | one bounded model repair | adjust plan or budget |
| Child budget exhausted | Child blocked; Branch active | none | extend/resume Child or discard Branch |
| Child Provider unavailable | Child blocked; Branch active | existing bounded retry policy only | retry Child or discard |
| Child terminal failure | Child terminal; Branch discarded | Parent receives partial Observation | continue or request input |
| repeated no-progress | Parent blocked with diagnostic | none after repair window | add corrective input, resume, or cancel |
| unknown Tool result | existing blocked unknown state | no replay | existing recovery decision |
| Context above active cost target | same Run; reduced Context view | deterministic projection/compaction | none normally |
| Context above hard limit | existing capacity block | no Provider request | compact/change model/recover |
| process restart with active Branch | same Child and Branch identities | rebuild projections only | explicit resume/discard |

Recovery must never replay a succeeded mutation, reset budget usage, synthesize Evidence, or silently discard a Branch.

## 9. Public contract impact and decisions

The implementation may require these minimal contract changes:

1. Run summary lineage classification for Host filtering — additive, read-only.
2. Worker recovery projection and allowed actions — additive, derived from existing facts.
3. `branch.activated` event or equivalent generic lifecycle event — additive; historical events unchanged.
4. structured convergence diagnostic in Run inspection/events — additive.
5. proposed `NO_PROGRESS_DETECTED` stop reason — additive but changes a public enum.
6. optional model-profile active Context target — additive policy field, validated below capacity soft limit.

The user accepted this Spec for implementation. The additive contract changes are implemented at the Runtime boundary and none introduces a new state authority.

## 10. Implementation plan

### Phase 1 — Correctness and recoverability

1. Separate delegated Child initialization from general fork snapshot copying.
2. Reset delegated Child usage and add late-delegation regression tests.
3. Validate useful Child allowance before Branch creation.
4. Make Branch lifecycle events unique.
5. Add lineage to the public Run summary projection.
6. Filter internal Children from Desktop Session synchronization.
7. Disable implicit Desktop delegation until an explicit compatible policy exists.
8. Add minimal Worker recovery projection and Desktop Composer actions for resume/discard.
9. Add restart recovery tests for a blocked Child and its Parent.

Exit criterion: the baseline late-delegation shape cannot create zero-call budget-blocked Children, and any blocked Child is actionable without SQLite access.

### Phase 2 — Execution convergence

1. Introduce canonical recent-action/result fingerprints derived from existing facts.
2. Implement resource-scoped invalidation for built-in filesystem Tools.
3. Keep shell/unknown effects globally invalidating.
4. Broaden Plan semantic no-op reconciliation without changing Plan authority.
5. Persist bounded repair/no-progress diagnostics.
6. Add the agreed blocked recovery reason/projection.
7. Add amplification tests for repeated read, cached read, patch conflict, unchanged Plan, and repeated completion rejection.

Exit criterion: deterministic adversarial Providers cannot exceed the bounded repair window without new progress.

### Phase 3 — Context cost governance

1. Add and validate the optional active Context cost target.
2. Route it through the existing Harness Context projection and compaction path.
3. Preserve current authoritative/recovery priorities.
4. Add aggregate amplification metrics to inspection/benchmark reports.
5. Test large-window models where capacity soft limit would otherwise never trigger.

Exit criterion: a long fixture retains Session continuity and completion evidence while aggregate input-token amplification falls below the acceptance bound.

### Phase 4 — Long-run Host experience and real Provider verification

1. Project extension-quality facts in the existing Composer recovery state.
2. Distinguish Provider active, Tool active, approval wait, and recovery wait time in Activity details.
3. Run deterministic Desktop UAT with Worker blocked/recovery and no Session leakage.
4. Run one explicitly authorized real-Provider repair workload.
5. Record the report and update `DEVELOPMENT.md` only after all gates pass.

Exit criterion: the user can understand why execution paused and recover it from the Parent Session without a Dashboard or internal Run navigation.

## 11. Acceptance matrix

| ID | Acceptance | Required evidence |
| --- | --- | --- |
| BEC-01 | late-delegated Child starts with zero usage | Runtime test with Parent already above 50 calls |
| BEC-02 | Child executes up to its own limits | deterministic Worker Provider test |
| BEC-03 | insufficient Child allowance creates no Branch | store/event assertion |
| BEC-04 | blocked Child has exact reason and allowed recovery actions | inspection contract test |
| BEC-05 | restart preserves same Child/Branch identity | crash/reopen integration test |
| BEC-06 | Parent cannot spin on identical completion rejection | adversarial Provider bounded-call test |
| BEC-07 | mutation objective is not assigned to read-only Worker | policy validation test |
| BEC-08 | Desktop defaults cannot create implicit Workers | Desktop service test |
| BEC-09 | internal Child never appears as Sidebar Session | Desktop synchronization/UAT |
| BEC-10 | one Branch produces one `branch.created` | event sequence test |
| BEC-11 | write to file A preserves cached read of file B | Runtime read-reuse test |
| BEC-12 | shell/unknown effect invalidates all reads | Runtime safety test |
| BEC-13 | equivalent Plan does not increment version after Tool activity/error | Plan authority tests |
| BEC-14 | repeated same read/result triggers repair then bounded block | adversarial Provider test |
| BEC-15 | different resources/results count as progress | negative no-progress test |
| BEC-16 | no-progress recovery never replays successful mutation | Invocation/effect assertion |
| BEC-17 | active Context target compacts large-window workload | Context benchmark fixture |
| BEC-18 | latest goal, Plan, unresolved effects, and validation survive compaction | projection assertions |
| BEC-19 | aggregate usage reports unknown cache telemetry truthfully | Model Call ledger assertion |
| BEC-20 | extension view reports progress since prior segment | Runtime/Desktop projection test |
| BEC-21 | four repeated extensions are never automatic | control/event assertion |
| BEC-22 | baseline-shaped task reaches terminal/recoverable state within bounds | deterministic system test |
| BEC-23 | authorized Qwen task has no zero-call Worker and no unbounded repeated read | real-Provider report |

### 11.1 Initial quantitative bounds

For the deterministic seven-file baseline fixture:

- no more than 2 physical reads per unchanged file between relevant mutations;
- no more than 3 equivalent no-progress action cycles before repair;
- no more than 2 repair windows before block;
- no duplicate Branch lifecycle facts;
- no internal Worker Sessions;
- aggregate model calls and Tool calls must remain below the fixture's configured hard budgets without extension;
- Context must remain below hard capacity on every call;
- aggregate input-token amplification must improve materially against a locked pre-fix fixture. The exact percentage is set from the reproducible fixture before Phase 3 implementation, not from the one-off real Run.

Real-Provider UAT is evidence of integration, not the sole regression oracle. Provider latency and model choice are variable.

## 12. Test strategy

Risk is L3 because the Feature touches budgets, recovery, side-effect replay protection, Context governance, and public Runtime projections.

### Unit and contract

- delegated versus manual-fork budget initialization;
- Child allowance compilation at boundary values;
- lineage projection schema;
- Plan semantic fingerprint/no-op;
- resource invalidation matching;
- progress fingerprint reducer and thresholds;
- active Context target validation.

### Integration

- Parent with high prior usage delegates two Children and both perform real deterministic Tools;
- one Child succeeds and one blocks, then restart, resume/discard, and Parent completion;
- process crash after accepted delegation and before join;
- repeated patch conflict without mutation replay;
- read A/read B/write A/read B and unknown-effect variants;
- multiple Session turns with compaction and recovery facts;
- Desktop synchronization across root and internal Child Runs.

### System/UAT

- deterministic Desktop task showing Conversation activity, blocked Worker recovery, result, and no Worker Sidebar entry;
- baseline-shaped seven-file repair using a scripted adversarial Provider;
- one authorized real Qwen repair task with a fixed prompt/workspace snapshot and persisted report;
- full Runtime/Harness release suite, Supervisor suite, Desktop deterministic UAT, typecheck, lint, and build.

## 13. Existing-data recovery

No destructive migration is required.

- Existing Runs and duplicate historical `branch.created` events remain readable.
- Existing active Branches are classified from stored lineage.
- Existing delegated Children with inherited usage are not silently reset because that would rewrite consumed-budget authority.
- Host presents resume/discard. If the Child is budget-blocked solely because of inherited usage, the safe default is discard and a new correctly initialized delegation; any automated repair would require an explicit migration decision and audit event.
- Hidden/session metadata is not used to delete Runtime Runs.

## 14. Rollback

Each phase must be independently releasable.

- Phase 1 rollback restores prior projection behavior but must not rewrite Runs created under the corrected budget semantics.
- Phase 2 no-progress enforcement must be guarded by one Runtime policy version so it can be disabled without deleting diagnostics.
- Phase 3 active target is optional; omitting it restores capacity-only governance.
- Desktop projection changes are read-only and can fall back to root Runs only.

Rollback never removes audit events, Tool Invocations, Evidence, Artifacts, or Branch lineage.

## 15. Deferred candidates

The audit found one useful but non-essential follow-up: a first-class multi-file patch/replace Tool could reduce exact-match conflicts in repetitive HTML work. It is deliberately excluded because it changes the public Tool Contract, approval grouping, idempotency, and recovery semantics. It should be proposed only if the Phase 2 baseline still fails its efficiency bounds after read reuse, Plan stability, and no-progress handling are corrected.

Likewise, mutation-capable parallel Workers require an explicit product decision about isolated workspace merge and per-Worker approval. Disabling implicit Desktop delegation is the safe minimal first release.

## 16. Definition of Done

This Feature is complete only when:

1. all BEC acceptance items have reproducible evidence;
2. the public contract decisions in section 9 are documented and versioned;
3. no second Run, Plan, Worker, Context, or Session authority was introduced;
4. existing approval, Evidence, Completion Gate, idempotency, and recovery invariants pass regression;
5. deterministic baseline execution is bounded and recoverable;
6. Desktop exposes recovery in the existing two-column Session flow without a Dashboard;
7. the authorized real-Provider UAT report distinguishes Runtime defects from Provider variability;
8. `DEVELOPMENT.md` records the verified result and remaining external risks.

### 16.1 Verification record

Local Feature Core verification completed on 2026-08-23:

- `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed;
- the complete test suite passed: 101 files and 492 tests;
- the Runtime/Harness release gate passed: 16 files and 91 tests;
- the Supervisor/Coordinator gate passed: 5 files and 22 tests;
- `pnpm desktop:uat:deterministic` passed through the public Desktop path;
- BEC-23 remains an external-environment acceptance item because no Provider credentials were used during this verification.
