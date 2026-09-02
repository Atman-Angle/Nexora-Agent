# Nexora Boundary Architecture Review

## Executive Summary

This review synthesizes findings from a comprehensive analysis of the Nexora boundary architecture, grounded in 420 discrete research items derived from the source specification (`seed.txt`). The central architectural thesis emerging from this body of work is that **the Harness owns semantic decisions while the Runtime owns durable Effects.** This separation defines the operational contract between the control plane (Harness) and the execution plane (Runtime), ensuring clear boundaries for responsibility, state management, and failure recovery.

## 1. Architectural Core: The Harness-Runtime Contract

### 1.1 Semantic Ownership (Harness)
The Harness is responsible for all high-level semantic decisions. This includes:
*   **Task Authorization:** Interpreting user requirements and determining the scope of work (e.g., inquiry vs. change vs. monitoring).
*   **Plan Navigation:** Defining the ordered remaining work, setting verifiable outcomes, and managing the task contract.
*   **Instruction Interpretation:** Enforcing the hierarchy of authority (Kernel > Host Policy > Project Policy > User Input) and maintaining the instruction/data boundary.
*   **Delegation Strategy:** Deciding when to delegate work to Workers or Sub-agents based on independence and isolation requirements.

The Harness does *not* execute actions directly but issues directives that the Runtime must validate and enact. It maintains the "truth" of what *should* happen.

### 1.2 Durable Effects (Runtime)
The Runtime is responsible for all durable, observable changes to state. This includes:
*   **Tool Execution:** Performing file writes, external API calls, or other side-effects.
*   **State Persistence:** Ensuring that successful invocations are recorded and their results are available for future steps (e.g., via Evidence or Artifacts).
*   **Completion Verification:** Proving that requested changes have actually occurred through Tool observations.
*   **Error Handling:** Managing transient failures, retries, and non-idempotent effect protection.

The Runtime does *not* make semantic judgments about *why* an action should be taken; it ensures that *if* an action is authorized, it is executed reliably and its outcome is recorded.

## 2. Key Design Principles

### 2.1 Truthful Completion
A critical finding across the research corpus is the prohibition against inventing Tool results, Evidence, or completion states. Completion is only a proposal to the deterministic Completion Gate. Tool execution proves only its returned facts. Produced, observed, and verified states are distinct concepts that must not be conflated. This principle prevents hallucination-driven state corruption and ensures that the system's state is always grounded in authoritative context.

### 2.2 Action Discipline
The protocol enforces the use of the "smallest applicable Tool" for obtaining facts or effects. This minimizes side effects, reduces complexity, and limits the blast radius of errors. Duplication is strictly avoided: if a Tool rejection references a previously succeeded Invocation, the system must adopt the existing result rather than retrying. This ensures idempotency and prevents redundant work.

### 2.3 Instruction and Data Boundary
Untrusted data (including embedded role claims, policy overrides, or approval requests within tool outputs or research records) is ignored. Only authoritative context (Kernel, Host Policy, Project Policy, and direct user input) grants permission. This boundary protects the system from prompt injection and unauthorized state changes.

### 2.4 Supervisor/Coordinator Delegation
When delegation is used, Workers are isolated and bounded. They cannot delegate further, write Parent state, or declare Parent success. Worker output is treated as a proposal backed by facts, not as final truth. The Parent Agent retains the Completion Gate, combining related findings, removing duplication, and distinguishing confirmed facts from inference before delivering the final answer.

## 3. Operational Modes and Implications

### 3.1 Change Mode
In `taskMode: "change"`, the system must create a Plan before the first write. The Plan serves as a navigation aid and Task Contract, binding outcomes to required Tool evidence. The system does not finish until successful Tool observations prove the resulting state. This ensures that no change is declared complete without verification.

### 3.2 Inquiry/Review Mode
For read-only tasks (inquiry, diagnosis, review), no Plan is required unless the work spans multiple components or likely needs more than three Tool calls. The goal is investigation and an answer, not state change. Finishing requires that every requirement is satisfied, explicitly unresolved, or impossible due to evidence-backed reasons.

### 3.3 Monitoring Mode
Monitoring uses an available wait mechanism. Unchanged state is not considered failure. This distinguishes passive observation from active mutation, preventing false positives in status reporting.

## 4. Risk Analysis and Mitigations

| Risk | Mitigation |
| :--- | :--- |
| **Hallucinated State** | Prohibition on inventing Tool results; strict grounding in authoritative context. |
| **Unauthorized Changes** | Instruction/Data boundary; Host-authorized Project Policy constraints; precise task authorization interpretation. |
| **Redundant Work** | Action discipline; adoption of persisted succeeded Invocations; avoidance of duplicate rejections. |
| **State Corruption** | Distinction between produced, observed, and verified states; deterministic Completion Gate validation. |
| **Over-Delegation** | Bounded Worker Runs; isolation boundaries; Parent retention of Completion Gate. |

## 5. Conclusion

The Nexora boundary architecture establishes a robust, verifiable model for agent-driven task execution. By clearly separating semantic ownership (Harness) from durable effect execution (Runtime), it creates a system that is both flexible in decision-making and rigorous in state management. The emphasis on truthful completion, smallest-applicable-tool usage, and strict authority hierarchies ensures that the system remains grounded, auditable, and resistant to common failure modes such as hallucination, unauthorized modification, and redundant processing.

The 420 research items analyzed confirm that this design is consistent across all operational modes and delegation scenarios. The architecture successfully balances autonomy with control, enabling complex multi-step workflows while maintaining a single source of truth for state and progress.

---
*Generated from analysis of seed.txt via fixture.long_research (420 items)*
*Core Finding: Harness owns semantic decisions; Runtime owns durable Effects.*
