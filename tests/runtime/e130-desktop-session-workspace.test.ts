import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DesktopRuntimeService } from "../../apps/desktop/src/runtime-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E130 Desktop Project and continuous Session", () => {
  it("migrates Project-scoped model profiles into one global Desktop catalog", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-global-migration-"));
    roots.push(workspace);
    mkdirSync(join(workspace, ".nexora"), { recursive: true });
    writeFileSync(join(workspace, ".env"), [
      "NEXORA_MODEL_API_KEY=legacy-secret",
      "NEXORA_MODEL_BASE_URL=https://legacy.example/v1",
      "NEXORA_MODEL_NAME=legacy-model",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096"
    ].join("\n"), "utf8");
    writeFileSync(join(workspace, ".nexora", "desktop-host.json"), JSON.stringify({
      version: 1,
      projects: [{
        path: workspace,
        name: "Legacy",
        sessions: [],
        hiddenRunIds: [],
        modelProfiles: [{
          id: "environment",
          name: "Legacy model",
          baseUrl: "https://legacy.example/v1",
          model: "legacy-model",
          contextWindowTokens: 64_000,
          decisionOutputTokens: 4_096,
          transport: "native_tools"
        }],
        selectedModelProfileId: "environment"
      }]
    }), "utf8");

    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    const snapshot = await service.snapshot();
    expect(snapshot.workspace).toMatchObject({
      selectedModelProfileId: "environment",
      providerConfigured: true,
      modelProfiles: [{ id: "environment", apiKeyConfigured: true }]
    });
    const migrated = JSON.parse(readFileSync(join(workspace, ".nexora", "desktop-host.json"), "utf8")) as {
      version: number;
      modelProfiles: unknown[];
      projects: Array<Record<string, unknown>>;
    };
    expect(migrated.version).toBe(2);
    expect(migrated.modelProfiles).toHaveLength(1);
    expect(migrated.projects[0]).not.toHaveProperty("modelProfiles");
    expect(JSON.stringify(snapshot)).not.toContain("legacy-secret");
    expect(JSON.stringify(migrated)).not.toContain("legacy-secret");
    await service.close();
  });

  it("creates, selects, updates and deletes Workspace model profiles without exposing API keys", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-models-"));
    roots.push(workspace);
    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });

    const first = await service.saveModelProfile({
      id: "primary",
      name: "Primary",
      baseUrl: "https://primary.example/v1",
      apiKey: "primary-secret",
      model: "custom-primary",
      contextWindowTokens: 64_000,
      decisionOutputTokens: 4_096,
      transport: "native_tools"
    });
    expect(first.workspace).toMatchObject({ selectedModelProfileId: "primary", model: "custom-primary" });
    expect(JSON.stringify(first)).not.toContain("primary-secret");

    await service.saveModelProfile({
      id: "secondary",
      name: "Secondary",
      baseUrl: "https://secondary.example/v1",
      apiKey: "secondary-secret",
      model: "custom-secondary",
      contextWindowTokens: 128_000,
      decisionOutputTokens: 8_192,
      transport: "native_tools"
    });
    const selected = await service.selectModelProfile("secondary");
    expect(selected.workspace).toMatchObject({ selectedModelProfileId: "secondary", model: "custom-secondary" });
    expect(selected.workspace.modelProfiles).toHaveLength(2);
    expect(JSON.stringify(selected)).not.toContain("secondary-secret");
    expect(readFileSync(join(workspace, ".env"), "utf8")).toEqual(expect.stringContaining('NEXORA_MODEL_NAME="custom-secondary"'));

    const deleted = await service.deleteModelProfile("secondary");
    expect(deleted.workspace).toMatchObject({ selectedModelProfileId: "primary", model: "custom-primary" });
    expect(deleted.workspace.modelProfiles.map(({ id }) => id)).toEqual(["primary"]);
    const sibling = await service.saveModelProfile({
      id: "primary-fast",
      name: "Primary Fast",
      baseUrl: "https://primary.example/v1",
      model: "custom-primary-fast",
      contextWindowTokens: 32_000,
      decisionOutputTokens: 2_048,
      transport: "native_tools"
    });
    expect(sibling.workspace.modelProfiles.find(({ id }) => id === "primary-fast")?.apiKeyConfigured).toBe(true);
    const siblingSelected = await service.selectModelProfile("primary-fast");
    expect(siblingSelected.workspace).toMatchObject({ selectedModelProfileId: "primary-fast", providerConfigured: true });
    expect(readFileSync(join(workspace, ".env"), "utf8")).toContain('NEXORA_MODEL_API_KEY="primary-secret"');
    await service.deleteModelProfile("primary-fast");
    expect(readFileSync(join(workspace, ".env"), "utf8")).not.toContain("secondary-secret");
    expect(readFileSync(join(workspace, ".nexora", "desktop-host.json"), "utf8")).not.toContain("primary-secret");
    const globalProject = mkdtempSync(join(tmpdir(), "nexora-e130-global-models-"));
    roots.push(globalProject);
    const globalSnapshot = await service.addProject(globalProject);
    expect(globalSnapshot.workspace).toMatchObject({ path: globalProject, providerConfigured: true });
    expect(globalSnapshot.workspace.modelProfiles.map(({ id }) => id)).toEqual(["primary"]);
    const storedHost = JSON.parse(readFileSync(join(workspace, ".nexora", "desktop-host.json"), "utf8")) as {
      version: number;
      modelProfiles: unknown[];
      projects: Array<Record<string, unknown>>;
    };
    expect(storedHost.version).toBe(2);
    expect(storedHost.modelProfiles).toHaveLength(1);
    expect(storedHost.projects.every((project) => !("modelProfiles" in project))).toBe(true);
    await service.close();

    const reopened = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    const persisted = await reopened.snapshot();
    expect(persisted.workspace).toMatchObject({ selectedModelProfileId: "primary", model: "custom-primary" });
    expect(persisted.workspace.modelProfiles).toHaveLength(1);
    await reopened.close();
  });

  it("projects one automatic grounded direct response without Tool Evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-direct-"));
    roots.push(workspace);
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      calls += 1;
      const content = {
        text: null,
        toolCalls: [{ name: "nexora_respond", arguments: { text: "I am Nexora." } }],
        finishReason: "tool_calls"
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    writeFileSync(join(workspace, ".env"), [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-key",
      "NEXORA_MODEL_NAME=qwen3.7-flash",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
    ].join("\n"), "utf8");

    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    await service.startSession("Who are you?");
    const completed = await waitForStatus(service, "succeeded");
    expect(completed.session?.inspection).toMatchObject({
      status: "succeeded",
      completion: { evidence: "auto", requiredToolNames: [] },
      evidence: [],
      invocations: []
    });
    expect(completed.session?.runs[0]?.inspection.result?.summary).toBe("I am Nexora.");
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    expect(calls).toBe(1);
  });

  it("restores successful Provider reasoning and content after Desktop reopen", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-durable-stream-"));
    roots.push(workspace);
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"reasoning_content":"Inspecting the request. "}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"**I am Nexora.**"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-response","type":"function","function":{"name":"nexora_respond","arguments":"{\\"text\\":\\"**I am Nexora.**\\"}"}}]},"finish_reason":"tool_calls"}],"usage":null}\n\n');
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    writeFileSync(join(workspace, ".env"), [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-key",
      "NEXORA_MODEL_NAME=qwen3.7-flash",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=native_tools"
    ].join("\n"), "utf8");

    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    const started = await service.startSession("Who are you?");
    const sessionId = started.session!.id;
    const completed = await waitForStatus(service, "succeeded");
    expect(completed.session?.runs[0]?.publicOutputs).toEqual([
      expect.objectContaining({
        reasoning: "Inspecting the request. ",
        content: "**I am Nexora.**"
      })
    ]);
    await service.close();

    const reopened = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    const restored = await reopened.openSession(workspace, sessionId);
    expect(restored.session?.runs[0]?.publicOutputs).toEqual(completed.session?.runs[0]?.publicOutputs);
    await reopened.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("continues terminal Runs in one Session and persists archive/remove navigation without exposing the API key", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-desktop-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "target.txt"), "verified\n", "utf8");
    let calls = 0;
    const requestBodies: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requestBodies.push(body);
      calls += 1;
      const content = calls % 2 === 1
        ? { text: null, toolCalls: [{ name: "filesystem.read", arguments: { path: "target.txt" } }], finishReason: "tool_calls" }
        : { text: "Verified target.txt.", toolCalls: [], finishReason: "stop" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    writeFileSync(join(workspace, ".env"), [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-desktop-secret",
      "NEXORA_MODEL_NAME=qwen3.7-flash",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
    ].join("\n"), "utf8");

    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    const started = await service.startSession("Read target.txt");
    const sessionId = started.session!.id;
    const first = await waitForStatus(service, "succeeded");
    expect(first.session).toMatchObject({ id: sessionId, runs: [{ userInput: "Read target.txt" }] });
    const firstRunId = first.session!.runs[0]!.inspection.runId;

    await service.continueSession(sessionId, "Read it once more");
    const continued = await waitForStatus(service, "succeeded");
    expect(continued.session?.id).toBe(sessionId);
    expect(continued.session?.runs.map(({ userInput }) => userInput)).toEqual(["Read target.txt", "Read it once more"]);
    expect(continued.session?.runs.every(({ inspection }) => inspection.status === "succeeded")).toBe(true);
    expect(continued.session?.runs[1]?.inspection).toMatchObject({
      continuation: { parentRunId: firstRunId },
      inputs: [{ text: "Read it once more" }]
    });

    await service.continueSession(sessionId, "Explain both earlier requests");
    const thirdTurn = await waitForStatus(service, "succeeded");
    expect(thirdTurn.session?.runs.map(({ userInput }) => userInput)).toEqual([
      "Read target.txt",
      "Read it once more",
      "Explain both earlier requests"
    ]);
    expect(requestBodies[4]).toContain("Read target.txt");
    expect(requestBodies[4]).toContain("Read it once more");
    expect(requestBodies[4]).toContain("Explain both earlier requests");

    const compacted = await service.compactSession(sessionId);
    expect(compacted.session?.runs).toHaveLength(3);
    expect(compacted.session?.runs[2]?.history.records.some((record) => (
      record.type === "context.compaction.requested"
    ))).toBe(true);
    await service.continueSession(sessionId, "Continue after /压缩上下文");
    const afterCompaction = await waitForStatus(service, "succeeded");
    expect(afterCompaction.session?.runs).toHaveLength(4);
    const compactedRequest = JSON.parse(requestBodies[6]!) as {
      messages: Array<{ role: string; content: string }>;
    };
    const compactedProviderInput = JSON.parse(compactedRequest.messages.at(-1)!.content) as {
      originalTaskContract: {
        continuation: Array<{ payloadMode: string }>;
      };
    };
    expect(compactedProviderInput.originalTaskContract.continuation.map(({ payloadMode }) => payloadMode)).toEqual([
      "reference",
      "reference",
      "compact"
    ]);

    const archived = await service.archiveSession(workspace, sessionId, true);
    expect(archived.session).toBeNull();
    expect(currentProject(archived).sessions.find(({ id }) => id === sessionId)?.archived).toBe(true);
    const restored = await service.archiveSession(workspace, sessionId, false);
    expect(currentProject(restored).sessions.find(({ id }) => id === sessionId)?.archived).toBe(false);

    const configured = await service.saveModelProfile({
      id: "environment",
      name: "Qwen Desktop",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "replacement-secret",
      model: "qwen3.7-flash",
      decisionOutputTokens: 2048,
      transport: "structured_output"
    });
    expect(JSON.stringify(configured)).not.toContain("replacement-secret");
    expect(readFileSync(join(workspace, ".env"), "utf8")).toContain('NEXORA_MODEL_DECISION_OUTPUT_TOKENS="2048"');

    const secondProject = mkdtempSync(join(tmpdir(), "nexora-e130-project-"));
    roots.push(secondProject);
    const switched = await service.addProject(secondProject);
    expect(switched.workspace).toMatchObject({ path: secondProject, providerConfigured: true });
    expect(switched.workspace.projects.map(({ path }) => path)).toEqual(expect.arrayContaining([workspace, secondProject]));
    const removed = await service.removeSession(workspace, sessionId);
    const sourceProject = removed.workspace.projects.find(({ path }) => path === workspace)!;
    expect(sourceProject.sessions.some(({ id }) => id === sessionId)).toBe(false);
    expect(removed.workspace.path).toBe(secondProject);
    await service.setWorkspace(workspace);
    await service.close();

    const reopened = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    const persisted = await reopened.snapshot();
    expect(currentProject(persisted).sessions.some(({ id }) => id === sessionId)).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain("replacement-secret");
    await reopened.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    expect(calls).toBe(8);
  });

  it("switches Projects while the previous Project Run continues in the background", async () => {
    const firstWorkspace = mkdtempSync(join(tmpdir(), "nexora-e130-background-first-"));
    const secondWorkspace = mkdtempSync(join(tmpdir(), "nexora-e130-background-second-"));
    roots.push(firstWorkspace, secondWorkspace);
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      calls += 1;
      const callNumber = calls;
      if (callNumber === 1) await firstGate;
      const content = {
        text: null,
        toolCalls: [{ name: "nexora_respond", arguments: { text: `Project ${callNumber} completed.` } }],
        finishReason: "tool_calls"
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    const environment = [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-key",
      "NEXORA_MODEL_NAME=qwen3.7-flash",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
    ].join("\n");
    writeFileSync(join(firstWorkspace, ".env"), environment, "utf8");
    writeFileSync(join(secondWorkspace, ".env"), environment, "utf8");

    const service = new DesktopRuntimeService({ workspace: firstWorkspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    await service.startSession("Keep working in the first Project.");
    await waitFor(() => calls === 1);
    const configuredWhileRunning = await service.saveModelProfile({
      id: "global-fast",
      name: "Global Fast",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "qwen3.7-fast",
      decisionOutputTokens: 2_048,
      transport: "structured_output"
    });
    expect(configuredWhileRunning.session?.inspection.status).toBe("running");
    expect(configuredWhileRunning.workspace.modelProfiles.map(({ id }) => id)).toContain("global-fast");
    const switched = await service.addProject(secondWorkspace);
    expect(switched.workspace.path).toBe(secondWorkspace);
    expect(switched.session).toBeNull();

    await service.startSession("Complete in the second Project.");
    const secondCompleted = await waitForStatus(service, "succeeded");
    expect(secondCompleted.workspace.path).toBe(secondWorkspace);
    expect(secondCompleted.session?.inspection.result?.summary).toBe("Project 2 completed.");

    releaseFirst();
    await service.setWorkspace(firstWorkspace);
    const firstCompleted = await waitForStatus(service, "succeeded");
    expect(firstCompleted.session?.inspection.result?.summary).toBe("Project 1 completed.");

    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("interrupts a running Run before sending the next turn in the same Session", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-interrupt-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "target.txt"), "verified\n", "utf8");
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      calls += 1;
      if (calls === 1) return;
      const content = calls === 2
        ? { text: null, toolCalls: [{ name: "filesystem.read", arguments: { path: "target.txt" } }], finishReason: "tool_calls" }
        : { text: "Continued after interruption.", toolCalls: [], finishReason: "stop" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    writeFileSync(join(workspace, ".env"), [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-key",
      "NEXORA_MODEL_NAME=qwen3.7-flash",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
    ].join("\n"), "utf8");

    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError() {} });
    const started = await service.startSession("Wait for a Provider response");
    const sessionId = started.session!.id;
    await waitFor(() => calls === 1);
    await service.continueSession(sessionId, "Interrupt and read target.txt");
    const completed = await waitForStatus(service, "succeeded");
    expect(completed.session?.runs).toHaveLength(2);
    expect(completed.session?.runs[0]?.inspection.status).toBe("cancelled");
    expect(completed.session?.runs[1]).toMatchObject({
      userInput: "Interrupt and read target.txt",
      inspection: { status: "succeeded" }
    });
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    expect(calls).toBe(3);
  });

  it("interrupts a running Run before recording manual Context compaction without creating a Turn", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-compact-running-"));
    roots.push(workspace);
    let calls = 0;
    const server = createServer(async (request) => {
      for await (const _chunk of request) { /* consume request */ }
      calls += 1;
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    writeFileSync(join(workspace, ".env"), [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-key",
      "NEXORA_MODEL_NAME=qwen3.7-flash",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
    ].join("\n"), "utf8");

    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError() {} });
    const started = await service.startSession("Wait while Context is compacted");
    const sessionId = started.session!.id;
    await waitFor(() => calls === 1);
    const compacted = await service.compactSession(sessionId);
    expect(compacted.session?.runs).toHaveLength(1);
    expect(compacted.session?.runs[0]).toMatchObject({
      userInput: "Wait while Context is compacted",
      inspection: { status: "cancelled", inputs: [{ text: "Wait while Context is compacted" }] }
    });
    expect(compacted.session?.runs[0]?.history.records.filter((record) => (
      record.type === "context.compaction.requested"
    ))).toHaveLength(1);

    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    expect(calls).toBe(1);
  });
});

async function waitForStatus(service: DesktopRuntimeService, status: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await service.snapshot();
    if (snapshot.session?.inspection.status === status) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Desktop Session did not reach ${status}.`);
}

function currentProject(snapshot: Awaited<ReturnType<DesktopRuntimeService["snapshot"]>>) {
  return snapshot.workspace.projects.find(({ path }) => path === snapshot.workspace.path)!;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("Condition did not become true.");
}
