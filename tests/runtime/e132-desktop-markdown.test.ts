import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderMarkdown } from "../../apps/desktop/src/renderer/markdown.js";
import { shouldSendOnEnter } from "../../apps/desktop/src/renderer/keyboard.js";
import { createPublicOutputBatcher, publicOutputPreview, PUBLIC_OUTPUT_PREVIEW_CHARS } from "../../apps/desktop/src/renderer/public-output-batcher.js";
import { workspaceOutputs } from "../../apps/desktop/src/renderer/workspace-outputs.js";

describe("E132 Desktop Markdown", () => {
  it("renders useful Markdown while escaping model-provided HTML and unsafe links", () => {
    const html = renderMarkdown([
      "# Result",
      "",
      "**passed** with `pnpm test`",
      "",
      "- one",
      "- two",
      "",
      "<script>alert(1)</script>",
      "[safe](https://example.com) [unsafe](javascript:alert(1))"
    ].join("\n"));

    expect(html).toContain("<h1>Result</h1>");
    expect(html).toContain("<strong>passed</strong>");
    expect(html).toContain("<code>pnpm test</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="javascript:');
  });
});

describe("E132 Desktop keyboard submission", () => {
  it("sends plain Enter but preserves Shift+Enter, IME composition and busy state", () => {
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: false }, false)).toBe(true);
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: true, isComposing: false }, false)).toBe(false);
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(false);
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: false }, true)).toBe(false);
  });
});

describe("E132 Desktop compact process output and deliverables", () => {
  it("keeps streaming process text to two lines until the user expands it", () => {
    const css = readFileSync(resolve("apps/desktop/src/renderer/styles.css"), "utf8");
    expect(css).toContain(".public-output-body");
    expect(css).toContain("max-height: 2.9em");
    expect(css).toContain(".public-output.expanded .public-output-body");
  });

  it("coalesces token floods and keeps collapsed process DOM bounded", () => {
    const scheduled: Array<() => void> = [];
    const flushes: string[][] = [];
    const batcher = createPublicOutputBatcher(
      (flush) => scheduled.push(flush),
      (keys) => flushes.push([...keys])
    );
    for (let index = 0; index < 5_000; index += 1) batcher.queue("run:call:attempt");
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(flushes).toEqual([["run:call:attempt"]]);
    const preview = publicOutputPreview("reasoning ".repeat(10_000));
    expect(preview.length).toBe(PUBLIC_OUTPUT_PREVIEW_CHARS + 1);
    expect(preview.startsWith("…")).toBe(true);
  });

  it("projects only successful workspace writes and patches as deduplicated deliverables", () => {
    expect(workspaceOutputs([
      { toolName: "filesystem.write", status: "succeeded", resultJson: { path: "site/index.html" } },
      { toolName: "filesystem.patch", status: "succeeded", resultJson: { path: "site/index.html" } },
      { toolName: "filesystem.write", status: "succeeded", resultJson: { path: "reports/result.docx" } },
      { toolName: "filesystem.write", status: "failed", resultJson: { path: "failed.txt" } },
      { toolName: "shell.exec", status: "succeeded", resultJson: { path: "ignored.txt" } }
    ])).toEqual([
      { path: "site/index.html", name: "index.html", kind: "website" },
      { path: "reports/result.docx", name: "result.docx", kind: "document" }
    ]);
  });
});
