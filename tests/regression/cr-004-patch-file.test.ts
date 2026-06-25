import { describe, expect, it } from "vitest";

import { computeArtifactHash } from "../../packages/contracts/src/index.js";
import { runCliForTest } from "../integration/cli-test-helper.js";

describe("CR-004 Patch File", () => {
  it("keeps the patch file chain working", async () => {
    const result = await runCliForTest(
      ["patch", "regression.txt", computeArtifactHash("alpha before"), "before", "after", "idem-cr-004"],
      {
        workspaceFiles: [{ relativePath: "regression.txt", content: "alpha before" }]
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Patched regression.txt with status applied");
    expect(result.readDatabaseState().executionRecords).toHaveLength(1);
  });
});
