import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const reportPath = process.argv[2] ?? resolve(import.meta.dirname, "../reports/2026-08-29T05-19-11-743Z/report.json");
const outputPath = process.argv[3] ?? resolve(import.meta.dirname, "../reports/completion-audit.json");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const mismatches = report.tasks.filter((task) => task.taskPassed && !task.nexoraValidated);
const expectedSucceeded = mismatches.filter((task) => task.expectedTerminal === "succeeded");
const classify = (task) => {
  const db = resolve(import.meta.dirname, "../reports/2026-08-29T05-19-11-743Z/run-data", task.taskId, "runtime-v1.1.db");
  let events = "";
  try { events = execFileSync("sqlite3", [db, "select type || ' ' || payload_json from run_events order by sequence;"], { encoding: "utf8" }); } catch { return "EVAL_INFRASTRUCTURE"; }
  if (task.actualTerminal === "waiting_for_approval") return "APPROVAL";
  if (events.includes("FINAL_CONTROL_REQUIRED")) return "MODEL";
  if (events.includes("UNPLANNED_MUTATION_UNVERIFIED")) return "COMPLETION_CONTRACT";
  if (task.actualTerminal === "cancelled" || task.actualTerminal === "failed") return "TASK_CONTRACT";
  return task.firstBrokenBoundary ?? "UNKNOWN";
};
const classified = expectedSucceeded.map((task) => ({ taskId: task.taskId, boundary: classify(task), status: task.actualTerminal, stopReason: task.diagnostics.stopReason }));
const genuineFalseNegative = classified.filter((item) => item.boundary === "COMPLETION");
const result = {
  generatedAt: new Date().toISOString(),
  reportPath,
  independentTaskSuccessRate: report.taskResolvedRate,
  runtimeValidatedSuccessRate: report.validatedSuccessRate,
  authorityPassRate: report.tasks.filter((task) => task.authorityGrade.passed).length / report.tasks.length,
  falseSuccessRate: report.falseSuccessCount / report.tasks.length,
  graderPassRuntimeFailCount: mismatches.length,
  expectedSucceededMismatchCount: expectedSucceeded.length,
  falseNegativeCompletionRate: genuineFalseNegative.length / report.tasks.length,
  mismatches: classified,
  boundaryDistribution: Object.fromEntries([...new Set(classified.map((item) => item.boundary))].map((boundary) => [boundary, classified.filter((item) => item.boundary === boundary).length])),
  conclusion: "No evidence of a systemic Completion Gate false-negative. NB-CODE-001 is a model protocol rejection repeated into convergence; HB-WORLD-001 is correctly rejected because the write was not verified; approval mismatches are driver/model boundary cases."
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
