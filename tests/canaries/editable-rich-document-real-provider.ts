import { resolve } from "node:path";

import { DesktopRuntimeService } from "../../apps/desktop/src/runtime-service.js";

const workspace = resolve(process.argv[2] ?? ".tmp/real-document-acceptance");
const existingSessionId = process.argv[3]?.trim();
const continuationPrompt = process.argv[4]?.trim()
  ?? "只把总营收指标改为¥1,320万，并将说明改为同比增长15.4%；其余内容保持不变，不要重新创建产物。";
const service = new DesktopRuntimeService({
  workspace,
  onSnapshot() {},
  onError(message) { console.error(JSON.stringify({ runtimeError: message })); }
});

try {
  const initial = existingSessionId === undefined
    ? await service.startSession(
        "创建一份包含三个指标、一个表格和一张趋势图的季度经营分析，先完成第一版，不要使用不存在的图片。"
      )
    : await service.continueSession(
        (await service.openSession(workspace, existingSessionId)).session!.id,
        continuationPrompt
      );
  console.log(JSON.stringify({ workspace, sessionId: initial.session?.id, status: initial.session?.inspection.status }));
  const deadline = Date.now() + 180_000;
  let current = initial;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
    current = await service.snapshot();
    const status = current.session?.inspection.status;
    console.log(JSON.stringify({ status, runCount: current.session?.runs.length, deliverableCount: current.session?.deliverables.length }));
    if (status !== undefined && ["succeeded", "blocked", "waiting"].includes(status)) break;
  }
  const latest = current.session?.runs.at(-1)?.inspection;
  console.log(JSON.stringify({
    status: current.session?.inspection.status,
    deliverables: current.session?.deliverables,
    runId: latest?.runId,
    runStatus: latest?.status,
    stopReason: latest?.stopReason,
    lastError: latest?.error,
    invocations: latest?.invocations.map(({ toolName, status }) => ({ toolName, status })),
    evidenceCount: latest?.evidence.length
  }, null, 2));
} finally {
  await service.close();
}
