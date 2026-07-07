import type { ToolDefinition } from "./tool-definition.js";
import { ToolRuntimeError } from "./errors.js";
import { registerCodingTools } from "./coding-tools/index.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown>>();

  public register<I>(tool: ToolDefinition<I>): void {
    this.tools.set(tool.name, tool as ToolDefinition<unknown>);
  }

  public get(toolName: string): ToolDefinition<unknown> {
    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      throw new ToolRuntimeError("RUNTIME_ERROR", `Tool ${toolName} is not registered.`, false);
    }
    return tool;
  }

  public tryGet(toolName: string): ToolDefinition<unknown> | undefined {
    return this.tools.get(toolName);
  }

  public has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  public listNames(): string[] {
    return [...this.tools.keys()];
  }

  public list(): ToolDefinition<unknown>[] {
    return [...this.tools.values()];
  }
}

export function createCodingToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerCodingTools(registry);
  return registry;
}

/**
 * @deprecated Use {@link createCodingToolRegistry} instead. Kept temporarily to
 * reduce churn across harnesses and tests during the F028 migration window.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  return createCodingToolRegistry();
}
