# Build with Nexora Runtime

`@nexora/runtime` is the only package an application imports. It runs a durable, workspace-bounded Agent with an OpenAI-compatible model provider.

## Install

```sh
npm install @nexora/runtime
```

For a local candidate from this repository:

```sh
pnpm --dir packages/runtime build
(cd packages/runtime && npm pack --pack-destination ../../tmp)
npm install ./tmp/nexora-runtime-0.1.0.tgz
```

## Configure the provider

Set these environment variables in the application process. Do not place the API key in source code, instructions, events, or artifacts.

```sh
NEXORA_MODEL_PROVIDER=openai-compatible
NEXORA_MODEL_BASE_URL=https://provider.example/v1
NEXORA_MODEL_API_KEY=...
NEXORA_MODEL_NAME=...
```

## Create an Agent

```ts
import { createAgent, fileTools } from "@nexora/runtime";

const agent = createAgent({
  workspace: vaultPath,
  instructions: "Read and organize this Markdown Vault. Keep links intact.",
  tools: [
    fileTools.read,
    fileTools.search,
    fileTools.list,
    fileTools.write,
    fileTools.patch
  ]
});

const result = await agent.run("Read the vault index and summarize its open tasks.");
if (result.status === "completed") console.log(result.text);
```

Only the listed file tools are available to the model. Shell, Git, and project-scanning tools are never added by this Facade.

## Handle writes and recovery

`write` and `patch` always return an approval request before changing the workspace. Approve or deny explicitly. A new Agent with the same workspace and `dataDir` can resume a pending run safely.

```ts
const result = await agent.run("Create today.md with today’s tasks.");
if (result.status === "approval_required") {
  const finished = await agent.approve(result.approvalId);
  console.log(finished);
}

// Or leave the workspace unchanged:
if (result.status === "approval_required") agent.deny(result.approvalId, "Not today");

// After a process restart:
const recovered = createAgent({ workspace: vaultPath, instructions: "...", tools: [fileTools.read, fileTools.write] });
const pending = await recovered.resume(result.runId);
```

By default Runtime stores only its SQLite state and artifacts under `<workspace>/.nexora`. This directory contains run state, approvals, checkpoints, events, and artifacts; it is not a Notes or knowledge database. Supply `dataDir` to place that Runtime data elsewhere. Call `agent.close()` before process shutdown.
