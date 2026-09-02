<p align="right"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center"><img src="./assets/readme/logo.png" width="104" alt="Nexora Agent logo"></p>

<h1 align="center">Nexora Agent</h1>

<p align="center"><strong>A trusted execution runtime for agents that do real work.</strong></p>

<p align="center">
  Bring your own model, tools, prompts, and product experience.<br>
  Nexora makes each run persistent, controllable, recoverable, and verifiable.
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-5CE1A4?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-5EA2FF?style=flat-square">
  <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-5EA2FF?style=flat-square">
  <img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-5CE1A4?style=flat-square">
</p>

<p align="center"><img src="./assets/readme/hero.png" width="100%" alt="Nexora turns agent actions into durable evidence and verified results"></p>

## What is Nexora?

Nexora is an embeddable TypeScript runtime for agents that use tools, change external state, wait for people, or continue across process restarts.

Your application still owns the user experience, domain logic, prompts, models, and tools. Nexora owns the execution concerns that are easy to get wrong: durable state, approvals, side-effect tracking, recovery, evidence, and truthful completion.

```text
User goal
  → Harness asks the model what to do next
  → Runtime validates and executes the action
  → Tool results become durable evidence
  → The run continues, pauses, recovers, or completes
  → Your application receives a verified result
```

Nexora is not a chatbot, hosted agent service, workflow builder, or replacement for your application framework. For a simple stateless model response, you probably do not need it.

## Why use it?

| Need | What Nexora provides |
| --- | --- |
| Perform real actions | Schema validation, permission checks, approval gates, and authoritative Tool Invocations |
| Survive interruption | Persisted Runs that can resume after process or application restarts |
| Avoid unsafe retries | Idempotency and explicit handling for unknown non-idempotent effects |
| Know what actually happened | Append-only events, artifacts, tool results, and persisted Evidence |
| Prevent false success | A deterministic Completion Gate before a Run can succeed |
| Embed inside a product | A TypeScript API, `RunHandle`, events, cancellation, input, approval, and recovery |

The model proposes decisions. It cannot directly execute tools, rewrite Run state, manufacture Evidence, or declare success.

## How it fits together

| Layer | Responsibility |
| --- | --- |
| **Your application** | User experience, goals, domain data, prompts, tools, and business rules |
| **Nexora Harness** | Agent loop, model calls, context, planning, profiles, skills, and decision compilation |
| **Nexora Runtime** | Run state, tool execution, approvals, recovery, Evidence, and completion invariants |
| **Model provider** | Proposes the next decision from a bounded working context |

There is one authoritative path for execution: Tool effects are recorded as Invocations, progress is backed by Evidence, and only the Runtime State Machine can change Run status.

## Quick start

Nexora currently runs from source and requires Node.js 20+ and pnpm 11.

```powershell
git clone https://github.com/Atman-Angle/Nexora-Agent.git
Set-Location -LiteralPath 'Nexora-Agent'
pnpm install
pnpm typecheck
```

### Start the Desktop workspace

```powershell
pnpm desktop
```

The Desktop app provides Projects, Sessions, streaming model output, approvals, recovery, workspace files, model settings, and persisted execution history. See the [Desktop guide](./apps/desktop/README.md) for configuration and usage.

### Embed the runtime

```ts
import {
  createAgent,
  createBuiltInTools,
  openAICompatibleProviderFromEnv
} from "@nexora/harness";

const agent = createAgent({
  workspace: "D:/my-agent-workspace",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  const run = agent.run("Read note.txt and produce an evidence-backed summary");
  const result = await run.result();
  console.log(result.status, result.summary);
} finally {
  await agent.close();
}
```

`agent.run()` returns a durable `RunHandle`, not an unchecked model answer. Hosts can subscribe to events, provide input, approve protected actions, cancel work, reopen Runs, and read the validated result.

## Current capabilities

- Durable Runs, events, artifacts, Tool Invocations, and Evidence
- Schema-validated tools with permissions, risk, approval, and recovery semantics
- OpenAI-compatible model providers with native tool calling and streaming output
- Bounded context, deterministic eviction, rehydration, and scoped cross-Run Memory
- Run-owned planning and deterministic completion validation
- Human input, approval, cancellation, continuation, and crash recovery
- Local Agent Skill discovery with model-owned, progressive instruction loading
- Managed long-running local processes through the same Runtime authority
- Bounded Supervisor and Child Run coordination with isolated workspaces
- Desktop, CLI, public TypeScript API, and Runtime testing utilities
- Task-scope authority that keeps required outcomes, exclusions, and Step bindings explicit across replans
- Coding-strategy and hybrid decision context for bounded autonomous execution with manifest-diff awareness
- Editable workspace artifacts, including rich documents and Office-format workflows with persisted links and evidence
- Execution cadence, liveness, and convergence controls for long-running coding tasks

## What is included in this development snapshot?

This snapshot advances Nexora's end-to-end execution surface. The Runtime and Harness now preserve task scope as an authoritative contract, reject unauthorized scope expansion, and require every required outcome to remain planned before completion. Provider-native tool calling, transient recovery, bounded retries, hybrid decision context, and coding-task strategy are integrated into the agent loop.

The Desktop workspace now supports richer streaming sessions, workspace links, editable deliverables, and Office-oriented artifacts. The benchmark harness, canaries, and Runtime/Desktop suites were expanded to exercise recovery, liveness, completion authority, document editing, and multi-format delivery paths.

The implementation is intentionally accompanied by its specifications, execution plans, reports, and measured canary outputs under [`docs/`](./docs/README.md), so the behavior and remaining verification limits are reviewable alongside the code.

## Project status

Nexora is currently version `0.1.0` and is not yet published to npm. The repository is under active development and should be treated as a release candidate rather than a stable 1.0 API.

The current implementation targets local TypeScript applications and OpenAI-compatible providers. It does not provide hosted execution, a plugin marketplace, remote Skill installation, a no-code workflow editor, or a general SaaS control plane.

## Documentation

| If you want to… | Read |
| --- | --- |
| Use the Desktop app | [Desktop guide](./apps/desktop/README.md) |
| Embed Nexora in an application | [Build with the Runtime](./docs/BUILD_WITH_NEXORA_RUNTIME.md) |
| Understand current user workflows | [Current user guide](./docs/USER_GUIDE_CURRENT.md) |
| Understand system boundaries | [Architecture](./ARCHITECTURE.md) |
| Follow execution and persistence | [Data flow](./DATA_FLOW.md) |
| Review product direction and scope | [Project](./PROJECT.md) |
| Review verification requirements | [Tests](./TESTS.md) |
| Browse all public documents | [Documentation index](./docs/README.md) |

## Development

```powershell
pnpm typecheck
pnpm test
pnpm build
```

More focused test and acceptance commands are documented in [TESTS.md](./TESTS.md) and the [Desktop guide](./apps/desktop/README.md).

## License

[Apache License 2.0](./LICENSE)
