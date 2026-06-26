import { z } from "zod";

export const BugTaskSchema = z.object({
  objective: z.string().min(1),
  reportedSymptoms: z.array(z.string().min(1)).min(1),
  expectedBehavior: z.string().min(1).optional(),
  reproductionHints: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  forbiddenChanges: z.array(z.string().min(1)).default([])
});

export type BugTask = z.infer<typeof BugTaskSchema>;

export const FixtureCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
  expectedExitCode: z.number().int().default(0),
  purpose: z.string().min(1).default("verification"),
  timeoutMs: z.number().int().positive().max(120_000).default(30_000)
});

export type FixtureCommand = z.infer<typeof FixtureCommandSchema>;

export const FixtureScoringRulesSchema = z.object({
  weights: z.object({
    functionalCorrectness: z.number().min(0).max(1),
    regressionSafety: z.number().min(0).max(1),
    scopePrecision: z.number().min(0).max(1),
    rootCauseQuality: z.number().min(0).max(1),
    evidenceQuality: z.number().min(0).max(1),
    runtimeReliability: z.number().min(0).max(1)
  }),
  passThreshold: z.number().min(0).max(1).default(0.6)
});

export type FixtureScoringRules = z.infer<typeof FixtureScoringRulesSchema>;

const RELATIVE_PATH_REGEX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const relativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.includes("..") && RELATIVE_PATH_REGEX.test(value), {
    message: "Path must be a relative workspace path without .. or absolute segments."
  });

export const BugFixtureManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.string().min(1),
    difficulty: z.enum(["basic", "intermediate", "advanced"]),
    projectType: z.string().min(1),
    languages: z.array(z.string().min(1)).min(1),
    frameworks: z.array(z.string().min(1)).default([]),
    issue: BugTaskSchema,
    setupCommand: FixtureCommandSchema.optional(),
    reproductionCommands: z.array(FixtureCommandSchema).min(1),
    acceptanceCommands: z.array(FixtureCommandSchema).min(1),
    regressionCommands: z.array(FixtureCommandSchema).default([]),
    allowedPaths: z.array(relativePath).default([]),
    forbiddenPaths: z.array(relativePath).default([]),
    expectedChangedFiles: z.array(relativePath).default([]),
    forbiddenChangedFiles: z.array(relativePath).default([]),
    requiredEvidence: z.array(z.string().min(1)).min(1),
    scoring: FixtureScoringRulesSchema,
    timeoutMs: z.number().int().positive().max(600_000),
    staticProvable: z.boolean().default(false)
  })
  .superRefine((manifest, context) => {
    const overlap = manifest.forbiddenPaths.filter((path) => manifest.allowedPaths.includes(path));
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `allowedPaths and forbiddenPaths overlap: ${overlap.join(", ")}`
      });
    }
    const changedOverlap = manifest.forbiddenChangedFiles.filter((path) => manifest.expectedChangedFiles.includes(path));
    if (changedOverlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expectedChangedFiles and forbiddenChangedFiles overlap: ${changedOverlap.join(", ")}`
      });
    }
    for (const command of [...manifest.reproductionCommands, ...manifest.acceptanceCommands, ...manifest.regressionCommands]) {
      if (looksLikeNetworkCommand(command.command, command.args)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Fixture commands must not require real network access: ${command.command}`
        });
      }
    }
  });

export type BugFixtureManifest = z.infer<typeof BugFixtureManifestSchema>;

export const RootCauseHypothesisSchema = z.object({
  description: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  affectedFiles: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.string().min(1)).default([]),
  falsificationCheck: z.string().min(1).optional()
});

export type RootCauseHypothesis = z.infer<typeof RootCauseHypothesisSchema>;

export const BugFixStepSchema = z.object({
  goal: z.string().min(1),
  plannedFiles: z.array(z.string().min(1)).default([]),
  precondition: z.string().min(1).optional(),
  completionCriteria: z.string().min(1),
  verification: z.string().min(1)
});

export const ValidationStepSchema = z.object({
  kind: z.enum(["targeted", "regression", "typecheck", "lint", "build", "contract"]),
  command: z.string().min(1).optional(),
  scope: z.string().min(1)
});

export const BugFixPlanSchema = z.object({
  objective: z.string().min(1),
  rootCause: z.string().min(1),
  intendedBehavior: z.string().min(1),
  affectedAreas: z.array(z.string().min(1)).default([]),
  plannedFiles: z.array(z.string().min(1)).default([]),
  steps: z.array(BugFixStepSchema).default([]),
  validationPlan: z.array(ValidationStepSchema).default([]),
  regressionRisks: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string().min(1)).default([])
});

export type BugFixPlan = z.infer<typeof BugFixPlanSchema>;
export type BugFixStep = z.infer<typeof BugFixStepSchema>;
export type ValidationStep = z.infer<typeof ValidationStepSchema>;

export const ReproductionResultSchema = z.object({
  reproduced: z.boolean(),
  command: z.string().min(1),
  workingDirectory: z.string().min(1),
  exitCode: z.number().int().nullable(),
  failureSummary: z.string().optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1)
});

export type ReproductionResult = z.infer<typeof ReproductionResultSchema>;

export const FixtureScoreSchema = z.object({
  functionalCorrectness: z.number().min(0).max(1),
  regressionSafety: z.number().min(0).max(1),
  scopePrecision: z.number().min(0).max(1),
  rootCauseQuality: z.number().min(0).max(1),
  evidenceQuality: z.number().min(0).max(1),
  runtimeReliability: z.number().min(0).max(1),
  total: z.number().min(0).max(1)
});

export type FixtureScore = z.infer<typeof FixtureScoreSchema>;

export const BugFixtureResultSchema = z.object({
  fixtureId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["passed", "failed", "blocked", "invalid_fixture"]),
  reproduced: z.boolean(),
  rootCauseIdentified: z.boolean(),
  acceptancePassed: z.boolean(),
  regressionPassed: z.boolean(),
  changedFiles: z.array(z.string().min(1)).default([]),
  unexpectedChangedFiles: z.array(z.string().min(1)).default([]),
  attempts: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  patchCount: z.number().int().nonnegative(),
  scores: FixtureScoreSchema,
  evidenceRefs: z.array(z.string().min(1)).default([]),
  failureReasons: z.array(z.string().min(1)).default([]),
  durationMs: z.number().int().nonnegative()
});

export type BugFixtureResult = z.infer<typeof BugFixtureResultSchema>;

export const BugFixtureSuiteReportSchema = z.object({
  suiteVersion: z.string().min(1),
  totalFixtures: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  averageScore: z.number().min(0).max(1),
  averageAttempts: z.number().min(0),
  averageDurationMs: z.number().min(0),
  failuresByCategory: z.record(z.string(), z.number().int().nonnegative()),
  results: z.array(BugFixtureResultSchema),
  generatedAt: z.string().datetime()
});

export type BugFixtureSuiteReport = z.infer<typeof BugFixtureSuiteReportSchema>;

export const FIXTURE_MANIFEST_SCHEMA_VERSION = "1" as const;

export const FIXTURE_ERROR_CODES = [
  "FIXTURE_NOT_FOUND",
  "FIXTURE_INVALID",
  "FIXTURE_SETUP_FAILED",
  "REPRODUCTION_FAILED",
  "BUG_NOT_REPRODUCED",
  "ROOT_CAUSE_UNRESOLVED",
  "REPAIR_PLAN_INVALID",
  "PATCH_SCOPE_VIOLATION",
  "FORBIDDEN_FILE_CHANGED",
  "USER_CHANGE_CONFLICT",
  "TARGET_VERIFICATION_FAILED",
  "REGRESSION_FAILED",
  "DIFF_REVIEW_FAILED",
  "FIXTURE_TIMEOUT",
  "REPAIR_BUDGET_EXHAUSTED",
  "EVIDENCE_INCOMPLETE",
  "FIXTURE_CLEANUP_FAILED"
] as const;

export type FixtureErrorCode = (typeof FIXTURE_ERROR_CODES)[number];

export class FixtureError extends Error {
  public readonly code: FixtureErrorCode;
  public readonly retryable: boolean;

  public constructor(code: FixtureErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "FixtureError";
    this.code = code;
    this.retryable = retryable;
  }
}

const NETWORK_COMMAND_PREFIXES = ["curl", "wget", "scp", "rsync", "ftp", "ssh", "http"];
const NETWORK_ARG_PATTERNS = [/^https?:\/\//i, /^ftp:\/\//i];

function looksLikeNetworkCommand(command: string, args: string[]): boolean {
  if (NETWORK_COMMAND_PREFIXES.some((prefix) => command.toLowerCase() === prefix || command.toLowerCase().startsWith(`${prefix} `))) {
    return true;
  }
  return args.some((arg) => NETWORK_ARG_PATTERNS.some((pattern) => pattern.test(arg)));
}

export function parseFixtureManifest(input: unknown): BugFixtureManifest {
  return BugFixtureManifestSchema.parse(input);
}
