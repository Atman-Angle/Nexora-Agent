export const TOOL_OUTPUT_PREVIEW_LINES = 8;
export const TOOL_OUTPUT_PREVIEW_CHARS = 1_200;

export function toolOutputPreview(result: unknown, error: unknown): string | null {
  const value = error ?? result;
  if (value === null || value === undefined) return null;
  const text = usefulText(value);
  if (text.trim().length === 0) return null;
  const lines = text.split(/\r?\n/u);
  const lineBounded = lines.length > TOOL_OUTPUT_PREVIEW_LINES
    ? `${lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES).join("\n")}\n…`
    : text;
  return lineBounded.length > TOOL_OUTPUT_PREVIEW_CHARS
    ? `${lineBounded.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)}…`
    : lineBounded;
}

function usefulText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => usefulText(item)).join("\n");
  if (typeof value !== "object" || value === null) return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ["content", "preview", "stdout", "stderr", "message"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  const entries = record.entries;
  if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) return entries.join("\n");
  const matches = record.matches;
  if (Array.isArray(matches)) return matches.map((match) => formatMatch(match)).join("\n");
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function formatMatch(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return usefulText(value);
  const match = value as Record<string, unknown>;
  const path = typeof match.path === "string" ? match.path : "";
  const line = typeof match.line === "number" ? `:${match.line}` : typeof match.lineNumber === "number" ? `:${match.lineNumber}` : "";
  const text = typeof match.text === "string" ? match.text : JSON.stringify(value);
  return `${path}${line}${path || line ? " · " : ""}${text}`;
}
