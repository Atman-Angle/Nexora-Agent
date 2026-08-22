import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgent,
  createOpenAICompatibleProvider,
  modelResponses,
  type AgentPublicOutputEvent
} from "../../packages/harness/src/index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E131 Provider public output stream", () => {
  it("does not let a failing UI listener change the Run outcome", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e131-observer-"));
    roots.push(workspace);
    const runtime = createAgent({
      workspace,
      provider: {
        modelProfile: {
          provider: "test",
          model: "test-model",
          contextWindowTokens: 16_000,
          reservedOutputTokens: { decision: 1_000 },
          softLimitRatio: 0.8
        },
        transport: { kind: "native_tools", promptCache: { mode: "disabled" } },
        async decide(_context, operation) {
          operation.reportPublicTextDelta?.("Visible progress.");
          return modelResponses.text("Completed despite the UI listener.");
        }
      },
      tools: [],
      publicOutputListener() { throw new Error("Renderer unavailable"); }
    });

    const result = await runtime.start({ input: "Complete without relying on the UI observer." });
    await runtime.close();

    expect(result).toMatchObject({ status: "succeeded", summary: "Completed despite the UI listener." });
  });

  it("streams public assistant text without persisting token deltas as Runtime facts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e131-stream-"));
    roots.push(workspace);
    let requestBody: Record<string, unknown> | null = null;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"reasoning_content":"Checking current facts. "}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"**Verified"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":" result**"},"finish_reason":"stop"}],"usage":null}\n\n');
      response.end("data: [DONE]\n\n");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    const output: AgentPublicOutputEvent[] = [];
    const runtime = createAgent({
      workspace,
      provider: createOpenAICompatibleProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
        model: "test-model",
        stream: true
      }),
      tools: [],
      publicOutputListener: (event) => output.push(event)
    });

    const result = await runtime.start({ input: "Return a short verified result." });
    const inspection = await runtime.inspect(result.runId);
    await runtime.close();

    expect(requestBody).toMatchObject({ stream: true });
    expect(result).toMatchObject({ status: "succeeded", summary: "**Verified result**" });
    expect(output.map((event) => event.type)).toEqual(["text.delta", "text.delta", "text.delta", "text.completed"]);
    expect(output.filter((event) => event.type === "text.delta").map((event) => event.text).join(""))
      .toBe("Checking current facts. **Verified result**");
    expect(output.every((event) => event.runId === result.runId)).toBe(true);
    expect(JSON.stringify(inspection.events)).not.toContain("text.delta");
  });

  it("discards provider-exposed process text when its Model attempt fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexora-e131-discard-"));
    roots.push(workspace);
    const output: AgentPublicOutputEvent[] = [];
    const runtime = createAgent({
      workspace,
      provider: {
        modelProfile: {
          provider: "test",
          model: "test-model",
          contextWindowTokens: 16_000,
          reservedOutputTokens: { decision: 1_000 },
          softLimitRatio: 0.8
        },
        transport: { kind: "native_tools", promptCache: { mode: "disabled" } },
        async decide(_context, operation) {
          operation.reportPublicTextDelta?.("This failed attempt must disappear.");
          throw new Error("Provider failed after emitting process text.");
        }
      },
      tools: [],
      publicOutputListener: (event) => output.push(event)
    });

    const result = await runtime.start({ input: "Fail after a visible partial response." });
    await runtime.close();

    expect(result).toMatchObject({ status: "blocked", stopReason: "PROVIDER_UNAVAILABLE" });
    expect(output.map((event) => event.type)).toEqual(["text.delta", "text.discarded"]);
  });
});
