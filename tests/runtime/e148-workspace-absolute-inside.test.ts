import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e148-tools-"));
  roots.push(root);
  return root;
}

function tool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const found = tools.find((item) => item.contract.identity.name === name);
  if (found === undefined) throw new Error(`Missing Tool: ${name}`);
  return found;
}

async function execute(target: RuntimeTool, root: string, input: unknown) {
  return target.execute(target.contract.execution.inputSchema.parse(input), {
    workspace: root,
    runId: "run-tools",
    invocationId: "inv-tools",
    signal: new AbortController().signal
  });
}

describe("E148 workspace-absolute path containment", () => {
  it("accepts absolute paths that resolve inside the workspace root", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "value.ts"), "export const marker = 'needle';\n", "utf8");
    const tools = createBuiltInTools();

    await expect(execute(tool(tools, "filesystem.read"), root, { path: join(root, "src", "value.ts") }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ content: expect.stringContaining("needle") }) }));

    const target = join(root, "out.txt");
    await expect(execute(tool(tools, "filesystem.write"), root, { path: target, content: "ok" }))
      .resolves.toEqual(expect.objectContaining({ status: "success" }));
    expect(readFileSync(target, "utf8")).toBe("ok");
  });

  it("still rejects absolute paths outside the workspace root", async () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "secret.txt"), "outside\n", "utf8");

    const result = await execute(tool(createBuiltInTools(), "filesystem.read"), root, { path: join(outside, "secret.txt") });
    expect(result).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "PATH_ESCAPE" })
    }));
  });

  it("still rejects escapes through a directory symlink even via an absolute path", async () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "secret.txt"), "outside\n", "utf8");
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

    const result = await execute(tool(createBuiltInTools(), "filesystem.read"), root, { path: join(root, "linked", "secret.txt") });
    expect(result).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "PATH_ESCAPE" })
    }));
  });

  it("keeps relative workspace paths working unchanged", async () => {
    const root = workspace();
    writeFileSync(join(root, "note.txt"), "before\n", "utf8");
    const read = tool(createBuiltInTools(), "filesystem.read");
    await expect(execute(read, root, { path: "note.txt" }))
      .resolves.toEqual(expect.objectContaining({ status: "success", facts: expect.objectContaining({ content: expect.stringContaining("before") }) }));
    await expect(execute(read, root, { path: "../outside.txt" }))
      .resolves.toEqual(expect.objectContaining({ status: "failure", error: expect.objectContaining({ code: "PATH_ESCAPE" }) }));
  });

  it("blocks workspace secret files from Agent reads", async () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NEXORA_MODEL_API_KEY=secret-value\n", "utf8");
    const result = await execute(tool(createBuiltInTools(), "filesystem.read"), root, { path: ".env" });
    expect(result).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "SECRET_FILE_READ_BLOCKED" })
    }));
  });

  it("verifies loopback HTTP responses with the dedicated read-only Tool", async () => {
    const root = workspace();
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("missing");
    });
    await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Loopback test server has no TCP address.");
    try {
      const httpTool = tool(createBuiltInTools(), "http.request");
      const healthy = await execute(httpTool, root, {
        url: `http://127.0.0.1:${address.port}/health`,
        expectedContentType: "text/plain"
      });
      expect(healthy).toEqual(expect.objectContaining({
        status: "success",
        facts: expect.objectContaining({ status: 200, body: "ok" })
      }));

      const mismatch = await execute(httpTool, root, {
        url: `http://127.0.0.1:${address.port}/health`,
        expectedStatus: 204
      });
      expect(mismatch).toEqual(expect.objectContaining({
        status: "failure",
        error: expect.objectContaining({ code: "HTTP_STATUS_MISMATCH" })
      }));

      const external = await execute(httpTool, root, { url: "http://example.com/" });
      expect(external).toEqual(expect.objectContaining({
        status: "failure",
        error: expect.objectContaining({ code: "HTTP_URL_NOT_LOOPBACK" })
      }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 10_000);
});
