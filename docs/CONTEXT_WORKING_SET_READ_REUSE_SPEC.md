# Context Working Set And Read Reuse Spec

## Feature Contract

```yaml
feature: context-working-set-read-reuse
goal: >
  Keep current authoritative file facts usable across Agent turns and prevent
  unchanged idempotent reads from causing repeated physical effects or model-call amplification.
current_gap: >
  A successful 16 KiB filesystem read may be projected as an unusable reference above 4 KiB;
  only eight recent observations feed the file working set; identical reads execute again;
  artifact recovery depends on an active Plan; and equivalent Plan updates create churn.
scope:
  - Tool Observation and current-resource Context projection
  - Provider-aware token eviction for current file content
  - declarative read-result reuse and invalidation
  - automatic recovery of current file payload artifacts
  - semantically equivalent Plan update handling
  - read/model amplification metrics and regression coverage
invariants:
  - Tool Invocation remains the only Tool effect and recovery Authority
  - Run-owned Structured Plan remains the only current Plan
  - derived working resources are rebuilt from persisted Invocation Authority
  - cached reuse never replays or invents an external effect
  - unknown external mutation invalidates reuse instead of assuming freshness
  - Runtime and Harness remain Provider-neutral
  - native Provider function calling remains the only Tool selection protocol
non_goals:
  - an unbounded Provider payload or sending all historical Tool output verbatim
  - Provider-specific thresholds or Tool-name-specific cache branches
  - a second file snapshot store or mutable Context Authority
  - lossy summarization of active source code
  - changing Approval, Completion Gate, State Machine or Tool permission semantics
acceptance:
  - a complete successful file read remains complete while the measured Provider budget permits
  - current file facts survive Plan revisions and unrelated Tool observations
  - candidate selection has no fixed observation-count cap and collapses equivalent historical facts
  - the same valid idempotent read result is physically executed once and reuse is auditable
  - relevant writes and unknown workspace mutation invalidate read reuse
  - current file artifact content is automatically usable without an active Plan
  - semantically identical Plan updates are accepted without a new Plan revision
  - existing Plan-plus-Tool and parallel read batching behavior remains valid
  - native Providers may return bounded parallel Tool batches instead of being forced to one call per turn
  - a successful verifier may run again after a later successful write changes the workspace
  - stale known Tool calls during delivery are repaired as Model responses, not mislabeled as Provider outages
  - deterministic L3 regression and a real Qwen incremental frontend task pass without false success
risk: L3
```

## Authority And Data Flow

```text
persisted Tool Invocations (Authority)
  -> collapse by semantic observation and resource identity
  -> derive latest current-resource views
  -> resolve current payload artifacts when useful
  -> assemble full decision candidates
  -> measure against the Provider input budget
  -> evict historical/helpful data before active resource content
  -> Provider wire
```

The working set is a deterministic projection. It owns no mutable file state and
can be deleted and rebuilt without losing facts.

## Context Policy

- Remove the independent 4 KiB per-observation visibility threshold.
- Remove the fixed eight-observation candidate limit.
- Keep the aggregate safety fuse only as a last-resort serialization guard; the
  Provider token meter and soft/hard limits decide normal eviction.
- Collapse equivalent observations before budgeting.
- Prefer the latest complete view for each current resource.
- Never emit a model-facing readable reference without a deterministic recovery path.

## Read Reuse Policy

Read reuse is declared by Tool execution metadata, not inferred from a Tool name.
An eligible result requires an idempotent read Tool, canonical input equality and
a valid freshness scope. Reuse records provenance to the original successful
Invocation. A declared mutation of that resource, an unknown workspace mutation,
or a cross-process continuation without a valid freshness proof invalidates reuse.

Runtime-controlled filesystem mutations provide exact path invalidation. Tools
whose effects cannot declare a narrower footprint invalidate the workspace scope.

## Plan And Batch Policy

Plan control and independent native Tool Calls may remain in one Provider response.
Equivalent Plan snapshots are accepted as no-ops. Plan revisions never determine
whether current file facts remain visible or whether an Artifact may be restored.
The OpenAI-compatible native transport advertises parallel Tool calling; the
existing eight-call response schema remains the deterministic batch bound.

An execute Tool remains protected from unchanged duplicate execution. A later
successful write invalidates that duplicate decision so verification can observe
the new workspace state. This is derived from ordered Tool Invocations, not a
second mutation counter. During delivery-only turns, a stale call to a known Tool
is routed through response repair; only names absent from the full Tool catalog
are Provider protocol errors.

Provider-budget contraction may omit optional Tool decision hints. Strategy
continuity therefore uses an immutable pre-contraction configuration digest,
while cache telemetry continues to report the exact transmitted stable-prefix
digest. The two digests must not be conflated.

## Verification

Deterministic coverage must prove projection continuity, artifact usability,
cache hit and invalidation behavior, restart safety, parallel batch parity, Plan
no-op behavior, Completion/Approval invariants, and bounded read amplification.
The real Provider canary must report model calls, Tool Invocations, physical Tool
executions, cache reuse, per-path reads, Plan revisions and false-success status.
