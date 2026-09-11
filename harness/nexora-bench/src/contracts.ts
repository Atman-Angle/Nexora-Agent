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

const VisibleBudgetSummarySchema = z.object({
  maxIterations: z.number().int().positive().optional(),
  maxModelCalls: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional()
}).strict();

const BudgetsSchema = z.object({
  maxIterations: z.number().int().positive(),
  maxModelCalls: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  maxDurationMs: z.number().int().positive()
}).strict();

const EvalTaskV2BudgetsSchema = BudgetsSchema.extend({
  maxInputTokens: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional()
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

export const HumanReviewRecordSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: IdentifierSchema,
  reviewStatus: z.literal("PENDING_HUMAN_REVIEW"),
  reviewer: z.string().trim().min(1).nullable(),
  reviewedAt: z.string().trim().min(1).nullable(),
  decision: z.enum(["approved", "rejected"]).nullable(),
  qualificationEvidence: RelativePathSchema,
  reviewNotes: z.array(z.string()).default([])
}).strict();

export const EvalTaskV1Schema = z.object({
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

/**
 * Eval Suite v2 keeps execution metadata separate from agent-visible input.
 * The current runner can execute this shape through the same v1-compatible
 * normalized task; grader material is deliberately never projected to the
 * Provider context.
 */
export const EvalTaskV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  datasetVersion: z.string().trim().min(1),
  family: IdentifierSchema,
  secondaryCoverage: z.array(z.enum([
    "long_horizon", "recovery", "context_pressure", "rehydration", "approval",
    "side_effect", "memory", "artifact", "validation", "cancellation", "restart"
  ])).default([]),
  difficulty: z.enum(["basic", "standard", "advanced"]),
  horizon: EvalHorizonSchema,
  split: EvalSplitSchema,
  source: z.enum(["synthetic_contract", "sanitized_real_failure", "real_workflow"]),
  agentVisible: z.object({
    instruction: z.string().trim().min(1),
    workspaceMount: RelativePathSchema.optional(),
    allowedCapabilities: z.array(IdentifierSchema).min(1),
    toolCatalogPolicy: z.enum(["declared", "full_runtime", "unsupported"]).optional(),
    budgetSummary: VisibleBudgetSummarySchema.optional(),
    environmentFacts: z.array(z.string()).default([])
  }).strict(),
  execution: z.object({
    fixtureRef: z.object({ path: RelativePathSchema, digest: DigestSchema }).strict().optional(),
    scenarioRef: RelativePathSchema.optional(),
    environmentSetupRef: RelativePathSchema.optional(),
    approvalPolicyRef: RelativePathSchema.optional(),
    fixture: z.object({ path: RelativePathSchema, digest: DigestSchema }).strict().optional(),
    scenario: RelativePathSchema.optional(),
    budgets: EvalTaskV2BudgetsSchema,
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    seedPolicy: z.enum(["fixed", "derived", "random", "none"]).optional(),
    seed: z.number().int().nonnegative().optional(),
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
        occurrence: z.number().int().positive(), decision: z.enum(["approve", "deny"]),
        reason: z.string().trim().min(1).optional(), restartBeforeDecision: z.boolean().default(false)
      }).strict()).default([]),
      inputs: z.array(z.object({
        occurrence: z.number().int().positive(), text: z.string().trim().min(1),
        restartBeforeDecision: z.boolean().default(false)
      }).strict()).default([]),
      recoveries: z.array(z.object({
        occurrence: z.number().int().positive(),
        outcome: z.enum(["confirmed_succeeded", "confirmed_failed", "abandon_run"]),
        subjectRef: z.string().trim().min(1).optional(), reason: z.string().trim().min(1).optional(),
        restartBeforeDecision: z.boolean().default(false)
      }).strict()).default([]),
      cancellations: z.array(z.object({
        occurrence: z.number().int().positive(), toolName: IdentifierSchema,
        triggerEvent: z.enum(["tool.started", "tool.attempt.succeeded"]).default("tool.started"),
        reason: z.string().trim().min(1), expectUnknown: z.boolean().default(false)
      }).strict()).default([])
    }).strict()
  }).strict(),
  constraints: z.object({
    forbiddenTools: z.array(IdentifierSchema).default([]),
    forbiddenPaths: z.array(RelativePathSchema).default([]),
    forbiddenOperations: z.array(z.string().trim().min(1)).optional(),
    networkPolicy: z.enum(["denied", "declared", "unrestricted", "unsupported"]).optional(),
    processPolicy: z.enum(["declared", "unsupported"]).default("declared"),
    cleanupRef: RelativePathSchema.optional()
  }).strict().default({ forbiddenTools: [], forbiddenPaths: [], processPolicy: "declared" }),
  expectedOutcome: z.object({
    acceptedTerminals: z.array(ExpectedTerminalSchema).min(1),
    acceptedStopReasons: z.array(z.string().trim().min(1)).default([]),
    completionRequired: z.boolean().optional(),
    confirmationRequired: z.boolean().default(false),
    approvalState: z.enum(["not_required", "approved", "denied", "pending"]).optional()
  }).strict(),
  sealed: z.object({
    /** This path is resolved by the runner only; it is never included in the agent prompt or workspace. */
    graderRef: RelativePathSchema,
    graderDigest: DigestSchema,
    referenceStateDigest: DigestSchema.optional(),
    authorityRequirementsRef: RelativePathSchema.optional(),
    safetyRequirementsRef: RelativePathSchema.optional(),
    expectedArtifactsRef: RelativePathSchema.optional(),
    referenceRef: RelativePathSchema.optional(),
    referenceDigest: DigestSchema.optional(),
    resetRef: RelativePathSchema.optional()
  }).strict(),
  humanReviewRef: RelativePathSchema,
  identity: z.object({
    taskDigest: DigestSchema,
    fixtureDigest: DigestSchema,
    toolCatalogDigest: DigestSchema.optional()
  }).strict()
}).strict().superRefine((task, ctx) => {
  if (task.execution.fixtureRef === undefined && task.execution.fixture === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["execution", "fixtureRef"], message: "fixtureRef is required." });
  }
  if (task.execution.scenarioRef === undefined && task.execution.scenario === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["execution", "scenarioRef"], message: "scenarioRef is required." });
  }
});

export const EvalTaskSchema = EvalTaskV1Schema;

const SemverSchema = z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export const EvalDatasetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdentifierSchema,
  version: z.number().int().positive(),
  description: z.string().trim().min(1),
  tasks: z.array(RelativePathSchema).min(1),
  /** Present only for a formal, release-gated Suite package. */
  release: z.boolean().optional(),
  /** Digest of the ordered manifest and public task contracts; sealed contents are excluded. */
  datasetDigest: DigestSchema.optional(),
  suiteVersion: SemverSchema.optional(),
  fixturesDigest: DigestSchema.optional(),
  gradersDigest: DigestSchema.optional(),
  runnerSchemaVersion: z.number().int().positive().optional(),
  reportSchemaVersion: z.number().int().positive().optional(),
  faultCatalogVersion: SemverSchema.optional(),
  reliabilitySelectionVersion: SemverSchema.optional()
}).strict().superRefine((manifest, ctx) => {
  if (manifest.release !== true) return;
  const required: Array<keyof typeof manifest> = [
    "datasetDigest", "suiteVersion", "fixturesDigest", "gradersDigest", "runnerSchemaVersion",
    "reportSchemaVersion", "faultCatalogVersion", "reliabilitySelectionVersion"
  ];
  for (const field of required) {
    if (manifest[field] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for a formal release.` });
    }
  }
});

export const CheckResultSchema = z.object({
  id: IdentifierSchema,
  passed: z.boolean(),
  message: z.string().trim().min(1),
  details: z.record(z.unknown()).optional()
}).strict();

export type EvalSplit = z.infer<typeof EvalSplitSchema>;
export type EvalTask = z.infer<typeof EvalTaskV1Schema>;
export type EvalTaskV2 = z.infer<typeof EvalTaskV2Schema>;
export type HumanReviewRecord = z.infer<typeof HumanReviewRecordSchema>;
export type EvalTaskSource = EvalTask | EvalTaskV2;
export type EvalDatasetManifest = z.infer<typeof EvalDatasetManifestSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type FailureBoundary = z.infer<typeof FailureBoundarySchema>;

export type NormalizedEvalTask = EvalTask & {
  readonly sourceSchemaVersion: 1 | 2;
  readonly suite: {
    readonly family: string;
    readonly secondaryCoverage: readonly string[];
    readonly difficulty: "basic" | "standard" | "advanced";
    readonly expectedOutcome: {
      readonly acceptedTerminals: readonly z.infer<typeof ExpectedTerminalSchema>[];
      readonly acceptedStopReasons: readonly string[];
      readonly confirmationRequired: boolean;
    };
    readonly taskDigest: string;
    readonly graderDigest: string;
    readonly toolCatalogDigest: string;
    readonly forbiddenTools: readonly string[];
  };
};

export function normalizeEvalTask(task: EvalTaskSource, sealedGrader?: EvalTask["grader"]): NormalizedEvalTask {
  if (task.schemaVersion === 1) {
    const graderDigest = stableDigest(task.grader);
    return Object.freeze(Object.defineProperties({ ...task }, {
      sourceSchemaVersion: { value: 1, enumerable: false },
      suite: { value: Object.freeze({
        family: task.category,
        secondaryCoverage: Object.freeze([]),
        difficulty: task.horizon === "atomic" ? "basic" : task.horizon === "long" ? "advanced" : "standard",
        expectedOutcome: Object.freeze({
          acceptedTerminals: Object.freeze([task.expectedTerminal]),
          acceptedStopReasons: Object.freeze([]),
          confirmationRequired: task.expectedTerminal === "blocked" && task.driver.recoveries.length > 0
        }),
        taskDigest: stableDigest(task),
        graderDigest,
        toolCatalogDigest: stableDigest(task.allowedCapabilities),
        forbiddenTools: Object.freeze([])
      }), enumerable: false }
    })) as NormalizedEvalTask;
  }
  if (sealedGrader === undefined) {
    throw new Error(`V2 task ${task.id} requires runner-resolved sealed grader material.`);
  }
  const grader = sealedGrader;
  const fixture = task.execution.fixtureRef ?? task.execution.fixture!;
  const scenario = task.execution.scenarioRef ?? task.execution.scenario!;
  const legacy: EvalTask = {
    schemaVersion: 1,
    id: task.id,
    category: task.family,
    horizon: task.horizon,
    split: task.split,
    source: task.source,
    instruction: task.agentVisible.instruction,
    fixture,
    scenario,
    allowedCapabilities: task.agentVisible.allowedCapabilities,
    budgets: task.execution.budgets,
    expectedTerminal: task.expectedOutcome.acceptedTerminals[0]!,
    driver: task.execution.driver,
    grader,
    hardGates: ["task_grader_passed", "expected_terminal", "no_false_success", "no_unauthorized_effect", "no_duplicate_non_idempotent_effect", "evidence_integrity", "result_evidence_integrity", "scenario_authority"]
  };
  if (task.identity.fixtureDigest !== fixture.digest) {
    throw new Error(`V2 task ${task.id} fixture identity does not match execution fixture digest.`);
  }
  const computedGraderDigest = stableDigest(grader);
  if (computedGraderDigest !== task.sealed.graderDigest) {
    throw new Error(`V2 task ${task.id} grader identity mismatch.`);
  }
  const computedTaskDigest = evalTaskV2IdentityDigest(task);
  if (computedTaskDigest !== task.identity.taskDigest) {
    throw new Error(`V2 task ${task.id} task identity mismatch.`);
  }
  return Object.freeze(Object.defineProperties(legacy, {
    sourceSchemaVersion: { value: 2, enumerable: false },
    suite: { value: Object.freeze({
      family: task.family,
      secondaryCoverage: Object.freeze([...task.secondaryCoverage]),
      difficulty: task.difficulty,
      expectedOutcome: task.expectedOutcome,
      taskDigest: task.identity.taskDigest,
      graderDigest: task.sealed.graderDigest,
      toolCatalogDigest: task.identity.toolCatalogDigest ?? stableDigest(task.agentVisible.allowedCapabilities),
      forbiddenTools: Object.freeze([...task.constraints.forbiddenTools])
    }), enumerable: false }
  })) as NormalizedEvalTask;
}

/** The task digest is a content identity; it intentionally excludes itself. */
export function evalTaskV2IdentityDigest(task: EvalTaskV2): string {
  const { taskDigest: _taskDigest, ...identity } = task.identity;
  return stableDigest({ ...task, identity });
}

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
