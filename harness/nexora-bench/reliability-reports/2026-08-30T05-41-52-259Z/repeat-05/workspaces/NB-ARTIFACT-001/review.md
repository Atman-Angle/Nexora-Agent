# Boundary Analysis Review

## Source
- **File**: `seed.txt`
- **Research Tool**: `fixture.long_research`
- **Artifact Digest**: `sha256:f4fd8461a3e490c3f7447ba9bacb628edbcc4d3008e4215b5718ebead2b1b2cb`

## Core Conclusion
**"Harness owns semantic decisions; Runtime owns durable Effects."**

This finding delineates the fundamental separation of concerns within the system architecture:
1.  **Semantic Decisions**: The Harness layer is responsible for interpreting meaning, context, and high-level logic. It determines *what* should happen based on the current state and goals.
2.  **Durable Effects**: The Runtime layer is responsible for the reliable, persistent execution of actions. It ensures that once a decision is made, the resulting state changes are applied correctly and permanently.

## Research Notes Summary
The research process generated 420 distinct analytical points (`research-1` through `research-420`), all converging on this central thesis. These notes provide the granular evidence supporting the high-level boundary definition between the semantic harness and the effectual runtime.
