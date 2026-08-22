import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveExternalUrl, resolveKnownWorkspaceEntry } from "../../apps/desktop/src/workspace-entry.js";

describe("E133 Desktop workspace deliverable links", () => {
  it("resolves a relative deliverable only inside a Host-known Project", () => {
    const workspace = resolve("D:/workspace/project");
    expect(resolveKnownWorkspaceEntry([{ path: workspace }], workspace, "site/index.html"))
      .toBe(resolve(workspace, "site/index.html"));
  });

  it("rejects unknown Projects, absolute paths and traversal", () => {
    const workspace = resolve("D:/workspace/project");
    expect(() => resolveKnownWorkspaceEntry([{ path: workspace }], "D:/other", "result.pdf"))
      .toThrow("Project is not managed by Nexora Desktop");
    expect(() => resolveKnownWorkspaceEntry([{ path: workspace }], workspace, resolve("D:/outside.txt")))
      .toThrow("workspace-relative");
    expect(() => resolveKnownWorkspaceEntry([{ path: workspace }], workspace, "../outside.txt"))
      .toThrow("outside the Project workspace");
  });

  it("allows only browser-safe external link protocols", () => {
    expect(resolveExternalUrl("https://example.com/result")).toBe("https://example.com/result");
    expect(resolveExternalUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(() => resolveExternalUrl("file:///D:/secret.txt")).toThrow("Unsupported external link protocol");
    expect(() => resolveExternalUrl("javascript:alert(1)")).toThrow("Unsupported external link protocol");
  });
});
