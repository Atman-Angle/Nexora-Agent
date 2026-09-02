import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error docx publishes declarations through package exports rather than beside its concrete ESM bundle.
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "../../apps/desktop/node_modules/docx/dist/index.mjs";
// These fixture writers are package-local production dependencies; the tests import their concrete files so root dependency resolution stays unchanged.
// @ts-expect-error ExcelJS publishes its declarations at the package root rather than beside excel.js.
import ExcelJS from "../../apps/desktop/node_modules/exceljs/excel.js";
import { unzipSync, zipSync } from "../../apps/desktop/node_modules/fflate/esm/index.mjs";
// @ts-expect-error PptxGenJS publishes declarations separately from its ESM bundle.
import pptxgen from "../../apps/desktop/node_modules/pptxgenjs/dist/pptxgen.es.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  importOfficeDocument,
  inspectOfficeSource,
  inspectImportedOffice,
  patchImportedOffice,
  readImportedOfficePreview
} from "../../apps/desktop/src/deliverables/imported-office.js";
import { createRichDocumentTools } from "../../apps/desktop/src/deliverables/tools.js";
import { ImportedOfficePatchInputSchema } from "../../apps/desktop/src/deliverables/contracts.js";
import { DesktopRuntimeService } from "../../apps/desktop/src/runtime-service.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("E138 existing Office attachment editing", () => {
  it("reads DOCX, XLSX and PPTX reference sources without creating a Deliverable", async () => {
    const workspace = createWorkspace();
    const sources = [
      ["references/report.docx", await docxFixture()],
      ["references/data.xlsx", await xlsxFixture()],
      ["references/deck.pptx", await pptxFixture()]
    ] as const;
    mkdirSync(join(workspace, "references"), { recursive: true });
    for (const [path, bytes] of sources) {
      writeFileSync(join(workspace, path), bytes);
      const inspected = inspectOfficeSource(workspace, { path, expectedDigest: digest(bytes), mode: "outline" });
      expect(inspected).toMatchObject({ path, digest: digest(bytes), validation: "passed" });
      expect(inspected.targetCount).toBeGreaterThan(0);
      expect(inspected.outline.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(workspace, "outputs"))).toBe(false);
    expect(existsSync(join(workspace, ".nexora", "deliverables"))).toBe(false);
  });

  it("normalizes only canonical integer revision strings and keeps generated/native patch contracts disjoint", () => {
    const digestValue = `sha256:${"0".repeat(64)}`;
    expect(ImportedOfficePatchInputSchema.parse({
      manifestPath: "outputs/imported/manifest.nexora.json",
      expectedRevision: "1",
      expectedSourceDigest: digestValue,
      operations: [{ type: "replace_text", targetId: "docx.p.0001", text: "updated" }]
    }).expectedRevision).toBe(1);
    expect(() => ImportedOfficePatchInputSchema.parse({
      manifestPath: "outputs/imported/manifest.nexora.json",
      expectedRevision: "01",
      expectedSourceDigest: digestValue,
      operations: [{ type: "replace_text", targetId: "docx.p.0001", text: "updated" }]
    })).toThrow();
    const tools = createRichDocumentTools();
    const generated = tools.find(({ contract }) => contract.identity.name === "document.apply_patch")!;
    const native = tools.find(({ contract }) => contract.identity.name === "document.apply_native_patch")!;
    const nativeInput = {
      manifestPath: "outputs/imported/manifest.nexora.json",
      expectedRevision: 1,
      expectedSourceDigest: digestValue,
      operations: [{ type: "replace_text", targetId: "docx.p.0001", text: "updated" }]
    };
    expect(generated.contract.execution.inputSchema.safeParse(nativeInput).success).toBe(false);
    expect(native.contract.execution.inputSchema.safeParse(nativeInput).success).toBe(true);
  });

  it("uses mixed text and Office files as bounded reference material before creating a new Office Deliverable", async () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "references"), { recursive: true });
    writeFileSync(join(workspace, "references", "brief.txt"), "TXT reference: retain 120 revenue.\n", "utf8");
    writeFileSync(join(workspace, "references", "notes.md"), "# MD reference\nUse a concise summary.\n", "utf8");
    writeFileSync(join(workspace, "references", "report.docx"), await docxFixture());
    writeFileSync(join(workspace, "references", "data.xlsx"), await xlsxFixture());
    writeFileSync(join(workspace, "references", "deck.pptx"), await pptxFixture());
    const requests: string[] = [];
    let calls = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requests.push(body);
      calls += 1;
      const content = calls === 1
        ? multiToolResponse([
          ["filesystem.read", { path: "references/brief.txt" }],
          ["filesystem.read", { path: "references/notes.md" }],
          ["document.read_source", { path: "references/report.docx", mode: "blocks", targetIds: ["docx.p.0001", "docx.p.0004"] }],
          ["document.read_source", { path: "references/data.xlsx", mode: "blocks", targetIds: ["xlsx.sheet.0001.cell.a3", "xlsx.sheet.0001.cell.b3"] }],
          ["document.read_source", { path: "references/deck.pptx", mode: "blocks", targetIds: ["pptx.slide.0004"] }]
        ])
        : calls === 2
          ? toolResponse("document.create", {
            outputDirectory: "outputs/mixed-reference",
            title: "Mixed reference summary",
            locale: "en-US",
            formats: ["docx"],
            theme: { pageWidth: "standard", surface: "light", primaryColor: "#2563eb", accentColor: "#0ea5e9", font: "system", spacing: "comfortable", corners: "rounded" },
            blocks: [
              { blockId: "title", type: "heading", level: 1, runs: "Mixed reference summary" },
              { blockId: "summary", type: "paragraph", runs: "Revenue 120 with a concise market summary." }
            ]
          })
          : calls === 3
            ? toolResponse("document.inspect", { manifestPath: "outputs/mixed-reference/manifest.nexora.json", mode: "summary" })
            : toolResponse("nexora_respond", { text: "Created the requested Office summary from the supplied references." });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Provider fixture did not bind.");
    writeProviderEnv(workspace, address.port, "mixed-reference-test");
    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    try {
      await service.startSession("Read all TXT, MD, DOCX, XLSX and PPTX files under references and create a new Word summary.");
      const completed = await waitForStatus(service, "succeeded", 15_000, 1);
      expect(completed.session?.deliverables).toEqual([expect.objectContaining({ revision: 1, stage: "created", files: [expect.objectContaining({ format: "docx" })] })]);
      const invocations = completed.session!.inspection.invocations;
      expect(invocations.filter(({ toolName }) => toolName === "document.read_source")).toHaveLength(3);
      expect(invocations.filter(({ toolName }) => toolName === "filesystem.read")).toHaveLength(2);
      expect(invocations.some(({ toolName, inputJson }) => toolName === "filesystem.read" && /\.(docx|xlsx|pptx)$/u.test(String((inputJson as { path?: string }).path)))).toBe(false);
      expect(invocations.some(({ toolName }) => toolName === "document.import")).toBe(false);
      expect(requests[1]).toContain("第三章原始内容，收入 120");
      expect(requests[1]).toContain("August");
      expect(requests[1]).toContain("第四页旧标题");
      expect(calls).toBe(4);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 25_000);

  it("replays stringified report blocks through generic normalization and the real document.create contract", async () => {
    const workspace = createWorkspace();
    const blocks = [
      { blockId: "title", type: "heading", level: 1, runs: "澄屿咖啡 2026 Q2 经营诊断与 Q3 行动方案" },
      { blockId: "summary", type: "paragraph", runs: "执行摘要：Q2 经营事实与 Q3 四周试点建议。" }
    ];
    const encodedBlocks = JSON.stringify(blocks);
    let calls = 0;
    const server = createServer(async (_request, response) => {
      calls += 1;
      const content = calls === 1
        ? toolResponse("document.create", {
          outputDirectory: "outputs/stringified-blocks",
          title: "澄屿咖啡 2026 Q2 经营诊断与 Q3 行动方案",
          locale: "zh-CN",
          formats: ["docx"],
          theme: { pageWidth: "standard", surface: "light", primaryColor: "#2563eb", accentColor: "#0ea5e9", font: "system", spacing: "comfortable", corners: "rounded" },
          blocks: encodedBlocks
        })
        : calls === 2
          ? toolResponse("document.inspect", { manifestPath: "outputs/stringified-blocks/manifest.nexora.json", mode: "summary" })
          : toolResponse("nexora_respond", { text: "已生成并检查真实 Word Deliverable。" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Provider fixture did not bind.");
    writeProviderEnv(workspace, address.port, "stringified-blocks-replay");
    const service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    try {
      await service.startSession("Generate the Word report from the already-read source facts.");
      const completed = await waitForStatus(service, "succeeded", 15_000, 1);
      expect(calls).toBe(3);
      expect(completed.session?.deliverables).toEqual([expect.objectContaining({
        revision: 1,
        stage: "created",
        validation: "passed",
        files: [expect.objectContaining({ format: "docx" })]
      })]);
      expect(completed.session?.inspection.invocations).toEqual([
        expect.objectContaining({ toolName: "document.create", status: "succeeded", inputJson: expect.objectContaining({ blocks }) }),
        expect.objectContaining({ toolName: "document.inspect", status: "succeeded" })
      ]);
      expect(completed.session?.history.records.map((event) => event.type)).not.toContain("response.rejected");
      const creationTurn = completed.session?.history.records.find((event) => (
        event.type === "model.turn"
        && Array.isArray(event.payload.toolCalls)
        && (event.payload.toolCalls[0] as { name?: unknown } | undefined)?.name === "document.create"
      ));
      expect(creationTurn?.payload).toMatchObject({
        toolCalls: [{
          name: "document.create",
          providerArguments: { blocks: encodedBlocks },
          normalizedArguments: { blocks },
          argumentNormalization: [{ path: "/blocks", kind: "json_array" }]
        }]
      });
      const documentPath = join(workspace, "outputs", "stringified-blocks", "revisions", "000001", "document.docx");
      const entries = unzipSync(readFileSync(documentPath));
      expect(entries["word/document.xml"]).toBeDefined();
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 25_000);

  it("imports an independently authored DOCX, changes one paragraph and preserves unrelated package content", async () => {
    const workspace = createWorkspace();
    const attachmentPath = join(workspace, "attachments", "existing-report.docx");
    const bytes = await docxFixture();
    writeFileSync(attachmentPath, bytes);
    const imported = await importOfficeDocument(workspace, "import-docx", {
      attachmentPath: "attachments/existing-report.docx",
      attachmentDigest: digest(bytes),
      outputDirectory: "outputs/existing-report",
      title: "Existing report"
    }, signal());

    const outline = inspectImportedOffice(workspace, { manifestPath: imported.manifestPath, mode: "outline" });
    expect(outline.outline.map(({ blockId }) => blockId)).toContain("docx.p.0003");
    const target = inspectImportedOffice(workspace, { manifestPath: imported.manifestPath, mode: "blocks", blockIds: ["docx.p.0004"] });
    expect(target.blocks[0]).toMatchObject({ text: "第三章原始内容，收入 120，需要缩短。" });

    const beforeEntries = unzipSync(bytes);
    const patched = await patchImportedOffice(workspace, "patch-docx", {
      manifestPath: imported.manifestPath,
      expectedRevision: imported.revision,
      expectedSourceDigest: imported.sourceDigest,
      operations: [{ type: "replace_text", targetId: "docx.p.0004", text: "第三章精简内容。" }]
    }, signal());
    expect(patched).toMatchObject({ revision: 2, changedBlockIds: ["docx.p.0004"] });
    const afterBytes = readFileSync(join(workspace, patched.files[0]!.path));
    const afterEntries = unzipSync(afterBytes);
    expect(Buffer.from(afterEntries["word/styles.xml"]!)).toEqual(Buffer.from(beforeEntries["word/styles.xml"]!));
    expect(Buffer.from(afterEntries["docProps/core.xml"]!)).toEqual(Buffer.from(beforeEntries["docProps/core.xml"]!));
    const reopened = inspectImportedOffice(workspace, { manifestPath: patched.manifestPath, mode: "blocks", blockIds: ["docx.p.0002", "docx.p.0004"] });
    expect(reopened.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "docx.p.0002", text: "第一章保持不变。" }),
      expect.objectContaining({ targetId: "docx.p.0004", text: "第三章精简内容。" })
    ]));
  });

  it("updates one XLSX cell, preserves the other sheet and requests formula recalculation", async () => {
    const workspace = createWorkspace();
    const attachmentPath = join(workspace, "attachments", "existing-data.xlsx");
    const bytes = await xlsxFixture();
    writeFileSync(attachmentPath, bytes);
    const imported = await importOfficeDocument(workspace, "import-xlsx", {
      attachmentPath: "attachments/existing-data.xlsx",
      attachmentDigest: digest(bytes),
      outputDirectory: "outputs/existing-data"
    }, signal());
    const beforeEntries = unzipSync(bytes);
    const patched = await patchImportedOffice(workspace, "patch-xlsx", {
      manifestPath: imported.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: imported.sourceDigest,
      operations: [{ type: "set_cell", targetId: "xlsx.sheet.0001.cell.b3", value: 135 }]
    }, signal());
    const afterBytes = readFileSync(join(workspace, patched.files[0]!.path));
    const afterEntries = unzipSync(afterBytes);
    expect(Buffer.from(afterEntries["xl/worksheets/sheet2.xml"]!)).toEqual(Buffer.from(beforeEntries["xl/worksheets/sheet2.xml"]!));
    expect(Buffer.from(afterEntries["xl/styles.xml"]!)).toEqual(Buffer.from(beforeEntries["xl/styles.xml"]!));
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(afterBytes.buffer.slice(afterBytes.byteOffset, afterBytes.byteOffset + afterBytes.byteLength) as ArrayBuffer);
    expect(reopened.getWorksheet("Data")!.getCell("B3").value).toBe(135);
    expect(reopened.getWorksheet("Data")!.getCell("C3").value).toMatchObject({ formula: "B3*2" });
    expect(reopened.getWorksheet("Keep")!.getCell("A1").value).toBe("untouched sheet");
    expect(Buffer.from(afterEntries["xl/workbook.xml"]!).toString("utf8")).toContain('fullCalcOnLoad="1"');
  });

  it("applies one stable complex DOCX batch while preserving unrelated package parts and revision one", async () => {
    const workspace = createWorkspace();
    const attachmentPath = join(workspace, "attachments", "complex-report.docx");
    const bytes = await docxFixture();
    writeFileSync(attachmentPath, bytes);
    const imported = await importOfficeDocument(workspace, "import-complex", {
      attachmentPath: "attachments/complex-report.docx",
      attachmentDigest: digest(bytes),
      outputDirectory: "outputs/complex-report"
    }, signal());
    const patched = await patchImportedOffice(workspace, "patch-complex", {
      manifestPath: imported.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: imported.sourceDigest,
      operations: [
        { type: "replace_text", targetId: "docx.p.0001", text: "现有业务报告（修订版）" },
        { type: "replace_text", targetId: "docx.p.0004", text: "第三章精简摘要，收入 120。" },
        { type: "set_table_cell", targetId: "docx.table.0001.cell.r0002.c0002", text: "135" },
        { type: "insert_paragraphs_after", targetId: "docx.p.0004", paragraphs: ["新增分析一。", "新增分析二。", "新增分析三。"] },
        { type: "delete_targets", targetIds: ["docx.p.0005"] }
      ]
    }, signal());
    expect(patched.revision).toBe(2);
    expect(readFileSync(join(workspace, "outputs", "complex-report", "revisions", "000001", "document.docx"))).toEqual(bytes);
    const revisedBytes = readFileSync(join(workspace, patched.files[0]!.path));
    const beforeEntries = unzipSync(bytes);
    const afterEntries = unzipSync(revisedBytes);
    for (const path of Object.keys(beforeEntries).filter((path) => path !== "word/document.xml")) {
      expect(Buffer.from(afterEntries[path]!)).toEqual(Buffer.from(beforeEntries[path]!));
    }
    const inspected = inspectImportedOffice(workspace, {
      manifestPath: patched.manifestPath,
      mode: "blocks",
      blockIds: ["docx.p.0001", "docx.p.0004", "docx.p.0005", "docx.p.0006", "docx.p.0007", "docx.p.0008", "docx.table.0001.cell.r0002.c0002"]
    });
    expect(inspected.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "docx.p.0001", text: "现有业务报告（修订版）" }),
      expect.objectContaining({ targetId: "docx.p.0004", text: "第三章精简摘要，收入 120。" }),
      expect.objectContaining({ targetId: "docx.p.0005", text: "新增分析一。" }),
      expect.objectContaining({ targetId: "docx.p.0006", text: "新增分析二。" }),
      expect.objectContaining({ targetId: "docx.p.0007", text: "新增分析三。" }),
      expect.objectContaining({ targetId: "docx.p.0008", text: "Appendix C 必须保留。" }),
      expect.objectContaining({ targetId: "docx.table.0001.cell.r0002.c0002", text: "135" })
    ]));
    expect(JSON.stringify(inspected.blocks)).not.toContain("Appendix B 应删除");
  });

  it("changes only slide four, inserts an image, reopens the PPTX and keeps other slide XML byte-identical", async () => {
    const workspace = createWorkspace();
    const attachmentPath = join(workspace, "attachments", "existing-deck.pptx");
    const imagePath = join(workspace, "attachments", "market.png");
    const bytes = await pptxFixture();
    const image = tinyPng();
    writeFileSync(attachmentPath, bytes);
    writeFileSync(imagePath, image);
    const imported = await importOfficeDocument(workspace, "import-pptx", {
      attachmentPath: "attachments/existing-deck.pptx",
      attachmentDigest: digest(bytes),
      outputDirectory: "outputs/existing-deck"
    }, signal());
    const outline = inspectImportedOffice(workspace, { manifestPath: imported.manifestPath, mode: "outline" });
    expect(outline.outline).toHaveLength(4);
    const beforeEntries = unzipSync(bytes);
    const patched = await patchImportedOffice(workspace, "patch-pptx", {
      manifestPath: imported.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: imported.sourceDigest,
      operations: [
        { type: "replace_slide_text", targetId: "pptx.slide.0004", title: "市场分析", body: "市场规模持续增长，重点关注企业客户。" },
        { type: "insert_image", targetId: "pptx.slide.0004", assetPath: "attachments/market.png", alt: "市场趋势", x: 8, y: 2, width: 4, height: 3 }
      ]
    }, signal());
    const afterBytes = readFileSync(join(workspace, patched.files[0]!.path));
    const afterEntries = unzipSync(afterBytes);
    expect(Buffer.from(afterEntries["ppt/slides/slide1.xml"]!)).toEqual(Buffer.from(beforeEntries["ppt/slides/slide1.xml"]!));
    expect(Buffer.from(afterEntries["ppt/slides/slide2.xml"]!)).toEqual(Buffer.from(beforeEntries["ppt/slides/slide2.xml"]!));
    expect(Buffer.from(afterEntries["ppt/slides/slide3.xml"]!)).toEqual(Buffer.from(beforeEntries["ppt/slides/slide3.xml"]!));
    expect(Object.keys(afterEntries).some((name) => /^ppt\/media\/nexora-/u.test(name))).toBe(true);
    const reopened = inspectImportedOffice(workspace, { manifestPath: patched.manifestPath, mode: "blocks", blockIds: ["pptx.slide.0004"] });
    expect(JSON.stringify(reopened.blocks[0])).toContain("市场分析");
    expect(JSON.stringify(reopened.blocks[0])).toContain("市场规模持续增长");
    expect(JSON.stringify(reopened.blocks[0])).toContain('"type":"image"');
    const preview = readImportedOfficePreview(workspace, patched.manifestPath, 2, patched.previewDigest);
    expect(preview.html).toContain("市场分析");
  });

  it("stages an attachment through the normal Desktop input, imports it through Runtime, continues editing and survives restart", async () => {
    const workspace = createWorkspace();
    const external = join(workspace, "existing-conversation.docx");
    writeFileSync(external, await docxFixture());
    let calls = 0;
    let stagedPath = "";
    let stagedDigest = "";
    let firstRequest = "";
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      calls += 1;
      if (calls === 1) firstRequest = body;
      const manifest = () => JSON.parse(readFileSync(join(workspace, "outputs", "conversation-import", "manifest.nexora.json"), "utf8")) as { currentRevision: number; sourceDigest: string };
      const content = calls === 1
        ? toolResponse("document.import", { attachmentPath: stagedPath, attachmentDigest: stagedDigest, outputDirectory: "outputs/conversation-import", title: "会话导入文档" })
        : calls === 2 || calls === 4 || calls === 6 || calls === 8
          ? toolResponse("document.inspect", {
              manifestPath: "outputs/conversation-import/manifest.nexora.json",
              mode: "blocks",
              blockIds: calls === 2
                ? ["docx.p.0001", "docx.p.0004", "docx.p.0005", "docx.p.0006", "docx.table.0001.cell.r0002.c0002"]
                : calls === 6
                  ? ["docx.p.0002"]
                  : calls === 4
                    ? ["docx.p.0001", "docx.p.0008", "docx.table.0001.cell.r0002.c0002"]
                    : ["docx.p.0002"]
            })
          : calls === 3
            ? toolResponse("document.apply_native_patch", { manifestPath: "outputs/conversation-import/manifest.nexora.json", expectedRevision: String(manifest().currentRevision), expectedSourceDigest: manifest().sourceDigest, operations: [
              { type: "replace_text", targetId: "docx.p.0001", text: "会话修订业务报告" },
              { type: "replace_text", targetId: "docx.p.0004", text: "第三章会话精简版，收入 120。" },
              { type: "set_table_cell", targetId: "docx.table.0001.cell.r0002.c0002", text: "135" },
              { type: "insert_paragraphs_after", targetId: "docx.p.0004", paragraphs: ["会话新增一。", "会话新增二。", "会话新增三。"] },
              { type: "delete_targets", targetIds: ["docx.p.0005"] }
            ] })
            : calls === 5
              ? toolResponse("nexora_respond", { text: "第三章已精简，其他内容保持。" })
              : calls === 7
                ? toolResponse("document.apply_native_patch", { manifestPath: "outputs/conversation-import/manifest.nexora.json", expectedRevision: manifest().currentRevision, expectedSourceDigest: manifest().sourceDigest, operations: [{ type: "replace_text", targetId: "docx.p.0002", text: "第一章再次调整。" }] })
                : toolResponse("nexora_respond", { text: "重启后已继续修改同一个文件。" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Provider fixture did not bind.");
    writeFileSync(join(workspace, ".env"), [
      `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${address.port}/v1`,
      "NEXORA_MODEL_API_KEY=test-key",
      "NEXORA_MODEL_NAME=existing-office-test",
      "NEXORA_MODEL_CONTEXT_WINDOW_TOKENS=128000",
      "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
      "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
    ].join("\n"), "utf8");

    let service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
    try {
      const staged = await service.stageAttachments([external]);
      stagedPath = staged[0]!.workspacePath;
      stagedDigest = staged[0]!.digest;
      await service.startSession({ text: "修改标题和第三章，更新表格数值，插入三段分析，删除 Appendix B，但保留 Appendix C 和其他内容。", attachments: staged });
      const revised = await waitForStatus(service, "succeeded", 15_000, 1);
      expect(revised.session?.runs[0]?.attachments).toEqual(staged);
      expect(revised.session?.deliverables).toEqual([expect.objectContaining({ revision: 2, title: "会话导入文档", stage: "modified" })]);
      const revisedDocument = inspectImportedOffice(workspace, { manifestPath: "outputs/conversation-import/manifest.nexora.json", mode: "blocks", blockIds: ["docx.p.0001", "docx.p.0008", "docx.table.0001.cell.r0002.c0002"] });
      expect(revisedDocument.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: "docx.p.0001", text: "会话修订业务报告" }),
        expect.objectContaining({ targetId: "docx.p.0008", text: "Appendix C 必须保留。" }),
        expect.objectContaining({ targetId: "docx.table.0001.cell.r0002.c0002", text: "135" })
      ]));
      expect(firstRequest).toContain("[HOST-VERIFIED ATTACHMENTS]");
      expect(firstRequest).toContain(stagedPath.replace(/\\/gu, "\\\\"));
      const sessionId = revised.session!.id;
      await service.close();
      service = new DesktopRuntimeService({ workspace, onSnapshot() {}, onError(message) { throw new Error(message); } });
      const reopened = await service.openSession(workspace, sessionId);
      expect(reopened.session?.deliverables).toEqual([expect.objectContaining({ revision: 2 })]);
      expect(reopened.session?.runs[0]?.attachments).toEqual(staged);

      await service.continueSession(sessionId, "再修改第一章。");
      const final = await waitForStatus(service, "succeeded", 15_000, 2);
      expect(final.session?.deliverables).toEqual([expect.objectContaining({ revision: 3, changedBlockIds: ["docx.p.0002"] })]);
      expect(calls).toBe(9);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 25_000);

  it("rejects attachment drift and active content before committing an imported revision", async () => {
    const workspace = createWorkspace();
    const attachmentPath = join(workspace, "attachments", "unsafe.docx");
    const original = await docxFixture();
    writeFileSync(attachmentPath, original);
    writeFileSync(attachmentPath, Buffer.concat([original, Buffer.from("changed")]));
    await expect(importOfficeDocument(workspace, "drift", {
      attachmentPath: "attachments/unsafe.docx",
      attachmentDigest: digest(original),
      outputDirectory: "outputs/drift"
    }, signal())).rejects.toMatchObject({ code: "DOCUMENT_ATTACHMENT_DRIFT" });
    expect(() => readFileSync(join(workspace, "outputs", "drift", "manifest.nexora.json"))).toThrow();

    const entries = unzipSync(original);
    entries["word/vbaProject.bin"] = new Uint8Array([1, 2, 3]);
    const active = Buffer.from(zipSync(entries));
    writeFileSync(attachmentPath, active);
    await expect(importOfficeDocument(workspace, "active", {
      attachmentPath: "attachments/unsafe.docx",
      attachmentDigest: digest(active),
      outputDirectory: "outputs/active"
    }, signal())).rejects.toMatchObject({ code: "DOCUMENT_UNSUPPORTED_OR_INVALID_OFFICE_FILE" });
    expect(() => readFileSync(join(workspace, "outputs", "active", "manifest.nexora.json"))).toThrow();
  });

  it("keeps the current revision unchanged after stale, wrong-format or unsupported patches", async () => {
    const workspace = createWorkspace();
    const attachmentPath = join(workspace, "attachments", "existing-report.docx");
    const bytes = await docxFixture();
    writeFileSync(attachmentPath, bytes);
    const imported = await importOfficeDocument(workspace, "import-safe", {
      attachmentPath: "attachments/existing-report.docx",
      attachmentDigest: digest(bytes),
      outputDirectory: "outputs/safe"
    }, signal());
    const manifestPath = join(workspace, imported.manifestPath);

    await expect(patchImportedOffice(workspace, "stale", {
      manifestPath: imported.manifestPath,
      expectedRevision: 2,
      expectedSourceDigest: imported.sourceDigest,
      operations: [{ type: "replace_text", targetId: "docx.p.0002", text: "must not commit" }]
    }, signal())).rejects.toMatchObject({ code: "DELIVERABLE_STALE_REVISION" });
    await expect(patchImportedOffice(workspace, "wrong-format", {
      manifestPath: imported.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: imported.sourceDigest,
      operations: [{ type: "set_cell", targetId: "xlsx.sheet.0001.cell.a1", value: 1 }]
    }, signal())).rejects.toMatchObject({ code: "INVALID_DOCUMENT_PATCH" });
    await expect(patchImportedOffice(workspace, "missing-target", {
      manifestPath: imported.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: imported.sourceDigest,
      operations: [{ type: "replace_text", targetId: "docx.p.9999", text: "must not commit" }]
    }, signal())).rejects.toMatchObject({ code: "INVALID_DOCUMENT_PATCH" });

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { currentRevision: number; sourceDigest: string };
    expect(manifest).toMatchObject({ currentRevision: 1, sourceDigest: imported.sourceDigest });
    expect(() => readFileSync(join(workspace, "outputs", "safe", "revisions", "000002", "document.docx"))).toThrow();
  });

  it("returns an explicit non-destructive limitation for imported Office to PDF conversion", async () => {
    const workspace = createWorkspace();
    const attachmentPath = join(workspace, "attachments", "existing-report.docx");
    const bytes = await docxFixture();
    writeFileSync(attachmentPath, bytes);
    const imported = await importOfficeDocument(workspace, "import-conversion", {
      attachmentPath: "attachments/existing-report.docx",
      attachmentDigest: digest(bytes),
      outputDirectory: "outputs/conversion"
    }, signal());
    const exportTool = createRichDocumentTools().find(({ contract }) => contract.identity.name === "document.export");
    expect(exportTool).toBeDefined();
    const result = await exportTool!.execute({
      manifestPath: imported.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: imported.sourceDigest,
      format: "pdf"
    }, { workspace, runId: "run-export-native", invocationId: "export-native", signal: signal() });
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "DOCUMENT_CONVERSION_UNAVAILABLE", retryable: false }
    });
    const manifest = JSON.parse(readFileSync(join(workspace, imported.manifestPath), "utf8")) as { currentRevision: number };
    expect(manifest.currentRevision).toBe(1);
  });
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-existing-office-"));
  mkdirSync(join(workspace, "attachments"), { recursive: true });
  workspaces.push(workspace);
  return workspace;
}

function signal(): AbortSignal { return new AbortController().signal; }
function digest(bytes: Uint8Array): `sha256:${string}` { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

async function docxFixture(): Promise<Buffer> {
  const document = new Document({ sections: [{ children: [
    new Paragraph({ text: "现有业务报告", heading: HeadingLevel.TITLE }),
    new Paragraph("第一章保持不变。"),
    new Paragraph({ text: "第三章", heading: HeadingLevel.HEADING_1 }),
    new Paragraph("第三章原始内容，收入 120，需要缩短。"),
    new Table({ rows: [
      new TableRow({ children: [new TableCell({ children: [new Paragraph("指标")] }), new TableCell({ children: [new Paragraph("数值")] })] }),
      new TableRow({ children: [new TableCell({ children: [new Paragraph("收入")] }), new TableCell({ children: [new Paragraph("120")] })] })
    ] }),
    new Paragraph("Appendix B 应删除。"),
    new Paragraph("Appendix C 必须保留。")
  ] }] });
  return Buffer.from(await Packer.toBuffer(document));
}

async function xlsxFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet("Data");
  data.addRows([["Month", "Revenue", "Double"], ["July", 100, { formula: "B2*2", result: 200 }], ["August", 120, { formula: "B3*2", result: 240 }]]);
  data.getRow(1).font = { bold: true };
  const keep = workbook.addWorksheet("Keep");
  keep.getCell("A1").value = "untouched sheet";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function pptxFixture(): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  for (let index = 1; index <= 4; index += 1) {
    const slide = pptx.addSlide();
    slide.addText(index === 4 ? "第四页旧标题" : `保持页面 ${index}`, { x: 0.8, y: 0.6, w: 11, h: 0.6, fontSize: 28, bold: true });
    slide.addText(index === 4 ? "第四页旧内容" : `未要求修改的第 ${index} 页内容`, { x: 0.8, y: 1.6, w: 11, h: 3, fontSize: 20 });
  }
  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }) as Uint8Array);
}

function tinyPng(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
}

function toolResponse(name: string, argumentsValue: unknown) {
  return { text: null, toolCalls: [{ name, arguments: argumentsValue }], finishReason: "tool_calls" };
}

function multiToolResponse(calls: ReadonlyArray<readonly [string, unknown]>) {
  return { text: null, toolCalls: calls.map(([name, argumentsValue]) => ({ name, arguments: argumentsValue })), finishReason: "tool_calls" };
}

function writeProviderEnv(workspace: string, port: number, model: string): void {
  writeFileSync(join(workspace, ".env"), [
    `NEXORA_MODEL_BASE_URL=http://127.0.0.1:${port}/v1`,
    "NEXORA_MODEL_API_KEY=test-key",
    `NEXORA_MODEL_NAME=${model}`,
    "NEXORA_MODEL_CONTEXT_WINDOW_TOKENS=128000",
    "NEXORA_MODEL_DECISION_OUTPUT_TOKENS=4096",
    "NEXORA_MODEL_TOOL_TRANSPORT=structured_output"
  ].join("\n"), "utf8");
}

async function waitForStatus(service: DesktopRuntimeService, status: string, timeoutMs: number, minimumRuns: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await service.snapshot();
    if (snapshot.session?.inspection.status === status && snapshot.session.runs.length >= minimumRuns) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Desktop Session did not reach ${status} with ${minimumRuns} Run(s).`);
}
