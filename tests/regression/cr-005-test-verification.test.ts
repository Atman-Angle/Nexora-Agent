import { describe, expect, it } from "vitest";

import { runCliForTest } from "../integration/cli-test-helper.js";

describe("CR-005 Test & Verification", () => {
  it("keeps the verification chain working", async () => {
    const result = await runCliForTest(["verify", process.execPath, "-e", "console.log('cr-005 ok')"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Verification command passed");
    expect(result.readDatabaseState().executionRecords).toHaveLength(1);
  });
});
