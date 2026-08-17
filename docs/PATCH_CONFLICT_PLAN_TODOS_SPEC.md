# Nexora Patch Conflict Recovery And Plan TODO Spec

Status: `COMPLETE`

Feature mode: `DIRECT`

Feature: `patch-conflict-plan-todos`

Risk: `L3`

Date: 2026-08-17

## 1. Problem

A real `qwen3.7-flash` incremental frontend Run used 43 successful Provider calls and exhausted all 40 Tool calls
without completing. It issued 32 reads, seven patches and one list. Two patches succeeded, five failed with
`CONTENT_CONFLICT`, and two read calls were rejected for exceeding the public `limit` maximum. Only `index.html`
changed; CSS, JavaScript and the verifier remained unfinished. Nexora failed truthfully with zero whole-file writes
and zero false success.

The first broken boundaries are inside the current execution contract:

1. `filesystem.patch` reports only that `expectedDigest` is stale. It does not return the current digest or whether
   the exact `find` segment is still safely identifiable, so a model must spend another read merely to recover the
   concurrency token.
2. Objective-only failed Invocations remain classified as unresolved critical observations after later successful
   Tools have cleared the current Runtime error. Historical conflicts can therefore consume the bounded Context slots
   even though the next decision needs the latest current-state observation.
3. The Plan contract says only that ordering or duration may make a Plan useful. It does not tell a general model to
   create outcome TODOs before a known multi-file or dependent mutation workflow, so the real Run created its Plan
   only after most of the Tool budget was consumed.

## 2. Decision

Keep the existing optimistic patch contract. The Provider must still submit `expectedDigest`, and Runtime must still
reject a stale mutation before an Effect. Improve recovery at that same boundary:

```text
stale expectedDigest
-> no file Effect
-> CONTENT_CONFLICT with bounded current-file facts
-> latest failure is projected as current repair
-> model retries with the current digest only when the exact target remains unique
```

Historical objective-only failures are ordinary history after Runtime no longer has that failure as its current
error. Only the current matching failure is classified as unresolved critical. Explicit required-Check failures and
safety failures retain their existing stronger retention.

Plan remains optional navigation, not permission. The general contract now gives concrete TODO heuristics:

- create a short outcome Plan before the first mutation when known work spans multiple files/components, contains
  multiple dependent outcomes plus verification, or is expected to require more than three Tool calls;
- when scope is initially unknown, perform only the smallest useful read-only exploration, then create the Plan before
  mutation;
- start with two to seven independently verifiable remaining outcomes, not a transcript of reads, patches or approvals;
- allow a later remaining-work snapshot to contain one final outcome after completed outcomes are omitted;
- omit an outcome as soon as it is complete and revise promptly when a conflict or new fact changes remaining work;
- skip Plan for a direct answer, one observation, or one obvious local change.

These are model decision semantics. Runtime does not make Plan a Tool whitelist or a prerequisite for mutation.

## 3. Patch Conflict Facts

`CONTENT_CONFLICT` diagnostics contain bounded JSON facts:

```ts
{
  path: string;
  expectedDigest: `sha256:${string}`;
  currentDigest: `sha256:${string}`;
  findOccurrences: number;
  recovery: "retry_with_current_digest" | "inspect_current_content";
}
```

`retry_with_current_digest` is emitted only when the exact `find` string occurs once in current content. It does not
authorize a retry or bypass Approval; it states that the original exact target remains identifiable. Zero or multiple
matches require inspection/revision. Diagnostics flow through the existing Tool Attempt, Invocation, Observation,
Repair and Journal path. They do not create state or a second file Authority.

## 4. Context Currentness

- A failed objective-only Invocation is unresolved critical only while it is the Invocation represented by the
  current `Run.lastError`.
- Once a later successful Tool clears `Run.lastError`, that historical failure becomes noncritical history.
- A failed explicit required Check remains critical through its Check binding.
- Approval, permission, cancellation, unknown-effect and other safety failures retain safety-critical projection.
- Equivalent observations remain collapsed, and the global eight-observation bound remains unchanged.

No Tool-name inference, repeated-read ban, semantic objective matching, hidden retry or Provider-specific branch is
introduced.

## 5. Authority And Safety

- State Machine remains the only Run Status writer.
- Run-owned Structured Plan remains the only current Plan.
- Tool Invocation remains side-effect and recovery Authority.
- The Provider cannot mutate a file by reporting a Plan or completion claim.
- A stale patch never executes automatically and still requires a fresh approved Invocation.
- Patch diagnostics are observations, not permission, Evidence or completion proof.
- Plan remains optional and cannot authorize Tools, bypass Approval or satisfy Completion.
- Runtime and Harness remain Provider-neutral.

## 6. Removed Behavior

- bare `CONTENT_CONFLICT` messages that omit the observed current digest and match state;
- objective-only historical failures pinned as unresolved after Runtime has cleared the failure;
- vague Plan guidance that allows a known multi-file mutation workflow to postpone TODO creation indefinitely.

The old behavior is not retained as a fallback.

## 7. Acceptance

- stale patch produces no Effect and exposes bounded current digest plus exact-match recovery facts;
- unique current target supports a fresh approved retry without an additional digest-only read;
- missing or ambiguous current target requires inspection and cannot be auto-applied;
- after a successful observation clears the current error, an old objective-only conflict is not critical;
- explicit Check and safety failure retention remains unchanged;
- Context still contains at most eight Tool observations and collapses exact repeats;
- Prompt and Plan Tool contract state concrete create/skip/update TODO heuristics;
- Plan TODOs remain current remaining outcomes and never become permission or completion Evidence;
- native and structured transports share the same semantics;
- deterministic mutation, Approval, recovery, Context, Prompt parity, package consumer and full L3 regressions pass;
- the same real Qwen incremental frontend task changes all four files through patch only, preserves the required
  baseline, passes independent old/new-hook checks plus syntax/verifier, and ends `succeeded / COMPLETED` without false
  success.

## 8. Verification

Required evidence is targeted Tool/Context/Prompt regression, Runtime/Harness release, Context quality,
Agent/Runtime parity, package consumers, full test suite, build, typecheck, lint, NexoraBench, privacy scan and the real
Qwen incremental Canary. Real failure evidence remains retained and must not be replaced or reclassified.

## 9. Completion Evidence

The deterministic acceptance passes Runtime and Harness builds, the root build, typecheck, lint, the 16-file / 85-test
Runtime/Harness release set, the 12-file / 65-test Context-quality set, the 6-file / 55-test Agent/Runtime parity set,
external packed consumers, the full 87-file / 406-test suite, and NexoraBench typecheck plus 6 files / 14 tests.

The retained real `qwen3.7-flash` native-Tool Run `351ccd7b-ae0a-48b9-b06b-35abf4129b1f` ended
`succeeded / COMPLETED` after 50 successful Model Calls and 39 Tool Invocations. Its first Plan preceded its first
mutation, and ten Plan versions tracked remaining outcomes. It issued 13 bounded patches across all four files, zero
whole-file writes and two structured `CONTENT_CONFLICT` failures with a unique current target; one was retried with
the returned current digest without an intervening read. Independent syntax, retained-hook, new-hook and verifier
checks all passed, with retained-line ratios from 82.05% to 100% and zero false success.

An earlier retained sample ended truthfully `blocked / PROVIDER_UNAVAILABLE` after nine successful read-only Tool
Invocations and no file Effect. Two later runner attempts exposed an undisclosed approval-policy bound and then a
runner exception on denial; the external Canary was corrected to disclose that policy and express rejection through
the normal Approval decision rather than terminating the process. No Provider-specific production branch or hidden
mutation retry was introduced.
