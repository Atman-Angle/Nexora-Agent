import { describe, expect, it } from "vitest";

import { runCliForTest } from "../integration/cli-test-helper.js";

describe("CR-002 Read File", () => {
  it("keeps the read file tool chain working", async () => {
    const result = await runCliForTest(["read", "regression.txt"], {
      workspaceFiles: [{ relativePath: "regression.txt", content: "read regression content" }]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("read regression content");
    expect(result.readDatabaseState().executionRecords).toHaveLength(1);
  });
});
