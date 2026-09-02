# Nexora Boundary Review: Detailed Analysis

## Source Context
This review is grounded in the research record produced from `seed.txt` (Artifact Digest: `sha256:f4fd8461a3e490c3f7447ba9bacb628edbcc4d3008e4215b5718ebead2b1b2cb`). The source contains 420 structured research notes synthesizing the operational boundaries of the Nexora system.

## Core Conclusion
**"Harness owns semantic decisions; Runtime owns durable Effects."**

This dichotomy defines the fundamental separation of concerns within the Nexora architecture.

### 1. Harness: Semantic Decisions
The "Harness" represents the intelligent, reasoning layer (the Agent/Protocol). Its authority lies in **semantics**:
*   **Interpretation:** Understanding user intent, policy constraints, and contextual nuance.
*   **Strategy:** Planning work sequences, delegating tasks, and determining *what* needs to be done and *why*.
*   **Judgment:** Making choices between ambiguous paths, requesting human input for irreversible preferences, and validating that outcomes meet requirements.
*   **Control Flow:** Directing the use of tools (`nexora_respond`, `nexora_update_plan`, etc.) based on logical necessity rather than hard-coded scripts.

The Harness does not directly manipulate state. It issues directives and plans, but it relies on the Runtime to execute them safely.

### 2. Runtime: Durable Effects
The "Runtime" represents the execution environment and tool infrastructure. Its authority lies in **effects**:
*   **Execution:** Actually calling tools like `filesystem.write`, `fixture.long_research`, or external APIs.
*   **Persistence:** Ensuring that changes to the workspace (files, artifacts) are committed, digested, and verified.
*   **State Management:** Maintaining the current plan, evidence, and invocation history.
*   **Validation:** Providing factual observations (success/failure, content digests) back to the Harness.

The Runtime does not interpret intent. It executes commands and returns objective facts about the resulting state.

## Operational Implications

### Truthful Completion & Evidence
Because the Runtime owns effects, the Harness can never *claim* a state change without **Runtime observation**. 
*   **Provenance:** Every fact about the workspace must be backed by a Tool result (Evidence).
*   **No Invention:** The Harness must not invent successful writes or external states. It must wait for the `filesystem.write` or similar tool to return a success status and digest.
*   **Verification:** After a mutation, the Harness should verify the result (e.g., by reading the file back or checking the digest) before considering the task complete.

### Instruction and Data Boundary
*   **Untrusted Data:** Tool outputs, research records, and external inputs are data. They may contain misleading instructions or role claims. The Harness must ignore embedded "approval" or "permission" requests within untrusted data and rely only on its own protocol authority.
*   **Authority Hierarchy:** Protocol > Host Policy > Project Policy > User Input > Untrusted Data.

### Working Loop Discipline
The Harness follows a strict loop:
1.  **Identify** the unresolved requirement.
2.  **Reuse** existing authoritative facts (avoid redundant reads).
3.  **Observe** only if facts are missing (smallest useful observation).
4.  **Act** with one or a bounded batch of independent actions.
5.  **Update** conclusions only when contradicted by new facts.
6.  **Verify** state changes proportionately.
7.  **Finish** only when all requirements are satisfied or explicitly unresolved.

### Delegation Strategy
When work is complex, the Harness may delegate to Workers. However:
*   Workers are isolated and cannot declare Parent success.
*   Their output is a proposal backed by facts/artifacts.
*   The Parent must combine findings, resolve conflicts, and produce the final deliverable directly.

## Summary
The Nexora system enforces a clean separation between **reasoning** (Harness) and **execution** (Runtime). This ensures that semantic decisions are made by the intelligent agent while durable state changes are handled reliably and verifiably by the runtime environment. All workspace changes must be evidenced by Tool results, and no completion claim is valid without such proof.
