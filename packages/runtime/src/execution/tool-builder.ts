import { z } from "zod";

import { JsonValueSchema } from "../contracts.js";
import type { RuntimeTool } from "../runtime-types.js";

export type ToolBuilderContext = {
  readonly workspace: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
};

export type ToolBuilderDefinition<
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny
> = {
  readonly name: string;
  readonly description: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly effect: "read" | "write" | "execute";
  readonly idempotent: boolean;
  readonly readCache?: { readonly mode: "until_mutation" };
  readonly inputSchema: InputSchema;
  readonly inputExample: z.input<InputSchema>;
  readonly outputSchema: OutputSchema;
  readonly produces: readonly string[];
  execute(
    input: z.output<InputSchema>,
    context: ToolBuilderContext
  ): Promise<{
    readonly subjectRef: string;
    readonly output: z.input<OutputSchema>;
  }>;
  dispose?(): void | Promise<void>;
};

export function defineTool<
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny
>(
  definition: ToolBuilderDefinition<InputSchema, OutputSchema>
): RuntimeTool {
  const tool: RuntimeTool = {
    contract: {
      identity: { name: definition.name },
      capability: {
        purpose: definition.description,
        nonGoals: definition.avoidWhen
      },
      decision: {
        useWhen: definition.useWhen,
        avoidWhen: definition.avoidWhen
      },
      execution: {
        effect: {
          kind: definition.effect,
          description: definition.description
        },
        idempotent: definition.idempotent,
        ...(definition.readCache === undefined ? {} : { readCache: definition.readCache }),
        inputSchema: definition.inputSchema,
        inputExample: definition.inputExample
      },
      evidence: {
        produces: definition.produces,
        factsSchema: definition.outputSchema
      }
    },
    async execute(input, context) {
      const parsedInput = definition.inputSchema.parse(input);
      const returned = await definition.execute(
        parsedInput,
        Object.freeze({
          workspace: context.workspace,
          idempotencyKey: context.invocationId,
          signal: context.signal
        })
      );
      const subjectRef = z.string().trim().min(1).parse(returned.subjectRef);
      const output = definition.outputSchema.parse(returned.output);
      return {
        status: "success",
        subjectRef,
        facts: JsonValueSchema.parse(output)
      };
    },
    ...(definition.dispose === undefined
      ? {}
      : {
          async dispose(): Promise<void> {
            await definition.dispose!();
          }
        })
  };
  return tool;
}
