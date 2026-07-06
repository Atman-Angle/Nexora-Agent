import type { ToolCall } from "../../../contracts/src/index.js";

export function fingerprintToolCall(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.read") {
    return JSON.stringify({ toolName: toolCall.toolName, path: toolCall.input.path });
  }
  if (toolCall.toolName === "filesystem.search") {
    return JSON.stringify({ toolName: toolCall.toolName, query: toolCall.input.query, limit: toolCall.input.limit });
  }
  if (toolCall.toolName === "filesystem.patch") {
    return JSON.stringify({
      toolName: toolCall.toolName,
      path: toolCall.input.path,
      patch: toolCall.input.patch,
      encoding: toolCall.input.encoding
    });
  }
  if (toolCall.toolName === "filesystem.write") {
    return JSON.stringify({
      toolName: toolCall.toolName,
      path: toolCall.input.path,
      content: toolCall.input.content,
      encoding: toolCall.input.encoding,
      mode: toolCall.input.mode,
      expectedHash: toolCall.input.expectedHash ?? null
    });
  }
  if (toolCall.toolName === "shell.execute") {
    return JSON.stringify({
      toolName: toolCall.toolName,
      command: toolCall.input.command,
      args: toolCall.input.args,
      cwd: toolCall.input.cwd,
      environment: toolCall.input.environment,
      purpose: toolCall.input.purpose
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

  const tokens = [toolCall.input.command, ...toolCall.input.args].join(" ").toLowerCase();
  return ["rm -rf", "del /f", "format ", "diskpart", "shutdown", "reboot", "mkfs"].some((pattern) => tokens.includes(pattern));
}

export function describeResourceScope(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return `workspace:${toolCall.input.path}`;
  }

  if (toolCall.toolName === "shell.execute") {
    return `workspace:${toolCall.input.cwd}`;
  }

  return "workspace";
}
