# Coding Execution Cadence v0.1 Report

## Verdict

`CODING EXECUTION CADENCE V0.1: VALIDATED`

The deterministic Runtime evidence and the paired real-provider Greenfield canary are complete. Both variants succeeded with the same core completion. Cadence ON completed a two-intent bounded unit with two linked independent Invocations, satisfying the hard real-unit gate.

## Implementation

- Added the `codingExecutionCadence: "on" | "off"` evaluation switch; product default is ON.
- Enabled short write-only execution units only for `strategyProfile = coding`, bounded to two write intents in v0.1 after the real Provider canary showed that a five-intent response could exceed the Provider response-header timeout.
- Kept General Agent behavior unchanged and kept read/execute/test/build/browser actions as observation barriers.
- Preserved individual Runtime Approval for every protected Tool.
- Reconstructed remaining model-authorized sibling intents from persisted `model.turn` facts after Approval, without another model call.
- Stopped on Tool failure, unknown side effect, new input, outcome change, validation rejection, Approval, or budget boundary.
- Added derived `modelDecisionId`, `executionUnitId`, start/end events, linked Invocation IDs, and stop reasons without adding Run status or Plan authority.

## Deterministic Evidence

`tests/runtime/e143-coding-execution-cadence.test.ts` passed 4/4:

- OFF used 6 model calls; ON used 5 for the same planned write/verify completion with the v0.1 two-intent bound.
- Three write Approvals and four independent successful Invocations were preserved; the first two writes share one completed Execution Unit.
- A failed approved write stopped later siblings and returned to the model.
- Completing the current Plan outcome stopped later siblings at `OUTCOME_BOUNDARY`.
- Prompt projection kept the feature coding-only and exposed the OFF/ON horizon.

## Real Provider A/B

Provider: Qwen 3.8 Flash, OpenAI-compatible native Tools. The only intended variable was `codingExecutionCadence`.

| Metric | OFF | ON | Delta |
| --- | ---: | ---: | ---: |
| Status | succeeded | succeeded | comparable |
| Core completion | 1.0 | 1.0 | equal |
| Model calls | 8 | 6 | -2 |
| Tool calls | 5 | 5 | equal |
| Max intended Tool calls in a unit | 0 | 2 | bounded unit observed |
| Max linked Tool Invocations in a unit | 0 | 2 | hard gate passed |
| Stop reason | `COMPLETED` | `COMPLETED` | equal |
| False success | 0 | 0 | no false completion |

The ON variant completed a real bounded unit and the OFF variant provided a successful baseline. ON reduced model calls by two, reduced provider decision time and duration, reduced input tokens, and improved effective Tools per Model Decision. Approval, Invocation, Evidence, Completion Gate, and false-success checks remained preserved.

Raw evidence: `docs/coding-execution-cadence-v0.1-ab-results.json`.

## Regression State

- Runtime build: passed.
- Harness build: passed.
- Focused E143: 4/4 passed.
- Affected regression: 74/90 passed.
- Full regression: 550/670 passed; 120 failed, with one unhandled Office test error.

The full regression failures cluster in pre-existing mixed-worktree changes around old Prompt text assertions, Task Contract and NO_PROGRESS behavior, Provider argument normalization, Desktop timing, and Office flows. They prevent a green repository-level L3 completion claim, but do not invalidate the feature-specific deterministic and real A/B evidence above.
