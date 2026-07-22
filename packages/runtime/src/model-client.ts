import { z } from "zod";

import type { RunSnapshot, RuntimeAction, ToolInvocation } from "./contracts.js";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ToolObservation = {
  readonly invocationId: string;
  readonly planVersion: number;
  readonly stepId: string;
  readonly toolName: string;
  readonly status: "succeeded" | "failed";
  readonly completedAt: string;
  readonly result: ToolInvocation["resultJson"];
  readonly error: ToolInvocation["errorJson"];
  readonly truncated: boolean;
  readonly digest: string;
};

export type ModelDecisionContext = {
  readonly workspace: string;
  readonly run: RunSnapshot;
  readonly allowedActions: readonly ("set_plan" | "call_tool" | "request_input" | "propose_finish")[];
  readonly actionContract: readonly RuntimeAction[];
  readonly toolObservations: readonly ToolObservation[];
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly risk: "read" | "write" | "execute";
    readonly idempotent: boolean;
    readonly inputExample?: unknown;
  }[];
};

export type SemanticValidationContext = {
  readonly inputs: readonly string[];
  readonly proposedSummary: string;
  readonly facts: readonly {
    readonly toolName: string;
    readonly subjectRef: string;
    readonly input: JsonValue;
    readonly output: JsonValue;
  }[];
};

export const SemanticValidationVerdictSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string().trim().min(1))
}).strict();
export type SemanticValidationVerdict = z.infer<typeof SemanticValidationVerdictSchema>;

export interface RuntimeProvider {
  decide(context: ModelDecisionContext): Promise<unknown>;
  validate(context: SemanticValidationContext): Promise<unknown>;
}
