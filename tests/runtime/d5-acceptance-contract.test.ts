import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("D5 Nexora 1.2 acceptance", () => {
  it("keeps the public documentation boundary explicit", () => {
    const docs = source("docs", "README.md");
    const guide = source("docs", "BUILD_WITH_NEXORA_RUNTIME.md");

    expect(docs).toContain("public documentation");
    expect(docs).toContain("BUILD_WITH_NEXORA_RUNTIME.md");
    expect(guide).toContain("@nexora/harness");
    expect(guide).toContain("createAgent");
    expect(docs).not.toMatch(/audit|reports|specs|agent-evaluation/);
  });

  it("keeps package exports and public types structurally closed", () => {
    const runtimePackage = JSON.parse(source(
      "packages",
      "runtime",
      "package.json"
    )) as {
      readonly exports: Record<string, unknown>;
      readonly files: readonly string[];
    };
    const harnessPackage = JSON.parse(source(
      "packages",
      "harness",
      "package.json"
    )) as {
      readonly exports: Record<string, unknown>;
      readonly dependencies: Record<string, string>;
    };
    const runtimeRoot = source("packages", "runtime", "src", "index.ts");
    const harnessRoot = source("packages", "harness", "src", "index.ts");
    const types = source("packages", "runtime", "src", "runtime-types.ts");

    expect(Object.keys(runtimePackage.exports).sort()).toEqual([".", "./internal"]);
    expect(Object.keys(harnessPackage.exports).sort()).toEqual([".", "./testing"]);
    expect(harnessPackage.dependencies["@nexora/runtime"]).toBe("workspace:*");
    expect(runtimePackage.files.some((path) => path.includes("examples"))).toBe(
      false
    );
    expect(runtimePackage.files).not.toContain("dist/context");
    expect(runtimePackage.files).not.toContain("dist/memory");
    expect(runtimePackage.files).not.toContain("dist/providers");
    expect(runtimeRoot).not.toMatch(/createAgent|createRuntime|RuntimeProvider/);
    expect(harnessRoot).toContain("createAgent");
    expect(types).not.toContain("submitAction");
    expect(
      /export type CreateRuntimeOptions = \{[^}]*readonly store:/s.test(types)
    ).toBe(false);
  });

  it("retains one Harness-owned Agent Loop and no example authority imports", () => {
    const runtime = source("packages", "runtime", "src", "runtime.ts");
    const testing = source(
      "packages",
      "harness",
      "src",
      "testing",
      "index.ts"
    );
    const harnessSources = typescriptSources(join(
      process.cwd(),
      "packages",
      "harness",
      "src"
    ));
    const worker = source("examples", "runtime", "worker.ts");
    const host = source("examples", "runtime", "http-host.ts");

    expect(runtime).not.toMatch(/runAgentLoop|#runLoop/);
    expect(runtime).toContain("this.#driver.run(");
    expect(harnessSources.flatMap((item) => (
      item.match(/export async function runAgentLoop\(/g) ?? []
    ))).toHaveLength(1);
    expect(testing).not.toMatch(/run-store|state-machine|CompletionGate/);
    for (const caller of [worker, host]) {
      expect(caller).not.toMatch(
        /apps[\\/]cli|packages[\\/]runtime[\\/]src|@nexora\/runtime\/dist/
      );
      expect(caller).not.toMatch(
        /run-store|state-machine|RuntimeAction|better-sqlite3/
      );
    }
    expect(host).not.toContain("new Map");
  });

  it("enforces one-way Harness to Runtime dependencies", () => {
    const runtimeSources = typescriptSources(join(
      process.cwd(),
      "packages",
      "runtime",
      "src"
    ));
    const harnessSources = typescriptSources(join(
      process.cwd(),
      "packages",
      "harness",
      "src"
    ));
    const runtimeImports = runtimeSources.flatMap(importSpecifiers);
    const harnessImports = harnessSources.flatMap(importSpecifiers);
    const agent = source("packages", "harness", "src", "agent.ts");

    for (const specifier of runtimeImports) {
      expect(specifier).not.toMatch(/^@nexora\/harness(?:\/|$)/);
      expect(specifier).not.toMatch(
        /(?:^|\/)(?:providers?|memory|context)(?:\/|\.|$)/i
      );
    }
    expect(runtimeSources.join("\n")).not.toMatch(
      /\b(?:RuntimeProvider|ModelDecisionContext|requestModel)\b|provider\.(?:decide|validate|compact)\s*\(/
    );
    expect(harnessImports).toContain("@nexora/runtime/internal");
    expect(harnessImports.some((item) => (
      item.includes("packages/runtime/src")
    ))).toBe(false);
    expect(agent).toMatch(
      /export function createRuntime\([^]*?return createAgent\(options\);\s*}/
    );
  });
});

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}

function typescriptSources(root: string): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.endsWith(".ts")) result.push(readFileSync(path, "utf8"));
    }
  }
  return result;
}

function importSpecifiers(content: string): string[] {
  return [...content.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
    .map((match) => match[1]!);
}
