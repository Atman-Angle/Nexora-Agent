import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RichDocumentCreateInputSchema,
  RichDocumentPatchInputSchema
} from "../../apps/desktop/src/deliverables/contracts.js";
import {
  compileAuthoringCreateInput,
  RichDocumentAuthoringCreateInputSchema
} from "../../apps/desktop/src/deliverables/authoring.js";
import { projectDeliverables } from "../../apps/desktop/src/deliverables/projection.js";
import {
  createRichDocument,
  inspectRichDocument,
  patchRichDocument,
  readRichDocumentPreview
} from "../../apps/desktop/src/deliverables/rich-document.js";
import { createRichDocumentTools } from "../../apps/desktop/src/deliverables/tools.js";
import { DesktopRuntimeService, desktopToolApprovalPolicy } from "../../apps/desktop/src/runtime-service.js";
import { responseRejectionDiagnostic } from "../../packages/runtime/src/runtime-helpers.js";

const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E135 editable rich-document Deliverable", () => {
  it("compiles model-friendly text and table cells into the strict persisted document shape", () => {
    const compiled = compileAuthoringCreateInput({
      outputDirectory: "outputs/quarterly-review",
      title: "Quarterly Review",
      theme: documentTheme(),
      blocks: [
        { blockId: "title", type: "heading", level: 1, runs: "Quarterly Review" },
        {
          blockId: "performance",
          type: "table",
          headers: ["Department", "Revenue", "Completion"],
          rows: [["Sales", "3150", "105%"], ["Marketing", "980", "98%"]]
        }
      ]
    });

    expect(compiled.blocks).toEqual([
      { blockId: "title", type: "heading", level: 1, runs: [{ text: "Quarterly Review" }] },
      {
        blockId: "performance",
        type: "table",
        headers: [[{ text: "Department" }], [{ text: "Revenue" }], [{ text: "Completion" }]],
        rows: [
          [[{ text: "Sales" }], [{ text: "3150" }], [{ text: "105%" }]],
          [[{ text: "Marketing" }], [{ text: "980" }], [{ text: "98%" }]]
        ]
      }
    ]);
    expect(RichDocumentCreateInputSchema.parse(compiled)).toEqual(compiled);
  });

  it("rejects ambiguous table nesting, unknown inline styling, and oversized create batches", () => {
    const base = {
      outputDirectory: "outputs/quarterly-review",
      title: "Quarterly Review",
      theme: documentTheme()
    };
    const malformedTable = RichDocumentAuthoringCreateInputSchema.safeParse({
      ...base,
      blocks: [{
        blockId: "performance",
        type: "table",
        headers: [["Department", "Revenue"]],
        rows: [[["Sales", "3150"]]]
      }]
    });
    const unknownStyle = RichDocumentAuthoringCreateInputSchema.safeParse({
      ...base,
      blocks: [{ blockId: "metric", type: "metric", label: "Revenue", value: "3150", delta: [{ text: "+5%", color: "#10b981" }] }]
    });
    const oversized = RichDocumentAuthoringCreateInputSchema.safeParse({
      ...base,
      blocks: Array.from({ length: 33 }, (_, index) => ({ blockId: `p-${index}`, type: "paragraph", runs: "text" }))
    });
    const mismatchedColumns = RichDocumentAuthoringCreateInputSchema.safeParse({
      ...base,
      blocks: [{ blockId: "performance", type: "table", headers: ["Department", "Revenue"], rows: [["Sales"]] }]
    });

    expect(malformedTable.success).toBe(false);
    expect(malformedTable.error?.issues.length).toBeGreaterThan(0);
    expect(unknownStyle.success).toBe(false);
    expect(unknownStyle.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    expect(oversized.success).toBe(false);
    expect(oversized.error?.issues.some((issue) => issue.path.join(".") === "blocks" && issue.code === "too_big")).toBe(true);
    expect(mismatchedColumns.success).toBe(false);
    expect(mismatchedColumns.error?.issues.some((issue) => issue.path.join(".").endsWith("rows.0") && issue.message.includes("Expected 2 cells"))).toBe(true);
  });

  it("projects actionable leaf paths for union schema failures", () => {
    const input = {
      outputDirectory: "outputs/quarterly-review",
      title: "Quarterly Review",
      theme: documentTheme(),
      blocks: [{ blockId: "performance", type: "table", headers: [["Department", "Revenue"]], rows: [[["Sales", "3150"]]] }]
    };
    const parsed = RichDocumentAuthoringCreateInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    const diagnostic = responseRejectionDiagnostic((parsed as { success: false; error: z.ZodError }).error, input);
    expect(diagnostic.issues.some((issue) => issue.path.includes("headers.0"))).toBe(true);
    expect(diagnostic.issues.every((issue) => issue.message !== "Invalid input")).toBe(true);
  });

  it("creates a polished immutable revision with local image, table, chart and inert HTML", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "brand.png"), pngFixture());

    const created = await createRichDocument(workspace, "invocation-create", createInput(), signal);

    expect(created).toMatchObject({
      revision: 1,
      validation: "passed",
      blockCount: 7,
      assetCount: 1,
      insertedBlockIds: ["title", "summary", "metrics", "revenue", "brand", "table", "chart"]
    });
    expect(readFileSync(join(workspace, created.manifestPath), "utf8")).toContain('"currentRevision": 1');
    expect(readFileSync(join(workspace, "outputs", "board-report", "revisions", "000001", "source.json"), "utf8")).toContain("<script>alert(1)</script>");

    const preview = readRichDocumentPreview(workspace, created.manifestPath, created.revision, created.previewDigest).html;
    expect(preview).toContain("Content-Security-Policy");
    expect(preview).toContain("script-src 'none'");
    expect(preview).toContain("navigate-to 'none'");
    expect(preview).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(preview).not.toMatch(/<script\b/iu);
    expect(preview).toContain("<table>");
    expect(preview).toContain("<svg");
    expect(preview).toContain('src="data:image/png;base64,');
    expect(readFileSync(join(workspace, created.previewPath), "utf8")).toMatch(/assets\/[a-f0-9]{64}\.png/u);
  });

  it("patches only addressed blocks, preserves revision one, and recovers idempotently", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "brand.png"), pngFixture());
    const created = await createRichDocument(workspace, "invocation-create", createInput(), signal);
    const beforeSource = readFileSync(join(workspace, "outputs", "board-report", "revisions", "000001", "source.json"), "utf8");
    const patch = RichDocumentPatchInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: created.revision,
      expectedSourceDigest: created.sourceDigest,
      operations: [{
        type: "replace_block",
        targetBlockId: "summary",
        block: { blockId: "summary", type: "paragraph", runs: [{ text: "董事会已确认新的执行重点。", bold: true }] }
      }]
    });

    const revised = await patchRichDocument(workspace, "invocation-patch", patch, signal);
    const replayed = await patchRichDocument(workspace, "invocation-patch", patch, signal);

    expect(revised).toMatchObject({ revision: 2, changedBlockIds: ["summary"], preservedBlockCount: 6 });
    expect(replayed).toEqual(revised);
    expect(readFileSync(join(workspace, "outputs", "board-report", "revisions", "000001", "source.json"), "utf8")).toBe(beforeSource);
    expect(readFileSync(join(workspace, "outputs", "board-report", "revisions", "000002", "source.json"), "utf8")).toContain("董事会已确认新的执行重点。");
    const revisionOne = JSON.parse(beforeSource) as { blocks: Array<{ blockId: string }> };
    expect(inspectRichDocument(workspace, created.manifestPath).source.blocks.find(({ blockId }) => blockId === "chart")).toEqual(
      revisionOne.blocks.find(({ blockId }) => blockId === "chart")
    );
  });

  it("rejects stale writes and Workspace path traversal without committing a revision", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "brand.png"), pngFixture());
    const created = await createRichDocument(workspace, "invocation-create", createInput(), signal);
    const patch = RichDocumentPatchInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: created.sourceDigest,
      operations: [{ type: "set_title", title: "Revision two" }]
    });
    await patchRichDocument(workspace, "invocation-patch", patch, signal);

    await expect(patchRichDocument(workspace, "stale-invocation", patch, signal)).rejects.toMatchObject({ code: "DELIVERABLE_CONFLICT" });
    expect(() => inspectRichDocument(workspace, "../outside/manifest.nexora.json")).toThrowError(expect.objectContaining({ code: "WORKSPACE_BOUNDARY_VIOLATION" }));
    expect(() => readFileSync(join(workspace, "outputs", "board-report", "revisions", "000003", "source.json"))).toThrow();

    const outside = createWorkspace();
    symlinkSync(outside, join(workspace, "linked-output"), "junction");
    await expect(createRichDocument(workspace, "linked-create", RichDocumentCreateInputSchema.parse({
      ...createInput(), outputDirectory: "linked-output/report"
    }), signal)).rejects.toMatchObject({ code: "WORKSPACE_BOUNDARY_VIOLATION" });
    expect(existsSync(join(outside, "report"))).toBe(false);
  });

  it("recovers a committed revision after a lost manifest update and cleans failed pre-commit creates", async () => {
    const workspace = createWorkspace();
    const input = createInput();
    await expect(createRichDocument(workspace, "invocation-create", input, signal)).rejects.toMatchObject({ code: "INVALID_DOCUMENT_ASSET" });

    writeFileSync(join(workspace, "brand.png"), pngFixture());
    const created = await createRichDocument(workspace, "invocation-create", input, signal);
    const manifestPath = join(workspace, created.manifestPath);
    const revisionOneManifest = readFileSync(manifestPath, "utf8");
    const patch = RichDocumentPatchInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: created.sourceDigest,
      operations: [{ type: "set_title", title: "Recovered revision" }]
    });
    const committed = await patchRichDocument(workspace, "recover-patch", patch, signal);
    writeFileSync(manifestPath, revisionOneManifest, "utf8");

    const recovered = await patchRichDocument(workspace, "recover-patch", patch, signal);
    expect(recovered).toEqual(committed);
    expect(inspectRichDocument(workspace, created.manifestPath).manifest).toMatchObject({ currentRevision: 2, title: "Recovered revision" });
    expect(existsSync(join(workspace, "outputs", "board-report", "revisions", "000003"))).toBe(false);
  });

  it("projects the latest successful revision as one restart-safe Session output", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "brand.png"), pngFixture());
    const created = await createRichDocument(workspace, "invocation-create", createInput(), signal);
    const revised = await patchRichDocument(workspace, "invocation-patch", RichDocumentPatchInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: created.revision,
      expectedSourceDigest: created.sourceDigest,
      operations: [{ type: "set_title", title: "Board report · revised" }]
    }), signal);

    const projected = projectDeliverables([
      { runId: "run-create", invocations: [{ toolName: "document.create", status: "succeeded", resultJson: created }] },
      { runId: "run-revise", invocations: [{ toolName: "document.apply_patch", status: "succeeded", resultJson: revised }] }
    ]);

    expect(projected).toEqual([expect.objectContaining({ revision: 2, title: "Board report · revised", sourceRunId: "run-revise" })]);
    const reopened = readRichDocumentPreview(workspace, projected[0]!.manifestPath, projected[0]!.revision, projected[0]!.previewDigest);
    expect(reopened.html).toContain('data-revision="2"');
  });

  it("registers bounded document tools, exact auto-approval and the sandboxed Output view", () => {
    expect(createRichDocumentTools().map(({ contract }) => contract.identity.name)).toEqual([
      "document.create",
      "document.import",
      "document.read_source",
      "document.inspect",
      "document.apply_patch",
      "document.apply_native_patch",
      "document.export"
    ]);
    expect(desktopToolApprovalPolicy("document.create")).toBe("auto_approve");
    expect(desktopToolApprovalPolicy("document.apply_patch")).toBe("auto_approve");
    expect(desktopToolApprovalPolicy("document.apply_native_patch")).toBe("auto_approve");
    expect(desktopToolApprovalPolicy("document.import")).toBe("auto_approve");
    expect(desktopToolApprovalPolicy("document.export")).toBe("auto_approve");
    expect(desktopToolApprovalPolicy("document.inspect")).toBe("require_user");
    expect(desktopToolApprovalPolicy("document.delete")).toBe("require_user");

    const renderer = readFileSync(resolve("apps/desktop/src/renderer/app.ts"), "utf8");
    const preload = readFileSync(resolve("apps/desktop/src/preload.cjs"), "utf8");
    expect(renderer).toContain('sandbox="allow-same-origin"');
    expect(renderer).toContain("readDeliverable(");
    expect(renderer).toContain('data-view="output"');
    expect(preload).toContain('ipcRenderer.invoke("desktop:read-deliverable"');
  });

  it("runs create, inspect, patch, Desktop restart and another patch through real Runtime authorities", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "brand.png"), pngFixture());
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      calls += 1;
      const manifest = () => JSON.parse(readFileSync(join(workspace, "outputs", "board-report", "manifest.nexora.json"), "utf8")) as { currentRevision: number; sourceDigest: string };
      const content = calls === 1
        ? toolResponse("document.create", createInput())
        : calls === 2
          ? toolResponse("nexora_respond", { text: "已创建可继续修改的经营简报。" })
          : calls === 3 || calls === 6
            ? toolResponse("document.inspect", { manifestPath: "outputs/board-report/manifest.nexora.json", mode: "blocks", blockIds: [calls === 3 ? "summary" : "title"] })
            : calls === 4
              ? toolResponse("document.apply_patch", {
                manifestPath: "outputs/board-report/manifest.nexora.json",
                expectedRevision: manifest().currentRevision,
                expectedSourceDigest: manifest().sourceDigest,
                operations: [{ type: "replace_block", targetBlockId: "summary", block: { blockId: "summary", type: "paragraph", runs: [{ text: "第二轮仅更新摘要。" }] } }]
              })
              : calls === 5
                ? toolResponse("nexora_respond", { text: "已按范围更新摘要，其他内容保持不变。" })
                : calls === 7
                  ? toolResponse("document.apply_patch", {
                    manifestPath: "outputs/board-report/manifest.nexora.json",
                    expectedRevision: manifest().currentRevision,
                    expectedSourceDigest: manifest().sourceDigest,
                    operations: [{ type: "set_title", title: "Board report · final" }]
                  })
                  : toolResponse("nexora_respond", { text: "重启后已继续修改同一产物。" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server did not bind.");
    writeFileSync(join(workspace, ".env"), [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-key",
      "NEXORA_MODEL_NAME=desktop-document-test",
      "NEXORA_MODEL_CONTEXT_WINDOW_TOKENS=128000",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
    ].join("\n"), "utf8");

    let service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    try {
      await service.startSession("创建一份包含图表、表格和图片的经营简报。");
      const first = await waitForStatus(service, "succeeded", 15_000);
      expect(first.session?.deliverables).toEqual([expect.objectContaining({ revision: 1 })]);
      expect(first.session?.history.records.filter(({ type }) => type === "approval.granted")).toHaveLength(1);

      await service.continueSession(first.session!.id, "只修改摘要，其他部分不要动。");
      const second = await waitForStatus(service, "succeeded", 15_000, 2);
      expect(second.session?.deliverables).toEqual([expect.objectContaining({ revision: 2, changedBlockIds: ["summary"], preservedBlockCount: 6 })]);
      expect(second.session?.runs[1]?.inspection.invocations.map(({ toolName }) => toolName)).toEqual(["document.inspect", "document.apply_patch"]);
      expect(second.session?.runs[1]?.inspection.evidence.length).toBeGreaterThan(0);

      const sessionId = second.session!.id;
      await service.close();
      service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
      const reopened = await service.openSession(workspace, sessionId);
      expect(reopened.session?.deliverables).toEqual([expect.objectContaining({ revision: 2 })]);
      const preview = await service.readDeliverable(workspace, reopened.session!.deliverables[0]!.manifestPath, 2, reopened.session!.deliverables[0]!.previewDigest);
      expect(preview.html).toContain("第二轮仅更新摘要。");

      await service.continueSession(sessionId, "把标题改成最终版。");
      const third = await waitForStatus(service, "succeeded", 15_000, 3);
      expect(third.session?.deliverables).toEqual([expect.objectContaining({ revision: 3, title: "Board report · final" })]);
      expect(third.session?.runs[2]?.inspection.invocations.map(({ toolName }) => toolName)).toEqual(["document.inspect", "document.apply_patch"]);
      expect(calls).toBe(8);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 20_000);
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e135-document-"));
  roots.push(workspace);
  return workspace;
}

function documentTheme() {
  return {
    pageWidth: "wide" as const,
    surface: "light" as const,
    primaryColor: "#2563eb",
    accentColor: "#0ea5e9",
    font: "system" as const,
    spacing: "comfortable" as const,
    corners: "rounded" as const
  };
}

function createInput() {
  return RichDocumentCreateInputSchema.parse({
    outputDirectory: "outputs/board-report",
    title: "Board report",
    locale: "zh-CN",
    theme: documentTheme(),
    blocks: [
      { blockId: "title", type: "heading", level: 1, runs: [{ text: "董事会经营简报" }] },
      { blockId: "summary", type: "paragraph", runs: [{ text: "<script>alert(1)</script> 这是安全转义的摘要。" }] },
      {
        blockId: "metrics",
        type: "columns",
        columns: [[{ blockId: "revenue", type: "metric", label: [{ text: "收入" }], value: [{ text: "¥12.8M" }], delta: [{ text: "+18%" }] }], [{ blockId: "brand", type: "image", assetPath: "brand.png", alt: "品牌图", fit: "contain" }]]
      },
      { blockId: "table", type: "table", headers: [[{ text: "区域" }], [{ text: "收入" }]], rows: [[[{ text: "华东" }], [{ text: "680" }]], [[{ text: "华南" }], [{ text: "420" }]]], align: ["left", "right"] },
      { blockId: "chart", type: "chart", chartType: "bar", title: "季度趋势", categories: ["Q1", "Q2", "Q3"], series: [{ name: "收入", values: [320, 410, 520] }], showLegend: true }
    ]
  });
}

function toolResponse(name: string, argumentsValue: unknown) {
  return { text: null, toolCalls: [{ name, arguments: argumentsValue }], finishReason: "tool_calls" };
}

function pngFixture(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
}

async function waitForStatus(service: DesktopRuntimeService, status: string, timeoutMs: number, minimumRuns = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await service.snapshot();
    if (snapshot.session?.inspection.status === status && snapshot.session.runs.length >= minimumRuns) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Desktop Session did not reach ${status} with ${minimumRuns} Run(s).`);
}
import { createServer } from "node:http";
