import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateDocxPackage } from "../../apps/desktop/src/deliverables/docx-renderer.js";
import { validatePdf } from "../../apps/desktop/src/deliverables/pdf-renderer.js";
import { validatePptxPackage } from "../../apps/desktop/src/deliverables/pptx-renderer.js";
import { validateXlsxPackage } from "../../apps/desktop/src/deliverables/xlsx-renderer.js";
import { DesktopRuntimeService } from "../../apps/desktop/src/runtime-service.js";

const workspace = resolve(process.argv[2] ?? `.tmp/office-multi-format-canary-${Date.now()}`);
mkdirSync(resolve(workspace, "outputs"), { recursive: true });
const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { console.error(JSON.stringify({ runtimeError: message })); } });

try {
  const started = await service.startSession([
    "根据以下经营数据创建同一个逻辑 Deliverable 的三种真实标准文件表示：XLSX、PPTX、PDF。请只调用一次 document.create，使用同一个 outputDirectory，并在 formats 数组中同时指定 xlsx、pptx、pdf；不要按格式拆成多个 Deliverable。",
    "北区收入120、续费率92%；南区收入98、续费率88%；季度收入趋势80、96、120。",
    "三种表示使用相同结构化内容，包含标题、核心指标、区域数据表、趋势图和三项行动建议。三个文件必须提交到Workspace，不能用Markdown、HTML、截图或聊天文本替代，也不要生成后默认阅读全文审计。"
  ].join(""));
  const first = await waitForTerminal(started.session!.id, 300_000, 1);
  const firstFiles = await assertSucceeded(first, 1, ["xlsx", "pptx", "pdf"]);

  await service.continueSession(first.session!.id, "继续修改这个唯一 Deliverable：只把北区收入更新为135，并增加行动建议‘优化重点客户续费节奏’；其他关键内容保持不变，在同一新 revision 中重新生成原来的XLSX、PPTX和PDF。无需全文语义审计。");
  const second = await waitForTerminal(first.session!.id, 300_000, 2);
  const secondFiles = await assertSucceeded(second, 2, ["xlsx", "pptx", "pdf"]);
  for (const format of ["xlsx", "pptx", "pdf"] as const) {
    if (firstFiles.get(format) === secondFiles.get(format)) throw new Error(`${format.toUpperCase()} digest did not change after the requested revision.`);
  }
  const deliverable = second.session!.deliverables[0]!;
  const sourcePath = resolve(workspace, deliverable.manifestPath, "..", "revisions", "000002", "source.json");
  const source = readFileSync(sourcePath, "utf8");
  for (const expected of ["135", "优化重点客户续费节奏"]) if (!source.includes(expected)) throw new Error(`Continuation source is missing ${expected}.`);

  await service.continueSession(first.session!.id, "不修改内容，只把这个唯一 Deliverable 的当前 revision 额外导出为 DOCX。先按需 inspect，然后调用一次 document.export；不要重建 Deliverable，也不要默认全文语义审计。");
  const third = await waitForTerminal(first.session!.id, 300_000, 3);
  await assertSucceeded(third, 3, ["xlsx", "pptx", "pdf", "docx"]);
  const latest = third.session!.runs.at(-1)!.inspection;
  if (!latest.invocations.some(({ toolName, status }) => toolName === "document.export" && status === "succeeded")) throw new Error("No successful document.export Invocation.");
  const exported = third.session!.deliverables[0]!;
  console.log(JSON.stringify({
    workspace,
    sessionId: third.session!.id,
    runIds: third.session!.runs.map(({ inspection }) => inspection.runId),
    status: third.session!.inspection.status,
    revision: exported.revision,
    files: exported.files,
    changedBlockIds: exported.changedBlockIds,
    preservedBlockCount: exported.preservedBlockCount
  }, null, 2));
} finally {
  await service.close();
}

async function waitForTerminal(sessionId: string, timeoutMs: number, minimumRuns: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await service.openSession(workspace, sessionId);
    if (["succeeded", "failed", "blocked", "cancelled"].includes(snapshot.session?.inspection.status ?? "") && snapshot.session!.runs.length >= minimumRuns) return snapshot;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Office multi-format canary did not reach a terminal state within ${timeoutMs}ms.`);
}

async function assertSucceeded(snapshot: Awaited<ReturnType<typeof service.snapshot>>, revision: number, expectedFormats: readonly string[]): Promise<Map<string, string>> {
  if (snapshot.session?.inspection.status !== "succeeded") throw new Error(`Office multi-format Run ended in ${snapshot.session?.inspection.status}: ${snapshot.session?.inspection.error?.message ?? "unknown error"}`);
  if (snapshot.session.deliverables.length !== 1 || snapshot.session.deliverables[0]!.revision !== revision) throw new Error(`Expected one revision ${revision} Deliverable.`);
  const deliverable = snapshot.session.deliverables[0]!;
  if (deliverable.files.map(({ format }) => format).join(",") !== expectedFormats.join(",")) throw new Error(`Expected committed ${expectedFormats.join(", ").toUpperCase()} representations.`);
  for (const file of deliverable.files) {
    const bytes = readFileSync(resolve(workspace, file.path));
    if (bytes.byteLength !== file.byteLength) throw new Error(`${file.format.toUpperCase()} byte length does not match Runtime facts.`);
    if (file.format === "docx") validateDocxPackage(bytes);
    else if (file.format === "xlsx") validateXlsxPackage(bytes);
    else if (file.format === "pptx") validatePptxPackage(bytes);
    else if (file.format === "pdf") await validatePdf(bytes);
  }
  const latest = snapshot.session.runs.at(-1)!.inspection;
  if (!latest.invocations.some(({ toolName, status }) => ["document.create", "document.apply_patch", "document.export"].includes(toolName) && status === "succeeded")) throw new Error("No successful Office write Invocation.");
  if (latest.evidence.length === 0) throw new Error("No persisted Runtime Evidence.");
  return new Map(deliverable.files.map((file) => [file.format, file.digest]));
}
