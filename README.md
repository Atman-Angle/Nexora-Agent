<p align="right"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <img src="./assets/readme/logo.png" width="104" alt="Nexora Agent logo">
</p>

<h1 align="center">Nexora Agent</h1>

<p align="center"><strong>The trusted execution layer beneath your Agent application.</strong></p>

<p align="center">
  Build with your own model, tools, prompts, and product experience.<br>
  Let Nexora make every run persistent, controllable, recoverable, and verifiable.
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-5CE1A4?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-5EA2FF?style=flat-square">
  <img alt="Embeddable Runtime" src="https://img.shields.io/badge/Runtime-embeddable-F4F7FA?style=flat-square">
  <img alt="Pre-release" src="https://img.shields.io/badge/status-pre--release-8B98A7?style=flat-square">
</p>

<p align="center">
  <img src="./assets/readme/hero.png" width="100%" alt="Nexora Agent turns model decisions and tool invocations into persisted evidence and a validated result">
</p>

## The execution layer beneath your Agent

An Agent product has three distinct responsibilities:

| Layer | Responsibility |
| --- | --- |
| **Your application** | Defines the goal, domain prompts, tools, data, UI, and product behavior. |
| **The model Provider** | Observes the current context and proposes what the Agent should do next. |
| **Nexora Runtime** | Executes that decision safely, persists what happened, handles interaction and recovery, and decides whether the task is truly complete. |

Nexora is the third layer. It is not another Agent persona and it does not replace your application framework. It is the runtime that turns an unreliable sequence of model calls and Tool calls into one durable, auditable **Run**.

```text
goal
  → model decision
  → Tool Invocation
  → persisted Evidence
  → next decision or human interaction
  → validated terminal Result
```

Without a runtime, every application eventually rebuilds its own state flags, retry rules, approval flow, partial-progress storage, and definition of “done.” Nexora provides one execution path for those concerns while leaving all domain behavior in the application.

## Why use Nexora?

Use Nexora when an Agent must do more than return one model response:

- **It performs real actions.** Tool calls are schema-validated and recorded as authoritative Invocations.
- **It may need a person.** Input, approval, and denial pause and continue the same Run.
- **It must survive interruption.** Persisted state allows a Run to be reopened after a process restart.
- **It cannot repeat side effects blindly.** Recovery distinguishes safe retry from unknown non-idempotent effects.
- **Its result must be defensible.** Evidence and the Completion Gate prevent plausible model text from impersonating success.
- **It lives inside a real product.** Nexora embeds through a TypeScript API and does not take ownership of domain data or UI.

For a simple stateless chat completion, Nexora may be unnecessary. It is designed for Agents whose execution has state, side effects, human interaction, or a meaningful completion contract.

## Core concepts

| Concept | What it means |
| --- | --- |
| `Runtime` | The configured execution environment: workspace, Provider, Tools, persistence, and lifecycle. |
| `Run` | One durable attempt to achieve a goal. Its State Machine is the only authority allowed to change Run status. |
| `RunHandle` | The public control surface used by a host to observe events, provide input or approval, cancel, resume, and read the result. |
| `Provider` | The model adapter that proposes decisions. It cannot execute Tools or write Run state directly. |
| `Tool Invocation` | The authoritative record of a requested real-world action and its execution outcome. |
| `Evidence` | Persisted proof used to validate progress and determine whether completion is justified. |

The current Structured Plan belongs to the Run. The application does not maintain a second plan, second state machine, or second source of truth for execution.

## Quick start

> Nexora Agent is currently pre-release and is not yet published to npm. Start from the source workspace.

Requirements: Node.js 20+ and pnpm 11.

```powershell
git clone https://github.com/Atman-Angle/Nexora-Agent.git
Set-Location -LiteralPath 'Nexora-Agent'
pnpm install
pnpm typecheck
```

Create a Runtime, start a Run, and wait for its validated result:

```ts
import {
  createBuiltInTools,
  createRuntime,
  openAICompatibleProviderFromEnv
} from "@nexora/runtime";

const runtime = createRuntime({
  workspace: "D:/my-agent-workspace",
  provider: openAICompatibleProviderFromEnv(),
  tools: createBuiltInTools()
});

try {
  const run = runtime.run("Read note.txt and produce an evidence-backed summary");
  const result = await run.result();

  console.log(result.status, result.summary);
} finally {
  await runtime.close();
}
```

`runtime.run()` returns a `RunHandle`, not an unverified model answer. Interactive hosts can use that same handle to continue the Run:

```ts
const subscription = run.subscribe(async (event) => {
  if (event.type === "input.required") {
    await run.input(await askUser(event.prompt), {
      requestId: event.requestId
    });
  }

  if (event.type === "approval.required") {
    await run.approve({ requestId: event.request.id });
  }
});
```

See [Build with the Nexora Runtime](docs/BUILD_WITH_NEXORA_RUNTIME.md) for packaging, Provider adapters, custom Tools, events, cancellation, and recovery.

## What happens during a Run?

1. `runtime.run(goal)` creates and persists a new Run.
2. The Provider observes the Run context and proposes the next decision.
3. A Tool request is validated and, when required, waits for approval.
4. Nexora records the Tool Invocation and its Evidence before continuing.
5. Input, failure, cancellation, or restart is handled through the same persisted Run.
6. The Completion Gate checks the Run-owned plan and Evidence before the State Machine can mark the Run as succeeded.

<p align="center">
  <img src="./assets/readme/runtime-architecture.png" width="100%" alt="Authority boundary between a host application, the Nexora Runtime, and validated outputs">
</p>

The boundary is intentional: the model, Tool, and host application cannot write Run status directly. This keeps execution state, side effects, recovery decisions, and completion under one authority.

## Reference harness: Research Agent

[`apps/research-agent`](apps/research-agent) is a real application harness built on Nexora's public API. Research Profiles, Tavily integration, news Tools, scheduling, and generated content remain application-owned; Nexora owns the Run lifecycle beneath them.

```ts
const runtime = createRuntime({ workspace, provider, tools });
const run = runtime.run(buildResearchGoal(profile));
const result = await run.result();
```

The harness verifies real retrieval, human interaction, failure recovery, and validated completion without reading the Core Store, writing Run state, copying CLI orchestration, or adding Research-specific branches to Core.

**[Explore the complete Research Agent setup, outputs, and live execution evidence →](docs/applications/research-agent.md)**

## Repository

```text
Nexora-Agent/
├─ packages/runtime/                 # Public Runtime
├─ apps/cli/                         # Thin CLI host
├─ apps/research-agent/              # Real application harness
│  ├─ src/                           # Application code
│  └─ canaries/                      # Live end-to-end runners
├─ tests/                            # Runtime and application contracts
├─ docs/                             # Guides and case studies
├─ reports/canaries/                 # Machine-readable live evidence
└─ assets/readme/                    # Logo and README visuals
```

## Documentation

- [Build with the Nexora Runtime](docs/BUILD_WITH_NEXORA_RUNTIME.md)
- [Research Agent harness and results](docs/applications/research-agent.md)
- [Architecture and authority boundaries](ARCHITECTURE.md)
- [System data flow](DATA_FLOW.md)
- [Testing strategy](TESTS.md)
- [Current development state](DEVELOPMENT.md)

## Project status

Nexora Agent is currently pre-release. The Runtime, CLI, and Research Agent harness can be built and tested in this repository; npm publication, long-running hosted deployment, and an open-source license have not yet been completed or declared.

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

> No license has been declared. Confirm licensing before adoption, distribution, or publication.
