/* global console, process */

import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const deterministic = process.argv.includes("--deterministic");
const reportPath = resolve(repositoryRoot, process.env.NEXORA_DESKTOP_UAT_REPORT_PATH ?? (deterministic ? ".tmp/desktop-uat-deterministic.json" : ".tmp/desktop-uat-report.json"));
const capturePath = resolve(repositoryRoot, process.env.NEXORA_DESKTOP_UAT_CAPTURE_PATH ?? (deterministic ? ".tmp/desktop-uat-deterministic.png" : ".tmp/desktop-uat.png"));
const electronCli = resolve(import.meta.dirname, "node_modules/electron/cli.js");
let fixture;
let server;
const uatEnvironment = {};

if (deterministic) {
  fixture = mkdtempSync(join(tmpdir(), "nexora-desktop-uat-"));
  writeFileSync(join(fixture, "target.txt"), "deterministic desktop evidence\n", "utf8");
  let calls = 0;
  server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (calls % 2 === 1) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Reading **target.txt**.", tool_calls: [{ index: 0, id: `read-${calls}`, function: { name: "filesystem_read", arguments: "{\"path\":\"target.txt\"}" } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "**Desktop turn " } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${calls / 2} completed.**` }, finish_reason: "stop" }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Desktop UAT Provider did not bind.");
  writeFileSync(join(fixture, ".env"), [
    `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
    "NEXORA_MODEL_API_KEY=desktop-uat-key",
    "NEXORA_MODEL_NAME=qwen3.7-flash",
    "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
    "NEXORA_MODEL_TOOL_TRANSPORT=native_tools"
  ].join("\n"), "utf8");
  Object.assign(uatEnvironment, {
    NEXORA_DESKTOP_WORKSPACE: fixture,
    NEXORA_DESKTOP_UAT_GOAL: "Read target.txt and report its verified content.",
    NEXORA_DESKTOP_UAT_CONTINUATION: "Read target.txt again and confirm the follow-up remains in this Session."
  });
} else if (!existsSync(resolve(repositoryRoot, ".env"))
  && !(process.env.NEXORA_MODEL_BASE_URL && process.env.NEXORA_MODEL_API_KEY && process.env.NEXORA_MODEL_NAME)) {
  throw new Error("Desktop UAT requires Provider configuration in the repository .env or process environment.");
}

const child = spawn(process.execPath, [electronCli, resolve(import.meta.dirname, "dist/main.js")], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    ...uatEnvironment,
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
if (server !== undefined) {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
if (exitCode !== 0) throw new Error(`Desktop UAT process exited with code ${exitCode}.`);

const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.status !== "succeeded") throw new Error(`Desktop UAT report status was ${String(report.status)}.`);
console.log(JSON.stringify({
  runId: report.runId,
  sessionId: report.sessionId,
  runs: report.runIds.length,
  status: report.status,
  invocations: report.invocations.length,
  evidence: report.evidence.length,
  publicOutputCount: report.publicOutputCount,
  modelProfileCount: report.modelProfileCount,
  reportPath,
  capturePath
}, null, 2));
