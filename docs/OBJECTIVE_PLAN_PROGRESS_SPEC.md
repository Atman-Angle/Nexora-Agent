# Nexora Objective-only Plan Progress Spec

Status: `COMPLETE`

Feature mode: `DIRECT`

Feature: `objective-plan-progress`

Risk: `L3`

Date: 2026-08-17

## 1. Problem

Provider Plan controls contain only ordered semantic objectives. Harness compiles those objectives into Steps with no Acceptance Checks. Runtime currently evaluates the empty required-check set with `every([])`, so the first successful Tool result marks every objective-only Step completed. A later equivalent Plan update then preserves those false completed Steps and appends newly compiled copies.

This corrupts the current Run-owned Plan even though Tool Invocation, Evidence and Completion remain truthful. Real DeepSeek execution consequently lost its active direction, repeated reads, exhausted the Tool budget and failed before producing all requested frontend files.

## 2. Decision

`nexora_update_plan.tasks` is the complete ordered snapshot of work that remains useful for navigation. It is not a completion claim and does not contain Runtime IDs, statuses, checks or evidence.

```text
Provider objectives
-> Harness reconciles equivalent objectives with the current Plan
-> Runtime validates CAS and owns the accepted Plan/progress snapshot
-> Tool outcomes satisfy only explicit mechanical Checks
-> final Completion Gate may close remaining objective-only navigation
```

The Provider contract remains objective-only:

```ts
type ModelPlanUpdate = {
  goal?: string;
  tasks: readonly { objective: string }[];
};
```

No model-authored Runtime Action, Step ID, status, Check, Evidence ID or completion proof is introduced.

## 3. Progress Semantics

1. A Step with one or more required Checks becomes completed only when every required Check has applicable Evidence.
2. A Step with no required Checks is never completed by Tool success alone. Its existing navigation status is retained while it remains in the Plan.
3. Exactly the first unresolved Step is active; later unresolved Steps are pending.
4. A Provider advances an objective-only Plan by submitting the new remaining-work snapshot. Omitted unfinished objectives leave the current Plan without being falsely marked completed. Their prior revisions remain in the Journal.
5. Harness reuses the existing Step identity for an equivalent objective that remains in the snapshot.
6. Already completed, mechanically proven Steps remain immutable and are preserved as a completed prefix. Repeating their objective does not append a duplicate.
7. An equivalent Plan update may create a new auditable Plan version, but it must not duplicate objectives or reset valid completed progress.
8. After the deterministic Completion Gate passes, Runtime may mark all remaining navigation Steps completed as part of the atomic success transition. Step progress never becomes completion evidence.

Objective equivalence is exact after the existing schema trim normalization. Nexora does not add semantic matching, keyword heuristics, Tool-name inference or Provider/model-specific behavior.

## 4. Authority And Safety

- State Machine remains the only Run Status writer.
- Run-owned Structured Plan remains the only current Plan.
- Runtime remains the only Plan/progress writer.
- Tool Invocation remains side-effect and recovery Authority.
- Evidence and Completion Gate remain completion Authority.
- Plan progress never authorizes a Tool and never proves business completion.
- Reopen reconstructs the same Plan and progress from durable Runtime state.

## 5. Removed Behavior

The following production behavior must be deleted rather than retained as a fallback:

- vacuous completion of Steps with zero required Checks;
- unconditional recompilation of every repeated objective with a new Step ID;
- preservation-plus-append logic that duplicates equivalent completed objectives;
- Prompt language that describes `tasks` as a static full history rather than the current remaining-work snapshot.

No repeated-read ban, model-specific branch, objective keyword classifier or extra Provider retry policy is part of this Feature.

## 6. Acceptance

- one successful Tool cannot complete unrelated objective-only Steps;
- read-only exploration cannot complete a mutation objective;
- equivalent replans retain Step identities and contain no duplicate copy;
- removing a finished objective advances the active Step without claiming Evidence;
- checked Steps still advance only from applicable persisted Evidence;
- frontend-style HTML -> CSS -> JavaScript -> verifier navigation progresses in order;
- reopen yields identical current Plan, progress and active objective;
- Completion Gate still rejects missing required checks and unresolved Invocations;
- final success closes remaining navigation only after the hard gate passes;
- native and structured Provider transports use the same semantics;
- real DeepSeek frontend Canary creates all four files, passes `node --check app.js` and `node verify.mjs`, and ends `succeeded / COMPLETED` without false success.

## 7. Verification

This is an L3 Runtime/Harness change. Required evidence is targeted regression, Plan/Tool/Completion/Recovery Core regression, full test suite, build, typecheck, lint, package consumers, NexoraBench, privacy scan and the real Provider frontend Canary. The configured model remains DeepSeek; any process-local reasoning override must be reported separately.
