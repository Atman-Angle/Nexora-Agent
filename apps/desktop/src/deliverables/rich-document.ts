import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  RichDocumentManifestSchema,
  RichDocumentSourceSchema,
  type InlineRun,
  type RichDocumentBlock,
  type RichDocumentCreateInput,
  type RichDocumentExportFacts,
  type RichDocumentExportInput,
  type RichDocumentLeafBlock,
  type RichDocumentManifest,
  type RichDocumentPatchInput,
  type RichDocumentPatchOperation,
  type RichDocumentSource,
  type RichDocumentWriteFacts
} from "./contracts.js";
import { renderDocx, validateDocxPackage, type DocxValidation } from "./docx-renderer.js";
import { renderPdf, type PdfValidation } from "./pdf-renderer.js";
import { renderPptx, validatePptxPackage, type PptxValidation } from "./pptx-renderer.js";
import { renderXlsx, validateXlsxPackage, type XlsxValidation } from "./xlsx-renderer.js";

const MAX_SOURCE_BYTES = 512_000;
const MAX_TEXT_CHARACTERS = 200_000;
const MAX_TABLE_CELLS = 10_000;
const MAX_CHART_POINTS = 2_000;
const MAX_ASSETS = 32;
const MAX_ASSET_BYTES = 10_000_000;
const MAX_TOTAL_ASSET_BYTES = 25_000_000;
const MAX_PREVIEW_BYTES = 5_000_000;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

type AssetSnapshot = {
  readonly sourcePath: string;
  readonly packagedPath: string;
  readonly digest: string;
  readonly byteLength: number;
};

type ValidationRecord = {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly rendererVersion: 1;
  readonly sourceDigest: string;
  readonly previewDigest: string;
  readonly blockCount: number;
  readonly assetSnapshots: readonly AssetSnapshot[];
  readonly files: readonly {
    readonly format: "docx" | "xlsx" | "pptx" | "pdf";
    readonly fileName: string;
    readonly digest: string;
    readonly byteLength: number;
    readonly mechanicalValidation: DocxValidation | XlsxValidation | PptxValidation | PdfValidation;
  }[];
  readonly changedBlockIds: readonly string[];
  readonly insertedBlockIds: readonly string[];
  readonly removedBlockIds: readonly string[];
  readonly movedBlockIds: readonly string[];
  readonly preservedBlockCount: number;
};

type PatchSummary = Pick<ValidationRecord,
  "changedBlockIds" | "insertedBlockIds" | "removedBlockIds" | "movedBlockIds" | "preservedBlockCount">;

export class DeliverableError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "DeliverableError";
  }
}

const deliverableLocks = new Map<string, Promise<void>>();

export async function createRichDocument(
  workspace: string,
  invocationId: string,
  input: RichDocumentCreateInput,
  signal: AbortSignal
): Promise<RichDocumentWriteFacts> {
  const outputDirectory = normalizeWorkspaceRelative(input.outputDirectory);
  return await withDeliverableLock(`${workspaceRoot(workspace).toLowerCase()}::${outputDirectory.toLowerCase()}`, async () => {
    throwIfAborted(signal);
    const root = resolveWorkspaceTarget(workspace, outputDirectory, false);
    const manifestPath = join(root, "manifest.nexora.json");
    if (existsSync(manifestPath)) {
      const existing = readManifest(workspace, toWorkspaceRelative(workspace, manifestPath));
      if (existing.createdByInvocationId === invocationId && existing.currentRevision === 1) {
        return writeFactsFromCommitted(workspace, existing, emptyPatchSummary(countBlocks(readCurrentSource(workspace, existing))));
      }
      throw new DeliverableError("DELIVERABLE_ALREADY_EXISTS", `A Deliverable already exists at ${outputDirectory}.`);
    }
    const recoverableOrphan = existsSync(root) && isRecoverableCreateOrphan(root, invocationId);
    if (existsSync(root) && !recoverableOrphan) {
      throw new DeliverableError("DELIVERABLE_ALREADY_EXISTS", `The output directory already exists: ${outputDirectory}.`);
    }
    mkdirSync(root, { recursive: true });
    assertWorkspaceContained(workspace, root);
    try {
      const deliverableId = deliverableIdFor(outputDirectory);
      const source = RichDocumentSourceSchema.parse({
        schemaVersion: 1,
        deliverableId,
        revision: 1,
        title: input.title,
        locale: input.locale,
        formats: input.formats,
        theme: input.theme,
        blocks: input.blocks
      });
      const summary: PatchSummary = {
        changedBlockIds: [],
        insertedBlockIds: allBlockIds(source.blocks),
        removedBlockIds: [],
        movedBlockIds: [],
        preservedBlockCount: 0
      };
      return await commitRevision(workspace, root, invocationId, source, null, summary, signal);
    } catch (error) {
      if (!recoverableOrphan && !existsSync(manifestPath)) rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function patchRichDocument(
  workspace: string,
  invocationId: string,
  input: RichDocumentPatchInput,
  signal: AbortSignal
): Promise<RichDocumentWriteFacts> {
  const manifestRelative = normalizeWorkspaceRelative(input.manifestPath);
  return await withDeliverableLock(`${workspaceRoot(workspace).toLowerCase()}::${manifestRelative.toLowerCase()}`, async () => {
    throwIfAborted(signal);
    const current = readManifest(workspace, manifestRelative);
    if (current.updatedByInvocationId === invocationId) {
      const validation = readValidation(workspace, current);
      return writeFactsFromCommitted(workspace, current, validation);
    }
    if (current.currentRevision !== input.expectedRevision || current.sourceDigest !== input.expectedSourceDigest) {
      throw new DeliverableError(
        "DELIVERABLE_CONFLICT",
        `The Deliverable is revision ${current.currentRevision} with source digest ${current.sourceDigest}; inspect it before preparing a new patch.`
      );
    }
    const before = readCurrentSource(workspace, current);
    const { source, summary } = applyOperations(before, input.operations);
    return await commitRevision(
      workspace,
      dirname(resolveWorkspaceTarget(workspace, manifestRelative, true)),
      invocationId,
      source,
      current,
      summary,
      signal
    );
  });
}

export async function exportRichDocumentFormat(
  workspace: string,
  invocationId: string,
  input: RichDocumentExportInput,
  signal: AbortSignal
): Promise<RichDocumentExportFacts> {
  const manifestRelative = normalizeWorkspaceRelative(input.manifestPath);
  return await withDeliverableLock(`${workspaceRoot(workspace).toLowerCase()}::${manifestRelative.toLowerCase()}`, async () => {
    throwIfAborted(signal);
    const current = readManifest(workspace, manifestRelative);
    if (current.updatedByInvocationId === invocationId) {
      return {
        ...writeFactsFromCommitted(workspace, current, readValidation(workspace, current)),
        exportedFromRevision: input.expectedRevision,
        exportedFromSourceDigest: input.expectedSourceDigest,
        exportedFormat: input.format
      };
    }
    if (current.currentRevision !== input.expectedRevision || current.sourceDigest !== input.expectedSourceDigest) {
      throw new DeliverableError(
        "DELIVERABLE_CONFLICT",
        `The Deliverable is revision ${current.currentRevision} with source digest ${current.sourceDigest}; inspect it before exporting another format.`
      );
    }
    const before = readCurrentSource(workspace, current);
    if (before.formats.includes(input.format)) {
      throw new DeliverableError("DOCUMENT_FORMAT_ALREADY_EXISTS", `${input.format.toUpperCase()} is already committed for revision ${before.revision}.`);
    }
    const source = RichDocumentSourceSchema.parse({
      ...before,
      revision: before.revision + 1,
      formats: [...before.formats, input.format]
    });
    const facts = await commitRevision(
      workspace,
      dirname(resolveWorkspaceTarget(workspace, manifestRelative, true)),
      invocationId,
      source,
      current,
      emptyPatchSummary(countBlocks(before)),
      signal
    );
    return {
      ...facts,
      exportedFromRevision: input.expectedRevision,
      exportedFromSourceDigest: input.expectedSourceDigest,
      exportedFormat: input.format
    };
  });
}

export function inspectRichDocument(workspace: string, manifestPath: string): {
  readonly manifest: RichDocumentManifest;
  readonly source: RichDocumentSource;
  readonly validation: ValidationRecord;
} {
  const manifest = readManifest(workspace, normalizeWorkspaceRelative(manifestPath));
  const source = readCurrentSource(workspace, manifest);
  const validation = readValidation(workspace, manifest);
  return { manifest, source, validation };
}

export function readRichDocumentPreview(
  workspace: string,
  manifestPath: string,
  expectedRevision: number,
  expectedPreviewDigest: string
): { readonly html: string; readonly manifest: RichDocumentManifest } {
  const manifest = readManifest(workspace, normalizeWorkspaceRelative(manifestPath));
  if (manifest.currentRevision !== expectedRevision || manifest.previewDigest !== expectedPreviewDigest) {
    throw new DeliverableError("DELIVERABLE_CONFLICT", "The Deliverable preview changed; refresh the Session before opening it.");
  }
  const previewPath = resolveWorkspaceTarget(workspace, `${manifest.currentRevisionPath}/preview.html`, true);
  const bytes = readFileSync(previewPath);
  if (bytes.byteLength > MAX_PREVIEW_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The preview exceeds the safe Desktop read budget.");
  if (digestBytes(bytes) !== manifest.previewDigest) throw new DeliverableError("DELIVERABLE_INVALID", "The preview digest does not match its manifest.");
  return { html: inlinePreviewAssets(workspace, manifest, bytes.toString("utf8")), manifest };
}

function inlinePreviewAssets(workspace: string, manifest: RichDocumentManifest, preview: string): string {
  return preview.replace(/src="assets\/([a-f0-9]{64}\.(?:png|jpg|webp))"/giu, (_match, fileName: string) => {
    const assetPath = resolveWorkspaceTarget(workspace, `${manifest.currentRevisionPath}/assets/${fileName}`, true);
    const bytes = readFileSync(assetPath);
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", `Preview image exceeds the safe Desktop read budget: ${fileName}.`);
    const extension = extname(fileName).toLowerCase();
    validateImageBytes(fileName, extension, bytes);
    const expectedDigest = `sha256:${fileName.slice(0, 64)}`;
    if (digestBytes(bytes) !== expectedDigest) throw new DeliverableError("DELIVERABLE_INVALID", `Preview image digest does not match its snapshot: ${fileName}.`);
    const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    return `src="data:${mime};base64,${bytes.toString("base64")}"`;
  });
}

async function commitRevision(
  workspace: string,
  root: string,
  invocationId: string,
  source: RichDocumentSource,
  previous: RichDocumentManifest | null,
  summary: PatchSummary,
  signal: AbortSignal
): Promise<RichDocumentWriteFacts> {
  validateDocument(source);
  throwIfAborted(signal);
  const revisionName = String(source.revision).padStart(6, "0");
  const revisionRoot = join(root, "revisions", revisionName);
  const temporaryRoot = join(root, `.tmp-${safeInvocationSegment(invocationId)}`);
  if (existsSync(revisionRoot)) {
    const validation = readJsonFile<ValidationRecord>(join(revisionRoot, "validation.json"));
    if (validation.invocationId !== invocationId) {
      throw new DeliverableError("DELIVERABLE_CONFLICT", `Revision ${source.revision} already belongs to another Invocation.`);
    }
    const recoveredManifest = manifestFor(workspace, root, source, previous, invocationId, validation);
    writeManifestAtomic(join(root, "manifest.nexora.json"), recoveredManifest);
    return writeFactsFromCommitted(workspace, recoveredManifest, validation);
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
  mkdirSync(join(temporaryRoot, "assets"), { recursive: true });
  writeFileSync(join(temporaryRoot, ".invocation.json"), `${JSON.stringify({ invocationId })}\n`, "utf8");
  try {
    const assetSnapshots = snapshotAssets(workspace, source.blocks, join(temporaryRoot, "assets"));
    const sourceText = `${JSON.stringify(source, null, 2)}\n`;
    if (Buffer.byteLength(sourceText) > MAX_SOURCE_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The structured document exceeds the source byte budget.");
    const sourceDigest = digestText(sourceText);
    const assetMap = new Map(assetSnapshots.map((asset) => [asset.sourcePath, asset.packagedPath]));
    const preview = renderRichDocument(source, assetMap);
    if (Buffer.byteLength(preview) > MAX_PREVIEW_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The rendered preview exceeds the byte budget.");
    validateRenderedPreview(preview, source);
    const previewDigest = digestText(preview);
    const files: Array<ValidationRecord["files"][number]> = [];
    const officeFormats = source.formats.filter((format): format is "docx" | "xlsx" | "pptx" | "pdf" => format !== "rich_document");
    for (const format of officeFormats) {
      let rendered: { readonly bytes: Buffer; readonly validation: DocxValidation | XlsxValidation | PptxValidation | PdfValidation };
      try {
        const resolveAsset = (sourcePath: string) => {
          const packaged = assetMap.get(normalizeWorkspaceRelative(sourcePath));
          if (packaged === undefined) throw new DeliverableError("INVALID_DOCUMENT_ASSET", `${format.toUpperCase()} asset was not committed: ${sourcePath}.`);
          return join(temporaryRoot, ...packaged.split("/"));
        };
        rendered = format === "docx" ? await renderDocx(source, resolveAsset)
          : format === "xlsx" ? await renderXlsx(source, resolveAsset)
          : format === "pptx" ? await renderPptx(source, resolveAsset)
          : await renderPdf(source, resolveAsset);
      } catch (error) {
        if (error instanceof DeliverableError) throw error;
        throw new DeliverableError("OFFICE_GENERATION_FAILED", `${format.toUpperCase()} generation failed: ${errorMessage(error)}`);
      }
      throwIfAborted(signal);
      const fileName = `document.${format}`;
      writeOfficeFile(format, join(temporaryRoot, fileName), rendered.bytes);
      files.push({
        format,
        fileName,
        digest: digestBytes(rendered.bytes),
        byteLength: rendered.bytes.byteLength,
        mechanicalValidation: rendered.validation
      });
    }
    const validation: ValidationRecord = {
      schemaVersion: 1,
      invocationId,
      rendererVersion: 1,
      sourceDigest,
      previewDigest,
      blockCount: countBlocks(source),
      assetSnapshots,
      files,
      ...summary
    };
    writeFileSync(join(temporaryRoot, "source.json"), sourceText, "utf8");
    writeFileSync(join(temporaryRoot, "preview.html"), preview, "utf8");
    writeFileSync(join(temporaryRoot, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`, "utf8");
    rmSync(join(temporaryRoot, ".invocation.json"), { force: true });
    throwIfAborted(signal);
    mkdirSync(dirname(revisionRoot), { recursive: true });
    renameSync(temporaryRoot, revisionRoot);
    const manifest = manifestFor(workspace, root, source, previous, invocationId, validation);
    writeManifestAtomic(join(root, "manifest.nexora.json"), manifest);
    return writeFactsFromCommitted(workspace, manifest, validation);
  } catch (error) {
    if (previous !== null) rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function manifestFor(
  workspace: string,
  root: string,
  source: RichDocumentSource,
  previous: RichDocumentManifest | null,
  invocationId: string,
  validation: ValidationRecord
): RichDocumentManifest {
  return RichDocumentManifestSchema.parse({
    schemaVersion: 1,
    deliverableId: source.deliverableId,
    kind: "rich_document",
    title: source.title,
    currentRevision: source.revision,
    currentRevisionPath: toWorkspaceRelative(workspace, join(root, "revisions", String(source.revision).padStart(6, "0"))),
    sourceDigest: validation.sourceDigest,
    previewDigest: validation.previewDigest,
    files: (validation.files ?? []).map((file) => ({
      format: file.format,
      path: toWorkspaceRelative(workspace, join(root, "revisions", String(source.revision).padStart(6, "0"), file.fileName)),
      digest: file.digest,
      byteLength: file.byteLength
    })),
    createdByInvocationId: previous?.createdByInvocationId ?? invocationId,
    updatedByInvocationId: invocationId
  });
}

function writeFactsFromCommitted(
  workspace: string,
  manifest: RichDocumentManifest,
  summary: PatchSummary | ValidationRecord
): RichDocumentWriteFacts {
  const source = readCurrentSource(workspace, manifest);
  return {
    deliverableId: manifest.deliverableId,
    kind: "rich_document",
    title: manifest.title,
    manifestPath: manifestPathForRevision(workspace, manifest),
    previewPath: `${manifest.currentRevisionPath}/preview.html`,
    revision: manifest.currentRevision,
    sourceDigest: manifest.sourceDigest,
    previewDigest: manifest.previewDigest,
    files: manifest.files,
    blockCount: countBlocks(source),
    assetCount: readValidation(workspace, manifest).assetSnapshots.length,
    validation: "passed",
    changedBlockIds: [...summary.changedBlockIds],
    insertedBlockIds: [...summary.insertedBlockIds],
    removedBlockIds: [...summary.removedBlockIds],
    movedBlockIds: [...summary.movedBlockIds],
    preservedBlockCount: summary.preservedBlockCount
  };
}

function manifestPathForRevision(workspace: string, manifest: RichDocumentManifest): string {
  const revision = resolveWorkspaceTarget(workspace, manifest.currentRevisionPath, true);
  return toWorkspaceRelative(workspace, join(dirname(dirname(revision)), "manifest.nexora.json"));
}

function readManifest(workspace: string, manifestPath: string): RichDocumentManifest {
  const absolute = resolveWorkspaceTarget(workspace, manifestPath, true);
  if (basename(absolute).toLowerCase() !== "manifest.nexora.json") {
    throw new DeliverableError("DELIVERABLE_INVALID", "A rich document reference must target manifest.nexora.json.");
  }
  try { return RichDocumentManifestSchema.parse(readJsonFile<unknown>(absolute)); }
  catch (error) {
    if (error instanceof DeliverableError) throw error;
    throw new DeliverableError("DELIVERABLE_INVALID", `The Deliverable manifest is invalid: ${errorMessage(error)}`);
  }
}

function readCurrentSource(workspace: string, manifest: RichDocumentManifest): RichDocumentSource {
  try {
    const path = resolveWorkspaceTarget(workspace, `${manifest.currentRevisionPath}/source.json`, true);
    const text = readFileSync(path, "utf8");
    if (digestText(text) !== manifest.sourceDigest) throw new DeliverableError("DELIVERABLE_INVALID", "The source digest does not match its manifest.");
    const source = RichDocumentSourceSchema.parse(JSON.parse(text));
    if (source.deliverableId !== manifest.deliverableId || source.revision !== manifest.currentRevision) {
      throw new DeliverableError("DELIVERABLE_INVALID", "The source identity does not match its manifest.");
    }
    validateDocument(source);
    return source;
  } catch (error) {
    if (error instanceof DeliverableError) throw error;
    throw new DeliverableError("DELIVERABLE_INVALID", `The current source is invalid: ${errorMessage(error)}`);
  }
}

function readValidation(workspace: string, manifest: RichDocumentManifest): ValidationRecord {
  try {
    const path = resolveWorkspaceTarget(workspace, `${manifest.currentRevisionPath}/validation.json`, true);
    const record = readJsonFile<ValidationRecord>(path);
    if (record.sourceDigest !== manifest.sourceDigest || record.previewDigest !== manifest.previewDigest) {
      throw new DeliverableError("DELIVERABLE_INVALID", "The validation record does not match its manifest.");
    }
    if ((record.files ?? []).length !== manifest.files.length) {
      throw new DeliverableError("DELIVERABLE_INVALID", "The committed Office file set does not match its manifest.");
    }
    for (const file of manifest.files) {
      const absolute = resolveWorkspaceTarget(workspace, file.path, true);
      const bytes = readFileSync(absolute);
      if (bytes.byteLength !== file.byteLength || digestBytes(bytes) !== file.digest) {
        throw new DeliverableError("DELIVERABLE_INVALID", `The committed ${file.format.toUpperCase()} bytes do not match the manifest.`);
      }
      if (file.format === "docx") validateDocxPackage(bytes);
      else if (file.format === "xlsx") validateXlsxPackage(bytes);
      else if (file.format === "pptx") validatePptxPackage(bytes);
      else if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || !bytes.subarray(Math.max(0, bytes.length - 1_024)).includes(Buffer.from("%%EOF"))) {
        throw new DeliverableError("DELIVERABLE_INVALID", "The committed PDF package is not mechanically readable.");
      }
    }
    return record;
  } catch (error) {
    if (error instanceof DeliverableError) throw error;
    throw new DeliverableError("DELIVERABLE_INVALID", `The validation record is invalid: ${errorMessage(error)}`);
  }
}

function applyOperations(before: RichDocumentSource, operations: readonly RichDocumentPatchOperation[]): {
  readonly source: RichDocumentSource;
  readonly summary: PatchSummary;
} {
  const blocks = structuredClone(before.blocks) as RichDocumentBlock[];
  let title = before.title;
  let theme = structuredClone(before.theme);
  const changed = new Set<string>();
  const inserted = new Set<string>();
  const removed = new Set<string>();
  const moved = new Set<string>();
  for (const operation of operations) {
    if (operation.type === "set_title") { title = operation.title; continue; }
    if (operation.type === "set_theme") { theme = operation.theme; continue; }
    if (operation.type === "replace_block") {
      if (operation.block.blockId !== operation.targetBlockId) {
        throw new DeliverableError("INVALID_DOCUMENT_PATCH", "replace_block must preserve the target block ID.");
      }
      const location = requireBlockLocation(blocks, operation.targetBlockId);
      location.container[location.index] = structuredClone(operation.block);
      changed.add(operation.targetBlockId);
      continue;
    }
    if (operation.type === "insert_before" || operation.type === "insert_after") {
      const location = requireBlockLocation(blocks, operation.targetBlockId);
      const additions = structuredClone(operation.blocks) as RichDocumentBlock[];
      location.container.splice(location.index + (operation.type === "insert_after" ? 1 : 0), 0, ...additions);
      for (const block of additions) for (const id of allBlockIds([block])) inserted.add(id);
      continue;
    }
    if (operation.type === "remove_block") {
      const location = requireBlockLocation(blocks, operation.targetBlockId);
      const [deleted] = location.container.splice(location.index, 1);
      if (deleted !== undefined) for (const id of allBlockIds([deleted])) removed.add(id);
      continue;
    }
    if (!("anchorBlockId" in operation)) {
      throw new DeliverableError("INVALID_DOCUMENT_PATCH", `Unsupported patch operation: ${operation.type}.`);
    }
    const target = requireBlockLocation(blocks, operation.targetBlockId);
    const anchor = requireBlockLocation(blocks, operation.anchorBlockId);
    if (target.container !== anchor.container) {
      throw new DeliverableError("INVALID_DOCUMENT_PATCH", "Move operations require target and anchor blocks in the same container.");
    }
    const [block] = target.container.splice(target.index, 1);
    if (block === undefined) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `Block not found: ${operation.targetBlockId}.`);
    const updatedAnchor = requireBlockLocation(blocks, operation.anchorBlockId);
    updatedAnchor.container.splice(updatedAnchor.index + (operation.type === "move_after" ? 1 : 0), 0, block);
    moved.add(operation.targetBlockId);
  }
  const source = RichDocumentSourceSchema.parse({
    ...before,
    revision: before.revision + 1,
    title,
    theme,
    blocks
  });
  validateDocument(source);
  const beforeDigests = blockDigests(before.blocks);
  const afterDigests = blockDigests(source.blocks);
  let preservedBlockCount = 0;
  for (const [id, digest] of beforeDigests) {
    if (changed.has(id) || removed.has(id) || moved.has(id)) continue;
    if (afterDigests.get(id) !== digest) {
      throw new DeliverableError("INVALID_DOCUMENT_PATCH", `Unaddressed block changed unexpectedly: ${id}.`);
    }
    preservedBlockCount += 1;
  }
  return {
    source,
    summary: {
      changedBlockIds: [...changed],
      insertedBlockIds: [...inserted],
      removedBlockIds: [...removed],
      movedBlockIds: [...moved],
      preservedBlockCount
    }
  };
}

function requireBlockLocation(blocks: RichDocumentBlock[], blockId: string): { container: RichDocumentBlock[]; index: number } {
  const found = findBlockLocation(blocks, blockId);
  if (found === null) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `Block not found: ${blockId}.`);
  return found;
}

function findBlockLocation(blocks: RichDocumentBlock[], blockId: string): { container: RichDocumentBlock[]; index: number } | null {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.blockId === blockId) return { container: blocks, index };
    if (block.type !== "columns") continue;
    for (const column of block.columns) {
      const found = findBlockLocation(column as RichDocumentBlock[], blockId);
      if (found !== null) return found;
    }
  }
  return null;
}

function validateDocument(source: RichDocumentSource): void {
  const ids = allBlockIds(source.blocks);
  if (new Set(ids).size !== ids.length) throw new DeliverableError("DELIVERABLE_INVALID", "Document block IDs must be unique.");
  let textCharacters = source.title.length;
  let tableCells = 0;
  let chartPoints = 0;
  for (const block of flattenBlocks(source.blocks)) {
    textCharacters += blockTextLength(block);
    if (block.type === "table") {
      const width = Math.max(block.headers.length, ...block.rows.map((row) => row.length), 0);
      if (block.headers.length > 0 && block.rows.some((row) => row.length !== block.headers.length)) {
        throw new DeliverableError("DELIVERABLE_INVALID", `Table ${block.blockId} rows must match its header width.`);
      }
      if (block.headers.length === 0 && block.rows.some((row) => row.length !== width)) {
        throw new DeliverableError("DELIVERABLE_INVALID", `Table ${block.blockId} rows must have a consistent width.`);
      }
      tableCells += block.headers.length + block.rows.reduce((sum, row) => sum + row.length, 0);
    }
    if (block.type === "chart") {
      if (block.series.some((series) => series.values.length !== block.categories.length)) {
        throw new DeliverableError("DELIVERABLE_INVALID", `Chart ${block.blockId} series values must match its categories.`);
      }
      if (block.chartType === "pie" && block.series.length !== 1) {
        throw new DeliverableError("DELIVERABLE_INVALID", `Pie chart ${block.blockId} requires exactly one series.`);
      }
      chartPoints += block.categories.length * block.series.length;
    }
  }
  if (textCharacters > MAX_TEXT_CHARACTERS) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "Document text exceeds the safe character budget.");
  if (tableCells > MAX_TABLE_CELLS) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "Document tables exceed the safe cell budget.");
  if (chartPoints > MAX_CHART_POINTS) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "Document charts exceed the safe point budget.");
}

function snapshotAssets(workspace: string, blocks: readonly RichDocumentBlock[], targetDirectory: string): AssetSnapshot[] {
  const paths = [...new Set(flattenBlocks(blocks).filter((block) => block.type === "image").map((block) => block.assetPath))];
  if (paths.length > MAX_ASSETS) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The document exceeds the image count budget.");
  const snapshots: AssetSnapshot[] = [];
  let totalBytes = 0;
  for (const sourcePath of paths) {
    const extension = extname(sourcePath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      throw new DeliverableError("INVALID_DOCUMENT_ASSET", `Unsupported image format: ${sourcePath}.`);
    }
    let absolute: string;
    try { absolute = resolveWorkspaceTarget(workspace, normalizeWorkspaceRelative(sourcePath), true); }
    catch (error) { throw new DeliverableError("INVALID_DOCUMENT_ASSET", `Invalid image path ${sourcePath}: ${errorMessage(error)}`); }
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new DeliverableError("INVALID_DOCUMENT_ASSET", `Image is not a regular file: ${sourcePath}.`);
    if (stats.size > MAX_ASSET_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", `Image exceeds the per-file byte budget: ${sourcePath}.`);
    totalBytes += stats.size;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "Document images exceed the total byte budget.");
    const bytes = readFileSync(absolute);
    validateImageBytes(sourcePath, extension, bytes);
    const digest = digestBytes(bytes);
    const fileName = `${digest.slice("sha256:".length)}${extension === ".jpeg" ? ".jpg" : extension}`;
    const destination = join(targetDirectory, fileName);
    if (!existsSync(destination)) copyFileSync(absolute, destination);
    snapshots.push({ sourcePath: normalizeWorkspaceRelative(sourcePath), packagedPath: `assets/${fileName}`, digest, byteLength: bytes.byteLength });
  }
  return snapshots;
}

function validateImageBytes(sourcePath: string, extension: string, bytes: Buffer): void {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  const valid = extension === ".png" ? png : extension === ".jpg" || extension === ".jpeg" ? jpeg : extension === ".webp" && webp;
  if (!valid) throw new DeliverableError("INVALID_DOCUMENT_ASSET", `Image bytes do not match the declared format: ${sourcePath}.`);
}

function renderRichDocument(source: RichDocumentSource, assets: ReadonlyMap<string, string>): string {
  const theme = source.theme;
  const dark = theme.surface === "dark";
  const background = dark ? "#0f172a" : "#f3f5f8";
  const surface = dark ? "#172033" : "#ffffff";
  const text = dark ? "#e5edf7" : "#172033";
  const muted = dark ? "#9aa9bd" : "#64748b";
  const border = dark ? "#334155" : "#dbe3ee";
  const radius = theme.corners === "rounded" ? "18px" : "2px";
  const spacing = theme.spacing === "comfortable" ? "28px" : "18px";
  const maxWidth = theme.pageWidth === "narrow" ? "820px" : theme.pageWidth === "wide" ? "1320px" : "1080px";
  const font = theme.font === "serif" ? "Georgia, 'Times New Roman', serif" : "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  const body = source.blocks.map((block) => renderBlock(block, assets, source.theme.primaryColor, source.theme.accentColor)).join("\n");
  return `<!doctype html>
<html lang="${escapeAttribute(source.locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">
  <title>${escapeHtml(source.title)}</title>
  <style>
    :root{color-scheme:${dark ? "dark" : "light"};--primary:${theme.primaryColor};--accent:${theme.accentColor};--bg:${background};--surface:${surface};--text:${text};--muted:${muted};--border:${border};--radius:${radius};--space:${spacing}}
    *{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font-family:${font};font-size:16px;line-height:1.65}
    main{width:min(calc(100% - 32px),${maxWidth});margin:32px auto;padding:clamp(24px,5vw,64px);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 24px 70px rgba(15,23,42,.12)}
    h1,h2,h3,h4{line-height:1.18;letter-spacing:-.025em;margin:1.4em 0 .55em}h1{font-size:clamp(2.2rem,5vw,4.4rem);margin-top:0}h2{font-size:2rem;border-bottom:1px solid var(--border);padding-bottom:.35em}h3{font-size:1.4rem}h4{font-size:1.1rem}
    p,ul,ol{margin:.75em 0}a{color:var(--primary);text-decoration-thickness:1px;text-underline-offset:3px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:color-mix(in srgb,var(--primary) 10%,transparent);padding:.12em .35em;border-radius:5px}
    .columns{display:grid;grid-template-columns:repeat(var(--columns),minmax(0,1fr));gap:var(--space);margin:var(--space) 0}.column>*:first-child{margin-top:0}
    .metric,.callout{border:1px solid var(--border);border-radius:var(--radius);padding:20px;background:color-mix(in srgb,var(--primary) 4%,var(--surface))}.metric-label,.caption{color:var(--muted);font-size:.88rem}.metric-value{font-size:2rem;font-weight:750;color:var(--primary);line-height:1.2}.metric-delta{color:var(--accent);font-weight:650}.callout{border-left:5px solid var(--accent)}.callout.warning{--accent:#f59e0b}.callout.success{--accent:#16a34a}
    .table-wrap{overflow:auto;margin:var(--space) 0;border:1px solid var(--border);border-radius:var(--radius)}table{width:100%;border-collapse:collapse;min-width:520px}th,td{padding:12px 14px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}th{background:color-mix(in srgb,var(--primary) 9%,var(--surface));font-weight:700}tr:last-child td{border-bottom:0}
    figure{margin:var(--space) 0}figure img{display:block;width:100%;max-height:560px;object-fit:contain;border-radius:var(--radius);border:1px solid var(--border)}figure.cover img{object-fit:cover}.caption{margin-top:8px}.chart{padding:16px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}.chart svg{display:block;width:100%;height:auto}.chart-title{font-weight:750;margin-bottom:10px}.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;color:var(--muted);font-size:.85rem}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px}
    hr{border:0;border-top:1px solid var(--border);margin:var(--space) 0}@media(max-width:760px){main{width:100%;margin:0;border:0;border-radius:0;padding:24px}.columns{grid-template-columns:1fr!important}}
  </style>
</head>
<body><main data-deliverable-id="${escapeAttribute(source.deliverableId)}" data-revision="${source.revision}">${body}</main></body>
</html>\n`;
}

function renderBlock(block: RichDocumentBlock, assets: ReadonlyMap<string, string>, primary: string, accent: string): string {
  const id = escapeAttribute(block.blockId);
  if (block.type === "heading") return `<h${block.level} data-block-id="${id}">${renderRuns(block.runs)}</h${block.level}>`;
  if (block.type === "paragraph") return `<p data-block-id="${id}">${renderRuns(block.runs)}</p>`;
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    return `<${tag} data-block-id="${id}">${block.items.map((item) => `<li>${renderRuns(item)}</li>`).join("")}</${tag}>`;
  }
  if (block.type === "table") {
    const header = block.headers.length === 0 ? "" : `<thead><tr>${block.headers.map((cell, index) => `<th style="text-align:${block.align?.[index] ?? "left"}">${renderRuns(cell)}</th>`).join("")}</tr></thead>`;
    const rows = block.rows.map((row) => `<tr>${row.map((cell, index) => `<td style="text-align:${block.align?.[index] ?? "left"}">${renderRuns(cell)}</td>`).join("")}</tr>`).join("");
    return `<figure data-block-id="${id}">${block.caption === undefined ? "" : `<figcaption class="caption">${renderRuns(block.caption)}</figcaption>`}<div class="table-wrap"><table>${header}<tbody>${rows}</tbody></table></div></figure>`;
  }
  if (block.type === "metric") return `<section class="metric" data-block-id="${id}"><div class="metric-label">${renderRuns(block.label)}</div><div class="metric-value">${renderRuns(block.value)}</div>${block.delta === undefined ? "" : `<div class="metric-delta">${renderRuns(block.delta)}</div>`}${block.note === undefined ? "" : `<div class="caption">${renderRuns(block.note)}</div>`}</section>`;
  if (block.type === "callout") return `<aside class="callout ${block.tone}" data-block-id="${id}">${renderRuns(block.runs)}</aside>`;
  if (block.type === "image") {
    const packaged = assets.get(normalizeWorkspaceRelative(block.assetPath));
    if (packaged === undefined) throw new DeliverableError("INVALID_DOCUMENT_ASSET", `Image snapshot missing: ${block.assetPath}.`);
    return `<figure class="${block.fit === "cover" ? "cover" : ""}" data-block-id="${id}"><img src="${escapeAttribute(packaged)}" alt="${escapeAttribute(block.alt)}">${block.caption === undefined ? "" : `<figcaption class="caption">${renderRuns(block.caption)}</figcaption>`}</figure>`;
  }
  if (block.type === "chart") return `<figure class="chart" data-block-id="${id}">${block.title === undefined ? "" : `<figcaption class="chart-title">${escapeHtml(block.title)}</figcaption>`}${renderChart(block, primary, accent)}</figure>`;
  if (block.type === "columns") return `<section class="columns" style="--columns:${block.columns.length}" data-block-id="${id}">${block.columns.map((column) => `<div class="column">${column.map((child) => renderBlock(child, assets, primary, accent)).join("\n")}</div>`).join("\n")}</section>`;
  return `<hr data-block-id="${id}">`;
}

function renderRuns(runs: readonly InlineRun[]): string {
  return runs.map((run) => {
    let value = escapeHtml(run.text);
    if (run.code === true) value = `<code>${value}</code>`;
    if (run.bold === true) value = `<strong>${value}</strong>`;
    if (run.italic === true) value = `<em>${value}</em>`;
    if (run.underline === true) value = `<u>${value}</u>`;
    if (run.href !== undefined) value = `<a href="${escapeAttribute(run.href)}" rel="noreferrer">${value}</a>`;
    return value;
  }).join("");
}

function renderChart(block: Extract<RichDocumentLeafBlock, { type: "chart" }>, primary: string, accent: string): string {
  const colors = block.series.map((series, index) => series.color ?? [primary, accent, "#8b5cf6", "#f59e0b", "#16a34a", "#ef4444"][index % 6]!);
  if (block.chartType === "pie") return renderPieChart(block, colors[0]!);
  const width = 900;
  const height = 420;
  const left = 70;
  const right = 20;
  const top = 20;
  const bottom = 70;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = block.series.flatMap((series) => series.values);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const y = (value: number) => top + (max - value) / range * plotHeight;
  const zeroY = y(0);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = min + range * index / 4;
    const py = y(value);
    return `<line x1="${left}" x2="${width - right}" y1="${fixed(py)}" y2="${fixed(py)}" stroke="currentColor" opacity=".12"/><text x="${left - 10}" y="${fixed(py + 4)}" text-anchor="end" fill="currentColor" opacity=".65" font-size="12">${escapeHtml(formatNumber(value))}</text>`;
  }).join("");
  const labels = block.categories.map((category, index) => {
    const x = left + (index + .5) / block.categories.length * plotWidth;
    return `<text x="${fixed(x)}" y="${height - 28}" text-anchor="middle" fill="currentColor" opacity=".7" font-size="12">${escapeHtml(compactLabel(category))}</text>`;
  }).join("");
  let marks = "";
  if (block.chartType === "bar") {
    const groupWidth = plotWidth / block.categories.length * .76;
    const barWidth = groupWidth / block.series.length;
    marks = block.categories.map((_, categoryIndex) => block.series.map((series, seriesIndex) => {
      const value = series.values[categoryIndex]!;
      const x = left + (categoryIndex + .5) / block.categories.length * plotWidth - groupWidth / 2 + seriesIndex * barWidth;
      const valueY = y(value);
      return `<rect x="${fixed(x)}" y="${fixed(Math.min(zeroY, valueY))}" width="${fixed(Math.max(1, barWidth - 3))}" height="${fixed(Math.max(1, Math.abs(zeroY - valueY)))}" rx="3" fill="${colors[seriesIndex]}"><title>${escapeHtml(`${series.name}: ${formatNumber(value)}`)}</title></rect>`;
    }).join("")).join("");
  } else {
    marks = block.series.map((series, seriesIndex) => {
      const points = series.values.map((value, index) => `${fixed(left + (index + .5) / block.categories.length * plotWidth)},${fixed(y(value))}`).join(" ");
      const dots = series.values.map((value, index) => `<circle cx="${fixed(left + (index + .5) / block.categories.length * plotWidth)}" cy="${fixed(y(value))}" r="4" fill="${colors[seriesIndex]}"><title>${escapeHtml(`${series.name}: ${formatNumber(value)}`)}</title></circle>`).join("");
      return `<polyline points="${points}" fill="none" stroke="${colors[seriesIndex]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
    }).join("");
  }
  const legend = block.showLegend ? `<div class="legend">${block.series.map((series, index) => `<span><i style="background:${colors[index]}"></i>${escapeHtml(series.name)}</span>`).join("")}</div>` : "";
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(block.title ?? "Chart")}" xmlns="http://www.w3.org/2000/svg">${grid}<line x1="${left}" x2="${width - right}" y1="${fixed(zeroY)}" y2="${fixed(zeroY)}" stroke="currentColor" opacity=".35"/>${labels}${marks}</svg>${legend}`;
}

function renderPieChart(block: Extract<RichDocumentLeafBlock, { type: "chart" }>, color: string): string {
  const series = block.series[0]!;
  const values = series.values.map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const palette = [color, "#0ea5e9", "#8b5cf6", "#f59e0b", "#16a34a", "#ef4444", "#ec4899", "#14b8a6"];
  let offset = 0;
  const circles = values.map((value, index) => {
    const portion = value / total;
    const dash = `${fixed(portion * 100)} ${fixed((1 - portion) * 100)}`;
    const element = `<circle cx="50" cy="50" r="34" fill="none" stroke="${palette[index % palette.length]}" stroke-width="26" pathLength="100" stroke-dasharray="${dash}" stroke-dashoffset="${fixed(-offset * 100)}"><title>${escapeHtml(`${block.categories[index]}: ${formatNumber(value)}`)}</title></circle>`;
    offset += portion;
    return element;
  }).join("");
  const legend = block.showLegend ? `<div class="legend">${block.categories.map((category, index) => `<span><i style="background:${palette[index % palette.length]}"></i>${escapeHtml(category)}</span>`).join("")}</div>` : "";
  return `<svg viewBox="0 0 100 100" role="img" aria-label="${escapeAttribute(block.title ?? "Pie chart")}" xmlns="http://www.w3.org/2000/svg" style="max-height:360px">${circles}<circle cx="50" cy="50" r="20" fill="var(--surface)"/></svg>${legend}`;
}

function validateRenderedPreview(preview: string, source: RichDocumentSource): void {
  const forbidden = [/<script\b/iu, /\son[a-z]+\s*=/iu, /javascript:/iu, /<iframe\b/iu, /<object\b/iu, /\s(?:src|poster)\s*=\s*["']https?:\/\//iu];
  if (forbidden.some((pattern) => pattern.test(preview))) {
    throw new DeliverableError("DOCUMENT_RENDER_FAILED", "The rendered preview contains an executable or remote resource capability.");
  }
  if (!preview.includes("Content-Security-Policy") || !preview.includes("script-src 'none'")) {
    throw new DeliverableError("DOCUMENT_RENDER_FAILED", "The rendered preview is missing its restrictive CSP.");
  }
  for (const id of allBlockIds(source.blocks)) {
    if (!preview.includes(`data-block-id="${escapeAttribute(id)}"`)) {
      throw new DeliverableError("DOCUMENT_RENDER_FAILED", `Rendered block is missing: ${id}.`);
    }
  }
}

function blockTextLength(block: RichDocumentLeafBlock): number {
  if (block.type === "heading" || block.type === "paragraph" || block.type === "callout") return runsLength(block.runs);
  if (block.type === "list") return block.items.reduce((sum, item) => sum + runsLength(item), 0);
  if (block.type === "table") return block.headers.reduce((sum, cell) => sum + runsLength(cell), 0) + block.rows.flat().reduce((sum, cell) => sum + runsLength(cell), 0) + (block.caption === undefined ? 0 : runsLength(block.caption));
  if (block.type === "metric") return runsLength(block.label) + runsLength(block.value) + (block.delta === undefined ? 0 : runsLength(block.delta)) + (block.note === undefined ? 0 : runsLength(block.note));
  if (block.type === "image") return block.alt.length + (block.caption === undefined ? 0 : runsLength(block.caption));
  if (block.type === "chart") return (block.title?.length ?? 0) + block.categories.join("").length + block.series.reduce((sum, series) => sum + series.name.length, 0);
  return 0;
}

function runsLength(runs: readonly InlineRun[]): number { return runs.reduce((sum, run) => sum + run.text.length + (run.href?.length ?? 0), 0); }
function flattenBlocks(blocks: readonly RichDocumentBlock[]): RichDocumentLeafBlock[] { return blocks.flatMap((block) => block.type === "columns" ? block.columns.flat() : [block]); }
function allBlockIds(blocks: readonly RichDocumentBlock[]): string[] { return blocks.flatMap((block) => block.type === "columns" ? [block.blockId, ...block.columns.flatMap((column) => allBlockIds(column))] : [block.blockId]); }
function countBlocks(source: RichDocumentSource): number { return allBlockIds(source.blocks).length; }
function blockDigests(blocks: readonly RichDocumentBlock[]): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (items: readonly RichDocumentBlock[]): void => {
    for (const block of items) {
      map.set(block.blockId, digestText(JSON.stringify(block)));
      if (block.type === "columns") for (const column of block.columns) visit(column);
    }
  };
  visit(blocks);
  return map;
}

function emptyPatchSummary(preservedBlockCount: number): PatchSummary {
  return { changedBlockIds: [], insertedBlockIds: [], removedBlockIds: [], movedBlockIds: [], preservedBlockCount };
}

function isRecoverableCreateOrphan(root: string, invocationId: string): boolean {
  const validation = join(root, "revisions", "000001", "validation.json");
  if (existsSync(validation)) {
    try { return readJsonFile<ValidationRecord>(validation).invocationId === invocationId; }
    catch { return false; }
  }
  const marker = join(root, `.tmp-${safeInvocationSegment(invocationId)}`, ".invocation.json");
  if (!existsSync(marker)) return false;
  try { return readJsonFile<{ invocationId: string }>(marker).invocationId === invocationId; }
  catch { return false; }
}

function deliverableIdFor(relativeDirectory: string): string { return `deliverable:${createHash("sha256").update(relativeDirectory.toLowerCase()).digest("hex")}`; }
function digestText(value: string): string { return digestBytes(Buffer.from(value, "utf8")); }
function digestBytes(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function readJsonFile<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
function fixed(value: number): string { return Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/u, "") : "0"; }
function formatNumber(value: number): string { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value); }
function compactLabel(value: string): string { return value.length <= 12 ? value : `${value.slice(0, 11)}…`; }
function escapeHtml(value: string): string { return value.replace(/[&<>]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!); }
function escapeAttribute(value: string): string { return escapeHtml(value).replace(/["']/gu, (character) => character === '"' ? "&quot;" : "&#39;"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeInvocationSegment(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    throw new DeliverableError("DOCUMENT_TIMEOUT", "Document generation exceeded its allowed duration.", true);
  }
  throw new DeliverableError("DOCUMENT_CANCELLED", "Document generation was cancelled before commit.");
}

export function writeOfficeFile(format: "docx" | "xlsx" | "pptx" | "pdf", path: string, bytes: Uint8Array): void {
  try { writeFileSync(path, bytes); }
  catch (error) { throw new DeliverableError("OFFICE_FILE_WRITE_FAILED", `${format.toUpperCase()} write failed: ${errorMessage(error)}`); }
}

function writeManifestAtomic(path: string, manifest: RichDocumentManifest): void {
  const temporary = `${path}.${safeInvocationSegment(manifest.updatedByInvocationId)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

function normalizeWorkspaceRelative(value: string): string {
  const trimmed = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (trimmed.length === 0 || isAbsolute(trimmed) || /^[a-z]:/iu.test(trimmed) || trimmed.startsWith("//")) {
    throw new DeliverableError("WORKSPACE_BOUNDARY_VIOLATION", "Deliverable paths must be non-empty Workspace-relative paths.");
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new DeliverableError("WORKSPACE_BOUNDARY_VIOLATION", "Deliverable paths cannot contain empty, dot or parent segments.");
  }
  return parts.join("/");
}

function resolveWorkspaceTarget(workspace: string, relativePath: string, mustExist: boolean): string {
  const root = workspaceRoot(workspace);
  const normalized = normalizeWorkspaceRelative(relativePath);
  const target = resolve(root, ...normalized.split("/"));
  assertWorkspaceContained(root, target);
  let cursor = root;
  for (const segment of normalized.split("/")) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) throw new DeliverableError("WORKSPACE_BOUNDARY_VIOLATION", `Workspace path contains a symbolic link: ${relativePath}.`);
  }
  if (mustExist && !existsSync(target)) throw new DeliverableError("DELIVERABLE_INVALID", `Workspace entry does not exist: ${relativePath}.`);
  return target;
}

function assertWorkspaceContained(workspace: string, target: string): void {
  const root = workspaceRoot(workspace);
  const relation = relative(root, resolve(target));
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) return;
  throw new DeliverableError("WORKSPACE_BOUNDARY_VIOLATION", "Resolved Deliverable path escapes the current Workspace.");
}

function toWorkspaceRelative(workspace: string, target: string): string {
  assertWorkspaceContained(workspace, target);
  return relative(workspaceRoot(workspace), resolve(target)).split(sep).join("/");
}

function workspaceRoot(workspace: string): string {
  const root = resolve(workspace);
  if (!existsSync(root)) throw new DeliverableError("WORKSPACE_BOUNDARY_VIOLATION", "The current Workspace does not exist.");
  return realpathSync.native(root);
}

async function withDeliverableLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = deliverableLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const queued = previous.then(() => current);
  deliverableLocks.set(key, queued);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (deliverableLocks.get(key) === queued) deliverableLocks.delete(key);
  }
}
