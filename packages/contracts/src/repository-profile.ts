import { z } from "zod";

export const SourceReferenceSchema = z.object({
  path: z.string().min(1),
  scope: z.enum(["root", "subdirectory"]).optional(),
  revision: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional()
});

export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const DetectedTechnologySchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sourcePath: z.string().min(1),
  sourceField: z.string().min(1).optional(),
  detectionMethod: z.string().min(1)
});

export type DetectedTechnology = z.infer<typeof DetectedTechnologySchema>;

export const ProjectCommandKindSchema = z.enum([
  "dev",
  "build",
  "test",
  "lint",
  "typecheck",
  "format"
]);

export const ProjectCommandSchema = z.object({
  kind: ProjectCommandKindSchema,
  command: z.string().min(1),
  workingDirectory: z.string().min(1),
  sourceFile: z.string().min(1),
  sourceField: z.string().min(1).optional(),
  packageOrProject: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  requiresApproval: z.boolean()
});

export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type ProjectCommandKind = z.infer<typeof ProjectCommandKindSchema>;

export const ProjectUnitKindSchema = z.enum(["application", "service", "package", "workspace"]);

export const ProjectUnitSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: ProjectUnitKindSchema,
  sourcePath: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1))
});

export type ProjectUnit = z.infer<typeof ProjectUnitSchema>;

export const IntegrationCandidateRoleSchema = z.enum([
  "model_provider",
  "workflow_orchestration",
  "tool",
  "storage",
  "api",
  "queue_background_job",
  "runtime_entry_point"
]);

export const IntegrationCandidateSchema = z.object({
  role: IntegrationCandidateRoleSchema,
  path: z.string().min(1),
  description: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1)),
  candidate: z.literal(true)
});

export type IntegrationCandidate = z.infer<typeof IntegrationCandidateSchema>;

export const RepositoryWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.string().min(1).optional()
});

export type RepositoryWarning = z.infer<typeof RepositoryWarningSchema>;

export const RepositoryPathSchema = z.object({
  path: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1))
});

export type RepositoryPath = z.infer<typeof RepositoryPathSchema>;

export const GitFileChangeSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  status: z.enum(["modified", "added", "deleted", "renamed", "untracked", "conflicted", "copied"]),
  staged: z.boolean()
});

export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

export const GitFactsSchema = z.object({
  isRepository: z.boolean(),
  repositoryRoot: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  headRevision: z.string().min(1).optional(),
  isDirty: z.boolean(),
  dirtyFiles: z.array(z.string().min(1))
});

export type GitFacts = z.infer<typeof GitFactsSchema>;

export const GitStatusResultSchema = z.object({
  isRepository: z.boolean(),
  repositoryRoot: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  headRevision: z.string().min(1).optional(),
  stagedFiles: z.array(GitFileChangeSchema),
  modifiedFiles: z.array(GitFileChangeSchema),
  untrackedFiles: z.array(GitFileChangeSchema),
  deletedFiles: z.array(GitFileChangeSchema),
  renamedFiles: z.array(GitFileChangeSchema),
  conflictedFiles: z.array(GitFileChangeSchema),
  isDirty: z.boolean()
});

export type GitStatusResult = z.infer<typeof GitStatusResultSchema>;

export const RepositoryProfileSchema = z.object({
  schemaVersion: z.literal("1"),
  root: z.string().min(1),
  repositoryType: z.enum(["single", "monorepo", "multi-project", "unknown"]),
  languages: z.array(DetectedTechnologySchema),
  frameworks: z.array(DetectedTechnologySchema),
  packageManagers: z.array(DetectedTechnologySchema),
  buildSystems: z.array(DetectedTechnologySchema),
  testSystems: z.array(DetectedTechnologySchema),
  workspaceFiles: z.array(SourceReferenceSchema),
  instructionFiles: z.array(SourceReferenceSchema),
  configFiles: z.array(SourceReferenceSchema),
  applications: z.array(ProjectUnitSchema),
  services: z.array(ProjectUnitSchema),
  packages: z.array(ProjectUnitSchema),
  sourceRoots: z.array(RepositoryPathSchema),
  testRoots: z.array(RepositoryPathSchema),
  generatedRoots: z.array(RepositoryPathSchema),
  ignoredRoots: z.array(RepositoryPathSchema),
  commands: z.array(ProjectCommandSchema),
  integrationCandidates: z.array(IntegrationCandidateSchema),
  git: GitFactsSchema,
  warnings: z.array(RepositoryWarningSchema),
  evidenceRefs: z.array(z.string().min(1)),
  generatedAt: z.string().datetime()
});

export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

export const RepositoryUnderstandingBudgetSchema = z.object({
  maxScanDepth: z.number().int().positive(),
  maxEntries: z.number().int().positive(),
  maxInstructionFiles: z.number().int().positive(),
  maxConfigFiles: z.number().int().positive(),
  maxFileReadBytes: z.number().int().positive(),
  maxWorkingSetFiles: z.number().int().positive(),
  maxInlineDiffBytes: z.number().int().positive(),
  maxProfileBytes: z.number().int().positive(),
  maxIntegrationCandidates: z.number().int().positive()
});

export type RepositoryUnderstandingBudget = z.infer<typeof RepositoryUnderstandingBudgetSchema>;

export const DEFAULT_REPOSITORY_UNDERSTANDING_BUDGET: RepositoryUnderstandingBudget = {
  maxScanDepth: 4,
  maxEntries: 2000,
  maxInstructionFiles: 16,
  maxConfigFiles: 32,
  maxFileReadBytes: 64 * 1024,
  maxWorkingSetFiles: 12,
  maxInlineDiffBytes: 16 * 1024,
  maxProfileBytes: 32 * 1024,
  maxIntegrationCandidates: 24
};
