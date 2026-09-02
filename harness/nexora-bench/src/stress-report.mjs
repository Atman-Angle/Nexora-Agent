import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtimeReport = process.argv[2] ?? resolve(root, "reports/2026-08-29T05-19-11-743Z/report.json");
const output = process.argv[3] ?? resolve(root, "reports/stress-baseline.json");
const report = JSON.parse(readFileSync(runtimeReport, "utf8"));
const core = JSON.parse(readFileSync(resolve(root, "stress-tasks/core-v1.json"), "utf8"));
const products = [".tmp/desktop-recovery-uat.json", ".tmp/desktop-document-uat.json"]
  .map((path) => { try { return JSON.parse(readFileSync(resolve(root, "..", "..", path), "utf8")); } catch { return null; } })
  .filter(Boolean);
const tasks = report.tasks.map((task) => ({
  taskId: task.taskId,
  runtime: { taskPassed: task.taskPassed, validated: task.nexoraValidated, status: task.actualTerminal, boundary: task.firstBrokenBoundary, modelCalls: task.authorityGrade.metrics.modelCalls, invocations: task.authorityGrade.metrics.invocations, evidence: task.authorityGrade.metrics.evidence },
  product: { status: "uncovered", boundary: "PRODUCT_PATH" }
}));
const result = {
  generatedAt: new Date().toISOString(),
  runtimeReport,
  runtime: { candidates: tasks.length, taskSuccessRate: report.taskResolvedRate, validatedSuccessRate: report.validatedSuccessRate, authorityPassRate: report.tasks.filter((task) => task.authorityGrade.passed).length / tasks.length },
  productPath: { executedScenarios: products.length, reports: products.map((item) => ({ status: item.status, runs: item.runs?.length ?? 0, modelCalls: item.runs?.reduce((n, run) => n + run.modelCalls, 0) ?? 0, invocations: item.invocations?.length ?? 0, evidence: item.evidence?.length ?? 0, parity: item.parity ?? null })) },
  parity: { runtimePassProductFail: 0, runtimeFailProductFail: 0, uncoveredCoreTasks: core.tasks.length },
  tasks
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
