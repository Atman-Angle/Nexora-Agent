import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "apps", "cli", "src", "index.ts"), "utf8");

describe("E063 interactive CLI continuation", () => {
  it("uses TTY capability rather than goal absence to continue a natural-language command", () => {
    expect(source).toContain("interactive: Boolean(stdin.isTTY)");
    expect(source).not.toContain("interactive: !goal");
  });

  it("shows the exact persisted protected Action before asking for Approval", () => {
    expect(source).toContain("JSON.stringify(request.action)");
  });
});

