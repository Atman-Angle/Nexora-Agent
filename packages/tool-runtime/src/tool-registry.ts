import type { ToolCall } from "../../contracts/src/index.js";
import { ToolCallSchema } from "../../contracts/src/index.js";
import { ToolRuntimeError } from "./errors.js";
import { executeFilesystemPatch } from "./filesystem-patch.js";
import { executeFilesystemRead } from "./filesystem-read.js";
import { executeFilesystemSearch } from "./filesystem-search.js";
import { executeFilesystemList } from "./filesystem-list.js";
import { executeGitStatus } from "./git-status.js";
import { executeGitDiff } from "./git-diff.js";
import { executeGitShow } from "./git-show.js";
import { executeProjectCommands } from "./project-commands.js";
import { executeProjectInspect } from "./project-inspect.js";
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
  | Awaited<ReturnType<typeof executeFilesystemList>>
  | Awaited<ReturnType<typeof executeGitStatus>>
  | Awaited<ReturnType<typeof executeGitDiff>>
  | Awaited<ReturnType<typeof executeGitShow>>
  | Awaited<ReturnType<typeof executeProjectCommands>>
  | Awaited<ReturnType<typeof executeProjectInspect>>
  | Awaited<ReturnType<typeof executeShellCommand>>;

export type ToolDefinition = {
  name: ToolCall["toolName"];
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
  registry.register({
    name: "filesystem.list",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "filesystem.list") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected filesystem.list tool call.", false);
      }
      return executeFilesystemList({ ...context, toolCall: parsedToolCall });
    }
  });
  registry.register({
    name: "git.status",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "git.status") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected git.status tool call.", false);
      }
      return executeGitStatus({ ...context, toolCall: parsedToolCall });
    }
  });
  registry.register({
    name: "git.diff",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "git.diff") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected git.diff tool call.", false);
      }
      return executeGitDiff({ ...context, toolCall: parsedToolCall });
    }
  });
  registry.register({
    name: "git.show",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "git.show") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected git.show tool call.", false);
      }
      return executeGitShow({ ...context, toolCall: parsedToolCall });
    }
  });
  registry.register({
    name: "project.commands",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "project.commands") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected project.commands tool call.", false);
      }
      return executeProjectCommands({ ...context, toolCall: parsedToolCall });
    }
  });
  registry.register({
    name: "project.inspect",
    async execute(context, toolCall) {
      const parsedToolCall = ToolCallSchema.parse(toolCall);
      if (parsedToolCall.toolName !== "project.inspect") {
        throw new ToolRuntimeError("INVALID_TOOL_INPUT", "Expected project.inspect tool call.", false);
      }
      return executeProjectInspect({ ...context, toolCall: parsedToolCall });
    }
  });
  return registry;
}
