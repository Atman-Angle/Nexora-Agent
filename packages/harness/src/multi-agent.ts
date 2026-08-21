import { z } from "zod";

const Identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** Canonical helper roles with real prompt/profile consumers in V1. */
export const SupervisorWorkerRoleSchema = z.enum([
  "researcher", "planner", "executor", "reviewer", "validator"
]);
export type SupervisorWorkerRole = z.infer<typeof SupervisorWorkerRoleSchema>;

const ChildBudgetsSchema = z.object({
  maxIterations: z.number().int().positive().optional(),
  maxModelCalls: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional()
}).strict();

/** Host policy mechanically enforced by both Harness projection and Runtime dispatch. */
export const DelegationPolicySchema = z.object({
  mode: z.enum(["forbidden", "allowed", "required"]),
  maxConcurrentWorkers: z.number().int().min(2).max(8).default(8),
  allowedProfiles: z.array(Identifier).min(1).max(64).optional(),
  workerToolPolicies: z.record(z.array(Identifier).max(64)).optional(),
  childBudgets: ChildBudgetsSchema.optional()
}).strict().superRefine((policy, context) => {
  const allowed = new Set(policy.allowedProfiles ?? []);
  const toolProfiles = Object.keys(policy.workerToolPolicies ?? {});
  if (policy.allowedProfiles === undefined && toolProfiles.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedProfiles"], message: "allowedProfiles is required when workerToolPolicies declares profiles." });
  }
  for (const profile of policy.allowedProfiles ?? []) {
    if (!(profile in (policy.workerToolPolicies ?? {}))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workerToolPolicies", profile], message: "Every allowed Worker profile must have an explicit Tool allowlist." });
    }
  }
  for (const profile of toolProfiles) {
    if (!allowed.has(profile)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workerToolPolicies", profile], message: "A Worker Tool policy cannot widen allowedProfiles." });
    }
  }
});
export type DelegationPolicy = z.infer<typeof DelegationPolicySchema>;

export const DEFAULT_DELEGATION_POLICY: DelegationPolicy = Object.freeze({
  mode: "allowed",
  maxConcurrentWorkers: 8
});

export const SUPERVISOR_WORKER_PROMPT_RULES = `
## Supervisor / Worker protocol
You are a bounded Worker created by a Parent Supervisor. Work only on the assigned objective.
Use only the supplied context references and allowed Tools. Never delegate another Worker,
write Parent state, invent Evidence, or declare Parent success. Focus on findings that can
change the final answer, explain why they matter, and call out uncertainty or conflicts.
Return concise natural-language findings with source or Artifact references. Hidden chain-of-
thought is not requested or persisted.
`;

const ROLE_PROMPT_INSTRUCTIONS: Record<SupervisorWorkerRole, string> = {
  researcher: "Search and inspect the assigned scope. Do not modify files or external state.",
  planner: "Decompose the objective into dependencies, risks and verifiable acceptance outcomes. Do not execute Tools.",
  executor: "Work only in the isolated branch workspace. Produce a bounded result and run the assigned checks.",
  reviewer: "Independently inspect the task, outputs and evidence. Do not trust an Executor claim without evidence.",
  validator: "Run the assigned domain checks and report exact pass, fail or blocked evidence."
};

export function renderWorkerAssignmentPrompt(input: {
  readonly role: SupervisorWorkerRole;
  readonly objective: string;
  readonly finalDeliverable?: string;
  readonly contribution?: string;
  readonly contextRefs?: readonly string[];
  readonly allowedToolNames?: readonly string[];
  readonly verification?: readonly string[];
}): string {
  return [
    SUPERVISOR_WORKER_PROMPT_RULES.trim(),
    `## Role: ${input.role}`,
    ROLE_PROMPT_INSTRUCTIONS[input.role],
    ...(input.finalDeliverable === undefined ? [] : [`## Final deliverable supported\n${input.finalDeliverable.trim()}`]),
    ...(input.contribution === undefined ? [] : [`## Specific contribution\n${input.contribution.trim()}`]),
    `## Assigned objective\n${input.objective.trim()}`,
    ...(input.contextRefs === undefined ? [] : [`## Context references\n${input.contextRefs.join(", ") || "none"}`]),
    ...(input.allowedToolNames === undefined ? [] : [`## Allowed Tools\n${input.allowedToolNames.join(", ") || "none"}`]),
    ...(input.verification === undefined ? [] : [`## Verification\n${input.verification.join(", ") || "evidence_required"}`]),
    "## Required output\nReturn concise findings, why the important findings matter, evidence/artifact references and unresolved issues."
  ].join("\n\n");
}
