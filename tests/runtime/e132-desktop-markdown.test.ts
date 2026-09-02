import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderMarkdown } from "../../apps/desktop/src/renderer/markdown.js";
import { shouldSendOnEnter } from "../../apps/desktop/src/renderer/keyboard.js";
import { createPublicOutputBatcher } from "../../apps/desktop/src/renderer/public-output-batcher.js";
import { compactLatest, isFormalResultContent } from "../../apps/desktop/src/renderer/public-output-view.js";

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
      "| File | Status |",
      "| --- | --- |",
      "| app.ts | changed |",
      "",
      "---",
      "",
      "```ts",
      "const ok = true;",
      "```",
      "",
      "<script>alert(1)</script>",
      "[safe](https://example.com) [unsafe](javascript:alert(1))"
    ].join("\n"));

    expect(html).toContain("<h1>Result</h1>");
    expect(html).toContain("<strong>passed</strong>");
    expect(html).toContain("<code>pnpm test</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain('<div class="markdown-table-wrap"><table>');
    expect(html).toContain("<th>File</th>");
    expect(html).toContain("<td>app.ts</td>");
    expect(html).toContain("<hr>");
    expect(html).toContain('<figure class="code-block">');
    expect(html).toContain('<span>ts</span><button type="button" class="copy-code"');
    expect(html).toContain('<code class="language-ts">const ok = true;</code>');
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
  it("projects provider-exposed reasoning as one expandable inline transcript row", () => {
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    const conversationSource = source.slice(source.indexOf("function conversation("), source.indexOf("function resultMeta("));
    expect(conversationSource).not.toContain("activity-line");
    expect(conversationSource).toContain('segment.channel === "reasoning"');
    expect(conversationSource).toContain("Reasoning detail");
    expect(conversationSource).toContain("深度思考");
    expect(conversationSource).toContain("data-public-output-toggle");
    expect(conversationSource).toContain("compactLatest(output.text, 220)");
    expect(conversationSource).not.toContain("validation.passed");
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
    expect(source).toContain("publicOutputBatcher.queue(key)");
    expect(source).toContain("preview.textContent = compactLatest(output.text, 220)");
    expect(source).toContain('cursor.textContent = output.completed ? "" : "▍"');
  });

  it("reserves Conversation output for the formal result", () => {
    expect(compactLatest("first second third fourth", 13)).toBe("…third fourth");
    expect(isFormalResultContent({ completed: false, text: "Done", resultSummary: "Done" })).toBe(false);
    expect(isFormalResultContent({ completed: true, text: "Working notes", resultSummary: "Done" })).toBe(false);
    expect(isFormalResultContent({ completed: true, text: "Done", resultSummary: "Done" })).toBe(true);
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    expect(source).toContain("if (!formalResult) continue");
  });

  it("keeps detailed Tool facts inline and removes the old Activity execution UI", () => {
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    expect(source).toContain("function executionTranscript(run:");
    expect(source).toContain("toolDetail(invocation, services)");
    expect(source).toContain("run.inspection.evidence");
    expect(source).not.toContain("function activity(session: SessionView)");
    expect(source).not.toContain('data-view="activity"');
    expect(source).not.toContain("activityTimeline");
  });

  it("shows the real model Context window and keeps transient automatic eviction out of Conversation", () => {
    const source = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    expect(source).toContain("上下文已使用 ${context.percent.toFixed(1)}%");
    expect(source).toContain("usage.inputTokens / usage.contextWindowTokens");
    expect(source).not.toContain("已自动压缩上下文");
    expect(source).not.toContain('record.type !== "context.compaction.requested"');
    expect(source).not.toContain("context-control-placeholder");
  });
});
