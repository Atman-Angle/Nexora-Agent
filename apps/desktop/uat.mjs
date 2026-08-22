/* global console, process */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const reportPath = resolve(repositoryRoot, process.env.NEXORA_DESKTOP_UAT_REPORT_PATH ?? ".tmp/desktop-uat-report.json");
const capturePath = resolve(repositoryRoot, process.env.NEXORA_DESKTOP_UAT_CAPTURE_PATH ?? ".tmp/desktop-uat.png");
const electronCli = resolve(import.meta.dirname, "node_modules/electron/cli.js");

if (!existsSync(resolve(repositoryRoot, ".env"))
  && !(process.env.NEXORA_MODEL_BASE_URL && process.env.NEXORA_MODEL_API_KEY && process.env.NEXORA_MODEL_NAME)) {
  throw new Error("Desktop UAT requires Provider configuration in the repository .env or process environment.");
}

const child = spawn(process.execPath, [electronCli, resolve(import.meta.dirname, "dist/main.js")], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    NEXORA_DESKTOP_UAT_REPORT_PATH: reportPath,
    NEXORA_DESKTOP_UAT_CAPTURE_PATH: capturePath
  },
  stdio: "inherit",
  windowsHide: true
});

const exitCode = await new Promise((resolveExit, rejectExit) => {
  child.once("error", rejectExit);
  child.once("exit", (code) => resolveExit(code ?? 1));
});
if (exitCode !== 0) throw new Error(`Desktop UAT process exited with code ${exitCode}.`);

const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.status !== "succeeded") throw new Error(`Desktop UAT report status was ${String(report.status)}.`);
console.log(JSON.stringify({
  runId: report.runId,
  status: report.status,
  invocations: report.invocations.length,
  evidence: report.evidence.length,
  reportPath,
  capturePath
}, null, 2));
