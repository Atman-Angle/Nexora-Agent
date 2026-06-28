import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TASK_WORKING_SET_BUDGET,
  TaskContextManifestSchema,
  TaskWorkingSetSchema,
  computeArtifactHash,
  type IntegrationCandidate,
  type ProjectCommand,
  type RepositoryProfile,
  type TaskContextManifest,
  type TaskWorkingSet,
  type TaskWorkingSetEntry,
  type TaskWorkingSetEntryRole
} from "../../contracts/src/index.js";

export type BuildTaskWorkingSetInput = {
  taskGoal: string;
  profile: RepositoryProfile;
  searchResultPaths?: string[];
  budget?: { maxFiles: number; maxIntegrationCandidates: number };
};

const ROLE_KEYWORDS: Array<{ role: TaskWorkingSetEntryRole; keywords: string[] }> = [
  { role: "instruction", keywords: ["agents", "claude", "readme", "contributing", "project", "architecture", "development", "tests"] },
  { role: "configuration", keywords: ["package.json", "tsconfig", "pnpm-workspace", "turbo", "nx.json", "go.mod", "cargo.toml", "pyproject", "makefile", "docker-compose", ".env.example"] },
  { role: "test", keywords: ["test", "tests", "__tests__", "spec", ".test.", ".spec."] }
];

export function buildTaskWorkingSet(input: BuildTaskWorkingSetInput): TaskWorkingSet {
  const budget = input.budget ?? TASK_WORKING_SET_BUDGET;
  const candidates = new Map<string, TaskWorkingSetEntry>();
  const goalTokens = tokenize(input.taskGoal);

  for (const instructionFile of input.profile.instructionFiles) {
    if (candidates.size >= budget.maxFiles) break;
    addEntry(candidates, instructionFile.path, "instruction", `Instruction file relevant to task: ${instructionFile.path}`, instructionFile.path);
  }

  for (const configFile of input.profile.configFiles) {
    if (candidates.size >= budget.maxFiles) break;
    if (matchesGoal(configFile.path, goalTokens) || isCoreConfig(configFile.path)) {
      addEntry(candidates, configFile.path, "configuration", `Configuration file: ${configFile.path}`, configFile.path);
    }
  }

  for (const searchPath of input.searchResultPaths ?? []) {
    if (candidates.size >= budget.maxFiles) break;
    const role = inferRoleFromPath(searchPath);
    if (isGeneratedPath(searchPath)) {
      continue;
    }
    addEntry(candidates, searchPath, role, `Search result matched task: ${searchPath}`, searchPath);
  }

  for (const unit of [...input.profile.applications, ...input.profile.services, ...input.profile.packages]) {
    if (candidates.size >= budget.maxFiles) break;
    if (matchesGoal(unit.path, goalTokens) || matchesGoal(unit.name, goalTokens)) {
      const role: TaskWorkingSetEntryRole = unit.kind === "application" ? "interface" : unit.kind === "service" ? "interface" : "implementation";
      addEntry(candidates, unit.path, role, `Project unit matched task: ${unit.name}`, `outline:${unit.path}`);
    }
  }

  for (const candidate of input.profile.integrationCandidates.slice(0, budget.maxIntegrationCandidates)) {
    addEntry(candidates, candidate.path, "integration-candidate", `Integration candidate: ${candidate.role}`, ...candidate.evidenceRefs);
  }

  for (const command of input.profile.commands) {
    if (matchesGoal(command.kind, goalTokens) || matchesGoal(command.command, goalTokens)) {
      addEntry(candidates, command.sourceFile, "configuration", `Command source: ${command.kind}`, command.sourceFile);
    }
  }

  const items = [...candidates.values()].slice(0, budget.maxFiles);
  return TaskWorkingSetSchema.parse({
    taskGoal: input.taskGoal,
    itemCount: items.length,
    items,
    budget: { maxFiles: budget.maxFiles, maxIntegrationCandidates: budget.maxIntegrationCandidates }
  });
}

function addEntry(
  candidates: Map<string, TaskWorkingSetEntry>,
  path: string,
  role: TaskWorkingSetEntryRole,
  relevanceReason: string,
  ...evidenceRefs: string[]
): void {
  if (candidates.has(path)) {
    return;
  }
  candidates.set(path, {
    path,
    role,
    relevanceReason,
    evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : [path],
    stale: false
  });
}

function inferRoleFromPath(path: string): TaskWorkingSetEntryRole {
  const normalized = path.toLowerCase();
  for (const { role, keywords } of ROLE_KEYWORDS) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return role;
    }
  }
  if (normalized.includes("test") || normalized.includes("spec")) {
    return "test";
  }
  return "implementation";
}

function isGeneratedPath(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/);
  return segments.some((segment) => ["dist", "build", "coverage", ".next", ".turbo", "target", "__pycache__", ".cache", "node_modules"].includes(segment));
}

function isCoreConfig(path: string): boolean {
  const coreConfigs = ["package.json", "tsconfig.json", "pnpm-workspace.yaml", "turbo.json", "go.mod", "cargo.toml", "pyproject.toml", "makefile"];
  return coreConfigs.includes(path.toLowerCase());
}

function matchesGoal(text: string, goalTokens: string[]): boolean {
  const normalized = text.toLowerCase();
  return goalTokens.some((token) => token.length > 1 && normalized.includes(token));
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[\s/_\\\-.]+/).map((token) => token.trim()).filter((token) => token.length > 1))];
}

export type BuildContextManifestInput = {
  profile: RepositoryProfile;
  workingSet: TaskWorkingSet;
  workspaceRoot: string;
  now: string;
  budget?: { maxFiles: number; maxIntegrationCandidates: number };
};

export function buildTaskContextManifest(input: BuildContextManifestInput): TaskContextManifest {
  const budget = input.budget ?? TASK_WORKING_SET_BUDGET;
  const fileHashes = input.workingSet.items.map((entry) => {
    try {
      const absolute = join(input.workspaceRoot, entry.path);
      const content = readFileSync(absolute, "utf8");
      return { path: entry.path, hash: computeArtifactHash(content) };
    } catch {
      return { path: entry.path, hash: null };
    }
  });

  const dirtyFileCount = input.profile.git.isDirty ? input.profile.git.dirtyFiles.length : 0;
  const workingSetFiles = input.workingSet.items.length;
  const integrationCandidates = input.workingSet.items.filter((item) => item.role === "integration-candidate").length;

  return TaskContextManifestSchema.parse({
    profileVersion: input.profile.schemaVersion,
    gitRevision: input.profile.git.headRevision ?? null,
    dirtyState: {
      isRepository: input.profile.git.isRepository,
      isDirty: input.profile.git.isDirty,
      dirtyFileCount
    },
    workingSet: input.workingSet,
    fileHashes,
    truncation: {
      truncated: workingSetFiles >= budget.maxFiles,
      ...(workingSetFiles >= budget.maxFiles ? { reason: "working_set_file_budget" } : {})
    },
    stale: false,
    generatedAt: input.now,
    budgetUsage: {
      workingSetFiles,
      maxWorkingSetFiles: budget.maxFiles,
      integrationCandidates,
      maxIntegrationCandidates: budget.maxIntegrationCandidates
    }
  });
}

export type ProjectCommandsRef = ProjectCommand[];
export type IntegrationCandidatesRef = IntegrationCandidate[];
