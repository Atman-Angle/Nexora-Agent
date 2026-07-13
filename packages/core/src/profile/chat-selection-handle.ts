import type { AgentAction, SelectionHandle } from "../../../contracts/src/index.js";

/** Deterministic resolution for explicit ordinal references in the active session search list. */
export function resolveChatSelectionAction(input: {
  requestText: string;
  selectionHandles: readonly SelectionHandle[];
  toolCallId: string;
}): AgentAction | null {
  const position = extractOrdinalReference(input.requestText);
  if (position === null) return null;
  const handle = input.selectionHandles.find((candidate) => candidate.position === position);
  if (handle === undefined) {
    return {
      type: "ask_user",
      question: `I cannot resolve result ${position} because this chat session has no active search-result handle at that position. Provide a path or run a new search first.`,
      expectedInputType: "workspace-relative file path or search query",
      required: true
    };
  }
  return {
    type: "tool_call",
    toolCall: {
      toolCallId: input.toolCallId,
      toolName: "filesystem.read",
      input: { path: handle.path },
      timeoutMs: 5_000
    }
  };
}

function extractOrdinalReference(text: string): number | null {
  const english = /\b(?:the\s+)?(first|second|third|\d+)\s+(?:result|file)\b/i.exec(text);
  if (english !== null) {
    const value = english[1]?.toLowerCase();
    if (value === "first") return 1;
    if (value === "second") return 2;
    if (value === "third") return 3;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  const chinese = /第([一二三123])个(?:结果|文件)/.exec(text);
  if (chinese === null) return null;
  return ({ 一: 1, 二: 2, 三: 3, "1": 1, "2": 2, "3": 3 } as Record<string, number>)[chinese[1] ?? ""] ?? null;
}
