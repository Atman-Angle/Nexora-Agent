# Meaningful Progress and Bounded Convergence Report

## Scope

This Feature prevents a Run from remaining `running`, or repeatedly returning to an already disproved strategy, when persisted activity does not advance the user's task.

It changes no public Run status, State Machine, Tool authority, Evidence authority, or recovery framework. The implementation derives convergence from the existing Run, Plan, Invocation, Evidence, Event, Context, and continuation lineage facts.

## Meaningful Progress

Activity is not progress. Model requests, Provider attempts, model text, equivalent Plan updates, Context projection, heartbeat renewal, and repeated Tool calls only prove that the system is active.

For execution convergence, meaningful progress requires a new authoritative fact that can change the next safe decision:

- a completed non-mutation Tool Invocation whose authoritative outcome changes the next safe decision;
- a confirmed recovery result for an unknown effect;
- a passed validation result;
- a merged Worker result;
- or successful completion through the existing Completion Gate.

A new user message is preserved as input, but a generic `Continue` or `Retry` does not by itself disprove an earlier failure. A Plan revision is navigation, not execution progress. Provider availability is only reset by persisted execution or validation facts, not by another Provider call, Context rebuild, or equivalent Plan.

## Real Failure Session

Workspace: `D:\Nexora_test2`

Parent Run: `d4046c16-54b1-4a75-8e43-cf1084096d48`

- The Run imported and inspected the attached document, then attempted the requested mutation.
- `document.apply_patch` was rejected twice because the same field remained invalid: `expectedRevision` was a string instead of a number.
- No Tool Invocation was created for either rejected response, so no mutation, Evidence, or Step advancement occurred.
- Runtime correctly blocked the parent with `NO_PROGRESS_DETECTED` after 10 model calls and 5 earlier Tool calls.

Continuation Run: `9094d8ed-a5e0-4342-8057-17b60ce6c54d`

- Desktop created a continuation for the user's `重试` input and carried the unfinished Plan and full Context.
- The continuation did not carry the parent's disproved strategy window as an enforcement boundary.
- It made 5 additional model calls and 0 Tool Invocations.
- It repeated the same invalid `expectedRevision` shape, attempted an equivalent replan, and was blocked again only after spending a new convergence window.

This was not an Office-specific failure. The general defect was that continuation Context described the prior failure, while Runtime convergence was evaluated only from the child Run's local events.

## Other Failure Paths

The repository Runtime database also contains interrupted Runs whose last persisted fact is `provider.attempt.started` or `tool.attempt.started`. The Agent Loop checked duration and convergence only between calls. A Provider or Tool Promise that never settled prevented the loop from reaching the next check, so the Run could remain `running` indefinitely.

Provider recovery was bounded within one Run, but the recovery count treated input, Plan, and Context events as progress and did not span continuation lineage. A new continuation could therefore reopen the same unavailable Provider path.

### Successful mutation churn

Workspace: `D:\Nexora_Test_1_Raw_Materials`

Run: `28eb05cf-6b10-420e-b3ab-7210cee78b02`

- The user requested one bounded change: make the execution summary more concise.
- The Run repeatedly invoked a successful write against the same authoritative Deliverable subject and the same logical block, producing a different source digest each time.
- Because every immutable revision was a real Tool success, the previous exact-input/result fingerprint treated each near-synonym rewrite as fresh progress.
- The Run made 13 successful `document.apply_patch` Invocations, one revision conflict and two inspections, moving the Deliverable from revision 3 to revision 16 without proposing completion.
- The user cancelled the Run from Desktop. The cancellation is preserved as the truthful terminal status.

Later Run `3e78bf34-bfd1-4a12-bbbf-70d85102d98a` confirmed that this was not a threshold-tuning problem: after three different inspections it still performed seven consecutive successful patches, advancing revision 16 to revision 23 before the model eventually stopped itself.

The general defect was that a changed digest proved a new side effect, but did not prove task progress. Runtime had no persisted mutation-to-verification phase boundary, so every successful rewrite reopened another rewrite.

## Resolution

- Continuation convergence reads verified ancestor Events and Invocations.
- A child Run is blocked on the first recurrence of a failure signature that already caused an ancestor `NO_PROGRESS_DETECTED`, unless a new authoritative progress event occurred.
- Schema rejection signatures use issue kind, path, and code, so syntactic variations of the same invalid strategy do not create a fresh window.
- Tool failure/result signatures use Tool name, input digest, status, and persisted outcome.
- Provider failure accounting spans continuation lineage and resets only after execution, validation, recovery, or branch-merge facts.
- Continuation repair Context includes the parent's concrete rejected fields and recovery instruction.
- Each active execution segment arms the existing duration budget as an AbortSignal deadline.
- Provider and Tool awaits can be detached at that deadline even if the implementation ignores cancellation.
- A stalled non-idempotent Tool remains `TOOL_RESULT_UNKNOWN` and requires the existing explicit recovery decision; it is never auto-retried.
- User-initiated cancellation keeps its previous semantics and does not prematurely abandon an uncooperative non-idempotent Tool.
- A successful write proves only that an effect occurred. It closes the active mutation outcome; it does not prove completion or authorize another rewrite.
- Before Tool Invocation creation and before any Tool side effect, another write for the same mutation slot is rejected with `MUTATION_VERIFICATION_REQUIRED`.
- A later authoritative verification failure reopens that mutation slot for a corrective write. The correction closes it again and requires fresh verification.
- Successful unplanned completion requires a post-mutation verifier: a same-subject read or an execution result. Otherwise Completion Gate returns `UNPLANNED_MUTATION_UNVERIFIED`.
- A Plan cannot be added retroactively to bypass a closed unplanned mutation; `PLAN_AFTER_UNPLANNED_MUTATION` is rejected before execution.
- Unplanned mutation slots are derived from the registered Tool contract identity. This permits legitimate multi-stage capabilities such as import followed by native edit, while repeated use of the same writer remains closed until verification failure or new user input.
- Planned work derives distinct mutation slots from declared acceptance checks with `role: mutation`, and verification authority from checks with `role: verification`.
- Repeating a rejected state transition is handled by the existing generic `NO_PROGRESS_DETECTED` authority even when unrelated successful reads occur between attempts. The lifecycle policy itself has no mutation-count threshold.

## Verification

Fault-injection coverage proves the behavior without matching a Tool name or external error code:

- parent and continuation repeat the same schema field failure;
- parent and continuation repeat the same generic Tool failure;
- Provider failures exhaust recovery across continuation lineage;
- Provider Promise never settles;
- non-idempotent Tool Promise never settles;
- user cancellation of an uncooperative non-idempotent Tool;
- durable crash and Invocation recovery;
- Plan, Context reconstruction, liveness, completion, and RunHandle resume regressions.
- changing revision numbers and output digests cannot reopen a closed unplanned mutation;
- mutation, successful verification, and completion;
- mutation, failed verification, corrective mutation, fresh verification, and completion;
- unverified completion rejection;
- retroactive Plan rejection;
- two distinct planned mutation outcomes with fresh verification;
- Desktop auto-approved writes and existing Office import/edit continuation both include post-mutation verification.

The focused Runtime/Harness/Desktop/Office suite passed 90 tests across 6 files after rebuilding package artifacts. Typecheck and scoped ESLint also pass.
