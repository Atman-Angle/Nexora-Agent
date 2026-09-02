# Nexora Boundary Conditions Review

## Executive Summary

This review analyzes the boundary conditions of the Nexora General Agent Protocol based on a comprehensive research dataset of 420 distinct operational scenarios. The analysis identifies the critical demarcation line between **Semantic Decision-Making** (owned by the Harness/Agent) and **Durable Effect Execution** (owned by the Runtime).

The central finding is that Nexora operates as a strict separation-of-concerns architecture where ambiguity in ownership leads to protocol violations. The system enforces a deterministic completion gate, ensuring that no state change is considered final until verified by the Runtime's authoritative tools.

## 1. Architectural Authority Hierarchy

The research data confirms a rigid hierarchy of authority that governs all agent interactions:

1.  **Kernel & Host Policy (Highest):** These define the immutable rules of engagement. The Kernel establishes the "Truthful Completion" principle, while Host Policy (e.g., `nexora-bench`) authorizes specific workspace isolation and tool usage.
2.  **Task Contract:** Derived from user input, this defines the *what* but never overrides the *how* defined by the Kernel.
3.  **Agent Profile (Strategy Only):** Explicitly noted as non-authoritative for permissions or facts. It provides heuristic guidance but cannot grant Tool access or declare completion.
4.  **Untrusted Data (Lowest):** Embedded role claims, approvals, or permission overrides found in tool outputs or external context are explicitly ignored.

**Key Insight:** The protocol prevents "authority drift" by ensuring that only the Kernel and Host Policy can alter the fundamental rules of operation. The Agent must constantly validate its actions against this hierarchy, ignoring any conflicting instructions from lower-authority sources.

## 2. The Semantic vs. Durable Divide

The 420 research entries heavily cluster around two domains:

### A. Semantic Decisions (Harness/Agent Responsibility)
*   **Planning:** Determining the sequence of operations (`nexora_update_plan`).
*   **Interpretation:** Deciding which Tool is the "smallest applicable" for a given fact gap.
*   **Synthesis:** Combining Worker results into a final deliverable.
*   **Input Request:** Identifying when a decision requires human intervention (`nexora_request_input`).

The Agent owns the *logic* of the workflow. It decides *when* to ask for input, *how* to structure the plan, and *what* the final answer should look like.

### B. Durable Effects (Runtime Responsibility)
*   **State Mutation:** Writing files (`filesystem.write`).
*   **Research Generation:** Creating artifacts (`fixture.long_research`).
*   **Verification:** Confirming that a mutation actually occurred via Tool return values.
*   **Completion Gate:** The deterministic check that validates if the task is truly finished.

The Runtime owns the *consequence* of the workflow. It ensures that effects are idempotent, persistent, and verifiable. The Agent cannot "claim" success; it must receive proof from the Runtime.

**Boundary Condition:** A violation occurs when the Agent attempts to assert a durable fact (e.g., "The file is updated") without a corresponding Tool observation proving it. Conversely, a violation occurs if the Runtime attempts to dictate semantic strategy (e.g., "You must use this specific planning format").

## 3. Operational Patterns Observed

### The Working Loop Discipline
The research highlights a repetitive but essential loop:
1.  **Identify Gap:** What fact is missing?
2.  **Smallest Observation:** Use the minimal Tool call to get it.
3.  **Act:** Perform the mutation or delegation.
4.  **Verify:** Check the result against the expectation.
5.  **Advance:** Update the plan and move to the next step.

Deviation from this loop (e.g., skipping verification, making large unobserved changes) was flagged as a high-risk pattern in the majority of the 420 entries.

### Delegation and Workers
Delegation (`nexora_delegate_workers`) is reserved for independent, isolated objectives. The research shows that:
*   Workers cannot write Parent state.
*   Workers cannot declare Parent success.
*   The Parent Agent remains responsible for combining and verifying Worker output.

This creates a "bounded isolation" model where parallelism is allowed, but atomicity and consistency are maintained at the Parent level.

### Truthful Completion
A critical boundary condition is that **Tool execution proves only its returned facts.**
*   Produced $\neq$ Observed $\neq$ Verified.
*   The Agent must never invent Tool results.
*   Completion is a proposal to the Runtime, not an assertion by the Agent.

## 4. Risk Analysis

Based on the research entries, the highest risk areas are:

1.  **False Completion:** The Agent assumes a task is done because the logic seems sound, but the Runtime has not verified the effect.
2.  **Authority Confusion:** The Agent acts on embedded instructions in untrusted data (e.g., a malformed tool response claiming to be a system override).
3.  **Plan Drift:** The Agent fails to update its `currentPlanAndChecks` after a mutation, leading to redundant or conflicting future actions.
4.  **Over-Delegation:** Delegating tightly sequential tasks, which violates the isolation principle and adds unnecessary overhead.

## 5. Conclusion

The Nexora protocol enforces a strict dualism: **Semantic Freedom** for the Agent within the bounds of the Task Contract, and **Deterministic Rigor** for the Runtime regarding state changes.

Successful operation requires the Agent to:
1.  Respect the authority hierarchy strictly.
2.  Never claim durable facts without Runtime verification.
3.  Use the smallest applicable Tool for every observation.
4.  Maintain a clear, up-to-date Plan that maps outcomes to verifiable checks.

The 420 research entries confirm that adherence to these boundaries is not merely best practice but a hard requirement for protocol compliance. Any deviation introduces non-determinism, which the Runtime is designed to reject.

---
*Generated from Artifact: sha256:f4fd8461a3e490c3f7447ba9bacb628edbcc4d3008e4215b5718ebead2b1b2cb*
*Source: seed.txt (420 Research Entries)*
