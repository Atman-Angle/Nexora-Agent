import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("D5 Nexora 1.2 acceptance", () => {
  it("records a requirement-to-evidence validation report", () => {
    const report = source("docs", "audit", "nexora-1.2-validation-report.md");

    expect(report).toContain("Requirement-to-Evidence");
    expect(report).toContain("Worker");
    expect(report).toContain("HTTP Host");
    expect(report).toContain("Feature Core");
    expect(report).toContain("External Acceptance");
  });

  it("keeps package exports and public types structurally closed", () => {
    const packageJson = JSON.parse(source(
      "packages",
      "runtime",
      "package.json"
    )) as {
      readonly exports: Record<string, unknown>;
      readonly files: readonly string[];
    };
    const root = source("packages", "runtime", "src", "index.ts");
    const types = source("packages", "runtime", "src", "runtime-types.ts");

    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./testing"]);
    expect(packageJson.files.some((path) => path.includes("examples"))).toBe(
      false
    );
    expect(root).not.toMatch(/from "\.\/run-store|from "\.\/state-machine/);
    expect(types).not.toContain("submitAction");
    expect(
      /export type CreateRuntimeOptions = \{[^}]*readonly store:/s.test(types)
    ).toBe(false);
  });

  it("retains one Runtime loop and no testing or example authority imports", () => {
    const runtime = source("packages", "runtime", "src", "runtime.ts");
    const testing = source(
      "packages",
      "runtime",
      "src",
      "testing",
      "index.ts"
    );
    const worker = source("examples", "runtime", "worker.ts");
    const host = source("examples", "runtime", "http-host.ts");

    expect(runtime.match(/async #runLoop\(/g)).toHaveLength(1);
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
});

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}
