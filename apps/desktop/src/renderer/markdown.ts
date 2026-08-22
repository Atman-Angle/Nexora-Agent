export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { language: string; lines: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    output.push(`<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list === null) return;
    const tag = list.ordered ? "ol" : "ul";
    output.push(`<${tag}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  const flushCode = (): void => {
    if (code === null) return;
    const language = code.language.replace(/[^A-Za-z0-9_-]/g, "");
    output.push(`<pre><code${language ? ` class="language-${language}"` : ""}>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
    code = null;
  };

  for (const line of lines) {
    const fence = /^```\s*([^\s`]*)\s*$/.exec(line);
    if (fence !== null) {
      if (code === null) {
        flushParagraph();
        flushList();
        code = { language: fence[1] ?? "", lines: [] };
      } else flushCode();
      continue;
    }
    if (code !== null) {
      code.lines.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      output.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      const isOrdered = ordered !== null;
      if (list !== null && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((ordered ?? unordered)![1]!);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flushParagraph();
      flushList();
      output.push(`<blockquote>${inlineMarkdown(quote[1]!)}</blockquote>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushCode();
  flushParagraph();
  flushList();
  return output.join("");
}

function inlineMarkdown(source: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const index = tokens.push(html) - 1;
    return `NEXORAMDTOKEN${index}END`;
  };
  let prepared = source.replace(/`([^`\n]+)`/g, (_match, value: string) => token(`<code>${escapeHtml(value)}</code>`));
  prepared = prepared.replace(/\[([^\]\n]+)]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    if (!/^(https?:|mailto:)/i.test(href)) return match;
    return token(`<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
  });
  let html = escapeHtml(prepared)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  html = html.replace(/NEXORAMDTOKEN(\d+)END/g, (_match, index: string) => tokens[Number(index)] ?? "");
  return html;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
