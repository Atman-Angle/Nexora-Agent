import type { ToolCall, ToolResult } from "../../../contracts/src/index.js";

export function describeToolSuccess(toolResult: Extract<ToolResult, { status: "success" }>): string {
  if (toolResult.toolName === "filesystem.read") {
    return `Read ${toolResult.output.path}.`;
  }
  if (toolResult.toolName === "filesystem.search") {
    return `Search returned ${String(toolResult.output.result.returnedMatches)} matches.`;
  }
  if (toolResult.toolName === "filesystem.patch") {
    return `Patched ${toolResult.output.result.path}.`;
  }
  if (toolResult.toolName === "filesystem.write") {
    return `Wrote ${toolResult.output.result.path}.`;
  }
  if (toolResult.toolName === "shell.execute") {
    return `Executed ${toolResult.output.result.executionRecordId}.`;
  }
  if (toolResult.toolName === "filesystem.list") {
    if (toolResult.output.kind === "list_inline") {
      return `Listed ${String(toolResult.output.entries.length)} entries.`;
    }
    return `Listed ${String(toolResult.output.entryCount)} entries (artifact).`;
  }
  if (toolResult.toolName === "git.status") {
    return `Git status: dirty ${String(toolResult.output.result.isDirty)}.`;
  }
  if (toolResult.toolName === "git.diff") {
    return `Git diff: ${String(toolResult.output.changedFiles.length)} files.`;
  }
  if (toolResult.toolName === "git.show") {
    return `Git show ${toolResult.output.revision}.`;
  }
  if (toolResult.toolName === "project.commands") {
    return `Discovered ${String(toolResult.output.commands.length)} commands.`;
  }
  return `Inspected repository ${toolResult.output.profile.root}.`;
}

export function describeCapabilities(toolCall: ToolCall): string[] {
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return ["filesystem.write"];
  }
  if (toolCall.toolName === "shell.execute") {
    return ["process.execute"];
  }

  return ["filesystem.read"];
}

export function describeApprovalSummary(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch") {
    return `Patch ${toolCall.input.path}`;
  }

  if (toolCall.toolName === "filesystem.write") {
    return `Write ${toolCall.input.path} (${toolCall.input.mode})`;
  }

  if (toolCall.toolName === "shell.execute") {
    return `Execute ${toolCall.input.command}`;
  }

  return toolCall.toolName;
}

export function describeApprovalReason(toolCall: ToolCall): string {
  if (toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write") {
    return "Write access requires approval before mutating workspace files.";
  }

  return "Command execution requires approval before running a process.";
}
