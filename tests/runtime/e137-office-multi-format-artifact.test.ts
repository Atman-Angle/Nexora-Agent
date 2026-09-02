import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "../../apps/desktop/node_modules/fflate/esm/index.mjs";

import { createAgent } from "../../packages/harness/src/index.js";
import { compileAuthoringCreateInput } from "../../apps/desktop/src/deliverables/authoring.js";
import { RichDocumentExportInputSchema, RichDocumentPatchInputSchema, type RichDocumentExportFacts } from "../../apps/desktop/src/deliverables/contracts.js";
import { validatePdf } from "../../apps/desktop/src/deliverables/pdf-renderer.js";
import { readPptxSlideXml, validatePptxPackage } from "../../apps/desktop/src/deliverables/pptx-renderer.js";
import { projectDeliverables } from "../../apps/desktop/src/deliverables/projection.js";
import { createRichDocument, exportRichDocumentFormat, inspectRichDocument, patchRichDocument, writeOfficeFile } from "../../apps/desktop/src/deliverables/rich-document.js";
import { createRichDocumentTools } from "../../apps/desktop/src/deliverables/tools.js";
import { inspectXlsx, validateXlsxPackage } from "../../apps/desktop/src/deliverables/xlsx-renderer.js";
import { finishFromEvidence, responseCall, responseDirect, responsePlan, ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
const signal = new AbortController().signal;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("E137 real XLSX, PPTX and PDF Office representations", () => {
  it("atomically commits and mechanically reopens all three standard formats from one general source", async () => {
    const workspace = createWorkspace();
    const facts = await createRichDocument(workspace, "multi-create", compileAuthoringCreateInput(input()), signal);
    expect(facts.files.map(({ format }) => format)).toEqual(["xlsx", "pptx", "pdf"]);

    const xlsxBytes = bytes(workspace, facts, "xlsx");
    expect(validateXlsxPackage(xlsxBytes).packageEntryCount).toBeGreaterThan(8);
    const workbook = await inspectXlsx(xlsxBytes);
    expect(workbook.sheetNames).toEqual(expect.arrayContaining(["Summary", "Regional performance", "Quarterly trend"]));
    expect(workbook.values).toEqual(expect.arrayContaining(["Regional operating analysis", "North", "120", "Renewal", "92%"]));

    const pptxBytes = bytes(workspace, facts, "pptx");
    expect(validatePptxPackage(pptxBytes)).toMatchObject({ slideCount: 7 });
    expect(readPptxSlideXml(pptxBytes).join("\n")).toContain("Regional operating analysis");

    const pdfBytes = bytes(workspace, facts, "pdf");
    expect(await validatePdf(pdfBytes)).toMatchObject({ pageCount: expect.any(Number) });
    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("rejects macro, ActiveX and unexpected embedded payloads during package validation", async () => {
    const workspace = createWorkspace();
    const facts = await createRichDocument(workspace, "unsafe-package-fixture", compileAuthoringCreateInput(input()), signal);

    const xlsxEntries = unzipSync(bytes(workspace, facts, "xlsx"));
    xlsxEntries["xl/vbaProject.bin"] = strToU8("macro");
    expect(() => validateXlsxPackage(zipSync(xlsxEntries))).toThrow(/forbidden active content/u);

    const pptxEntries = unzipSync(bytes(workspace, facts, "pptx"));
    pptxEntries["ppt/activeX/activeX1.bin"] = strToU8("active-x");
    expect(() => validatePptxPackage(zipSync(pptxEntries))).toThrow(/forbidden active content/u);
    delete pptxEntries["ppt/activeX/activeX1.bin"];
    pptxEntries["ppt/embeddings/payload.bin"] = strToU8("payload");
    expect(() => validatePptxPackage(zipSync(pptxEntries))).toThrow(/forbidden embedded object/u);
  });

  it("regenerates each requested representation on a targeted revision and preserves prior files", async () => {
    const workspace = createWorkspace();
    const created = await createRichDocument(workspace, "multi-create", compileAuthoringCreateInput(input()), signal);
    const previous = new Map(created.files.map((file) => [file.format, readFileSync(join(workspace, file.path))]));
    const current = inspectRichDocument(workspace, created.manifestPath);
    const patch = RichDocumentPatchInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: current.manifest.currentRevision,
      expectedSourceDigest: current.manifest.sourceDigest,
      operations: [{ type: "replace_block", targetBlockId: "summary", block: { blockId: "summary", type: "paragraph", runs: [{ text: "Updated regional evidence." }] } }]
    });
    const revised = await patchRichDocument(workspace, "multi-patch", patch, signal);

    expect(revised).toMatchObject({ revision: 2, changedBlockIds: ["summary"] });
    for (const file of revised.files) {
      expect(file.digest).not.toBe(created.files.find(({ format }) => format === file.format)!.digest);
      expect(readFileSync(join(workspace, created.files.find(({ format }) => format === file.format)!.path))).toEqual(previous.get(file.format));
      expect(readFileSync(join(workspace, file.path)).byteLength).toBe(file.byteLength);
    }
    expect((await inspectXlsx(bytes(workspace, revised, "xlsx"))).values).toContain("Updated regional evidence.");
    expect(readPptxSlideXml(bytes(workspace, revised, "pptx")).join("\n")).toContain("Updated regional evidence.");
    expect((await validatePdf(bytes(workspace, revised, "pdf"))).pageCount).toBeGreaterThan(0);
  });

  it("exports one additional format from an exact source revision without rolling back prior representations", async () => {
    const workspace = createWorkspace();
    const created = await createRichDocument(workspace, "export-create", compileAuthoringCreateInput({ ...input(), formats: ["xlsx"] }), signal);
    const originalXlsx = readFileSync(join(workspace, created.files[0]!.path));
    const exported = await exportRichDocumentFormat(workspace, "export-pptx", RichDocumentExportInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: created.revision,
      expectedSourceDigest: created.sourceDigest,
      format: "pptx"
    }), signal);
    const replayed = await exportRichDocumentFormat(workspace, "export-pptx", RichDocumentExportInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: created.revision,
      expectedSourceDigest: created.sourceDigest,
      format: "pptx"
    }), signal);

    expect(replayed).toEqual(exported);
    expect(exported).toMatchObject({
      revision: 2,
      exportedFromRevision: 1,
      exportedFromSourceDigest: created.sourceDigest,
      exportedFormat: "pptx",
      files: [expect.objectContaining({ format: "xlsx" }), expect.objectContaining({ format: "pptx" })],
      changedBlockIds: [],
      preservedBlockCount: 6
    });
    expect(readFileSync(join(workspace, created.files[0]!.path))).toEqual(originalXlsx);
    expect(validatePptxPackage(bytes(workspace, exported, "pptx")).slideCount).toBeGreaterThan(0);
    await expect(exportRichDocumentFormat(workspace, "stale-export", RichDocumentExportInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: 1,
      expectedSourceDigest: created.sourceDigest,
      format: "pdf"
    }), signal)).rejects.toMatchObject({ code: "DELIVERABLE_CONFLICT" });
  });

  it("preserves successful format revisions when a later format export fails", async () => {
    const workspace = createWorkspace();
    const localized = {
      ...input(),
      title: "区域经营分析",
      formats: ["xlsx"] as const,
      blocks: input().blocks.map((block) => block.blockId === "summary"
        ? { blockId: "summary", type: "paragraph" as const, runs: "已核验的季度经营输入。" }
        : block)
    };
    const created = await createRichDocument(workspace, "partial-create", compileAuthoringCreateInput(localized), signal);
    const exported = await exportRichDocumentFormat(workspace, "partial-pptx", RichDocumentExportInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: created.revision,
      expectedSourceDigest: created.sourceDigest,
      format: "pptx"
    }), signal);
    const manifestBeforeFailure = readFileSync(join(workspace, exported.manifestPath), "utf8");
    const invalidFont = join(workspace, "invalid-font.ttf");
    writeFileSync(invalidFont, "not a font", "utf8");
    const previousFont = process.env.NEXORA_OFFICE_FONT_PATH;
    process.env.NEXORA_OFFICE_FONT_PATH = invalidFont;
    try {
      await expect(exportRichDocumentFormat(workspace, "partial-pdf", RichDocumentExportInputSchema.parse({
        manifestPath: exported.manifestPath,
        expectedRevision: exported.revision,
        expectedSourceDigest: exported.sourceDigest,
        format: "pdf"
      }), signal)).rejects.toMatchObject({ code: "OFFICE_GENERATION_FAILED" });
    } finally {
      if (previousFont === undefined) delete process.env.NEXORA_OFFICE_FONT_PATH;
      else process.env.NEXORA_OFFICE_FONT_PATH = previousFont;
    }
    expect(readFileSync(join(workspace, exported.manifestPath), "utf8")).toBe(manifestBeforeFailure);
    expect(inspectRichDocument(workspace, exported.manifestPath).manifest).toMatchObject({
      currentRevision: 2,
      files: [expect.objectContaining({ format: "xlsx" }), expect.objectContaining({ format: "pptx" })]
    });
  });

  it("commits the multi-format result through one existing Runtime Invocation and Completion Gate", async () => {
    const workspace = createWorkspace();
    const provider = new ScriptedRuntimeProvider([
      responseCall("document.create", input()),
      finishFromEvidence("The requested XLSX, PPTX and PDF files are committed.")
    ]);
    const agent = createAgent({ workspace, provider, tools: [...createRichDocumentTools()] });
    const run = agent.run("Create an analysis workbook, presentation and PDF from the same supplied facts.");
    const waiting = await run.wait();
    expect(waiting).toMatchObject({ status: "waiting_for_approval", pendingRequest: { toolName: "document.create" } });
    await run.approve({ requestId: waiting.pendingRequest!.id });
    expect((await run.result()).status).toBe("succeeded");
    const inspection = await run.inspect();
    expect(inspection.invocations).toEqual([expect.objectContaining({ toolName: "document.create", status: "succeeded" })]);
    expect(inspection.evidence).toHaveLength(1);
    const facts = inspection.invocations[0]!.resultJson as { files: Array<{ format: string; path: string }> };
    expect(facts.files.map(({ format }) => format)).toEqual(["xlsx", "pptx", "pdf"]);
    for (const file of facts.files) expect(readFileSync(join(workspace, file.path)).byteLength).toBeGreaterThan(1_000);
    await agent.close();
  });

  it("traces an additional-format export through Runtime Invocation, Evidence and Desktop projection", async () => {
    const workspace = createWorkspace();
    const created = await createRichDocument(workspace, "export-runtime-setup", compileAuthoringCreateInput({ ...input(), formats: ["xlsx"] }), signal);
    const provider = new ScriptedRuntimeProvider([
      responseCall("document.export", {
        manifestPath: created.manifestPath,
        expectedRevision: created.revision,
        expectedSourceDigest: created.sourceDigest,
        format: "pdf"
      }),
      finishFromEvidence("The PDF representation is committed from the cited source revision.")
    ]);
    const agent = createAgent({ workspace, provider, tools: [...createRichDocumentTools()] });
    const run = agent.run("Export the existing analysis Deliverable as PDF.");
    const waiting = await run.wait();
    expect(waiting).toMatchObject({ status: "waiting_for_approval", pendingRequest: { toolName: "document.export" } });
    await run.approve({ requestId: waiting.pendingRequest!.id });
    expect((await run.result()).status).toBe("succeeded");
    const inspection = await run.inspect();
    expect(inspection.invocations).toEqual([expect.objectContaining({ toolName: "document.export", status: "succeeded" })]);
    expect(inspection.evidence).toHaveLength(1);
    const facts = inspection.invocations[0]!.resultJson as RichDocumentExportFacts;
    expect(facts).toMatchObject({ exportedFromRevision: 1, exportedFormat: "pdf", revision: 2 });
    expect(projectDeliverables([{ runId: run.id, invocations: inspection.invocations }])).toEqual([
      expect.objectContaining({ deliverableId: created.deliverableId, revision: 2, files: expect.arrayContaining([expect.objectContaining({ format: "pdf" })]) })
    ]);
    await agent.close();
  });

  it("does not let a Provider claim completion after a Runtime Office export fails", async () => {
    const workspace = createWorkspace();
    const localized = {
      ...input(),
      title: "区域经营分析",
      formats: ["xlsx"] as const,
      blocks: input().blocks.map((block) => block.blockId === "summary"
        ? { blockId: "summary", type: "paragraph" as const, runs: "已核验的季度经营输入。" }
        : block)
    };
    const created = await createRichDocument(workspace, "runtime-failure-create", compileAuthoringCreateInput(localized), signal);
    const exported = await exportRichDocumentFormat(workspace, "runtime-failure-pptx", RichDocumentExportInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: created.revision,
      expectedSourceDigest: created.sourceDigest,
      format: "pptx"
    }), signal);
    const manifestBeforeFailure = readFileSync(join(workspace, exported.manifestPath), "utf8");
    const filesBeforeFailure = new Map(exported.files.map((file) => [file.path, readFileSync(join(workspace, file.path))]));
    const invalidFont = join(workspace, "invalid-runtime-font.ttf");
    writeFileSync(invalidFont, "not a font", "utf8");

    const provider = new ScriptedRuntimeProvider([
      responsePlan({
        goal: "Export the existing localized Office Deliverable as PDF.",
        tasks: [{
          objective: "Commit the requested PDF representation from the exact current revision.",
          checks: [{ toolName: "document.export", role: "mutation" }]
        }]
      }),
      responseCall("document.export", {
        manifestPath: exported.manifestPath,
        expectedRevision: exported.revision,
        expectedSourceDigest: exported.sourceDigest,
        format: "pdf"
      }),
      responseDirect("The PDF export is complete."),
      responseDirect("The PDF export is complete."),
      responseDirect("The PDF export is complete."),
      responseDirect("The PDF export is complete.")
    ]);
    const previousFont = process.env.NEXORA_OFFICE_FONT_PATH;
    process.env.NEXORA_OFFICE_FONT_PATH = invalidFont;
    const agent = createAgent({ workspace, provider, tools: [...createRichDocumentTools()] });
    try {
      const run = agent.run("Export the existing localized Office Deliverable as PDF and report only committed output.");
      const waiting = await run.wait();
      expect(waiting).toMatchObject({ status: "waiting_for_approval", pendingRequest: { toolName: "document.export" } });
      await run.approve({ requestId: waiting.pendingRequest!.id });
      const afterFailure = await run.wait();
      const inspection = await run.inspect();

      expect(afterFailure.status).not.toBe("succeeded");
      expect(inspection.status).not.toBe("succeeded");
      expect(inspection.invocations).toEqual([
        expect.objectContaining({
          toolName: "document.export",
          status: "failed",
          errorJson: expect.objectContaining({ code: "OFFICE_GENERATION_FAILED" })
        })
      ]);
      expect(inspection.evidence).toEqual([]);
      expect(inspection.result).toBeNull();
      expect(readFileSync(join(workspace, exported.manifestPath), "utf8")).toBe(manifestBeforeFailure);
      expect(inspectRichDocument(workspace, exported.manifestPath).manifest).toMatchObject({
        currentRevision: 2,
        files: [expect.objectContaining({ format: "xlsx" }), expect.objectContaining({ format: "pptx" })]
      });
      for (const [path, contents] of filesBeforeFailure) {
        expect(readFileSync(join(workspace, path))).toEqual(contents);
      }
    } finally {
      if (previousFont === undefined) delete process.env.NEXORA_OFFICE_FONT_PATH;
      else process.env.NEXORA_OFFICE_FONT_PATH = previousFont;
      await agent.close();
    }
  }, 15_000);

  it("reports invalid, unsupported, missing-resource, renderer, write, timeout and cancellation failures distinctly", async () => {
    const workspace = createWorkspace();
    const create = createRichDocumentTools().find(({ contract }) => contract.identity.name === "document.create")!;
    const context = (invocationId: string, operationSignal = signal) => ({ workspace, runId: "run-failures", invocationId, signal: operationSignal });

    await expect(create.execute({ ...input(), title: "" }, context("invalid"))).resolves.toMatchObject({
      status: "failure", error: { code: "DOCUMENT_INVALID_INPUT", retryable: false }
    });
    await expect(create.execute({ ...input(), formats: ["odt"] }, context("unsupported"))).resolves.toMatchObject({
      status: "failure", error: { code: "DOCUMENT_UNSUPPORTED_FORMAT", retryable: false }
    });
    await expect(create.execute({
      ...input(), outputDirectory: "outputs/missing-resource", formats: ["docx"],
      blocks: [{ blockId: "missing", type: "image", assetPath: "missing.png", alt: "missing", fit: "contain" }]
    }, context("missing-resource"))).resolves.toMatchObject({ status: "failure", error: { code: "INVALID_DOCUMENT_ASSET" } });

    writeFileSync(join(workspace, "unsupported.webp"), Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary"));
    await expect(create.execute({
      ...input(), outputDirectory: "outputs/renderer-failure", formats: ["docx"],
      blocks: [{ blockId: "unsupported", type: "image", assetPath: "unsupported.webp", alt: "unsupported", fit: "contain" }]
    }, context("renderer-failure"))).resolves.toMatchObject({ status: "failure", error: { code: "OFFICE_GENERATION_FAILED" } });

    const directoryTarget = join(workspace, "cannot-overwrite-directory.xlsx");
    mkdirSync(directoryTarget);
    expect(() => writeOfficeFile("xlsx", directoryTarget, Buffer.from("bytes"))).toThrowError(expect.objectContaining({ code: "OFFICE_FILE_WRITE_FAILED" }));

    const cancelled = new AbortController();
    cancelled.abort(new Error("user cancelled"));
    await expect(create.execute({ ...input(), outputDirectory: "outputs/cancelled" }, context("cancelled", cancelled.signal))).resolves.toMatchObject({
      status: "failure", error: { code: "DOCUMENT_CANCELLED", retryable: false }
    });
    const timedOut = AbortSignal.timeout(1);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await expect(create.execute({ ...input(), outputDirectory: "outputs/timeout" }, context("timeout", timedOut))).resolves.toMatchObject({
      status: "failure", error: { code: "DOCUMENT_TIMEOUT", retryable: true }
    });
  });
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e137-office-"));
  roots.push(workspace);
  return workspace;
}

function bytes(workspace: string, facts: { files: readonly { format: string; path: string }[] }, format: string): Buffer {
  return readFileSync(join(workspace, facts.files.find((file) => file.format === format)!.path));
}

function input() {
  return {
    outputDirectory: "outputs/regional-analysis",
    title: "Regional operating analysis",
    locale: "en-US",
    formats: ["xlsx", "pptx", "pdf"] as const,
    theme: { pageWidth: "wide" as const, surface: "light" as const, primaryColor: "#1d4ed8", accentColor: "#0891b2", font: "system" as const, spacing: "comfortable" as const, corners: "rounded" as const },
    blocks: [
      { blockId: "title", type: "heading" as const, level: 1 as const, runs: "Regional operating analysis" },
      { blockId: "summary", type: "paragraph" as const, runs: "Verified operating inputs for the quarter." },
      { blockId: "renewal", type: "metric" as const, label: "Renewal", value: "92%", delta: "+4pp" },
      { blockId: "actions", type: "list" as const, ordered: false, items: ["Retain key accounts", "Improve onboarding"] },
      { blockId: "regions", type: "table" as const, caption: "Regional performance", headers: ["Region", "Revenue"], rows: [["North", "120"], ["South", "98"]] },
      { blockId: "trend", type: "chart" as const, chartType: "bar" as const, title: "Quarterly trend", categories: ["Q1", "Q2", "Q3"], series: [{ name: "Revenue", values: [80, 96, 120] }], showLegend: true }
    ]
  };
}
