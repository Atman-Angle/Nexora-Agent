import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DesktopRuntimeService } from "../../apps/desktop/src/runtime-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E130 Desktop Project and continuous Session", () => {
  it("continues terminal Runs in one Session and persists archive/remove navigation without exposing the API key", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e130-desktop-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "target.txt"), "verified\n", "utf8");
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
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

    await service.continueSession(sessionId, "Read it once more");
    const continued = await waitForStatus(service, "succeeded");
    expect(continued.session?.id).toBe(sessionId);
    expect(continued.session?.runs.map(({ userInput }) => userInput)).toEqual(["Read target.txt", "Read it once more"]);
    expect(continued.session?.runs.every(({ inspection }) => inspection.status === "succeeded")).toBe(true);

    const archived = await service.archiveSession(sessionId, true);
    expect(archived.session).toBeNull();
    expect(currentProject(archived).sessions.find(({ id }) => id === sessionId)?.archived).toBe(true);
    const restored = await service.archiveSession(sessionId, false);
    expect(currentProject(restored).sessions.find(({ id }) => id === sessionId)?.archived).toBe(false);

    const configured = await service.saveProviderSettings({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "replacement-secret",
      model: "qwen3.7-flash",
      decisionOutputTokens: 2048,
      transport: "structured_output"
    });
    expect(JSON.stringify(configured)).not.toContain("replacement-secret");
    expect(readFileSync(join(workspace, ".env"), "utf8")).toContain('NEXORA_MODEL_DECISION_OUTPUT_TOKENS="2048"');

    const removed = await service.removeSession(sessionId);
    expect(currentProject(removed).sessions.some(({ id }) => id === sessionId)).toBe(false);
    const secondProject = mkdtempSync(join(tmpdir(), "nexora-e130-project-"));
    roots.push(secondProject);
    const switched = await service.setWorkspace(secondProject);
    expect(switched.workspace).toMatchObject({ path: secondProject, providerConfigured: false });
    expect(switched.workspace.projects.map(({ path }) => path)).toEqual(expect.arrayContaining([workspace, secondProject]));
    await service.setWorkspace(workspace);
    await service.close();

    const reopened = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    const persisted = await reopened.snapshot();
    expect(currentProject(persisted).sessions.some(({ id }) => id === sessionId)).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain("replacement-secret");
    await reopened.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    expect(calls).toBe(4);
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
