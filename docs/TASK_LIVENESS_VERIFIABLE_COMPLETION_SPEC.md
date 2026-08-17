# Task Liveness And Verifiable Completion Spec

## 1. Feature Contract

```yaml
feature: task-liveness-verifiable-completion
mode: EXPLORE -> DIRECT -> VERIFY
goal: >
  Keep supported tasks resumable across resource boundaries and prevent a Run
  from succeeding without the Host-declared mechanical completion evidence.
risk: L3
```

This feature strengthens the existing Run, Task Contract, Tool Invocation,
Evidence, Artifact and Context Projection path. It does not add a workflow
engine, semantic validator, second status machine or second completion
authority.

## 2. Problems

The current Runtime has four system-level liveness gaps:

1. A Provider can return final text for an effectful task before any Tool call,
   and the Completion Gate accepts a zero-Evidence success.
2. Iteration, Model-call, Tool-call and active-duration budgets terminate a Run
   as failed even though all persisted progress is resumable.
3. list/search/process Tools can report truncation without a lossless
   continuation or Artifact containing the omitted result.
4. Context contraction can remove or shorten original Input text, allowing the
   Agent Loop to continue without the complete authoritative request.

## 3. Completion Contract

The Host owns mechanical completion requirements because only the embedding
application knows whether a request is a direct answer, an observation, a
workspace mutation or a domain operation. The Provider may not create, weaken
or replace these requirements.

Every Run persists one `CompletionRequirements` value:

```ts
type CompletionRequirements = {
  evidence: "optional" | "required";
  requiredToolNames: readonly string[];
};
```

Rules:

- with no registered Tools, the default is `evidence: "optional"`;
- with one or more registered Tools, the safe default is
  `evidence: "required"`;
- a Host must explicitly select `optional` for a direct-answer Run when Tools
  are registered;
- every `requiredToolNames` entry must name a registered Tool and implies
  `evidence: "required"`;
- completion requires at least one eligible persisted Evidence item when
  Evidence is required;
- every required Tool must have at least one successful Invocation whose
  digest-valid Evidence is cited by the Result;
- Plan revisions cannot alter the completion requirements.

This is a mechanical guarantee. Semantic or domain correctness still belongs
to Host-declared Tools, checks and external graders; the Runtime must not claim
that arbitrary natural language is semantically proved.

The workspace CLI uses the safe Evidence-required default. It exposes explicit
direct-answer and required-Tool options rather than classifying intent with
hard-coded words or another model call.

## 4. Resumable Resource Boundaries

Budget exhaustion is a persisted pause, not task failure:

```text
running
-> final delivery-only Model turn when available
-> blocked / *_BUDGET_EXCEEDED
-> Host supplies a monotonic BudgetExtension
-> running from persisted Run, Plan, Invocation and Evidence
```

`BudgetExtension` adds positive quotas to the existing absolute limits. It
cannot reset usage or reduce a limit. Duration remains a per-active-segment
deadline; resuming a duration pause starts a new bounded active segment.

Provider unavailability and unknown non-idempotent Effects keep their existing
recovery semantics. A BudgetExtension never authorizes or replays a Tool.

## 5. Lossless Bounded Tool Results

- `filesystem.read`: retain existing ranged continuation and full Artifact.
- `filesystem.list`: add deterministic lexicographic `offset` / `limit` pages
  and `nextOffset`.
- `filesystem.search`: add deterministic streamed `offset` / `limit` pages and
  `nextOffset`; do not cap an earlier byte buffer that makes later pages
  unreachable.
- `shell.execute` and Git read Tools: keep bounded inline stdout/stderr and
  persist complete oversized streams as content-addressed Artifacts. Facts
  expose the Artifact refs and exact byte counts.

All pagination is repeatable for unchanged workspace state. Existing mutation
invalidation prevents cached reads from surviving a workspace-changing Tool.

## 6. Context Capacity

Original Input text and the current Task Contract are non-evictable authority
projections. Context contraction may remove rebuildable navigation, Memory,
historical Observation payloads and redundant continuation content, but it may
not delete or shorten user Inputs.

If the non-evictable minimum exceeds the configured Provider hard limit, the
Run enters a truthful `CONTEXT_CAPACITY_EXCEEDED` blocked state. It must not call
the Provider with a partial request. The Host may resume with a different
Provider configuration or add a new Run/Input contract; the Runtime does not
invent a lossy summary.

## 7. Acceptance

1. An effect request followed by text-only Provider output cannot succeed under
   the default Tool-enabled completion requirements.
2. Tool-free direct answers and explicitly opted-in direct answers still
   succeed without fabricated Evidence.
3. Required Tool names are configuration-validated and completion-enforced.
4. Every Runtime budget pause is inspectable and resumes only with the required
   monotonic extension; completed Effects are not replayed.
5. More than 2,000 files and more than 100 search matches are fully reachable
   through stable pages.
6. Oversized successful and failed process output is recoverable from Artifact
   refs while inline payloads remain bounded.
7. Context pressure never shortens original Inputs; irreducible overflow blocks
   before a Provider request.
8. Approval, crash recovery, unknown Effect, Completion provenance, public API,
   CLI and package-consumer regressions pass.
9. Full L3 regression, build, typecheck and lint pass, followed by a public-entry
   isolated UAT with no false success.

## 8. Non-goals

- guaranteeing semantic correctness for arbitrary natural language;
- unbounded loops, unbounded Provider requests or automatic infinite retries;
- model-authored permissions or completion requirements;
- domain-specific intent keywords or Tool-name branches in Core;
- changing Approval, Tool Invocation or Run Status Authority;
- adding a second Context Store or summary Authority.
