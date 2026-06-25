import { describe, expect, it } from "vitest";

import { runCliForTest } from "../integration/cli-test-helper.js";

describe("CR-001 Direct Mode", () => {
  it("keeps the direct mode chain working", async () => {
    const result = await runCliForTest(["ask", "regression"], {
      fakeModelText: "regression answer"
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\"status\":\"succeeded\"");
    expect(result.readDatabaseState().artifacts[0]?.content).toBe("regression answer");
  });
});
