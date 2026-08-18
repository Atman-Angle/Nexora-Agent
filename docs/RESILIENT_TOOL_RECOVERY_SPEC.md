# Resilient Tool Recovery

## Feature Contract

```yaml
feature: resilient-tool-recovery
goal: >
  Keep a supported task autonomously progressing after an ordinary Tool failure,
  while preserving bounded execution and unknown-side-effect safety.
current_gap: >
  Tool failures are durable observations, but the first decision after a failure
  may immediately pause for user input without attempting autonomous recovery.
scope:
  - post-failure Agent decision routing
  - existing Tool failure observations and repair feedback
  - bounded retry, alternative-action and completion behavior
  - independent read sibling and non-idempotent unknown safety regression
invariants:
  - State Machine remains the only Run Status writer
  - Tool Invocation remains the side-effect and recovery Authority
  - Completion Gate remains the only success Authority
  - deterministic Runtime retry remains limited to safe idempotent transient failures
  - unknown non-idempotent effects are never replayed automatically
  - Tool selection remains model-owned from the Host capability catalog
non_goals:
  - infinite retries or guaranteed success against unavailable external systems
  - domain-specific error-code-to-Tool routing
  - semantic classification of arbitrary user questions
  - a second recovery state machine or persisted recovery Authority
acceptance:
  - an ordinary Tool failure does not directly terminate or pause the Run
  - a model can change arguments or choose another registered Tool and then complete
  - successful batch siblings and prior Evidence are not replayed
  - unknown non-idempotent effects remain blocked for explicit confirmation
  - unresolved failures cannot produce false success
risk: L3
```

## Required Behavior

Tool execution produces a durable success, failure or unknown outcome. A normal
failure remains an Observation and returns control to the Agent Loop. Runtime may
mechanically retry only a transient, idempotent attempt under the existing retry
budget. Other failures require a new model decision based on the failure and the
current capability catalog.

User input remains a valid Host boundary when the model determines that a
user-exclusive fact, irreversible preference or business choice is required. Runtime
does not force every failed Tool through an automatic retry: it exposes the complete
failure Observation and capability catalog, then lets the model choose a changed
input, another Tool or the legitimate user boundary. This is the same error-as-
observation pattern used by mature graph and multi-agent runtimes.

Unknown non-idempotent outcomes, denied Approval, cancellation, exhausted resource
budgets, Provider unavailability and irreducible context capacity remain explicit
waiting or blocked boundaries. They are not ordinary Tool failures and must not be
hidden by automatic retries.
