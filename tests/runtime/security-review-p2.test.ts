import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "../../apps/desktop/node_modules/fflate/esm/index.mjs";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";
import { safeUnzipSync } from "../../apps/desktop/src/deliverables/zip-safety.js";
import { ArtifactStore } from "../../packages/runtime/src/store/artifacts.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(prefix = "nexora-review-p2-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function tool(tools: readonly RuntimeTool[], name: string): RuntimeTool {
  const found = tools.find((candidate) => candidate.contract.identity.name === name);
  if (found === undefined) throw new Error(`Missing Tool: ${name}`);
  return found;
}

function execute(target: RuntimeTool, root: string, input: unknown) {
  return target.execute(target.contract.execution.inputSchema.parse(input), {
    workspace: root,
    runId: "run-p2",
    invocationId: "inv-p2",
    signal: new AbortController().signal
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("P2 review regressions", () => {
  it("does not create directories outside the workspace through a junction", async () => {
    const root = workspace();
    const outside = workspace("nexora-review-p2-outside-");
    const linked = join(root, "linked");
    try {
      symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") return;
      throw error;
    }

    const result = await execute(tool(createBuiltInTools(), "filesystem.write"), root, {
      path: "linked/new-dir/file.txt",
      content: "must not be written\n"
    });
    expect(result).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "SYMLINK_ESCAPE" })
    }));
    expect(existsSync(join(outside, "new-dir"))).toBe(false);
  });

  it("rejects oversized text and patch targets before reading their content", async () => {
    const root = workspace();
    const path = join(root, "oversized.txt");
    const descriptor = openSync(path, "w");
    try {
      ftruncateSync(descriptor, 40 * 1024 * 1024);
    } finally {
      closeSync(descriptor);
    }
    const tools = createBuiltInTools();

    await expect(execute(tool(tools, "filesystem.read"), root, { path: "oversized.txt" }))
      .resolves.toEqual(expect.objectContaining({
        status: "failure",
        error: expect.objectContaining({ code: "FILE_TOO_LARGE" })
      }));
    await expect(execute(tool(tools, "filesystem.patch"), root, {
      path: "oversized.txt",
      expectedDigest: `sha256:${"0".repeat(64)}`,
      find: "a",
      replace: "b"
    })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "FILE_TOO_LARGE" })
    }));
  });

  it("streams large UTF-8 reads with bounded previews and exact ranged content", async () => {
    const root = workspace();
    const source = `${"0123456789abcdef".repeat(70_000)}终`;
    writeFileSync(join(root, "large.txt"), source, "utf8");
    const read = tool(createBuiltInTools(), "filesystem.read");

    const preview = await execute(read, root, { path: "large.txt" });
    expect(preview).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({
        preview: source.slice(0, 500),
        digest: sha256(source),
        byteLength: Buffer.byteLength(source),
        artifactRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      })
    }));

    if (preview.status !== "success") throw new Error("Large preview unexpectedly failed.");
    const previewFacts = preview.facts as { readonly artifactRef: string };
    expect(new ArtifactStore(join(root, ".nexora", "artifacts")).getText(previewFacts.artifactRef)).toBe(source);

    const ranged = await execute(read, root, { path: "large.txt", offset: 1_010, limit: 320 });
    expect(ranged).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({
        content: source.slice(1_010, 1_330),
        digest: sha256(source),
        characterLength: source.length,
        offset: 1_010,
        returnedCharacters: 320,
        nextOffset: 1_330,
        truncated: true
      })
    }));
  });

  it("bounds filesystem list offsets and traversal depth", async () => {
    const list = tool(createBuiltInTools(), "filesystem.list");
    expect(list.contract.execution.inputSchema.safeParse({ path: ".", offset: 50_000 }).success).toBe(true);
    expect(list.contract.execution.inputSchema.safeParse({ path: ".", offset: 50_001 }).success).toBe(false);

    const root = workspace();
    let nested = root;
    for (let depth = 0; depth < 66; depth += 1) nested = join(nested, `d${depth}`);
    mkdirSync(nested, { recursive: true });
    await expect(execute(list, root, { path: "." })).resolves.toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "LIST_DEPTH_EXCEEDED" })
    }));
  });

  it("rejects high-ratio and traversal ZIP entries before materialization", () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(2_000_000) });
    expect(() => safeUnzipSync(bomb)).toThrow(/compression ratio|expands beyond/u);

    const traversal = zipSync({ "../escape.txt": new Uint8Array([1, 2, 3]) });
    expect(() => safeUnzipSync(traversal)).toThrow(/escapes its package root/u);

    const valid = zipSync({ "word/document.xml": Buffer.from("<w:document><w:body/></w:document>") });
    expect(safeUnzipSync(valid)).toHaveProperty("word/document.xml");
  });
});
