import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E049 reusable @nexora/runtime package", () => {
  it("packs and runs from an external ESM consumer without legacy source paths", () => {
    const root = mkdtempSync(join(tmpdir(), "nexora-e049-consumer-"));
    roots.push(root);
    execFileSync("pnpm", ["--filter", "@nexora/runtime", "pack", "--pack-destination", root], { cwd: process.cwd(), stdio: "pipe", shell: process.platform === "win32" });
    const tarball = join(root, readdirSync(root).find((name) => name.endsWith(".tgz"))!);
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");
    execFileSync("npm", ["install", "--offline", tarball], { cwd: root, stdio: "pipe", shell: process.platform === "win32" });
    writeFileSync(join(root, "target.txt"), "external consumer\n", "utf8");
    writeFileSync(join(root, "consumer.mjs"), `
import { createBuiltInTools, createRuntime } from "@nexora/runtime";
let call = 0;
const workspace = ${JSON.stringify(root)};
const provider = {
  async decide(context) {
    call += 1;
    if (call === 1) return { type: "set_plan", basedOnVersion: null, taskContract: { version: 1, inputVersion: 1, goal: "Search target", workspace, constraints: [], acceptanceCriteria: ["search"] }, orderedSteps: [{ id: "search", objective: "Search", acceptanceChecks: [{ id: "check", kind: "tool_result", required: true, toolName: "filesystem.search", expectedStatus: "success" }] }] };
    if (call === 2) return { type: "call_tool", stepId: "search", checkIds: ["check"], toolName: "filesystem.search", input: { query: "external consumer", path: "." } };
    return { type: "propose_finish", summary: "Verified", evidenceIds: context.run.evidence.map((item) => item.id) };
  },
  async validate() { return { passed: true, issues: [] }; }
};
const runtime = createRuntime({ workspace, provider, tools: createBuiltInTools() });
const result = await runtime.start({ input: "Search for external consumer" });
const view = await runtime.inspect(result.runId);
runtime.close();
console.log(JSON.stringify({ status: result.status, invocations: view.toolInvocations.length }));
`, "utf8");
    const output = execFileSync(process.execPath, ["consumer.mjs"], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ status: "succeeded", invocations: 1 });

    const packageRoot = join(root, "node_modules", "@nexora", "runtime");
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(packageJson.dependencies).sort()).toEqual(["@vscode/ripgrep", "better-sqlite3", "zod"]);
    const packedFiles = allFiles(packageRoot);
    expect(packedFiles.some((path) => path.includes("docling") || path.includes("packages/core"))).toBe(false);
    for (const path of packedFiles.filter((item) => /\.(?:js|d\.ts)$/.test(item))) {
      expect(readFileSync(path, "utf8")).not.toMatch(/\.\.\/\.\.\/(?:core|contracts|storage|tool-runtime)\/src/);
    }
  }, 60_000);
});

function allFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path); else files.push(path);
    }
  }
  return files;
}
