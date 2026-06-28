import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  DEFAULT_REPOSITORY_UNDERSTANDING_BUDGET,
  DetectedTechnologySchema,
  GitFactsSchema,
  IntegrationCandidateSchema,
  ProjectCommandSchema,
  ProjectUnitSchema,
  RepositoryPathSchema,
  RepositoryProfileSchema,
  RepositoryWarningSchema,
  SourceReferenceSchema,
  type DetectedTechnology,
  type GitFacts,
  type IntegrationCandidate,
  type ProjectUnit,
  type RepositoryPath,
  type RepositoryProfile,
  type RepositoryUnderstandingBudget,
  type RepositoryWarning,
  type SourceReference
} from "../../contracts/src/index.js";
import { computeArtifactHash } from "../../contracts/src/artifact.js";
import { discoverProjectCommands } from "./project-commands.js";
import { runGit } from "./git-runner.js";

const INSTRUCTION_FILE_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "PROJECT.md",
  "ARCHITECTURE.md",
  "DEVELOPMENT.md",
  "TESTS.md"
];

const CONFIG_FILE_NAMES = [
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "tsconfig.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "docker-compose.yml",
  ".env.example"
];

const GENERATED_ROOT_NAMES = new Set(["dist", "build", "coverage", ".next", ".turbo", "target", "__pycache__", ".cache"]);
const IGNORED_ROOT_NAMES = new Set(["node_modules", "vendor", "tmp", "temp", ".git"]);

type InspectorInput = {
  workspaceRoot: string;
  relativePath?: string;
  now: string;
  budget?: RepositoryUnderstandingBudget;
  gitFacts?: GitFacts;
};

export async function inspectRepository(input: InspectorInput): Promise<RepositoryProfile> {
  const budget = input.budget ?? DEFAULT_REPOSITORY_UNDERSTANDING_BUDGET;
  const absoluteRoot = resolve(input.workspaceRoot, input.relativePath ?? ".");

  const warnings: RepositoryWarning[] = [];
  const evidenceRefs: string[] = [];

  const instructionFiles = await discoverKnownFiles(absoluteRoot, INSTRUCTION_FILE_NAMES, budget.maxInstructionFiles, evidenceRefs);
  const configFiles = await discoverKnownFiles(absoluteRoot, CONFIG_FILE_NAMES, budget.maxConfigFiles, evidenceRefs);
  const outline = await buildDirectoryOutline(absoluteRoot, budget, warnings);

  const { languages, frameworks, packageManagers, buildSystems, testSystems } = await detectTechnologies(
    absoluteRoot,
    configFiles,
    evidenceRefs,
    warnings
  );

  const { applications, services, packages, sourceRoots, testRoots, generatedRoots, ignoredRoots } = await classifyProjectUnits(
    absoluteRoot,
    outline,
    evidenceRefs
  );

  const repositoryType = inferRepositoryType(outline, packages, configFiles);

  const { commands } = await discoverProjectCommands({ workspaceRoot: absoluteRoot });
  const boundedCommands = commands.slice(0, 64).map((command) => ProjectCommandSchema.parse(command));

  const gitFacts = input.gitFacts ?? (await collectGitFacts(absoluteRoot));
  const integrationCandidates = detectIntegrationCandidates(outline, evidenceRefs, budget);

  const profile = RepositoryProfileSchema.parse({
    schemaVersion: "1",
    root: absoluteRoot,
    repositoryType,
    languages,
    frameworks,
    packageManagers,
    buildSystems,
    testSystems,
    workspaceFiles: outline.workspaceFiles,
    instructionFiles,
    configFiles,
    applications,
    services,
    packages,
    sourceRoots,
    testRoots,
    generatedRoots,
    ignoredRoots,
    commands: boundedCommands,
    integrationCandidates,
    git: GitFactsSchema.parse(gitFacts),
    warnings: warnings.slice(0, 32).map((warning) => RepositoryWarningSchema.parse(warning)),
    evidenceRefs: [...new Set(evidenceRefs)].slice(0, 128),
    generatedAt: input.now
  });

  return profile;
}

type DirectoryOutline = {
  workspaceFiles: SourceReference[];
  topLevelDirs: string[];
  childPackageDirs: string[];
};

async function buildDirectoryOutline(
  root: string,
  budget: RepositoryUnderstandingBudget,
  warnings: RepositoryWarning[]
): Promise<DirectoryOutline> {
  const workspaceFiles: SourceReference[] = [];
  const topLevelDirs: string[] = [];
  const childPackageDirs: string[] = [];

  await walkOutline(root, root, 0, budget.maxScanDepth, {
    workspaceFiles,
    topLevelDirs,
    childPackageDirs,
    scannedRef: { count: 0 },
    maxScanned: budget.maxEntries,
    warnings
  });

  return { workspaceFiles, topLevelDirs, childPackageDirs };
}

async function walkOutline(
  root: string,
  currentDir: string,
  depth: number,
  maxDepth: number,
  state: {
    workspaceFiles: SourceReference[];
    topLevelDirs: string[];
    childPackageDirs: string[];
    scannedRef: { count: number };
    maxScanned: number;
    warnings: RepositoryWarning[];
  }
): Promise<void> {
  if (state.scannedRef.count >= state.maxScanned) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of entries) {
    if (state.scannedRef.count >= state.maxScanned) {
      return;
    }
    state.scannedRef.count += 1;

    const fullPath = join(currentDir, entry.name);
    const relativePath = relative(root, fullPath).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      if (GENERATED_ROOT_NAMES.has(entry.name) || IGNORED_ROOT_NAMES.has(entry.name)) {
        continue;
      }
      if (depth === 0) {
        state.topLevelDirs.push(relativePath);
      }
      const hasPackageJson = await pathExists(join(fullPath, "package.json"));
      if (hasPackageJson && depth > 0) {
        state.childPackageDirs.push(relativePath);
      }
      if (depth + 1 < maxDepth) {
        await walkOutline(root, fullPath, depth + 1, maxDepth, state);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const isInstruction = INSTRUCTION_FILE_NAMES.includes(entry.name);
    const isConfig = CONFIG_FILE_NAMES.includes(entry.name);
    if (isInstruction || isConfig) {
      continue;
    }

    const hash = await hashFile(fullPath);
    state.workspaceFiles.push(
      SourceReferenceSchema.parse({
        path: relativePath,
        scope: depth === 0 ? "root" : "subdirectory",
        ...(hash === undefined ? {} : { contentHash: hash })
      })
    );
  }
}

async function discoverKnownFiles(
  root: string,
  names: string[],
  budget: number,
  evidenceRefs: string[]
): Promise<SourceReference[]> {
  const found: SourceReference[] = [];
  const searchDirs = await collectSearchDirs(root);
  for (const dir of searchDirs) {
    for (const name of names) {
      if (found.length >= budget) {
        return found;
      }
      const candidate = join(dir.absolutePath, name);
      if (await pathExists(candidate)) {
        const relativePath = relative(root, candidate).replaceAll("\\", "/");
        const hash = await hashFile(candidate);
        found.push(
          SourceReferenceSchema.parse({
            path: relativePath,
            scope: dir.depth === 0 ? "root" : "subdirectory",
            ...(hash === undefined ? {} : { contentHash: hash })
          })
        );
        evidenceRefs.push(`file:${relativePath}`);
      }
    }
  }
  return found;
}

async function collectSearchDirs(root: string): Promise<Array<{ absolutePath: string; depth: number }>> {
  const dirs: Array<{ absolutePath: string; depth: number }> = [{ absolutePath: root, depth: 0 }];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (GENERATED_ROOT_NAMES.has(entry.name) || IGNORED_ROOT_NAMES.has(entry.name)) {
        continue;
      }
      if (entry.name.startsWith(".") && entry.name !== ".") {
        continue;
      }
      dirs.push({ absolutePath: join(root, entry.name), depth: 1 });
    }
  } catch {
    /* ignore */
  }
  return dirs;
}

async function detectTechnologies(
  root: string,
  configFiles: SourceReference[],
  evidenceRefs: string[],
  warnings: RepositoryWarning[]
): Promise<{
  languages: DetectedTechnology[];
  frameworks: DetectedTechnology[];
  packageManagers: DetectedTechnology[];
  buildSystems: DetectedTechnology[];
  testSystems: DetectedTechnology[];
}> {
  const languages: DetectedTechnology[] = [];
  const frameworks: DetectedTechnology[] = [];
  const packageManagers: DetectedTechnology[] = [];
  const buildSystems: DetectedTechnology[] = [];
  const testSystems: DetectedTechnology[] = [];
  const seen = new Set<string>();

  const packageJsonRef = configFiles.find((file) => file.path === "package.json");
  if (packageJsonRef !== undefined) {
    const parsed = await readJson(join(root, "package.json"), "package.json", warnings);
    if (parsed !== null) {
      addTechnology(packageManagers, seen, "npm", "package_manager", 0.7, "package.json", "packageManager", "package_json_presence", evidenceRefs);
      const dependencies = { ...(parsed.dependencies as Record<string, string> | undefined), ...(parsed.devDependencies as Record<string, string> | undefined) };
      detectJsFrameworks(frameworks, seen, dependencies, evidenceRefs);
      detectJsTestSystems(testSystems, seen, dependencies, evidenceRefs);
      detectJsLanguages(languages, seen, dependencies, evidenceRefs);
      const packageManagerField = parsed.packageManager;
      if (typeof packageManagerField === "string") {
        const manager = packageManagerField.split("@")[0] ?? "";
        if (manager.length > 0) {
          packageManagers.length = 0;
          addTechnology(packageManagers, seen, manager, "package_manager", 0.99, "package.json", "packageManager", "package_json_field", evidenceRefs);
        }
      }
      const scripts = parsed.scripts;
      if (scripts !== undefined && typeof scripts === "object" && scripts !== null) {
        const scriptMap = scripts as Record<string, unknown>;
        if (typeof scriptMap.build === "string") {
          addTechnology(buildSystems, seen, "npm-scripts", "build_system", 0.7, "package.json", "scripts.build", "package_json_field", evidenceRefs);
        }
      }
    }
  }

  if (await pathExists(join(root, "pnpm-workspace.yaml"))) {
    addTechnology(packageManagers, seen, "pnpm", "package_manager", 0.9, "pnpm-workspace.yaml", undefined, "config_file_presence", evidenceRefs);
  }
  if (await pathExists(join(root, "turbo.json"))) {
    addTechnology(buildSystems, seen, "turborepo", "build_system", 0.9, "turbo.json", undefined, "config_file_presence", evidenceRefs);
  }
  if (await pathExists(join(root, "tsconfig.json"))) {
    addTechnology(languages, seen, "TypeScript", "language", 0.95, "tsconfig.json", undefined, "config_file_presence", evidenceRefs);
  }
  if (await pathExists(join(root, "go.mod"))) {
    addTechnology(languages, seen, "Go", "language", 0.95, "go.mod", undefined, "config_file_presence", evidenceRefs);
    addTechnology(packageManagers, seen, "go-modules", "package_manager", 0.9, "go.mod", undefined, "config_file_presence", evidenceRefs);
    addTechnology(buildSystems, seen, "go-build", "build_system", 0.8, "go.mod", undefined, "config_file_presence", evidenceRefs);
  }
  if (await pathExists(join(root, "Cargo.toml"))) {
    addTechnology(languages, seen, "Rust", "language", 0.95, "Cargo.toml", undefined, "config_file_presence", evidenceRefs);
    addTechnology(packageManagers, seen, "cargo", "package_manager", 0.9, "Cargo.toml", undefined, "config_file_presence", evidenceRefs);
    addTechnology(buildSystems, seen, "cargo", "build_system", 0.9, "Cargo.toml", undefined, "config_file_presence", evidenceRefs);
  }
  if (await pathExists(join(root, "pyproject.toml")) || await pathExists(join(root, "requirements.txt"))) {
    addTechnology(languages, seen, "Python", "language", 0.9, "pyproject.toml", undefined, "config_file_presence", evidenceRefs);
    const pmFile = (await pathExists(join(root, "pyproject.toml"))) ? "pyproject.toml" : "requirements.txt";
    addTechnology(packageManagers, seen, "pip", "package_manager", 0.7, pmFile, undefined, "config_file_presence", evidenceRefs);
  }
  if (await pathExists(join(root, "Makefile"))) {
    addTechnology(buildSystems, seen, "make", "build_system", 0.8, "Makefile", undefined, "config_file_presence", evidenceRefs);
  }

  return {
    languages: languages.map((tech) => DetectedTechnologySchema.parse(tech)),
    frameworks: frameworks.map((tech) => DetectedTechnologySchema.parse(tech)),
    packageManagers: packageManagers.map((tech) => DetectedTechnologySchema.parse(tech)),
    buildSystems: buildSystems.map((tech) => DetectedTechnologySchema.parse(tech)),
    testSystems: testSystems.map((tech) => DetectedTechnologySchema.parse(tech))
  };
}

function detectJsFrameworks(
  frameworks: DetectedTechnology[],
  seen: Set<string>,
  dependencies: Record<string, string>,
  evidenceRefs: string[]
): void {
  const frameworkMap: Array<{ name: string; dep: string }> = [
    { name: "Next.js", dep: "next" },
    { name: "React", dep: "react" },
    { name: "Vue", dep: "vue" },
    { name: "Express", dep: "express" },
    { name: "Fastify", dep: "fastify" },
    { name: "NestJS", dep: "@nestjs/core" },
    { name: "Electron", dep: "electron" },
    { name: "Vite", dep: "vite" }
  ];
  for (const { name, dep } of frameworkMap) {
    if (dependencies[dep] !== undefined) {
      addTechnology(frameworks, seen, name, "framework", 0.9, "package.json", `dependencies.${dep}`, "package_json_field", evidenceRefs);
    }
  }
}

function detectJsTestSystems(
  testSystems: DetectedTechnology[],
  seen: Set<string>,
  dependencies: Record<string, string>,
  evidenceRefs: string[]
): void {
  const testMap: Array<{ name: string; dep: string }> = [
    { name: "Vitest", dep: "vitest" },
    { name: "Jest", dep: "jest" },
    { name: "Mocha", dep: "mocha" },
    { name: "Playwright", dep: "@playwright/test" }
  ];
  for (const { name, dep } of testMap) {
    if (dependencies[dep] !== undefined) {
      addTechnology(testSystems, seen, name, "test_system", 0.9, "package.json", `dependencies.${dep}`, "package_json_field", evidenceRefs);
    }
  }
}

function detectJsLanguages(
  languages: DetectedTechnology[],
  seen: Set<string>,
  dependencies: Record<string, string>,
  evidenceRefs: string[]
): void {
  if (dependencies.typescript !== undefined) {
    addTechnology(languages, seen, "TypeScript", "language", 0.85, "package.json", "dependencies.typescript", "package_json_field", evidenceRefs);
  } else {
    addTechnology(languages, seen, "JavaScript", "language", 0.6, "package.json", undefined, "package_json_presence", evidenceRefs);
  }
}

function addTechnology(
  bucket: DetectedTechnology[],
  seen: Set<string>,
  name: string,
  category: string,
  confidence: number,
  sourcePath: string,
  sourceField: string | undefined,
  detectionMethod: string,
  evidenceRefs: string[]
): void {
  const key = `${category}:${name}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  bucket.push({
    name,
    category,
    confidence,
    sourcePath,
    ...(sourceField === undefined ? {} : { sourceField }),
    detectionMethod
  });
  evidenceRefs.push(`${detectionMethod}:${sourcePath}${sourceField === undefined ? "" : `:${sourceField}`}:${name}`);
}

type ClassifyResult = {
  applications: ProjectUnit[];
  services: ProjectUnit[];
  packages: ProjectUnit[];
  sourceRoots: RepositoryPath[];
  testRoots: RepositoryPath[];
  generatedRoots: RepositoryPath[];
  ignoredRoots: RepositoryPath[];
};

async function classifyProjectUnits(
  root: string,
  outline: DirectoryOutline,
  evidenceRefs: string[]
): Promise<ClassifyResult> {
  const applications: ProjectUnit[] = [];
  const services: ProjectUnit[] = [];
  const packages: ProjectUnit[] = [];
  const sourceRoots: RepositoryPath[] = [];
  const testRoots: RepositoryPath[] = [];
  const generatedRoots: RepositoryPath[] = [];
  const ignoredRoots: RepositoryPath[] = [];

  for (const dir of outline.topLevelDirs) {
    const evidence = [`outline:${dir}`];
    evidenceRefs.push(`outline:${dir}`);
    if (dir === "apps" || dir === "app") {
      applications.push(
        ProjectUnitSchema.parse({ name: dir, path: dir, kind: "application", sourcePath: "package.json", confidence: 0.6, evidenceRefs: evidence })
      );
    } else if (dir === "services" || dir === "service") {
      services.push(
        ProjectUnitSchema.parse({ name: dir, path: dir, kind: "service", sourcePath: "package.json", confidence: 0.6, evidenceRefs: evidence })
      );
    } else if (dir === "packages" || dir === "libs" || dir === "lib") {
      packages.push(
        ProjectUnitSchema.parse({ name: dir, path: dir, kind: "package", sourcePath: "package.json", confidence: 0.6, evidenceRefs: evidence })
      );
    } else if (GENERATED_ROOT_NAMES.has(dir)) {
      generatedRoots.push(RepositoryPathSchema.parse({ path: dir, evidenceRefs: evidence }));
    } else if (IGNORED_ROOT_NAMES.has(dir)) {
      ignoredRoots.push(RepositoryPathSchema.parse({ path: dir, evidenceRefs: evidence }));
    } else if (dir === "src") {
      sourceRoots.push(RepositoryPathSchema.parse({ path: dir, evidenceRefs: evidence }));
    } else if (dir === "test" || dir === "tests" || dir === "__tests__") {
      testRoots.push(RepositoryPathSchema.parse({ path: dir, evidenceRefs: evidence }));
    }
  }

  for (const childPackage of outline.childPackageDirs.slice(0, 32)) {
    const evidence = [`outline:${childPackage}`];
    evidenceRefs.push(`outline:${childPackage}`);
    const packageName = await readPackageName(join(root, childPackage, "package.json"));
    const name = packageName ?? (childPackage.split("/").pop() ?? childPackage);
    const parent = childPackage.split("/")[0] ?? "";
    const kind: ProjectUnit["kind"] = parent === "apps" ? "application" : parent === "services" ? "service" : "package";
    const bucket = kind === "application" ? applications : kind === "service" ? services : packages;
    bucket.push(
      ProjectUnitSchema.parse({ name, path: childPackage, kind, sourcePath: `${childPackage}/package.json`, confidence: 0.85, evidenceRefs: evidence })
    );
  }

  return { applications, services, packages, sourceRoots, testRoots, generatedRoots, ignoredRoots };
}

async function readPackageName(packageJsonPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      return parsed.name;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function inferRepositoryType(outline: DirectoryOutline, packages: ProjectUnit[], configFiles: SourceReference[]): RepositoryProfile["repositoryType"] {
  const hasApps = outline.topLevelDirs.includes("apps");
  const hasPackages = outline.topLevelDirs.includes("packages");
  const hasServices = outline.topLevelDirs.includes("services");
  const hasWorkspaceConfig = configFiles.some((file) => file.path === "pnpm-workspace.yaml") || (hasApps && hasPackages);
  if (hasWorkspaceConfig || (hasApps && hasPackages) || packages.length > 1) {
    return "monorepo";
  }
  if (hasApps || hasServices) {
    return "multi-project";
  }
  const packageJson = configFiles.find((file) => file.path === "package.json");
  if (packageJson !== undefined) {
    return "single";
  }
  return "unknown";
}

async function collectGitFacts(root: string): Promise<GitFacts> {
  const inside = await isInsideWorkTree(root);
  if (!inside) {
    return GitFactsSchema.parse({ isRepository: false, isDirty: false, dirtyFiles: [] });
  }
  const status = await runGit({ cwd: root, args: ["status", "--porcelain=v2", "-z", "--branch"] });
  const output = status.stdout.toString("utf8");
  const dirtyFiles: string[] = [];
  let branch: string | undefined;
  let headRevision: string | undefined;
  for (const record of output.split("\0")) {
    if (record.startsWith("# branch.head")) {
      branch = record.slice("# branch.head".length).trim() || undefined;
    } else if (record.startsWith("# branch.oid")) {
      const oid = record.slice("# branch.oid".length).trim();
      if (oid.length > 0 && oid !== "(initial)") {
        headRevision = oid;
      }
    } else if (record.startsWith("1 ") || record.startsWith("2 ") || record.startsWith("u ") || record.startsWith("? ")) {
      const path = record.startsWith("? ") ? record.slice(2) : record.split("\t").slice(1).join("\t");
      if (path.length > 0) {
        dirtyFiles.push(path);
      }
    }
  }
  const repositoryRootResult = await runGit({ cwd: root, args: ["rev-parse", "--show-toplevel"] });
  const repositoryRoot = repositoryRootResult.exitCode === 0 ? repositoryRootResult.stdout.toString("utf8").trim() : undefined;
  return GitFactsSchema.parse({
    isRepository: true,
    ...(repositoryRoot === undefined || repositoryRoot.length === 0 ? {} : { repositoryRoot }),
    ...(branch === undefined ? {} : { branch }),
    ...(headRevision === undefined ? {} : { headRevision }),
    isDirty: dirtyFiles.length > 0,
    dirtyFiles
  });
}

async function isInsideWorkTree(root: string): Promise<boolean> {
  try {
    const result = await runGit({ cwd: root, args: ["rev-parse", "--is-inside-work-tree"] });
    return result.exitCode === 0 && result.stdout.toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

function detectIntegrationCandidates(
  outline: DirectoryOutline,
  evidenceRefs: string[],
  budget: RepositoryUnderstandingBudget
): IntegrationCandidate[] {
  const candidates: IntegrationCandidate[] = [];
  const allDirs = [...outline.topLevelDirs, ...outline.childPackageDirs];
  const candidateMap: Array<{ role: IntegrationCandidate["role"]; dir: string; description: string }> = [
    { role: "model_provider", dir: "packages/model-gateway", description: "Model gateway package may wrap model provider access." },
    { role: "workflow_orchestration", dir: "packages/core", description: "Core package may contain agent loop and workflow orchestration." },
    { role: "tool", dir: "packages/tool-runtime", description: "Tool runtime package may expose external capability tools." },
    { role: "storage", dir: "packages/storage", description: "Storage package may own persistence boundaries." },
    { role: "api", dir: "packages/contracts", description: "Contracts package may define API surface." },
    { role: "queue_background_job", dir: "packages/recovery", description: "Recovery package may host background job and queue logic." },
    { role: "runtime_entry_point", dir: "apps/cli", description: "CLI app may be a runtime entry point." }
  ];

  for (const { role, dir, description } of candidateMap) {
    if (candidates.length >= budget.maxIntegrationCandidates) {
      break;
    }
    if (allDirs.includes(dir)) {
      const evidence = [`outline:${dir}`];
      evidenceRefs.push(`integration_candidate:${dir}`);
      candidates.push(
        IntegrationCandidateSchema.parse({
          role,
          path: dir,
          description,
          confidence: 0.6,
          evidenceRefs: evidence,
          candidate: true
        })
      );
    }
  }

  return candidates;
}

async function readJson(absolutePath: string, relativePath: string, warnings: RepositoryWarning[]): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(absolutePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    warnings.push({
      code: "CONFIG_PARSE_FAILED",
      message: `Config file could not be parsed: ${error instanceof Error ? error.message : "parse error"}`,
      path: relativePath
    });
    return null;
  }
}

async function hashFile(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return computeArtifactHash(content);
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile() || stats.isDirectory();
  } catch {
    return false;
  }
}
