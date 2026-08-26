# @nexora/harness

The Provider-neutral Nexora Agent Loop, Prompt compiler, Context and Memory policy, Provider adapters, Multi-Agent coordination and Testing Kit.

```ts
import { createAgentHarness } from "@nexora/harness";
```

The Harness delegates durable state, side effects, Evidence and completion authority to `@nexora/runtime`.

## Local Agent Skills

Hosts may configure explicit local Agent Skills roots through `CreateAgentOptions.skills`. Nexora reads Agent Skills-compatible `SKILL.md` packages, exposes only a bounded metadata catalog to the Provider, and accepts the Harness control `nexora_select_skills` before loading selected instructions on the next turn. Skill packages are strategy-only: they cannot register or execute Tools, grant permission, create Evidence, modify Runtime state, or declare completion. Remote installation, MCP and automatic script execution are outside this boundary. See `docs/AGENT_SKILL_AUTO_SELECTION_SPEC.md` for the production contract.

Documentation and source: [Nexora Agent](https://github.com/Atman-Angle/Nexora-Agent)

Version `0.1.0` is licensed under Apache-2.0. The package is not yet published to npm; until publication, install it from a locally produced tarball.
