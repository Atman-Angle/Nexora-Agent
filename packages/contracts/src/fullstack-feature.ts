import { z } from "zod";

import { SourceReferenceSchema } from "./repository-profile.js";

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  layer: z.enum(["requirement", "architecture", "contract", "data", "service", "api", "client", "e2e", "regression"]),
  verificationCommand: z.string().min(1).optional()
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const FeatureUserFlowSchema = z.object({
  name: z.string().min(1),
  actor: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1)
});

export type FeatureUserFlow = z.infer<typeof FeatureUserFlowSchema>;

export const FeatureRequirementSchema = z.object({
  objective: z.string().min(1),
  userValue: z.string().min(1),
  actors: z.array(z.string().min(1)).default([]),
  userFlows: z.array(FeatureUserFlowSchema).default([]),
  functionalRequirements: z.array(z.string().min(1)).min(1),
  nonFunctionalRequirements: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string().min(1)).default([]),
  compatibilityRequirements: z.array(z.string().min(1)).default([]),
  securityRequirements: z.array(z.string().min(1)).default([])
});

export type FeatureRequirement = z.infer<typeof FeatureRequirementSchema>;

export const ArchitecturePatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([])
});

export const IntegrationPointSchema = z.object({
  name: z.string().min(1),
  layer: z.string().min(1),
  path: z.string().min(1),
  description: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([])
});

export const FeatureArchitectureMapSchema = z.object({
  entryPoints: z.array(SourceReferenceSchema).default([]),
  clientLayer: z.array(SourceReferenceSchema).default([]),
  apiLayer: z.array(SourceReferenceSchema).default([]),
  serviceLayer: z.array(SourceReferenceSchema).default([]),
  domainLayer: z.array(SourceReferenceSchema).default([]),
  storageLayer: z.array(SourceReferenceSchema).default([]),
  migrationLayer: z.array(SourceReferenceSchema).default([]),
  runtimeLayer: z.array(SourceReferenceSchema).default([]),
  testLayer: z.array(SourceReferenceSchema).default([]),
  existingPatterns: z.array(ArchitecturePatternSchema).default([]),
  integrationPoints: z.array(IntegrationPointSchema).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([])
});

export type FeatureArchitectureMap = z.infer<typeof FeatureArchitectureMapSchema>;

export const FeatureContractFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.boolean().default(false),
  defaultValue: z.string().optional(),
  description: z.string().min(1).optional()
});

export const PlannedContractSchema = z.object({
  name: z.string().min(1),
  authoritySource: z.string().min(1),
  owningLayer: z.string().min(1),
  entity: z.string().min(1).optional(),
  fields: z.array(FeatureContractFieldSchema).default([]),
  requestShape: z.string().min(1).optional(),
  responseShape: z.string().min(1).optional(),
  errors: z.array(z.string().min(1)).default([]),
  statuses: z.array(z.string().min(1)).default([]),
  compatibilityStrategy: z.string().min(1).default("additive")
});

export type PlannedContract = z.infer<typeof PlannedContractSchema>;

export const DataChangeKindSchema = z.enum(["additive", "compatible", "destructive", "data-transforming"]);

export const DataChangePlanSchema = z.object({
  schema: z.string().min(1),
  changes: z.array(
    z.object({
      kind: DataChangeKindSchema,
      description: z.string().min(1),
      reversible: z.boolean().default(true),
      requiresApproval: z.boolean().default(false)
    })
  ).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  indexes: z.array(z.string().min(1)).default([]),
  defaults: z.array(z.string().min(1)).default([]),
  nullability: z.array(z.string().min(1)).default([])
});

export type DataChangePlan = z.infer<typeof DataChangePlanSchema>;

export const RuntimeReusePlanSchema = z.object({
  reusesTask: z.boolean().default(false),
  reusesRun: z.boolean().default(false),
  reusesStateMachine: z.boolean().default(false),
  reusesModelGateway: z.boolean().default(false),
  reusesToolRegistry: z.boolean().default(false),
  reusesApproval: z.boolean().default(false),
  reusesArtifact: z.boolean().default(false),
  reusesEvidence: z.boolean().default(false),
  reusesCheckpoint: z.boolean().default(false),
  reusesRecovery: z.boolean().default(false),
  reusesCompletionGate: z.boolean().default(false),
  notes: z.array(z.string().min(1)).default([])
});

export type RuntimeReusePlan = z.infer<typeof RuntimeReusePlanSchema>;

export const FeatureStageStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "waiting_for_approval",
  "waiting_for_user",
  "blocked",
  "verified",
  "completed"
]);

export type FeatureStageStatus = z.infer<typeof FeatureStageStatusSchema>;

export const FeatureStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  layers: z.array(z.string().min(1)).default([]),
  plannedFiles: z.array(z.string().min(1)).default([]),
  precondition: z.string().min(1).optional(),
  completionCriteria: z.string().min(1),
  verification: z.string().min(1),
  status: FeatureStageStatusSchema.default("not_started"),
  evidenceRefs: z.array(z.string().min(1)).default([])
});

export type FeatureStage = z.infer<typeof FeatureStageSchema>;

export const PlannedFileChangeSchema = z.object({
  path: z.string().min(1),
  layer: z.string().min(1),
  changeKind: z.enum(["create", "modify", "delete"]).default("create"),
  rationale: z.string().min(1).optional()
});

export const FeatureValidationStepSchema = z.object({
  kind: z.enum(["contract", "data", "service", "api", "client", "e2e", "regression"]),
  command: z.string().min(1).optional(),
  scope: z.string().min(1)
});

export const FeatureRiskSchema = z.object({
  description: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  mitigation: z.string().min(1).optional()
});

export const FullStackFeaturePlanSchema = z.object({
  objective: z.string().min(1),
  architectureSummary: z.string().min(1),
  contracts: z.array(PlannedContractSchema).default([]),
  stages: z.array(FeatureStageSchema).default([]),
  plannedFiles: z.array(PlannedFileChangeSchema).default([]),
  dataPlan: DataChangePlanSchema.optional(),
  runtimeReusePlan: RuntimeReusePlanSchema.optional(),
  validationPlan: z.array(FeatureValidationStepSchema).default([]),
  risks: z.array(FeatureRiskSchema).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string().min(1)).default([])
});

export type FullStackFeaturePlan = z.infer<typeof FullStackFeaturePlanSchema>;

export const FeatureFixtureCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
  expectedExitCode: z.number().int().default(0),
  purpose: z.string().min(1).default("verification"),
  timeoutMs: z.number().int().positive().max(120_000).default(30_000)
});

export type FeatureFixtureCommand = z.infer<typeof FeatureFixtureCommandSchema>;

export const FeatureFixtureScoringSchema = z.object({
  weights: z.object({
    functionalCompleteness: z.number().min(0).max(1),
    contractConsistency: z.number().min(0).max(1),
    architectureFit: z.number().min(0).max(1),
    dataSafety: z.number().min(0).max(1),
    verificationQuality: z.number().min(0).max(1),
    scopePrecision: z.number().min(0).max(1),
    runtimeReuse: z.number().min(0).max(1),
    runtimeReliability: z.number().min(0).max(1)
  }),
  passThreshold: z.number().min(0).max(1).default(0.6)
});

export type FeatureFixtureScoring = z.infer<typeof FeatureFixtureScoringSchema>;

const RELATIVE_PATH_REGEX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const relativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.includes("..") && RELATIVE_PATH_REGEX.test(value), {
    message: "Path must be a relative workspace path without .. or absolute segments."
  });

export const FullStackFeatureFixtureManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.string().min(1),
    difficulty: z.enum(["basic", "intermediate", "advanced"]),
    projectType: z.string().min(1),
    stack: z.array(z.string().min(1)).min(1),
    requirement: FeatureRequirementSchema,
    setupCommands: z.array(FeatureFixtureCommandSchema).default([]),
    baselineCommands: z.array(FeatureFixtureCommandSchema).default([]),
    acceptanceCommands: z.array(FeatureFixtureCommandSchema).default([]),
    e2eCommands: z.array(FeatureFixtureCommandSchema).default([]),
    regressionCommands: z.array(FeatureFixtureCommandSchema).default([]),
    allowedPaths: z.array(relativePath).default([]),
    forbiddenPaths: z.array(relativePath).default([]),
    expectedLayers: z.array(z.string().min(1)).min(1),
    requiredEvidence: z.array(z.string().min(1)).min(1),
    requiresRuntimeReuse: z.boolean().default(false),
    scoring: FeatureFixtureScoringSchema,
    timeoutMs: z.number().int().positive().max(600_000),
    networkAllowed: z.boolean().default(false)
  })
  .superRefine((manifest, context) => {
    const overlap = manifest.forbiddenPaths.filter((path) => manifest.allowedPaths.includes(path));
    if (overlap.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `allowedPaths and forbiddenPaths overlap: ${overlap.join(", ")}` });
    }
    if (!manifest.networkAllowed) {
      for (const command of [...manifest.setupCommands, ...manifest.baselineCommands, ...manifest.acceptanceCommands, ...manifest.e2eCommands, ...manifest.regressionCommands]) {
        if (looksLikeNetworkCommand(command.command, command.args)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Fixture commands must not require real network access: ${command.command}` });
        }
      }
    }
  });

export type FullStackFeatureFixtureManifest = z.infer<typeof FullStackFeatureFixtureManifestSchema>;

export const AcceptanceCriterionResultSchema = z.object({
  criterionId: z.string().min(1),
  passed: z.boolean(),
  evidenceRefs: z.array(z.string().min(1)).default([])
});

export type AcceptanceCriterionResult = z.infer<typeof AcceptanceCriterionResultSchema>;

export const FeatureScoresSchema = z.object({
  functionalCompleteness: z.number().min(0).max(1),
  contractConsistency: z.number().min(0).max(1),
  architectureFit: z.number().min(0).max(1),
  dataSafety: z.number().min(0).max(1),
  verificationQuality: z.number().min(0).max(1),
  scopePrecision: z.number().min(0).max(1),
  runtimeReuse: z.number().min(0).max(1),
  runtimeReliability: z.number().min(0).max(1),
  total: z.number().min(0).max(1)
});

export type FeatureScores = z.infer<typeof FeatureScoresSchema>;

export const FullStackFeatureFixtureResultSchema = z.object({
  fixtureId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["passed", "failed", "blocked", "invalid_fixture"]),
  acceptanceCriteria: z.array(AcceptanceCriterionResultSchema).default([]),
  contractPassed: z.boolean(),
  dataPassed: z.boolean(),
  backendPassed: z.boolean(),
  clientPassed: z.boolean(),
  e2ePassed: z.boolean(),
  regressionPassed: z.boolean(),
  runtimeReused: z.boolean(),
  completedStages: z.array(z.string().min(1)).default([]),
  incompleteStages: z.array(z.string().min(1)).default([]),
  changedFiles: z.array(z.string().min(1)).default([]),
  unexpectedChangedFiles: z.array(z.string().min(1)).default([]),
  attempts: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  patchCount: z.number().int().nonnegative(),
  scores: FeatureScoresSchema,
  evidenceRefs: z.array(z.string().min(1)).default([]),
  failureReasons: z.array(z.string().min(1)).default([]),
  failureLayer: z.string().min(1).optional(),
  durationMs: z.number().int().nonnegative()
});

export type FullStackFeatureFixtureResult = z.infer<typeof FullStackFeatureFixtureResultSchema>;

export const FeatureFixtureSuiteReportSchema = z.object({
  suiteVersion: z.string().min(1),
  totalFixtures: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  averageScore: z.number().min(0).max(1),
  averageAttempts: z.number().min(0),
  averageDurationMs: z.number().min(0),
  failuresByLayer: z.record(z.string(), z.number().int().nonnegative()),
  failuresByCategory: z.record(z.string(), z.number().int().nonnegative()),
  runtimeReuseRate: z.number().min(0).max(1),
  results: z.array(FullStackFeatureFixtureResultSchema),
  generatedAt: z.string().datetime()
});

export type FeatureFixtureSuiteReport = z.infer<typeof FeatureFixtureSuiteReportSchema>;

export const FEATURE_FIXTURE_MANIFEST_SCHEMA_VERSION = "1" as const;

export const FEATURE_FIXTURE_ERROR_CODES = [
  "FEATURE_FIXTURE_NOT_FOUND",
  "FEATURE_FIXTURE_INVALID",
  "FEATURE_SETUP_FAILED",
  "REQUIREMENT_INVALID",
  "ARCHITECTURE_MAP_INVALID",
  "CONTRACT_MISMATCH",
  "DATA_CHANGE_FAILED",
  "PARTIAL_FEATURE",
  "FALSE_E2E",
  "ARCHITECTURE_DRIFT",
  "SCOPE_EXPANSION",
  "USER_CHANGE_CONFLICT",
  "FEATURE_TIMEOUT",
  "FEATURE_BUDGET_EXHAUSTED",
  "PORT_UNAVAILABLE",
  "PROCESS_CLEANUP_FAILED",
  "FEATURE_CLEANUP_FAILED",
  "FEATURE_EVIDENCE_INCOMPLETE"
] as const;

export type FeatureFixtureErrorCode = (typeof FEATURE_FIXTURE_ERROR_CODES)[number];

export class FeatureFixtureError extends Error {
  public readonly code: FeatureFixtureErrorCode;
  public readonly retryable: boolean;

  public constructor(code: FeatureFixtureErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "FeatureFixtureError";
    this.code = code;
    this.retryable = retryable;
  }
}

const NETWORK_COMMAND_PREFIXES = ["curl", "wget", "scp", "rsync", "ftp", "ssh"];
const NETWORK_ARG_PATTERNS = [/^https?:\/\//i, /^ftp:\/\//i];

function looksLikeNetworkCommand(command: string, args: string[]): boolean {
  if (NETWORK_COMMAND_PREFIXES.some((prefix) => command.toLowerCase() === prefix || command.toLowerCase().startsWith(`${prefix} `))) {
    return true;
  }
  return args.some((arg) => NETWORK_ARG_PATTERNS.some((pattern) => pattern.test(arg)));
}

export function parseFeatureFixtureManifest(input: unknown): FullStackFeatureFixtureManifest {
  return FullStackFeatureFixtureManifestSchema.parse(input);
}
