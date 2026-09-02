import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateDocxPackage } from "../../apps/desktop/src/deliverables/docx-renderer.js";
import { DesktopRuntimeService } from "../../apps/desktop/src/runtime-service.js";

const workspace = resolve(process.argv[2] ?? `.tmp/office-docx-canary-${Date.now()}`);
const initialPrompt = process.argv[3]?.trim() ?? [
  "在普通 Session 中创建一份真实 Word DOCX 文件，主题是县域科技服务调研简报。",
  "包含标题、摘要、三个调研发现、一个两列数据表和后续行动清单。",
  "将文件提交到 Workspace 的 outputs 目录。不要只返回 Markdown、HTML、聊天文本或截图；不要在生成后重新阅读全文或做语义审计。"
].join("");
const continuationPrompt = process.argv[4]?.trim()
  ?? "继续修改刚才同一个 Word 产物：只把摘要改为‘本轮覆盖12家机构’，并在行动清单末尾增加‘建立季度回访机制’；其余关键内容保持不变。";

const errors: string[] = [];
mkdirSync(resolve(workspace, "outputs"), { recursive: true });
const service = new DesktopRuntimeService({
  workspace,
  onSnapshot() {},
  onError(message) { errors.push(message); }
});

try {
  const started = await service.startSession(initialPrompt);
  const first = await waitForTerminal(started.session!.id, 240_000, 1);
  assertSucceededDocx(first, 1);

  const continued = await service.continueSession(first.session!.id, continuationPrompt);
  const second = await waitForTerminal(continued.session!.id, 240_000, 2);
  assertSucceededDocx(second, 2);

  const deliverable = second.session!.deliverables[0]!;
  const docx = deliverable.files.find(({ format }) => format === "docx")!;
  console.log(JSON.stringify({
    workspace,
    sessionId: second.session!.id,
    runIds: second.session!.runs.map(({ inspection }) => inspection.runId),
    status: second.session!.inspection.status,
    deliverable,
    docxPackage: validateDocxPackage(readFileSync(resolve(workspace, docx.path))),
    errors
  }, null, 2));
} finally {
  await service.close();
}

async function waitForTerminal(sessionId: string, timeoutMs: number, minimumRuns: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await service.openSession(workspace, sessionId);
    const status = snapshot.session?.inspection.status;
    if (["succeeded", "failed", "blocked", "cancelled"].includes(status ?? "") && snapshot.session!.runs.length >= minimumRuns) return snapshot;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Office DOCX canary did not reach a terminal state within ${timeoutMs}ms.`);
}

function assertSucceededDocx(snapshot: Awaited<ReturnType<typeof service.snapshot>>, revision: number): void {
  if (snapshot.session?.inspection.status !== "succeeded") {
    throw new Error(`Office DOCX Run ended in ${snapshot.session?.inspection.status}: ${snapshot.session?.inspection.error?.message ?? "unknown error"}`);
  }
  if (snapshot.session.deliverables.length !== 1) throw new Error("Office DOCX canary expected exactly one logical Deliverable.");
  const deliverable = snapshot.session.deliverables[0]!;
  if (deliverable.revision !== revision) throw new Error(`Office DOCX canary expected revision ${revision}, received ${deliverable.revision}.`);
  const docx = deliverable.files.find(({ format }) => format === "docx");
  if (docx === undefined || !existsSync(resolve(workspace, docx.path))) throw new Error("Office DOCX canary did not commit a real DOCX file.");
  const bytes = readFileSync(resolve(workspace, docx.path));
  if (bytes.byteLength !== docx.byteLength) throw new Error("Office DOCX canary file size does not match Runtime facts.");
  validateDocxPackage(bytes);
  if (revision === 2) {
    const source = readFileSync(resolve(workspace, deliverable.manifestPath, "..", "revisions", "000002", "source.json"), "utf8");
    for (const expected of ["本轮覆盖12家机构", "建立季度回访机制"]) {
      if (!source.includes(expected)) throw new Error(`Office DOCX continuation did not persist the requested content: ${expected}.`);
    }
  }
  const latest = snapshot.session.runs.at(-1)!.inspection;
  if (!latest.invocations.some(({ toolName, status }) => ["document.create", "document.apply_patch"].includes(toolName) && status === "succeeded")) {
    throw new Error("Office DOCX canary has no successful document write Invocation.");
  }
  if (latest.evidence.length === 0) throw new Error("Office DOCX canary has no persisted Runtime Evidence.");
}
