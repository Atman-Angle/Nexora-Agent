import { z } from "zod";

import type { Evidence, RunSnapshot } from "./contracts.js";

export type ModelDecisionContext = {
  readonly run: RunSnapshot;
  readonly allowedActions: readonly ("set_plan" | "call_tool" | "request_input" | "propose_finish")[];
  readonly tools: readonly {
    readonly name: string;
    readonly risk: "read" | "write" | "execute";
    readonly idempotent: boolean;
  }[];
};

export type SemanticValidationContext = {
  readonly originalInput: string;
  readonly currentInput: readonly string[];
  readonly taskContract: NonNullable<RunSnapshot["taskContract"]>;
  readonly plan: NonNullable<RunSnapshot["currentPlan"]>;
  readonly proposedSummary: string;
  readonly evidence: readonly Evidence[];
};

export const SemanticValidationVerdictSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string().trim().min(1)),
  evidenceIds: z.array(z.string().trim().min(1))
}).strict();
export type SemanticValidationVerdict = z.infer<typeof SemanticValidationVerdictSchema>;

export interface RuntimeProvider {
  decide(context: ModelDecisionContext): Promise<unknown>;
  validate(context: SemanticValidationContext): Promise<unknown>;
}
