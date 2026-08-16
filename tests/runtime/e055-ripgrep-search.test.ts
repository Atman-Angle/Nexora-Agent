import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltInTools, type RuntimeTool } from "../../packages/harness/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e055-search-"));
  roots.push(root);
  return root;
}

function searchTool(): RuntimeTool {
  const tool = createBuiltInTools().find((candidate) => candidate.contract.identity.name === "filesystem.search");
  if (tool === undefined) throw new Error("Missing filesystem.search");
  return tool;
}

async function search(root: string, input: unknown) {
  const tool = searchTool();
  return tool.execute(tool.contract.execution.inputSchema.parse(input), {
    workspace: root,
    runId: "run-e055",
    invocationId: "inv-e055",
    signal: new AbortController().signal
  });
}

describe("E055 bundled Ripgrep search", () => {
  it("keeps literal case-insensitive search, subpath, ignore, binary, size and symlink boundaries", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "src", "nested"));
    mkdirSync(join(root, "src", "node_modules"));
    writeFileSync(join(root, "src", "a.txt"), "Needle [literal].*\n", "utf8");
    writeFileSync(join(root, "src", "nested", "b.txt"), "needle [literal].*\n", "utf8");
    writeFileSync(join(root, "src", "node_modules", "ignored.txt"), "needle [literal].*\n", "utf8");
    writeFileSync(join(root, "src", "binary.bin"), Buffer.from("needle\0hidden"));
    writeFileSync(join(root, "src", "large.txt"), `needle ${"x".repeat(256 * 1024)}`, "utf8");
    try {
      symlinkSync(join(root, "src", "a.txt"), join(root, "src", "linked.txt"), "file");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }

    await expect(search(root, { query: "[literal].*", path: "src" })).resolves.toEqual({
      status: "success",
      subjectRef: "search:[literal].*",
      facts: {
        matches: [
          { path: "src/a.txt", line: 1, text: "Needle [literal].*" },
          { path: "src/nested/b.txt", line: 1, text: "needle [literal].*" }
        ],
        truncated: false
      }
    });
  });

  it("reports exact bounded results deterministically without claiming exactly 100 matches were truncated", async () => {
    const root = workspace();
    const hundredLines = Array.from({ length: 100 }, (_, index) => `needle-${String(index).padStart(3, "0")}`).join("\n");
    writeFileSync(join(root, "matches.txt"), `${hundredLines}\n`, "utf8");

    const first = await search(root, { query: "needle" });
    const second = await search(root, { query: "needle" });
    expect(first).toEqual(second);
    expect(first).toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ matches: expect.any(Array), truncated: false })
    }));
    if (first.status !== "success") throw new Error("Search unexpectedly failed");
    expect((first.facts as { matches: unknown[] }).matches).toHaveLength(100);

    writeFileSync(join(root, "overflow.txt"), "needle-overflow\n", "utf8");
    await expect(search(root, { query: "needle" })).resolves.toEqual(expect.objectContaining({
      status: "success",
      facts: expect.objectContaining({ matches: expect.any(Array), truncated: true })
    }));
  });

  it("declares the bundled engine in both the workspace and independently packed Runtime", () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const runtimePackage = JSON.parse(readFileSync(join(process.cwd(), "packages", "runtime", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(rootPackage.dependencies?.["@vscode/ripgrep"]).toBe("1.18.0");
    expect(runtimePackage.dependencies?.["@vscode/ripgrep"]).toBe("1.18.0");
  });
});
