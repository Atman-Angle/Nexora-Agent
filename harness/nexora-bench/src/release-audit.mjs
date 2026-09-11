import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
const benchRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(process.env.INIT_CWD?.trim() || repositoryRoot, option("--manifest") || "harness/nexora-bench/datasets/nexora-core-v1/release-v1.json");
const reliabilityPath = option("--reliability");
const faultLabPath = option("--fault-lab");
const outputPath = resolve(process.env.INIT_CWD?.trim() || repositoryRoot, option("--output") || "harness/nexora-bench/release-reports/latest/release-audit.json");
const checks = [];

const manifestExists = exists(manifestPath);
checks.push({ id: "formal-manifest-present", passed: manifestExists, message: manifestExists ? manifestPath : `Missing formal manifest: ${manifestPath}` });
let manifest;
if (manifestExists) {
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (error) { checks.push({ id: "formal-manifest-json", passed: false, message: String(error) }); }
}
if (manifest) {
  checks.push({ id: "formal-manifest-release", passed: manifest.release === true, message: "Formal manifest must set release=true." });
  checks.push({ id: "formal-manifest-task-count", passed: Array.isArray(manifest.tasks) && manifest.tasks.length === 60, message: `Formal manifest declares ${manifest.tasks?.length ?? 0} tasks; expected 60.` });
  checks.push({ id: "formal-manifest-identities", passed: ["datasetDigest", "fixturesDigest", "gradersDigest", "suiteVersion", "runnerSchemaVersion", "reportSchemaVersion", "faultCatalogVersion", "reliabilitySelectionVersion"].every((key) => manifest[key] !== undefined), message: "Formal manifest identity and release metadata are required." });
}
const source = gitSource();
checks.push({ id: "clean-commit", passed: source.dirty === false, message: source.dirty === false ? "Source tree is clean." : "Formal benchmark requires a clean source tree." });
const reliability = readOptionalJson(reliabilityPath);
checks.push({ id: "reliability-evidence", passed: reliability !== null && reliability.overall !== undefined && reliability.source?.dirty === false, message: reliability === null ? "No reliability report supplied." : "Reliability report must include overall metrics and clean source evidence." });
const faultLab = readOptionalJson(faultLabPath);
checks.push({ id: "fault-lab-evidence", passed: faultLab !== null && faultLab.passed === true && faultLab.source?.dirty === false, message: faultLab === null ? "No Fault Lab report supplied." : "Fault Lab must pass with clean source evidence." });

const report = { schemaVersion: 1, benchmarkId: "nexora-eval-v1-release-audit", createdAt: new Date().toISOString(), source, manifestPath, reliabilityPath: reliabilityPath ?? null, faultLabPath: faultLabPath ?? null, passed: checks.every((check) => check.passed), checks };
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.passed, reportPath: outputPath, failed: checks.filter((check) => !check.passed).map((check) => check.id) }, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;

function readOptionalJson(path) { if (!path || !exists(path)) return null; try { return JSON.parse(readFileSync(resolve(process.env.INIT_CWD?.trim() || repositoryRoot, path), "utf8")); } catch { return null; } }
function exists(path) { try { readFileSync(path); return true; } catch { return false; } }
function gitSource() { const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }); const status = spawnSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }); return { commit: commit.status === 0 ? commit.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.trim().length > 0 : null }; }
function option(name) { const index = process.argv.lastIndexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
