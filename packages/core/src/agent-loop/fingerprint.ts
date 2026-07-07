import type { ToolCall } from "../../../contracts/src/index.js";

export function fingerprintToolCall(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.read") {
    const input = toolCall.input as { path: string };
    return JSON.stringify({ toolName: toolCall.toolName, path: input.path });
  }
  if (toolCall.toolName === "filesystem.search") {
    const input = toolCall.input as { query: string; limit: number };
    return JSON.stringify({ toolName: toolCall.toolName, query: input.query, limit: input.limit });
  }
  if (toolCall.toolName === "filesystem.patch") {
    const input = toolCall.input as { path: string; patch: unknown; encoding: string };
    return JSON.stringify({
      toolName: toolCall.toolName,
      path: input.path,
      patch: input.patch,
      encoding: input.encoding
    });
  }
  if (toolCall.toolName === "filesystem.write") {
    const input = toolCall.input as { path: string; content: string; encoding: string; mode: string; expectedHash?: string };
    return JSON.stringify({
      toolName: toolCall.toolName,
      path: input.path,
      content: input.content,
      encoding: input.encoding,
      mode: input.mode,
      expectedHash: input.expectedHash ?? null
    });
  }
  if (toolCall.toolName === "shell.execute") {
    const input = toolCall.input as { command: string; args: string[]; cwd: string; environment: Record<string, string>; purpose: string };
    return JSON.stringify({
      toolName: toolCall.toolName,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      environment: input.environment,
      purpose: input.purpose
    });
  }
  return JSON.stringify({ toolName: toolCall.toolName, input: toolCall.input });
}

export function fingerprintAction(toolCall: ToolCall): string {
  return fingerprintToolCall(toolCall);
}

export function isCriticalAction(toolCall: ToolCall): boolean {
  if (toolCall.toolName !== "shell.execute") {
    return false;
  }

  const input = toolCall.input as { command: string; args: string[] };
  const tokens = [input.command, ...input.args].join(" ").toLowerCase();
  return ["rm -rf", "del /f", "format ", "diskpart", "shutdown", "reboot", "mkfs"].some((pattern) => tokens.includes(pattern));
}

export function describeResourceScope(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    const input = toolCall.input as { path: string };
    return `workspace:${input.path}`;
  }

  if (toolCall.toolName === "shell.execute") {
    const input = toolCall.input as { cwd: string };
    return `workspace:${input.cwd}`;
  }

  return "workspace";
}
