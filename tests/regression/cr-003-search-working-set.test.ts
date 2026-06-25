import { describe, expect, it } from "vitest";

import { runCliForTest } from "../integration/cli-test-helper.js";

describe("CR-003 Search & Working Set", () => {
  it("keeps the search and working set chain working", async () => {
    const result = await runCliForTest(["search", "needle"], {
      workspaceFiles: [{ relativePath: "src/needle.ts", content: "needle result" }]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src/needle.ts");
    expect(result.readDatabaseState().executionRecords).toHaveLength(1);
  });
});
