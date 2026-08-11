import { z } from "zod";

import {
  JsonValueSchema,
  PlanTaskContractSchema
} from "../contracts.js";

const NonEmptyString = z.string().trim().min(1);

const CapabilityResultRequirementSchema = z.object({
  kind: z.literal("capability_result"),
  capability: NonEmptyString,
  // Planning never executes these values. Accept and erase the two common
  // Provider spellings so redundant business parameters do not become
  // protocol-repair tax; use_capabilities remains the only executable input.
  arguments: JsonValueSchema.optional(),
  args: JsonValueSchema.optional()
}).strict().transform(({ kind, capability }) => ({ kind, capability }));

const StateAssertionRequirementSchema = z.object({
  kind: z.literal("state_assertion"),
  capability: NonEmptyString,
  arguments: JsonValueSchema,
  assertion: z.discriminatedUnion("operator", [
    z.object({ operator: z.literal("exists"), expected: z.boolean() }).strict(),
    z.object({ operator: z.literal("equals"), expected: JsonValueSchema }).strict(),
    z.object({ operator: z.literal("schema"), schemaName: NonEmptyString }).strict()
  ])
}).strict();

const ArtifactSchemaRequirementSchema = z.object({
  kind: z.literal("artifact_schema"),
  schemaName: NonEmptyString
}).strict();

const UserConfirmationRequirementSchema = z.object({
  kind: z.literal("user_confirmation"),
  prompt: NonEmptyString
}).strict();

const SemanticReviewRequirementSchema = z.object({
  kind: z.literal("semantic_review"),
  criterion: NonEmptyString
}).strict();

const ContextRefRequirementSchema = z.object({
  kind: z.literal("context_ref"),
  ref: NonEmptyString
}).strict();

export const SemanticCompletionRequirementSchema = z.union([
  CapabilityResultRequirementSchema,
  StateAssertionRequirementSchema,
  ArtifactSchemaRequirementSchema,
  UserConfirmationRequirementSchema,
  SemanticReviewRequirementSchema,
  ContextRefRequirementSchema
]);
export type SemanticCompletionRequirement = z.infer<typeof SemanticCompletionRequirementSchema>;

export const SemanticTaskSchema = z.object({
  objective: NonEmptyString,
  completionRequirements: z.array(SemanticCompletionRequirementSchema).min(1)
}).strict();
export type SemanticTask = z.infer<typeof SemanticTaskSchema>;

const PlanTasksIntentSchema = z.object({
  kind: z.literal("plan_tasks"),
  taskContract: PlanTaskContractSchema.optional(),
  tasks: z.array(SemanticTaskSchema).min(1)
}).strict();

const RestoreContextIntentSchema = z.object({
  kind: z.literal("restore_context"),
  refs: z.array(NonEmptyString.max(4096)).min(1).max(8)
}).strict();

export const CapabilityCallSchema = z.object({
  capability: NonEmptyString,
  arguments: JsonValueSchema
}).strict();

const UseCapabilitiesIntentSchema = z.object({
  kind: z.literal("use_capabilities"),
  calls: z.array(CapabilityCallSchema).min(1).max(8)
}).strict();

const RequestInputIntentSchema = z.object({
  kind: z.literal("request_input"),
  question: NonEmptyString,
  reason: NonEmptyString
}).strict();

const FinishIntentSchema = z.object({
  kind: z.literal("finish"),
  summary: NonEmptyString
}).strict();

export const ProviderIntentSchema = z.discriminatedUnion("kind", [
  PlanTasksIntentSchema,
  RestoreContextIntentSchema,
  UseCapabilitiesIntentSchema,
  RequestInputIntentSchema,
  FinishIntentSchema
]);
export type ProviderIntent = z.infer<typeof ProviderIntentSchema>;
export type ProviderIntentKind = ProviderIntent["kind"];

export const ProviderDecisionSchema = z.object({
  reasoningSummary: NonEmptyString.max(2_000).optional(),
  intent: ProviderIntentSchema
}).strict();
export type ProviderDecision = z.infer<typeof ProviderDecisionSchema>;

export const ValidationIssueKindSchema = z.enum([
  "missing_fact",
  "missing_context_evidence",
  "missing_tool_evidence",
  "inaccurate_summary",
  "incomplete_summary",
  "forbidden_action",
  "plan_mismatch",
  "unresolved_failure"
]);
export type ValidationIssueKind = z.infer<typeof ValidationIssueKindSchema>;

export const SemanticValidationIssueSchema = z.object({
  kind: ValidationIssueKindSchema,
  message: NonEmptyString.max(2_000)
}).strict();
export type SemanticValidationIssue = z.infer<typeof SemanticValidationIssueSchema>;

export const SemanticValidationVerdictV2Schema = z.object({
  passed: z.boolean(),
  issues: z.array(SemanticValidationIssueSchema)
}).strict().superRefine((verdict, context) => {
  if (verdict.passed && verdict.issues.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issues"],
      message: "A passing validation verdict cannot contain issues."
    });
  }
  if (!verdict.passed && verdict.issues.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issues"],
      message: "A failing validation verdict requires at least one classified issue."
    });
  }
});

const IntentExamples: Record<ProviderIntentKind, ProviderDecision> = {
  plan_tasks: {
    intent: {
      kind: "plan_tasks",
      taskContract: {
        goal: "<goal>",
        constraints: [],
        acceptanceCriteria: ["<verifiable-criterion>"]
      },
      tasks: [{
        objective: "<task-objective>",
        completionRequirements: [{
          kind: "capability_result",
          capability: "<registered-capability-name>"
        }]
      }]
    }
  },
  restore_context: {
    intent: { kind: "restore_context", refs: ["<published-source-ref>"] }
  },
  use_capabilities: {
    intent: {
      kind: "use_capabilities",
      calls: [{ capability: "<registered-capability-name>", arguments: {} }]
    }
  },
  request_input: {
    intent: { kind: "request_input", question: "<question>", reason: "<blocking-reason>" }
  },
  finish: {
    intent: { kind: "finish", summary: "<verified-summary>" }
  }
};

export function providerIntentContract(
  allowedIntents: readonly ProviderIntentKind[],
  includeTaskContract: boolean
): readonly ProviderDecision[] {
  return allowedIntents.map((kind) => {
    const example = structuredClone(IntentExamples[kind]);
    if (
      kind === "plan_tasks"
      && example.intent.kind === "plan_tasks"
      && !includeTaskContract
    ) {
      delete example.intent.taskContract;
    }
    return ProviderDecisionSchema.parse(example);
  });
}
