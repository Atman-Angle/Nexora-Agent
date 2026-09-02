# Nexora Boundary Review: Detailed Analysis

## Source
- **Input**: `seed.txt`
- **Research Record**: Preserved via Artifact path (`sha256:f4fd8461a3e490c3f7447ba9bacb628edbcc4d3008e4215b5718ebead2b1b2cb`)
- **Total Research Points**: 420 entries

## Executive Summary
The research synthesizes the operational boundaries between the **Harness** (the agent/decision-making layer) and the **Runtime** (the execution/environment layer). The central thesis is a strict separation of concerns: the Harness is responsible for all semantic logic, while the Runtime is responsible for all durable state changes and effects.

## Core Principles

### 1. Harness Ownership: Semantic Decisions
The Harness retains exclusive authority over meaning, intent, and logic. This includes:
*   **Instruction Interpretation**: Determining what a user request actually requires.
*   **Strategy Selection**: Choosing which tools or paths to take to achieve a goal.
*   **Logical Reasoning**: Deductive steps, planning, and error analysis.
*   **Policy Adherence**: Ensuring actions align with Host Policy, Project Policy, and Kernel constraints.

The Harness does *not* directly modify state. It generates proposals, plans, and tool calls that describe *intended* semantic outcomes.

### 2. Runtime Ownership: Durable Effects
The Runtime retains exclusive authority over the physical/digital state of the workspace and external systems. This includes:
*   **State Mutation**: Writing files, updating databases, or changing system configurations.
*   **Execution Verification**: Confirming that a tool call completed successfully and returned the expected data.
*   **Persistence**: Ensuring that changes are saved and durable across sessions.
*   **Boundary Enforcement**: Preventing unauthorized or invalid operations from taking effect.

The Runtime does *not* make semantic judgments. It executes instructions provided by the Harness and reports back factual results.

## Operational Workflow

1.  **Inquiry & Planning (Harness)**: The Harness analyzes the user input and authoritative context. If facts are missing, it requests observations. It formulates a plan or direct response based on semantic understanding.
2.  **Tool Invocation (Harness -> Runtime)**: The Harness issues a tool call (e.g., `filesystem.write`, `nexora_update_plan`). This is a request for a specific effect.
3.  **Execution & Verification (Runtime)**: The Runtime executes the tool call. It verifies the operation's success and returns factual evidence (e.g., file digest, byte length, status).
4.  **Evaluation (Harness)**: The Harness receives the evidence. It evaluates whether the observed state matches the intended semantic outcome. If not, it repairs or retries.
5.  **Completion Proposal (Harness)**: Once all semantic requirements are satisfied and verified by Runtime evidence, the Harness proposes completion.

## Key Implications

*   **No Direct State Access**: The Harness cannot "know" the state of the workspace without Runtime observation. All knowledge of state must come through Tool results.
*   **Evidence-Based Truth**: Completion is never declared by the Harness alone. It is only valid when backed by Runtime-proven evidence (e.g., successful Tool invocations).
*   **Separation of Concerns**: This architecture prevents logical errors in the Harness from corrupting state, and prevents Runtime anomalies from confusing semantic logic. Errors are isolated to their respective layers.
*   **Deterministic Completion**: The Completion Gate is deterministic because it relies on factual Tool results, not subjective claims of success.

## Conclusion
The Nexora protocol enforces a robust dichotomy: **Semantics belong to the Harness; Effects belong to the Runtime.** This ensures that intelligent decision-making is decoupled from state mutation, enhancing reliability, auditability, and safety. All work must flow through this boundary, with the Harness proposing and the Runtime executing and verifying.
