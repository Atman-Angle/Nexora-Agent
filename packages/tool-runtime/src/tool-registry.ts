import type { ToolCall } from "../../contracts/src/index.js";
import { ToolCallSchema } from "../../contracts/src/index.js";
import { ToolRuntimeError } from "./errors.js";
import { executeFilesystemPatch } from "./filesystem-patch.js";
import { executeFilesystemRead } from "./filesystem-read.js";
import { executeFilesystemSearch } from "./filesystem-search.js";
import { executeShellCommand } from "./shell-execute.js";

export type ToolExecutionContext = {
  runId: string;
  executionId: string;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
};

export type ToolExecutionResult =
  | Awaited<ReturnType<typeof executeFilesystemRead>>
  | Awaited<ReturnType<typeof executeFilesystemSearch>>
  | Awaited<ReturnType<typeof executeFilesystemPatch>>
  | Awaited<ReturnType<typeof executeShellCommand>>;

export type ToolDefinition = {
  name: "filesystem.read" | "filesystem.search" | "filesystem.patch" | "shell.execute";
  execute(context: ToolExecutionContext, toolCall: ToolCall): Promise<ToolExecutionResult>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  public get(toolName: string): ToolDefinition {
    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      throw new ToolRuntimeError("RUNTIME_ERROR", `Tool ${toolName} is not registered.`, false);
    }

    return tool;
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "filesystem.read",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "filesystem.read") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected filesystem.read tool call.", false);
      }
      return executeFilesystemRead(
        {
          ...context,
          toolCall: parsedToolCall
        }
      );
    }
  });
  registry.register({
    name: "filesystem.search",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "filesystem.search") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected filesystem.search tool call.", false);
      }

      return executeFilesystemSearch({
        ...context,
        toolCall: parsedToolCall
      });
    }
  });
  registry.register({
    name: "filesystem.patch",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "filesystem.patch") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected filesystem.patch tool call.", false);
      }

      return executeFilesystemPatch({
        ...context,
        toolCall: parsedToolCall
      });
    }
  });
  registry.register({
    name: "shell.execute",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "shell.execute") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected shell.execute tool call.", false);
      }

      return executeShellCommand({
        ...context,
        toolCall: parsedToolCall
      });
    }
  });
  return registry;
}
