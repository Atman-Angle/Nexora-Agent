# Nexora Evaluation Spec

Status: adopted architecture, version 1.0, 2026-09-03.

## Purpose

Nexora evaluation is **Harbor-based Agent Evaluation plus Nexora-specific
Runtime Evaluation**. Harbor is the authority for mature generic evaluation
infrastructure. Nexora is the authority only for facts and invariants that arise
inside Nexora Runtime.

This specification defines the integration boundary. It does not restate or
override Harbor internals.

## Ownership boundary

Harbor owns:

- Task and Dataset packaging;
- isolated environment and container lifecycle;
- job/trial scheduling, attempts, retry policy and concurrency;
- external verifier lifecycle and generic numeric rewards;
- logs, artifacts, trial records, aggregate job records and experiment identity.

Nexora owns:

- the Harbor Agent adapter that invokes Nexora Runtime;
- Runtime execution, control decisions and durable state;
- Runtime fact-bundle export;
- Runtime Integrity, Plan/State Authority, Invocation/Attempt, Approval,
  Evidence/Result provenance, unknown-effect, idempotency and Lease/Fencing
  grading;
- Safety, ExpectedOutcome, false-success and firstBrokenBoundary semantics;
- Runtime-specific Fault Lab;
- projection of Harbor results into Nexora release metrics.

Nexora must not fork or patch Harbor while its public Agent, Verifier, Task,
Dataset, Job, Metric and Artifact extension points can express the requirement.

## Harbor adapter contract

The adapter is a public Harbor `BaseAgent` extension. For each Harbor trial it:

1. receives the Harbor-owned public instruction;
2. installs the current Nexora Runtime source into the Harbor environment;
3. runs Runtime directly against Harbor's workspace (`/app`);
4. drives only Nexora-required approval/input/recovery controls declared by the
   Runtime evaluation profile;
5. writes the Runtime store, fact bundle and Runtime telemetry to Harbor's
   artifact convention directory.

The adapter must not create a second outcome workspace, schedule repeats,
perform the external outcome grade or synthesize success from model text.

## Runtime fact bundle

Each trial exports one JSON object with:

- `schemaVersion` and `kind=nexora-runtime-fact-bundle`;
- export timestamp;
- task/run identity and actual terminal state;
- persisted Run, Plan, Events, Invocations, Attempts, Evidence and Result-derived
  grading facts through the task report;
- independent Runtime Integrity, Authority, Safety and ExpectedOutcome checks;
- false-success and `firstBrokenBoundary` attribution.

The bundle is derived from the Runtime Store and execution records, never from
model self-report. Missing, malformed or multi-task bundles fail verification.

## Grading composition

The Harbor external verifier answers only whether the requested user-visible
outcome exists in the isolated environment. Hidden/private verifier material is
uploaded only for the verifier phase.

The Nexora verifier extension reads the external reward and independently reads
the Runtime fact bundle. It emits:

```text
external_result
runtime_integrity
authority
safety
expected_outcome
nexora_strict_pass
reward
```

`nexora_strict_pass` is the conjunction of the four Nexora-specific verdicts.
Final `reward` (STRICT_PASS) is true exactly when `external_result` and every
Nexora-specific verdict are true. A successful workspace with broken Runtime
authority fails. A clean Runtime trace with an incorrect outcome also fails.

## Capability Dataset policy

Capability tasks use Harbor's native Task/Dataset contract. Each task must have:

- a realistic user outcome;
- a deterministic external verifier;
- private verifier material where revealing it would leak the answer;
- no expected answer in the public instruction;
- no task-specific branch in production Runtime;
- failure artifacts and Runtime facts retained by Harbor;
- immutable or digest-governed fixture and Nexora evaluation-profile inputs.

Nexora evaluation profiles may declare Runtime-only budgets, permitted
capabilities, approval/recovery policy, ExpectedOutcome and sealed invariant
checks. They are not a second generic Task package and do not own environment,
attempt or result lifecycle.

## Reliability

Repeated execution is configured exclusively through Harbor `n_attempts`, jobs
and concurrency. Nexora must not implement a repeat scheduler.

Nexora may project the completed Harbor records into:

- empirical strict pass rate;
- observed All-3 and All-5 when enough attempts exist;
- terminal distribution;
- firstBrokenBoundary distribution;
- external and Runtime-grade component pass rates.

The projection is read-only and cannot change a Harbor trial result.

## Fault Lab

Crash/recovery, prepared-before-effect, partial batch, interrupted Attempt,
unknown side effect, cancellation reconciliation and Lease/Fencing injection
remain Nexora-owned. They operate at durable Runtime boundaries and are graded
against Runtime invariants. They are not forced into ordinary Harbor tasks.
Harbor may provide their outer environment or CI scheduling without acquiring
authority over fault injection or invariant meaning.

## Release acceptance

A release candidate is acceptable only when:

1. Harbor runs Nexora Runtime in a Harbor-managed isolated environment;
2. at least one representative Capability Task passes end to end;
3. external outcome and every Nexora-specific grade appear in the same trial;
4. a Harbor repeated-attempt job completes and its Nexora projection is valid;
5. the fact bundle is present, parseable and derived from persisted facts;
6. the Runtime Fault Lab passes at the required risk level;
7. no production entry point maintains a second repeat/job/task-result system;
8. relevant TypeScript/Python tests and typecheck pass;
9. deterministic and real-provider cohorts remain explicitly separated.

Any future Harbor incompatibility claim must cite the missing official extension
point and a failing minimal reproduction before an alternative such as Inspect AI
is evaluated.
