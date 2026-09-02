/* global console, process */

import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { createAgent, createBuiltInTools, openAICompatibleProviderFromEnv } from "@nexora/harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const deterministic = process.argv.includes("--deterministic");
const deterministicDocument = process.argv.includes("--deterministic-document");
const deterministicRecovery = process.argv.includes("--deterministic-recovery");
const deterministicChanges = process.argv.includes("--deterministic-changes");
const reportPath = resolve(repositoryRoot, process.env.NEXORA_DESKTOP_UAT_REPORT_PATH ?? (deterministicDocument ? ".tmp/desktop-document-uat.json" : deterministicRecovery ? ".tmp/desktop-recovery-uat.json" : deterministicChanges ? ".tmp/desktop-changes-uat.json" : deterministic ? ".tmp/desktop-uat-deterministic.json" : ".tmp/desktop-uat-report.json"));
const capturePath = resolve(repositoryRoot, process.env.NEXORA_DESKTOP_UAT_CAPTURE_PATH ?? (deterministicDocument ? ".tmp/desktop-document-uat.png" : deterministicRecovery ? ".tmp/desktop-recovery-uat.png" : deterministicChanges ? ".tmp/desktop-changes-uat.png" : deterministic ? ".tmp/desktop-uat-deterministic.png" : ".tmp/desktop-uat.png"));
const electronCli = resolve(import.meta.dirname, "node_modules/electron/cli.js");
let fixture;
let directFixture;
let uatUserData;
let server;
let directParity = null;
const uatEnvironment = {};
uatUserData = mkdtempSync(join(tmpdir(), "nexora-desktop-user-data-"));

if (deterministic || deterministicDocument || deterministicRecovery || deterministicChanges) {
  fixture = mkdtempSync(join(tmpdir(), "nexora-desktop-uat-"));
  writeFileSync(join(fixture, "target.txt"), "deterministic desktop evidence\n", "utf8");
  if (deterministicChanges) mkdirSync(join(fixture, "src", "features", "portfolio", "components", "hero", "presentation"), { recursive: true });
  if (deterministicDocument) writeFileSync(join(fixture, "brand.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  let calls = 0;
  const recoveryCalls = new Map();
  server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    calls += 1;
    if (deterministicRecovery) {
      const client = request.headers.authorization ?? "unknown";
      const clientCall = (recoveryCalls.get(client) ?? 0) + 1;
      recoveryCalls.set(client, clientCall);
      const content = clientCall <= 4
        ? { text: null, toolCalls: [{ name: "filesystem.read", arguments: { path: "missing/target.txt" } }], finishReason: "tool_calls" }
        : clientCall === 5
          ? { text: null, toolCalls: [{ name: "filesystem.search", arguments: { query: "deterministic desktop evidence", path: "." } }], finishReason: "tool_calls" }
          : clientCall === 6
            ? { text: null, toolCalls: [{ name: "filesystem.read", arguments: { path: "target.txt" } }], finishReason: "tool_calls" }
            : { text: null, toolCalls: [{ name: "nexora_respond", arguments: { text: "Recovered through an alternative search strategy." } }], finishReason: "tool_calls" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      return;
    }
    if (deterministicDocument) {
      const manifest = () => JSON.parse(readFileSync(join(fixture, "outputs", "quarterly-analysis", "manifest.nexora.json"), "utf8"));
      const createInput = {
        outputDirectory: "outputs/quarterly-analysis",
        title: "季度经营分析",
        locale: "zh-CN",
        formats: ["docx", "xlsx", "pptx", "pdf"],
        theme: { pageWidth: "wide", surface: "light", primaryColor: "#2563eb", accentColor: "#0ea5e9", font: "system", spacing: "comfortable", corners: "rounded" },
        blocks: [
          { blockId: "title", type: "heading", level: 1, runs: [{ text: "季度经营分析" }] },
          { blockId: "summary", type: "paragraph", runs: [{ text: "本季度收入与客户增长保持稳健。" }] },
          { blockId: "metrics", type: "columns", columns: [[{ blockId: "revenue", type: "metric", label: [{ text: "收入" }], value: [{ text: "¥12.8M" }], delta: [{ text: "+18%" }] }], [{ blockId: "brand", type: "image", assetPath: "brand.png", alt: "品牌图", fit: "contain" }]] },
          { blockId: "table", type: "table", headers: ["区域", "收入"], rows: [["华东", "680"], ["华南", "420"]], align: ["left", "right"] },
          { blockId: "chart", type: "chart", chartType: "bar", title: "季度趋势", categories: ["Q1", "Q2", "Q3"], series: [{ name: "收入", values: [320, 410, 520] }], showLegend: true }
        ]
      };
      const content = calls === 1
        ? { text: null, toolCalls: [{ name: "nexora_update_plan", arguments: { goal: "创建包含指标、图片、表格和趋势图的季度经营分析", tasks: [{ objective: "创建并验证季度经营分析交付物", checks: [{ toolName: "document.create" }] }] } }], finishReason: "tool_calls" }
        : calls === 2
          ? { text: null, toolCalls: [{ name: "document.create", arguments: createInput }], finishReason: "tool_calls" }
          : calls === 3
            ? { text: null, toolCalls: [{ name: "nexora_respond", arguments: { text: "季度经营分析已生成。" } }], finishReason: "tool_calls" }
            : calls === 4
              ? { text: null, toolCalls: [{ name: "nexora_update_plan", arguments: { goal: "更新趋势图和结论并保留其他内容", tasks: [{ objective: "检查目标内容", checks: [{ toolName: "document.inspect" }] }, { objective: "更新目标内容并验证新版本", checks: [{ toolName: "document.apply_patch" }] }] } }], finishReason: "tool_calls" }
              : calls === 5
                ? { text: null, toolCalls: [{ name: "document.inspect", arguments: { manifestPath: "outputs/quarterly-analysis/manifest.nexora.json", mode: "blocks", blockIds: ["summary", "chart"] } }], finishReason: "tool_calls" }
                : calls === 6
                  ? { text: null, toolCalls: [{ name: "document.apply_patch", arguments: { manifestPath: "outputs/quarterly-analysis/manifest.nexora.json", expectedRevision: manifest().currentRevision, expectedSourceDigest: manifest().sourceDigest, operations: [
                { type: "replace_block", targetBlockId: "summary", block: { blockId: "summary", type: "paragraph", runs: [{ text: "结论已精简，增长趋势保持明确。" }] } },
                { type: "replace_block", targetBlockId: "chart", block: { blockId: "chart", type: "chart", chartType: "line", title: "季度趋势", categories: ["Q1", "Q2", "Q3"], series: [{ name: "收入", values: [320, 410, 520] }], showLegend: true } }
              ] } }], finishReason: "tool_calls" }
                  : { text: null, toolCalls: [{ name: "nexora_respond", arguments: { text: "趋势图和结论已按范围更新。" } }], finishReason: "tool_calls" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      return;
    }
    if (deterministicChanges) {
      const content = calls === 1
        ? { text: null, toolCalls: [{ name: "nexora_update_plan", arguments: { goal: "创建长路径作品集组件", tasks: [{ objective: "创建并验证组件文件", checks: [{ toolName: "filesystem.write" }] }] } }], finishReason: "tool_calls" }
        : calls === 2
          ? { text: null, toolCalls: [{ name: "filesystem.write", arguments: { path: "src/features/portfolio/components/hero/presentation/interactive-developer-profile-card.tsx", content: "export const ProfileCard = () => 'Nexora';\n" } }], finishReason: "tool_calls" }
          : calls === 3
            ? { text: null, toolCalls: [{ name: "nexora_respond", arguments: { text: "# 单文件更新完成\n\n已创建长路径组件文件。" } }], finishReason: "tool_calls" }
            : calls === 4
              ? { text: null, toolCalls: [{ name: "nexora_update_plan", arguments: { goal: "同步入口与主题样式", tasks: [{ objective: "更新并验证两个关联文件", checks: [{ toolName: "filesystem.write" }] }] } }], finishReason: "tool_calls" }
              : calls === 5
                ? { text: null, toolCalls: [
                  { name: "filesystem.write", arguments: { path: "src/app.ts", content: "export { ProfileCard } from './features/portfolio/components/hero/presentation/interactive-developer-profile-card.js';\n" } },
                  { name: "filesystem.write", arguments: { path: "src/theme.css", content: ":root { color-scheme: light; }\n" } }
                ], finishReason: "tool_calls" }
                : { text: null, toolCalls: [{ name: "nexora_respond", arguments: { text: "# 多文件更新完成\n\n入口与主题样式已同步。" } }], finishReason: "tool_calls" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (calls % 2 === 1) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Inspecting the requested workspace file. " }, finish_reason: null }] })}\n\n`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "The target is known; read it before reporting the verified result. " }, finish_reason: null }] })}\n\n`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Reading **target.txt**.", tool_calls: [{ index: 0, id: `read-${calls}`, function: { name: "filesystem_read", arguments: "{\"path\":\"target.txt\"}" } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      const turn = calls / 2;
      const result = [
        `# Verified result`,
        ``,
        `Desktop turn ${turn} completed after reading \`target.txt\`.`,
        ``,
        `## Validation`,
        ``,
        `- Workspace file read succeeded`,
        `- Persisted evidence was accepted`,
        ``,
        `\`\`\`text`,
        `deterministic desktop evidence`,
        `\`\`\``,
        ``,
        `| Check | Result |`,
        `| --- | --- |`,
        `| File read | Passed |`,
        `| Evidence | Confirmed |`
      ].join("\n");
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `respond-${calls}`, function: { name: "nexora_respond", arguments: JSON.stringify({ text: result }) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
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
    "NEXORA_MODEL_CONTEXT_WINDOW_TOKENS=128000",
    "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
    `NEXORA_MODEL_TOOL_TRANSPORT=${deterministicDocument || deterministicRecovery || deterministicChanges ? "structured_output" : "native_tools"}`
  ].join("\n"), "utf8");
  Object.assign(uatEnvironment, {
    NEXORA_DESKTOP_WORKSPACE: fixture,
    NEXORA_DESKTOP_UAT_GOAL: deterministicDocument ? "创建一份包含指标、图片、表格和趋势图的季度经营分析。" : deterministicRecovery ? "Read target.txt; if the configured location fails, locate it using another safe strategy." : deterministicChanges ? "创建一个长路径的作品集组件文件。" : "Read target.txt and report its verified content.",
    NEXORA_DESKTOP_UAT_CONTINUATION: deterministicDocument ? "把趋势图改成折线图并精简结论，其他部分不要动。" : deterministicRecovery || deterministicChanges ? "" : "Read target.txt again and confirm the follow-up remains in this Session.",
    ...(deterministicRecovery ? {
      NEXORA_DESKTOP_UAT_RECOVER_BOUNDARY: "true",
      NEXORA_DESKTOP_UAT_RECOVERY_INPUT: "The configured path failed repeatedly. Search the workspace for the known content, then read the located file and finish."
    } : {}),
    ...(deterministicDocument || deterministicChanges ? { NEXORA_DESKTOP_UAT_AUTO_APPROVE: "true" } : {}),
    ...(deterministicDocument ? { NEXORA_DESKTOP_UAT_EXPECT_DELIVERABLE: "true" } : {}),
    ...(deterministicChanges ? { NEXORA_DESKTOP_UAT_EXPECT_FILE_CHANGES: "1" } : {}),
    ...(deterministic ? { NEXORA_DESKTOP_UAT_EXPECT_CODE_COPY: "true" } : {})
  });

  if (deterministicRecovery) {
    directFixture = mkdtempSync(join(tmpdir(), "nexora-runtime-parity-"));
    writeFileSync(join(directFixture, "target.txt"), "deterministic desktop evidence\n", "utf8");
    const provider = openAICompatibleProviderFromEnv({
      NEXORA_MODEL_PROVIDER: "openai-compatible",
      NEXORA_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      NEXORA_MODEL_API_KEY: "runtime-direct-uat-key",
      NEXORA_MODEL_NAME: "desktop-recovery-parity",
      NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: "128000",
      NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096",
      NEXORA_MODEL_TOOL_TRANSPORT: "structured_output",
      NEXORA_MODEL_STREAM: "false"
    });
    const runtime = createAgent({ workspace: directFixture, provider, tools: createBuiltInTools() });
    try {
      const parent = await runtime.start({
        input: "Read target.txt; if the configured location fails, locate it using another safe strategy.",
        budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
      });
      if (parent.status !== "failed" || parent.stopReason !== "NO_PROGRESS_DETECTED") {
        throw new Error(`Runtime-direct parity parent stopped in ${parent.status}/${String(parent.stopReason)}: ${JSON.stringify(parent.lastError)}.`);
      }
      const child = await runtime.start({
        input: "The configured path failed repeatedly. Search the workspace for the known content, then read the located file and finish.",
        continuation: { parentRunId: parent.runId },
        budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 20, maxRetries: 0, maxDurationMs: 30_000 }
      });
      const inspection = await runtime.inspect(child.runId);
      if (child.status !== "succeeded") throw new Error(`Runtime-direct parity child stopped in ${child.status}/${String(child.stopReason)}.`);
      directParity = {
        parentRunId: parent.runId,
        parentStatus: parent.status,
        parentStopReason: parent.stopReason,
        childRunId: child.runId,
        childStatus: child.status,
        childStopReason: child.stopReason,
        modelCalls: inspection.modelCalls.length,
        invocations: inspection.toolInvocations.map(({ toolName, status }) => ({ toolName, status })),
        evidence: inspection.snapshot.evidence.length
      };
    } finally {
      await runtime.close();
    }
  }
} else if (!existsSync(resolve(repositoryRoot, ".env"))
  && !(process.env.NEXORA_MODEL_BASE_URL && process.env.NEXORA_MODEL_API_KEY && process.env.NEXORA_MODEL_NAME)) {
  throw new Error("Desktop UAT requires Provider configuration in the repository .env or process environment.");
}

const child = spawn(process.execPath, [
  electronCli,
  "--disable-gpu",
  `--user-data-dir=${uatUserData}`,
  resolve(import.meta.dirname, "dist/main.js")
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    ...uatEnvironment,
    NEXORA_DESKTOP_UAT_REPORT_PATH: reportPath,
    NEXORA_DESKTOP_UAT_CAPTURE_PATH: capturePath,
    NEXORA_DESKTOP_UAT_EXPECT_REASONING_STREAM: deterministic ? "true" : "false"
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
if (directFixture !== undefined) rmSync(directFixture, { recursive: true, force: true });
if (uatUserData !== undefined) rmSync(uatUserData, { recursive: true, force: true });
if (exitCode !== 0) throw new Error(`Desktop UAT process exited with code ${exitCode}.`);

const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.status !== "succeeded") throw new Error(`Desktop UAT report status was ${String(report.status)}.`);
if (deterministicRecovery) {
  if (directParity?.childStatus !== "succeeded") throw new Error("Runtime-direct recovery parity did not succeed.");
  if (report.recoveredBoundaryRunId === null || report.runs?.length < 2) {
    throw new Error("Desktop product path did not recover a terminal Run through a continuation turn.");
  }
  const stopped = report.runs.find((run) => run.runId === report.recoveredBoundaryRunId);
  const completed = report.runs.at(-1);
  if (stopped?.status !== "failed" || stopped.stopReason !== "NO_PROGRESS_DETECTED") {
    throw new Error("Desktop product path did not expose the injected no-progress boundary.");
  }
  if (completed?.status !== "succeeded"
    || !completed.invocations.some(({ toolName, status }) => toolName === "filesystem.search" && status === "succeeded")
    || !completed.invocations.some(({ toolName, status }) => toolName === "filesystem.read" && status === "succeeded")
    || completed.evidence < 1) {
    throw new Error("Desktop recovery did not produce authoritative alternative-strategy progress.");
  }
  report.parity = {
    runtimeDirect: directParity,
    productPath: {
      stoppedRunId: stopped.runId,
      stoppedStatus: stopped.status,
      stoppedStopReason: stopped.stopReason,
      completedRunId: completed.runId,
      completedStatus: completed.status,
      modelCalls: completed.modelCalls,
      invocations: completed.invocations,
      evidence: completed.evidence
    },
    firstBrokenBoundary: directParity.childStatus === completed.status ? null : "desktop_product_path"
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (deterministicDocument && report.deliverables?.[0]?.files?.map(({ format }) => format).join(",") !== "docx,xlsx,pptx,pdf") {
  throw new Error("Desktop document UAT did not project all committed Office representations.");
}
if (deterministicChanges && (report.runs?.length !== 1
  || report.runs[0]?.invocations.filter(({ toolName, status }) => toolName === "filesystem.write" && status === "succeeded").length !== 1)) {
  throw new Error("Desktop file-change UAT did not preserve its authoritative single-file turn.");
}
console.log(JSON.stringify({
  runId: report.runId,
  sessionId: report.sessionId,
  runs: report.runIds.length,
  status: report.status,
  invocations: report.invocations.length,
  evidence: report.evidence.length,
  deliverables: report.deliverables?.length ?? 0,
  publicOutputCount: report.publicOutputCount,
  modelProfileCount: report.modelProfileCount,
  parity: report.parity ?? null,
  reportPath,
  capturePath
}, null, 2));
