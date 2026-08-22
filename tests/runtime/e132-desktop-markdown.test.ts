import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../../apps/desktop/src/renderer/markdown.js";
import { shouldSendOnEnter } from "../../apps/desktop/src/renderer/keyboard.js";

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
