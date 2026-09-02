import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgent } from "../../packages/harness/src/index.js";

import { compileAuthoringCreateInput } from "../../apps/desktop/src/deliverables/authoring.js";
import { RichDocumentPatchInputSchema } from "../../apps/desktop/src/deliverables/contracts.js";
import { readDocxDocumentXml, validateDocxPackage } from "../../apps/desktop/src/deliverables/docx-renderer.js";
import { projectDeliverables } from "../../apps/desktop/src/deliverables/projection.js";
import {
  createRichDocument,
  inspectRichDocument,
  patchRichDocument
} from "../../apps/desktop/src/deliverables/rich-document.js";
import { createRichDocumentTools } from "../../apps/desktop/src/deliverables/tools.js";
import { finishFromEvidence, responseCall, ScriptedRuntimeProvider } from "./runtime-testkit.js";

const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E136 real DOCX Office artifact", () => {
  it("compiles an explicit DOCX request without changing the default rich-document representation", () => {
    expect(compileAuthoringCreateInput(authoringInput()).formats).toEqual(["docx"]);
    expect(compileAuthoringCreateInput({ ...authoringInput(), formats: undefined }).formats).toEqual(["rich_document"]);
  });

  it("commits a non-empty reopenable DOCX package with the requested structural content", async () => {
    const workspace = createWorkspace();
    const facts = await createRichDocument(workspace, "docx-create", compileAuthoringCreateInput(authoringInput()), signal);

    expect(facts.files).toEqual([expect.objectContaining({ format: "docx", byteLength: expect.any(Number) })]);
    const file = facts.files[0]!;
    const bytes = readFileSync(join(workspace, file.path));
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(validateDocxPackage(bytes).packageEntryCount).toBeGreaterThan(5);
    expect(file.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const documentXml = readDocxDocumentXml(bytes);
    expect(documentXml).toContain("County Technology Service Survey");
    expect(documentXml).toContain("Interview synthesis");
    expect(documentXml).toContain("Coverage");
    expect(documentXml).toContain("North District");
    expect(documentXml).toContain("Quarterly trend");
    expect(existsSync(join(workspace, "outputs", "technology-survey", "manifest.nexora.json"))).toBe(true);
  });

  it("regenerates DOCX on a targeted patch, preserves revision one, and replays idempotently", async () => {
    const workspace = createWorkspace();
    const created = await createRichDocument(workspace, "docx-create", compileAuthoringCreateInput(authoringInput()), signal);
    const beforeBytes = readFileSync(join(workspace, created.files[0]!.path));
    const inspected = inspectRichDocument(workspace, created.manifestPath);
    const patch = RichDocumentPatchInputSchema.parse({
      manifestPath: created.manifestPath,
      expectedRevision: inspected.manifest.currentRevision,
      expectedSourceDigest: inspected.manifest.sourceDigest,
      operations: [{
        type: "replace_block",
        targetBlockId: "summary",
        block: { blockId: "summary", type: "paragraph", runs: [{ text: "Updated evidence from twelve interviews." }] }
      }]
    });

    const revised = await patchRichDocument(workspace, "docx-patch", patch, signal);
    const replayed = await patchRichDocument(workspace, "docx-patch", patch, signal);
    expect(replayed).toEqual(revised);
    expect(revised).toMatchObject({ revision: 2, changedBlockIds: ["summary"] });
    expect(readFileSync(join(workspace, created.files[0]!.path))).toEqual(beforeBytes);

    const documentXml = readDocxDocumentXml(readFileSync(join(workspace, revised.files[0]!.path)));
    expect(documentXml).toContain("Updated evidence from twelve interviews.");
    expect(documentXml).toContain("North District");
    expect(revised.files[0]!.digest).not.toBe(created.files[0]!.digest);
  });

  it("projects the latest committed DOCX as a restart-safe Desktop output", async () => {
    const workspace = createWorkspace();
    const created = await createRichDocument(workspace, "docx-create", compileAuthoringCreateInput(authoringInput()), signal);
    const projected = projectDeliverables([{
      runId: "run-docx",
      invocations: [{ toolName: "document.create", status: "succeeded", resultJson: created }]
    }]);
    expect(projected).toEqual([expect.objectContaining({
      deliverableId: created.deliverableId,
      revision: 1,
      files: [expect.objectContaining({ format: "docx", path: created.files[0]!.path })]
    })]);
    expect(readFileSync(join(workspace, projected[0]!.files[0]!.path)).byteLength).toBe(created.files[0]!.byteLength);
  });

  it("does not commit a fake success when DOCX generation rejects an unsupported image representation", async () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "unsafe.webp"), Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary"));
    const input = compileAuthoringCreateInput({
      ...authoringInput(),
      outputDirectory: "outputs/unsupported-image",
      blocks: [{ blockId: "image", type: "image", assetPath: "unsafe.webp", alt: "unsupported", fit: "contain" }]
    });
    await expect(createRichDocument(workspace, "docx-webp", input, signal)).rejects.toThrow(/DOCX supports PNG and JPEG/u);
    expect(existsSync(join(workspace, "outputs", "unsupported-image", "manifest.nexora.json"))).toBe(false);
  });

  it("runs the DOCX write through the existing Invocation, Evidence and Completion authorities and reopens it", async () => {
    const workspace = createWorkspace();
    const provider = new ScriptedRuntimeProvider([
      responseCall("document.create", authoringInput()),
      finishFromEvidence("The requested DOCX is committed in the Workspace.")
    ]);
    const first = createAgent({ workspace, provider, tools: [...createRichDocumentTools()] });
    const run = first.run("Create a county technology service survey as a real Word document.");
    const waiting = await run.wait();
    expect(waiting).toMatchObject({ status: "waiting_for_approval", pendingRequest: { kind: "approval", toolName: "document.create" } });
    await run.approve({ requestId: waiting.pendingRequest!.id });
    const result = await run.result();
    const inspection = await run.inspect();

    expect(result.status).toBe("succeeded");
    expect(inspection.invocations).toEqual([expect.objectContaining({ toolName: "document.create", status: "succeeded" })]);
    expect(inspection.evidence).toHaveLength(1);
    const facts = inspection.invocations[0]!.resultJson as { files: Array<{ path: string }> };
    expect(readFileSync(join(workspace, facts.files[0]!.path)).byteLength).toBeGreaterThan(1_000);
    await first.close();

    let providerCalls = 0;
    const second = createAgent({
      workspace,
      provider: { async decide() { providerCalls += 1; throw new Error("A terminal Run must not execute again."); } },
      tools: [...createRichDocumentTools()]
    });
    expect((await second.openRun(run.id).result()).status).toBe("succeeded");
    expect(providerCalls).toBe(0);
    await second.close();
  });
});

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e136-docx-"));
  roots.push(workspace);
  return workspace;
}

function authoringInput() {
  return {
    outputDirectory: "outputs/technology-survey",
    title: "County Technology Service Survey",
    locale: "en-US",
    formats: ["docx"] as const,
    theme: {
      pageWidth: "standard" as const,
      surface: "light" as const,
      primaryColor: "#1d4ed8",
      accentColor: "#0891b2",
      font: "serif" as const,
      spacing: "comfortable" as const,
      corners: "square" as const
    },
    blocks: [
      { blockId: "title", type: "heading" as const, level: 1 as const, runs: "County Technology Service Survey" },
      { blockId: "summary", type: "paragraph" as const, runs: "Interview synthesis from local operators." },
      {
        blockId: "coverage",
        type: "table" as const,
        caption: "Coverage",
        headers: ["Area", "Interviews"],
        rows: [["North District", "8"], ["South District", "4"]]
      },
      {
        blockId: "trend",
        type: "chart" as const,
        chartType: "bar" as const,
        title: "Quarterly trend",
        categories: ["Q1", "Q2"],
        series: [{ name: "Requests", values: [18, 27] }],
        showLegend: true
      }
    ]
  };
}
