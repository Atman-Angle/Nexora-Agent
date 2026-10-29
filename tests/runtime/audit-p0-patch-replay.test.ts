import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("adversarial filesystem.patch replay handling", () => {
  it("fails closed when current content only happens to contain the replacement", async () => {
    const root = workspace();
    writeFileSync(join(root, "target.txt"), "replacement already present\n", "utf8");
    const result = await execute("filesystem.patch", root, {
      path: "target.txt",
      expectedDigest: digest("original\n"),
      find: "original",
      replace: "replacement"
    });

    expect(result).toEqual(expect.objectContaining({
      status: "failure",
      error: expect.objectContaining({ code: "CONTENT_CONFLICT" })
    }));
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("replacement already present\n");
  });

  it("rejects an empty replacement before a write can produce Evidence", () => {
    const tool = getTool("filesystem.patch");
    expect(tool.contract.execution.inputSchema.safeParse({
      path: "target.txt",
      expectedDigest: digest("original\n"),
      find: "original",
      replace: ""
    }).success).toBe(false);
  });

  it("rechecks the file before and after the atomic commit", async () => {
    const root = workspace();
    writeFileSync(join(root, "target.txt"), "original\n", "utf8");
    const result = await execute("filesystem.patch", root, {
      path: "target.txt",
      expectedDigest: digest("original\n"),
      find: "original",
      replace: "updated"
    });

    expect(result).toEqual(expect.objectContaining({
      status: "success",
      facts: { path: "target.txt", digest: digest("updated\n"), replayed: false }
    }));
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("updated\n");
  });

  it("serializes concurrent patch commits with an OS-level target lock", async () => {
    const root = workspace();
    const target = join(root, "target.txt");
    const original = "ORIGINAL\n";
    writeFileSync(target, original, "utf8");
    const input = {
      path: "target.txt",
      expectedDigest: digest(original),
      find: "ORIGINAL",
      replace: "UPDATED"
    };
    const [first, second] = await Promise.all([
      execute("filesystem.patch", root, input),
      execute("filesystem.patch", root, input)
    ]);

    expect([first, second].filter((result) => result.status === "success")).toHaveLength(1);
    expect([first, second].find((result) => result.status === "failure")).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: "CONTENT_CONFLICT" })
    }));
    expect(readFileSync(target, "utf8")).toBe("UPDATED\n");
  });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-audit-patch-"));
  roots.push(root);
  return root;
}

function getTool(name: string): RuntimeTool {
  const tool = createBuiltInTools().find((candidate) => candidate.contract.identity.name === name);
  if (tool === undefined) throw new Error(`Missing Tool ${name}`);
  return tool;
}

async function execute(name: string, workspaceRoot: string, input: unknown) {
  const tool = getTool(name);
  return await tool.execute(tool.contract.execution.inputSchema.parse(input), {
    workspace: workspaceRoot,
    runId: "run-audit-patch",
    invocationId: "inv-audit-patch",
    signal: new AbortController().signal
  });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
