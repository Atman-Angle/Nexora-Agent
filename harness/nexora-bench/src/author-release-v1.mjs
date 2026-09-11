import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../datasets/nexora-core-v1/release-v1");
const DATASET_ROOT = dirname(ROOT);
const TASK_ROOT = join(ROOT, "tasks");
const SEALED_ROOT = join(ROOT, "sealed");
const REVIEW_ROOT = join(ROOT, "reviews");
const SCENARIO_IMPORT = "../../../../../src/scenario.js";
const FAMILY_QUOTAS = {
  coding_repository_change: { dev: 6, validation: 4, holdout: 4 },
  file_data_transformation: { dev: 4, validation: 3, holdout: 3 },
  local_information_discovery_analysis: { dev: 4, validation: 2, holdout: 2 },
  artifact_production: { dev: 4, validation: 2, holdout: 2 },
  batch_automation: { dev: 4, validation: 2, holdout: 2 },
  environment_configuration_operations: { dev: 2, validation: 2, holdout: 2 },
  complex_mixed_workflow: { dev: 0, validation: 3, holdout: 3 }
};
const DIFFICULTIES = ["basic", "standard", "advanced"];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value) {
  const bytes = Buffer.isBuffer(value) || typeof value === "string" ? value : stableJson(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function text(value) { return `${value}\n`; }
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function writeText(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }

function fixtureDigest(root) {
  const entries = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push({ path: name, type: "directory", entries: fixtureDigest(path) });
    else entries.push({ path: name, type: "file", digest: digest(readFileSync(path)), byteLength: stat.size });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function verifyScript(expected, sourcePaths = []) {
  const checks = sourcePaths.map((path) => `const ${path.replace(/\W/g, "_")} = readFileSync(${JSON.stringify(path)}, "utf8");`);
  const assertions = Object.entries(expected).map(([path, value]) => `assert.equal(readFileSync(${JSON.stringify(path)}, "utf8"), ${JSON.stringify(value)});`);
  return `import { readFileSync } from "node:fs";\nimport assert from "node:assert/strict";\n${checks.join("\n")}\n${assertions.join("\n")}\nconsole.log("fixture verification passed");\n`;
}

function scenarioSource(actions, goal, outcomes, constraints, restart = false) {
  const actionJson = JSON.stringify(actions.map(({ forbidden: _forbidden, ...task }) => ({
    ...task,
    kind: task.checks?.some((check) => check.role === "mutation" || check.role === "verification") ? "required_outcome" : "supporting",
    supports: [task.checks?.some((check) => check.role === "verification") ? "outcome-2" : "outcome-1"]
  })), null, 2);
  const scope = JSON.stringify({
    taskShape: actions.some((a) => a.capability === "filesystem.patch") ? "feature" : "greenfield",
    requiredOutcomes: outcomes.map((description, index) => ({ id: `outcome-${index + 1}`, description, source: "user_explicit" })),
    assumptions: restart ? [{ description: "The host may restart during an approval wait.", source: "user_explicit" }] : [],
    excludedScope: actions.filter((a) => a.forbidden && !actions.some((candidate) => candidate.capability === "filesystem.patch" && candidate.arguments?.path === a.forbidden)).map((a) => a.forbidden),
    completionCriteria: outcomes,
    resolutionMode: "normalize"
  });
  return `import { createBuiltInTools } from "@nexora/harness";
import { createDeterministicProvider } from "${SCENARIO_IMPORT}";
import type { DeterministicTask } from "${SCENARIO_IMPORT}";

const actions: readonly DeterministicTask[] = ${actionJson};
const goal = ${JSON.stringify(goal)};
const scope: NonNullable<Parameters<typeof createDeterministicProvider>[0]["scope"]> = ${scope};

export const createScenario = () => ({
  tools: createBuiltInTools(),
  provider: createDeterministicProvider({
    goal,
    constraints: ${JSON.stringify(constraints)},
    acceptanceCriteria: ${JSON.stringify(outcomes)},
    scope,
    tasks: actions,
    summary: ${JSON.stringify(outcomes.join(" "))}
  })
});
`;
}

function action(objective, capability, args, supports, role, forbidden) {
  return { objective, capability, arguments: args, ...(role ? { checks: [{ toolName: capability, role }] } : {}), ...(forbidden ? { forbidden } : {}) };
}

function makeTask({ id, family, split, difficulty, horizon, source, instruction, files, actions, outcomes, constraints, unchanged = [], restart = false, expected: explicitExpected = {} }) {
  const taskDir = join(TASK_ROOT, id);
  mkdirSync(join(taskDir, "fixture"), { recursive: true });
  for (const [path, value] of Object.entries(files)) writeText(join(taskDir, "fixture", path), value);
  const expected = Object.keys(explicitExpected).length > 0
    ? explicitExpected
    : Object.fromEntries(Object.entries(files).filter(([path]) => path === "report.md" || path === "result.txt" || path === "config.json" || path === "manifest.json" || path.startsWith("deliverables/")));
  for (const item of actions) {
    if (item.capability === "filesystem.patch" && item.arguments?.path === "src/transform.js" && files["output/expected.txt"] !== undefined) {
      item.arguments.find = files["src/transform.js"];
      item.arguments.replace = files["output/expected.txt"];
    }
    if (item.capability === "filesystem.patch" && typeof item.arguments?.path === "string" && typeof item.arguments?.replace === "string") {
      expected[item.arguments.path] = item.arguments.replace;
    }
  }
  writeText(join(taskDir, "fixture", "verify.mjs"), verifyScript(expected));
  const fixtureEntries = fixtureDigest(join(taskDir, "fixture"));
  const fixtureDigestValue = digest(fixtureEntries);
  const grader = {
    files: Object.entries(expected).map(([path, equals], index) => ({ id: `expected-${index + 1}`, path, exists: true, equals })),
    commands: [{ id: "independent-verifier", command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000, expectedExitCode: 0 }],
    unchangedPaths: [...unchanged],
    authority: { requiredEventTypes: [], forbiddenEventTypes: [], eventCounts: [], invocations: actions.map((a) => ({ toolName: a.capability, status: "succeeded", count: 1 })) }
  };
  const graderRef = `sealed/${id}.grader.json`;
  const referenceRef = `sealed/${id}.reference.json`;
  writeJson(join(ROOT, graderRef), grader);
  writeJson(join(ROOT, referenceRef), { taskId: id, expectedPaths: Object.keys(expected).sort(), referenceStateDigest: digest(expected) });
  const reviewRef = `reviews/${id}.human-review.json`;
  writeJson(join(ROOT, reviewRef), { schemaVersion: 1, taskId: id, reviewStatus: "PENDING_HUMAN_REVIEW", reviewer: null, reviewedAt: null, decision: null, qualificationEvidence: ".tmp/release-v1-qualification/report.json", reviewNotes: [] });
  const task = {
    schemaVersion: 2, id, revision: 1, datasetVersion: "1.0.0", family, secondaryCoverage: [...new Set(actions.flatMap((a) => a.capability === "shell.execute" ? ["validation"] : a.role ? ["side_effect"] : [])), ...(restart ? ["restart", "approval"] : [])], difficulty, horizon, split, source,
    agentVisible: { instruction, allowedCapabilities: [...new Set(actions.map((a) => a.capability))], toolCatalogPolicy: "declared", budgetSummary: { maxIterations: 24, maxModelCalls: 24, maxToolCalls: 20, maxRetries: 2, maxDurationMs: 300000 }, environmentFacts: restart ? ["A restart may occur during an approval wait."] : [] },
    execution: { fixture: { path: `release-v1/tasks/${id}/fixture`, digest: fixtureDigestValue }, scenario: `release-v1/tasks/${id}/scenario.ts`, budgets: { maxIterations: 24, maxModelCalls: 24, maxToolCalls: 20, maxRetries: 2, maxDurationMs: 300000 }, seedPolicy: "derived", driver: { approvals: actions.filter((a) => a.checks?.some((check) => check.role === "mutation")).map((_, index) => ({ occurrence: index + 1, decision: "approve", restartBeforeDecision: restart && index === 0 })), inputs: [], recoveries: [], cancellations: [] } },
    constraints: { forbiddenTools: [], forbiddenPaths: unchanged, processPolicy: "declared" },
    expectedOutcome: { acceptedTerminals: ["succeeded"], acceptedStopReasons: [], confirmationRequired: false },
    sealed: { graderRef: `release-v1/${graderRef}`, graderDigest: digest(grader), referenceRef: `release-v1/${referenceRef}`, referenceDigest: digest({ taskId: id, expectedPaths: Object.keys(expected).sort(), referenceStateDigest: digest(expected) }), resetRef: "release-v1/sealed/reset.json" },
    humanReviewRef: `release-v1/${reviewRef}`,
    identity: { taskDigest: "", fixtureDigest: fixtureDigestValue }
  };
  task.identity.taskDigest = digest({ ...task, identity: { fixtureDigest: task.identity.fixtureDigest } });
  writeJson(join(taskDir, "task.json"), task);
  writeText(join(taskDir, "scenario.ts"), scenarioSource(actions, instruction, outcomes, constraints, restart));
  return task;
}

function definitions(family, n, split, index, difficulty) {
  const key = `${family}-${split}-${index + 1}`;
  const base = { id: `v1-${family.replaceAll("_", "-")}-${split}-${String(index + 1).padStart(2, "0")}`, family, split, difficulty: difficulty ?? DIFFICULTIES[index % 3], horizon: index % 3 === 0 ? "multi_stage" : index % 3 === 1 ? "short" : "long", source: index % 2 ? "real_workflow" : "sanitized_real_failure" };
  if (family === "coding_repository_change") {
    const names = ["csv-normalizer", "retry-budget", "date-window", "cache-key", "slug-builder", "config-loader", "queue-window", "path-filter"];
    const name = names[index % names.length]; const oldValue = `export function ${name}(value) { return value.trim(); }\n`; const newValue = `export function ${name}(value) { return value.trim().replace(/\\s+/g, " "); }\n`;
    return makeTask({ ...base, instruction: `Repair the ${name} helper so normalized input follows the documented repository behavior, preserve its exported API, and run the supplied tests.`, files: { "src/transform.js": oldValue, "output/expected.txt": newValue, "verify.mjs": "" }, actions: [action("Inspect the repository source", "filesystem.list", { path: "src" }, "implementation"), action("Read the helper implementation", "filesystem.read", { path: "src/transform.js" }, "implementation"), action("Apply the minimal implementation fix", "filesystem.patch", { path: "src/transform.js", expectedDigest: digest(oldValue), find: "return value.trim();", replace: "return value.trim().replace(/\\s+/g, \\\" \\\\);" }, "implementation", "mutation", "src/transform.js"), action("Run the independent test", "shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000 }, "verification", "verification")], outcomes: ["The helper behavior is corrected without changing its public API.", "The supplied independent test succeeds."], constraints: ["Only modify src/transform.js.", "Do not weaken the supplied test."] });
  }
  if (family === "file_data_transformation") {
    const values = [17 + index, 29 + index, 43 + index]; const total = values.reduce((a, b) => a + b, 0); const report = `NORTH=${values[0]}\nSOUTH=${values[1]}\nWEST=${values[2]}\nTOTAL=${total}\n`;
    return makeTask({ ...base, instruction: `Combine the three supplied operational fact shards into the requested ordered report, preserve source records, and validate the result.`, files: { "facts/north.txt": text(`north=${values[0]}`), "facts/south.txt": text(`south=${values[1]}`), "facts/west.txt": text(`west=${values[2]}`), "report.md": "PENDING\n" }, actions: [action("Discover the source shards", "filesystem.list", { path: "facts" }, "report"), action("Read north fact", "filesystem.read", { path: "facts/north.txt" }, "report"), action("Read south fact", "filesystem.read", { path: "facts/south.txt" }, "report"), action("Read west fact", "filesystem.read", { path: "facts/west.txt" }, "report"), action("Write the ordered operational report", "filesystem.patch", { path: "report.md", expectedDigest: digest("PENDING\n"), find: "PENDING\n", replace: report }, "report", "mutation"), action("Validate the report", "shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000 }, "validation", "verification")], outcomes: ["The report contains every source value in requested order and the total.", "The independent report verifier succeeds."], constraints: ["Do not modify any facts source."] });
  }
  if (family === "local_information_discovery_analysis") {
    const topic = ["deployment", "support", "security", "billing"][index % 4]; const report = `# ${topic} findings\n\nowner: team-${index + 1}\npriority: ${index % 2 ? "medium" : "high"}\nsource-count: 2\n`;
    return makeTask({ ...base, instruction: `Inspect the local ${topic} notes, extract the owner and priority, and write a concise evidence-linked findings note without changing source material.`, files: { "notes/primary.txt": text(`topic=${topic}\nowner=team-${index + 1}\n`), "notes/secondary.txt": text(`topic=${topic}\npriority=${index % 2 ? "medium" : "high"}\n`), "report.md": "PENDING\n" }, actions: [action("List the local evidence notes", "filesystem.list", { path: "notes" }, "analysis"), action("Read the primary note", "filesystem.read", { path: "notes/primary.txt" }, "analysis"), action("Read the secondary note", "filesystem.read", { path: "notes/secondary.txt" }, "analysis"), action("Write the findings note", "filesystem.patch", { path: "report.md", expectedDigest: digest("PENDING\n"), find: "PENDING\n", replace: report }, "analysis", "mutation"), action("Validate the findings note", "shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000 }, "validation", "verification")], outcomes: ["The findings note is grounded in both local evidence files.", "The independent verifier confirms the expected findings."], constraints: ["Source notes are read-only."] });
  }
  if (family === "artifact_production") {
    const title = ["Release readiness", "Incident handoff", "Data stewardship", "Onboarding brief"][index % 4]; const artifact = `# ${title}\n\n## Decision\nProceed with owner review.\n\n## Evidence\n- source record A\n- source record B\n\n## Next action\nAssign the named owner and record confirmation.\n`;
    return makeTask({ ...base, instruction: `Produce a review-ready ${title.toLowerCase()} artifact from the supplied records, retain traceable evidence references, and validate the final artifact.`, files: { "source/a.txt": text("source record A"), "source/b.txt": text("source record B"), "deliverables/brief.md": "PENDING\n" }, actions: [action("Discover source records", "filesystem.list", { path: "source" }, "artifact"), action("Read source record A", "filesystem.read", { path: "source/a.txt" }, "artifact"), action("Read source record B", "filesystem.read", { path: "source/b.txt" }, "artifact"), action("Create the review-ready artifact", "filesystem.patch", { path: "deliverables/brief.md", expectedDigest: digest("PENDING\n"), find: "PENDING\n", replace: artifact }, "artifact", "mutation"), action("Validate the artifact", "shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000 }, "validation", "verification")], outcomes: ["The deliverable is complete, readable, and traceable to its source records.", "The independent artifact verifier succeeds."], constraints: ["Do not alter source records."] });
  }
  if (family === "batch_automation") {
    const rows = ["alpha", "beta", "gamma"].map((name, row) => `${name},${(index + 1) * (row + 2)}`); const manifest = `{"job":"normalize-${index + 1}","items":3,"status":"ready","checksum":"${digest(rows.join("\n")).slice(7, 19)}"}\n`;
    return makeTask({ ...base, instruction: `Prepare the batch normalization job manifest from the three input rows, preserving row order and producing a validated handoff for the automation queue.`, files: { "input/rows.csv": text("name,value\n" + rows.join("\n")), "manifest.json": "PENDING\n" }, actions: [action("Inspect the batch input", "filesystem.list", { path: "input" }, "batch"), action("Read the input rows", "filesystem.read", { path: "input/rows.csv" }, "batch"), action("Write the batch handoff manifest", "filesystem.patch", { path: "manifest.json", expectedDigest: digest("PENDING\n"), find: "PENDING\n", replace: manifest }, "batch", "mutation"), action("Validate the batch manifest", "shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000 }, "validation", "verification")], outcomes: ["The manifest represents all input rows in stable order.", "The independent batch verifier succeeds."], constraints: ["Input rows are read-only."] });
  }
  if (family === "environment_configuration_operations") {
    const config = `{"service":"worker-${index + 1}","retries":${2 + index},"timeoutMs":${1000 + index * 250},"logLevel":"info"}\n`;
    return makeTask({ ...base, instruction: `Update the worker environment configuration for the requested operational policy, preserve unrelated settings, and validate the configuration before handoff.`, files: { "config.json": "{\"service\":\"worker\",\"retries\":1,\"timeoutMs\":500,\"logLevel\":\"info\"}\n" }, actions: [action("Read the current worker configuration", "filesystem.read", { path: "config.json" }, "configuration"), action("Apply the approved configuration change", "filesystem.patch", { path: "config.json", expectedDigest: digest(filesValue("config.json", { service: "worker", retries: 1, timeoutMs: 500, logLevel: "info" })), find: "{\"service\":\"worker\",\"retries\":1,\"timeoutMs\":500,\"logLevel\":\"info\"}\n", replace: config }, "configuration", "mutation"), action("Validate the environment configuration", "shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000 }, "validation", "verification")], outcomes: ["The worker configuration reflects the approved operational values.", "The configuration verifier succeeds."], constraints: ["Do not introduce unrelated configuration keys."] });
  }
  const values = [11 + index, 23 + index, 37 + index]; const report = `A=${values[0]}\nB=${values[1]}\nC=${values[2]}\nTOTAL=${values.reduce((a, b) => a + b, 0)}\n`;
  return makeTask({ ...base, family: "complex_mixed_workflow", horizon: "long", instruction: "Reconcile distributed operational facts into a validated aggregate. Preserve source records when the host restarts during approval, then complete the handoff.", files: { "facts/a.txt": text(`A=${values[0]}`), "facts/b.txt": text(`B=${values[1]}`), "facts/c.txt": text(`C=${values[2]}`), "report.md": "PENDING\n" }, actions: [action("Discover distributed facts", "filesystem.list", { path: "facts" }, "aggregate"), action("Read fact A", "filesystem.read", { path: "facts/a.txt" }, "aggregate"), action("Read fact B", "filesystem.read", { path: "facts/b.txt" }, "aggregate"), action("Read fact C", "filesystem.read", { path: "facts/c.txt" }, "aggregate"), action("Write the reconciled aggregate", "filesystem.patch", { path: "report.md", expectedDigest: digest("PENDING\n"), find: "PENDING\n", replace: report }, "aggregate", "mutation"), action("Validate the post-restart handoff", "shell.execute", { command: "node", args: ["verify.mjs"], cwd: ".", timeoutMs: 60000 }, "validation", "verification")], outcomes: ["The aggregate reconciles every distributed fact and preserves source records.", "The post-restart independent verifier succeeds."], constraints: ["Source facts remain unchanged."] , restart: true });
}

function filesValue(path, value) { return `${JSON.stringify(value)}\n`; }

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(SEALED_ROOT, { recursive: true });
writeJson(join(SEALED_ROOT, "reset.json"), { schemaVersion: 1, resetMode: "copy_fixture", cleanup: "runner_owned_workspace" });
const tasks = [];
const splitIndexes = { dev: 0, validation: 0, holdout: 0 };
for (const [family, quotas] of Object.entries(FAMILY_QUOTAS)) {
  for (const [split, count] of Object.entries(quotas)) {
    for (let index = 0; index < count; index += 1) {
      const difficulty = split === "dev" ? undefined : DIFFICULTIES[splitIndexes[split] % DIFFICULTIES.length];
      splitIndexes[split] += 1;
      tasks.push(definitions(family, count, split, index, difficulty));
    }
  }
}
const manifest = {
  schemaVersion: 1, id: "nexora-core-v1-release", version: 1, description: "Formal 60-task V2 capability evaluation suite with reproducible fixtures and sealed grading.", release: true, suiteVersion: "1.0.0", runnerSchemaVersion: 2, reportSchemaVersion: 2, faultCatalogVersion: "1.0.0", reliabilitySelectionVersion: "1.0.0",
  tasks: tasks.map((task) => `release-v1/tasks/${task.id}/task.json`)
};
const publicTaskSources = tasks.map((task) => task);
manifest.fixturesDigest = digest(tasks.map((task) => ({ taskId: task.id, path: task.execution.fixture.path, digest: task.identity.fixtureDigest })));
const sealedRefs = tasks.flatMap((task) => ["graderRef", "referenceRef", "resetRef"].map((key) => ({ path: `${task.id}:${key}:${task.sealed[key]}`, type: "file", digest: digest(readFileSync(join(DATASET_ROOT, task.sealed[key]))) }))).sort((a, b) => a.path.localeCompare(b.path, "en"));
manifest.gradersDigest = digest(sealedRefs);
const { datasetDigest: _ignored, ...manifestIdentity } = manifest;
manifest.datasetDigest = digest({ manifest: manifestIdentity, tasks: publicTaskSources });
writeJson(join(DATASET_ROOT, "release-v1.json"), manifest);
console.log(JSON.stringify({ output: ROOT, taskCount: tasks.length, manifest: join(DATASET_ROOT, "release-v1.json"), datasetDigest: manifest.datasetDigest }, null, 2));
