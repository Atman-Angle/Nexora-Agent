import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderMarkdown } from "../../apps/desktop/src/renderer/markdown.js";
import { shouldSendOnEnter } from "../../apps/desktop/src/renderer/keyboard.js";
import { createPublicOutputBatcher } from "../../apps/desktop/src/renderer/public-output-batcher.js";
import { compactLatest, isFormalResultContent } from "../../apps/desktop/src/renderer/public-output-view.js";
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
  it("keeps reasoning as a compact single row until the user expands it", () => {
    const css = readFileSync(resolve("apps/desktop/src/renderer/styles.css"), "utf8");
    expect(css).toContain(".think-summary");
    expect(css).toContain(".think-preview");
    expect(css).toContain("text-overflow: ellipsis");
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
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    expect(source).toContain("compactLatest(output.text, 180)");
  });

  it("shows the newest streaming text and reserves full content for the formal result", () => {
    expect(compactLatest("first second third fourth", 13)).toBe("…third fourth");
    expect(isFormalResultContent({ completed: false, text: "Done", resultSummary: "Done" })).toBe(false);
    expect(isFormalResultContent({ completed: true, text: "Working notes", resultSummary: "Done" })).toBe(false);
    expect(isFormalResultContent({ completed: true, text: "Done", resultSummary: "Done" })).toBe(true);
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    expect(source).toContain("reasoningAttempts.has(segment.baseKey)");
    expect(source).toContain("Working</span>");
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

  it("keeps Tool results collapsed by default and preserves the explicit detail disclosure", () => {
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    expect(source).not.toContain("toolOutputPreview(invocation.resultJson");
    expect(source).toContain("data-tool=\"${escapeAttr(invocation.id)}\"");
    expect(source).toContain("${expanded ? `<div class=\"activity-detail\">");
    expect(source).toContain("data-workspace-entry=\"${escapeAttr(presentation.workspacePath)}\"");
  });

  it("shows the real model Context window and keeps transient automatic eviction out of Conversation", () => {
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    expect(source).toContain("<span>Context ${formatTokens(context.used)} / ${formatTokens(context.window)}</span>");
    expect(source).toContain("usage.inputTokens / usage.contextWindowTokens");
    expect(source).not.toContain("已自动压缩上下文");
    expect(source).toContain('record.type !== "context.compaction.requested"');
  });
});
