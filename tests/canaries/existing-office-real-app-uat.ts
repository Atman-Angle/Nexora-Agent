import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  importOfficeDocument,
  inspectImportedOffice,
  patchImportedOffice
} from "../../apps/desktop/src/deliverables/imported-office.js";

const root = resolve(process.env.NEXORA_EXISTING_OFFICE_UAT_ROOT ?? ".tmp/existing-office-real-uat-20260828");
const inputRoot = join(root, "inputs");
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "inputs"), { recursive: true });
const signal = new AbortController().signal;

const sources = {
  docx: stage("microsoft-word-existing.docx"),
  xlsx: stage("microsoft-excel-existing.xlsx"),
  pptx: stage("microsoft-powerpoint-existing.pptx")
};
const imageSource = resolve(process.env.NEXORA_EXISTING_OFFICE_UAT_IMAGE ?? ".tmp/desktop-document-uat.png");
const imageTarget = join(workspace, "inputs", basename(imageSource));
copyFileSync(imageSource, imageTarget);

const docxImported = await importOfficeDocument(workspace, "real-uat-import-docx", {
  attachmentPath: sources.docx.path,
  attachmentDigest: sources.docx.digest,
  outputDirectory: "outputs/word-existing",
  title: "Microsoft Word existing file"
}, signal);
const docxOutline = inspectImportedOffice(workspace, { manifestPath: docxImported.manifestPath, mode: "outline" });
const docxTarget = inspectImportedOffice(workspace, { manifestPath: docxImported.manifestPath, mode: "blocks", blockIds: docxOutline.outline.map(({ blockId }) => blockId).slice(0, 16) });
const thirdChapterParagraph = docxTarget.blocks.find((block) => String(block.text ?? "").includes("第三章原始内容"));
if (thirdChapterParagraph === undefined) throw new Error("The Word third-chapter paragraph was not found.");
const docxPatched = await patchImportedOffice(workspace, "real-uat-patch-docx", {
  manifestPath: docxImported.manifestPath,
  expectedRevision: docxImported.revision,
  expectedSourceDigest: docxImported.sourceDigest,
  operations: [{ type: "replace_text", targetId: thirdChapterParagraph.targetId, text: "第三章精简内容。" }]
}, signal);

const xlsxImported = await importOfficeDocument(workspace, "real-uat-import-xlsx", {
  attachmentPath: sources.xlsx.path,
  attachmentDigest: sources.xlsx.digest,
  outputDirectory: "outputs/excel-existing",
  title: "Microsoft Excel existing file"
}, signal);
const xlsxOutline = inspectImportedOffice(workspace, { manifestPath: xlsxImported.manifestPath, mode: "outline" });
const xlsxSheets = inspectImportedOffice(workspace, { manifestPath: xlsxImported.manifestPath, mode: "blocks", blockIds: xlsxOutline.outline.map(({ blockId }) => blockId) });
const dataSheet = xlsxSheets.blocks.find((block) => block.type === "sheet" && block.name === "Data");
if (dataSheet === undefined) throw new Error("The Excel Data sheet was not found.");
const xlsxPatched = await patchImportedOffice(workspace, "real-uat-patch-xlsx", {
  manifestPath: xlsxImported.manifestPath,
  expectedRevision: xlsxImported.revision,
  expectedSourceDigest: xlsxImported.sourceDigest,
  operations: [{ type: "set_cell", targetId: `${dataSheet.targetId}.cell.b3`, value: 135 }]
}, signal);

const pptxImported = await importOfficeDocument(workspace, "real-uat-import-pptx", {
  attachmentPath: sources.pptx.path,
  attachmentDigest: sources.pptx.digest,
  outputDirectory: "outputs/powerpoint-existing",
  title: "Microsoft PowerPoint existing file"
}, signal);
const pptxPatched = await patchImportedOffice(workspace, "real-uat-patch-pptx", {
  manifestPath: pptxImported.manifestPath,
  expectedRevision: pptxImported.revision,
  expectedSourceDigest: pptxImported.sourceDigest,
  operations: [
    { type: "replace_slide_text", targetId: "pptx.slide.0004", title: "市场分析", body: "市场规模持续增长，重点关注企业客户。" },
    { type: "insert_image", targetId: "pptx.slide.0004", assetPath: `inputs/${basename(imageTarget)}`, alt: "市场分析配图", x: 8, y: 2.1, width: 4.2, height: 3.2 }
  ]
}, signal);

const report = {
  generatedAt: new Date().toISOString(),
  workspace,
  inputs: sources,
  outputs: {
    docx: summarize(docxPatched),
    xlsx: summarize(xlsxPatched),
    pptx: summarize(pptxPatched)
  }
};
writeFileSync(join(root, "nexora-existing-office-uat-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function stage(name: string): { readonly path: string; readonly digest: `sha256:${string}`; readonly byteLength: number } {
  const source = join(inputRoot, name);
  const target = join(workspace, "inputs", name);
  copyFileSync(source, target);
  const bytes = readFileSync(target);
  return { path: `inputs/${name}`, digest: digest(bytes), byteLength: bytes.byteLength };
}

function digest(bytes: Uint8Array): `sha256:${string}` { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function summarize(facts: { readonly revision: number; readonly sourceDigest: string; readonly files: readonly { readonly path: string; readonly digest: string; readonly byteLength: number }[]; readonly changedBlockIds: readonly string[] }) {
  return { revision: facts.revision, sourceDigest: facts.sourceDigest, file: facts.files[0], changedTargetIds: facts.changedBlockIds };
}
