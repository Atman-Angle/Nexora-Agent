import { createHash } from "node:crypto";

import { z } from "zod";

const IdentifierSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]*$/i);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RelativePathSchema = z.string().trim().min(1).refine(
  (value) => !value.includes("\\") && !value.startsWith("/") && !value.split("/").includes(".."),
  "Expected a normalized relative path."
);

export const EvalSplitSchema = z.enum(["dev", "validation", "holdout"]);
export const EvalHorizonSchema = z.enum(["atomic", "short", "multi_stage", "long"]);
export const ExpectedTerminalSchema = z.enum([
  "succeeded",
  "waiting_for_input",
  "waiting_for_approval",
  "blocked",
  "failed",
  "cancelled"
]);
export const FailureBoundarySchema = z.enum([
  "EVAL_INFRASTRUCTURE",
  "TASK_UNDERSTANDING",
  "PLAN_OR_INTENT",
  "CONTEXT_RECALL",
  "CAPABILITY_SELECTION",
  "ACTION_CONTRACT",
  "APPROVAL",
  "TOOL_EXECUTION",
  "INVOCATION_RECOVERY",
  "EVIDENCE",
  "COMPLETION",
  "PROVIDER_EXTERNAL",
  "EFFICIENCY",
  "MODEL_CAPABILITY",
  "TOOL_CONTRACT",
  "PLAN",
  "VALIDATION",
  "COMPLETION_CONTRACT",
  "CONVERGENCE",
  "PRODUCT_PATH"
]);

const BudgetsSchema = z.object({
  maxIterations: z.number().int().positive(),
  maxModelCalls: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  maxDurationMs: z.number().int().positive()
}).strict();

const FileCheckSchema = z.object({
  id: IdentifierSchema,
  path: RelativePathSchema,
  exists: z.boolean().default(true),
  equals: z.string().optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional()
}).strict();

const CommandCheckSchema = z.object({
  id: IdentifierSchema,
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: RelativePathSchema.default("."),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000),
  expectedExitCode: z.number().int().default(0)
}).strict();

const InvocationExpectationSchema = z.object({
  toolName: IdentifierSchema,
  status: z.enum(["prepared", "started", "succeeded", "failed", "unknown"]),
  count: z.number().int().nonnegative()
}).strict();

const AuthorityExpectationSchema = z.object({
  requiredEventTypes: z.array(z.string().trim().min(1)).default([]),
  forbiddenEventTypes: z.array(z.string().trim().min(1)).default([]),
  eventCounts: z.array(z.object({
    type: z.string().trim().min(1),
    count: z.number().int().nonnegative()
  }).strict()).default([]),
  invocations: z.array(InvocationExpectationSchema).default([]),
  evidenceCount: z.number().int().nonnegative().optional(),
  artifactInvocationCount: z.number().int().nonnegative().optional()
}).strict();

export const EvalTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdentifierSchema,
  category: IdentifierSchema,
  horizon: EvalHorizonSchema,
  split: EvalSplitSchema,
  source: z.enum(["synthetic_contract", "sanitized_real_failure", "real_workflow"]),
  instruction: z.string().trim().min(1),
  fixture: z.object({
    path: RelativePathSchema,
    digest: DigestSchema
  }).strict(),
  scenario: RelativePathSchema,
  allowedCapabilities: z.array(IdentifierSchema).min(1),
  budgets: BudgetsSchema,
  expectedTerminal: ExpectedTerminalSchema,
  driver: z.object({
    approvalPolicy: z.object({
      mode: z.enum(["unattended", "interactive"]),
      rules: z.array(z.object({
        toolName: IdentifierSchema,
        decision: z.enum(["approve", "deny"]),
        maxApprovals: z.number().int().positive().optional(),
        input: z.record(z.unknown()).optional(),
        reason: z.string().trim().min(1).optional()
      }).strict()).min(1),
      maxApprovals: z.number().int().positive().optional()
    }).strict().optional(),
    approvals: z.array(z.object({
      occurrence: z.number().int().positive(),
      decision: z.enum(["approve", "deny"]),
      reason: z.string().trim().min(1).optional(),
      restartBeforeDecision: z.boolean().default(false)
    }).strict()).default([]),
    inputs: z.array(z.object({
      occurrence: z.number().int().positive(),
      text: z.string().trim().min(1),
      restartBeforeDecision: z.boolean().default(false)
    }).strict()).default([]),
    recoveries: z.array(z.object({
      occurrence: z.number().int().positive(),
      outcome: z.enum(["confirmed_succeeded", "confirmed_failed", "abandon_run"]),
      subjectRef: z.string().trim().min(1).optional(),
      reason: z.string().trim().min(1).optional(),
      restartBeforeDecision: z.boolean().default(false)
    }).strict()).default([]),
    cancellations: z.array(z.object({
      occurrence: z.number().int().positive(),
      toolName: IdentifierSchema,
      triggerEvent: z.enum(["tool.started", "tool.attempt.succeeded"]).default("tool.started"),
      reason: z.string().trim().min(1),
      expectUnknown: z.boolean().default(false)
    }).strict()).default([])
  }).strict(),
  grader: z.object({
    files: z.array(FileCheckSchema).default([]),
    commands: z.array(CommandCheckSchema).default([]),
    unchangedPaths: z.array(RelativePathSchema).default([]),
    authority: AuthorityExpectationSchema.default({
      requiredEventTypes: [],
      forbiddenEventTypes: [],
      invocations: []
    })
  }).strict(),
  hardGates: z.array(z.enum([
    "task_grader_passed",
    "expected_terminal",
    "no_false_success",
    "no_unauthorized_effect",
    "no_duplicate_non_idempotent_effect",
    "evidence_integrity",
    "result_evidence_integrity",
    "scenario_authority"
  ])).min(1)
}).strict();

export const EvalDatasetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdentifierSchema,
  version: z.number().int().positive(),
  description: z.string().trim().min(1),
  tasks: z.array(RelativePathSchema).min(1)
}).strict();

export const CheckResultSchema = z.object({
  id: IdentifierSchema,
  passed: z.boolean(),
  message: z.string().trim().min(1),
  details: z.record(z.unknown()).optional()
}).strict();

export type EvalSplit = z.infer<typeof EvalSplitSchema>;
export type EvalTask = z.infer<typeof EvalTaskSchema>;
export type EvalDatasetManifest = z.infer<typeof EvalDatasetManifestSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type FailureBoundary = z.infer<typeof FailureBoundarySchema>;

export function stableDigest(value: unknown): string {
  return digestText(stableJson(value));
}

export function digestText(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
