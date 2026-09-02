import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";

import type {
  ImportedOfficeCreateInput,
  ImportedOfficePatchInput,
  ImportedOfficePatchOperation,
  OfficeSourceInspectInput,
  RichDocumentInspectInput,
  RichDocumentWriteFacts
} from "./contracts.js";
import { validateDocxPackage } from "./docx-renderer.js";
import { validatePptxPackage } from "./pptx-renderer.js";
import { DeliverableError } from "./rich-document.js";
import { validateXlsxPackage } from "./xlsx-renderer.js";

type OfficeFormat = "docx" | "xlsx" | "pptx";
type PackageEntries = Record<string, Uint8Array>;
type NativeDescriptor = Record<string, unknown> & { readonly targetId: string; readonly type: string };

const MAX_OFFICE_BYTES = 50_000_000;
const MAX_PREVIEW_BYTES = 5_000_000;
const MAX_INSPECT_TARGETS = 512;
const EMU_PER_INCH = 914_400;
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";

const ImportedOfficeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  deliverableId: z.string().regex(/^deliverable:[a-f0-9]{64}$/u),
  kind: z.literal("rich_document"),
  sourceKind: z.literal("imported_office"),
  title: z.string().trim().min(1).max(300),
  originalFormat: z.enum(["docx", "xlsx", "pptx"]),
  originalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  originalAttachmentPath: z.string().min(1).max(1_024),
  currentRevision: z.number().int().positive(),
  currentRevisionPath: z.string().min(1).max(1_024),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  previewDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  files: z.array(z.object({
    format: z.enum(["docx", "xlsx", "pptx"]),
    path: z.string().min(1).max(1_024),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    byteLength: z.number().int().positive()
  }).strict()).length(1),
  createdByInvocationId: z.string().min(1).max(256),
  updatedByInvocationId: z.string().min(1).max(256)
}).strict();

export type ImportedOfficeManifest = z.infer<typeof ImportedOfficeManifestSchema>;

export type OfficeSourceInspection = {
  readonly path: string;
  readonly format: OfficeFormat;
  readonly digest: string;
  readonly byteLength: number;
  readonly validation: "passed";
  readonly targetCount: number;
  readonly outline: NativeInspection["outline"];
  readonly blocks: readonly NativeDescriptor[];
};

type NativeInspection = {
  readonly format: OfficeFormat;
  readonly descriptors: readonly NativeDescriptor[];
  readonly outline: readonly { readonly blockId: string; readonly type: string; readonly depth: number }[];
};

const importedLocks = new Map<string, Promise<void>>();

export function isImportedOfficeDeliverable(workspace: string, manifestPath: string): boolean {
  try {
    const value = JSON.parse(readFileSync(resolveWorkspaceTarget(workspace, manifestPath, true), "utf8")) as Record<string, unknown>;
    return value.sourceKind === "imported_office";
  } catch {
    return false;
  }
}

export function inspectOfficeSource(workspace: string, input: OfficeSourceInspectInput): OfficeSourceInspection {
  const source = resolveWorkspaceTarget(workspace, input.path, true);
  const stats = lstatSync(source);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new DeliverableError("DOCUMENT_INVALID_INPUT", "The Office source must be a regular file.");
  if (stats.size <= 0 || stats.size > MAX_OFFICE_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The Office source is empty or exceeds 50 MB.");
  const format = officeFormat(source);
  const bytes = readFileSync(source);
  const digest = digestBytes(bytes);
  if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
    throw new DeliverableError("DOCUMENT_ATTACHMENT_DRIFT", "The Office source digest changed before inspection.");
  }
  validateOfficeBytes(format, bytes);
  const inspection = inspectNativeBytes(format, bytes);
  const requested = new Set(input.targetIds ?? []);
  const blocks = input.mode === "blocks"
    ? inspection.descriptors.filter(({ targetId }) => requested.has(targetId))
    : [];
  if (input.mode === "blocks" && blocks.length !== requested.size) {
    throw new DeliverableError("INVALID_DOCUMENT_PATCH", "One or more requested Office source targets do not exist.");
  }
  return {
    path: normalizeWorkspaceRelative(input.path),
    format,
    digest,
    byteLength: bytes.byteLength,
    validation: "passed",
    targetCount: inspection.descriptors.length,
    outline: input.mode === "summary" ? [] : inspection.outline,
    blocks
  };
}

export async function importOfficeDocument(
  workspace: string,
  invocationId: string,
  input: ImportedOfficeCreateInput,
  signal: AbortSignal
): Promise<RichDocumentWriteFacts> {
  throwIfAborted(signal);
  const attachment = resolveWorkspaceTarget(workspace, input.attachmentPath, true);
  const stats = lstatSync(attachment);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new DeliverableError("DOCUMENT_INVALID_INPUT", "The Office attachment must be a regular file.");
  if (stats.size <= 0 || stats.size > MAX_OFFICE_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The Office attachment is empty or exceeds 50 MB.");
  const format = officeFormat(attachment);
  const bytes = readFileSync(attachment);
  const attachmentDigest = digestBytes(bytes);
  if (attachmentDigest !== input.attachmentDigest) throw new DeliverableError("DOCUMENT_ATTACHMENT_DRIFT", "The staged attachment digest changed before import.");
  validateOfficeBytes(format, bytes);
  const title = input.title?.trim() || basename(attachment, extname(attachment));
  const root = resolveWorkspaceTarget(workspace, input.outputDirectory, false);
  const manifestPath = toWorkspaceRelative(workspace, join(root, "manifest.nexora.json"));

  return await withImportedLock(root, async () => {
    throwIfAborted(signal);
    if (existsSync(join(root, "manifest.nexora.json"))) {
      const existing = readImportedManifest(workspace, manifestPath);
      if (existing.createdByInvocationId === invocationId && existing.originalDigest === attachmentDigest) {
        return factsFromManifest(workspace, existing, [], [], [], 0);
      }
      throw new DeliverableError("DELIVERABLE_ALREADY_EXISTS", "The import output directory already contains a Deliverable.");
    }
    if (existsSync(root) && readDirectoryNotEmpty(root)) throw new DeliverableError("DELIVERABLE_ALREADY_EXISTS", "The import output directory is not empty.");

    const deliverableId = deliverableIdFor(toWorkspaceRelative(workspace, root));
    const inspection = inspectNativeBytes(format, bytes);
    const preview = renderNativePreview(title, 1, inspection);
    const previewDigest = digestText(preview);
    const revisionRoot = join(root, "revisions", "000001");
    const temporaryRoot = `${revisionRoot}.pending-${safeInvocationSegment(invocationId)}`;
    rmSync(temporaryRoot, { recursive: true, force: true });
    mkdirSync(temporaryRoot, { recursive: true });
    try {
      const fileName = `document.${format}`;
      writeFileSync(join(temporaryRoot, fileName), bytes);
      writeFileSync(join(temporaryRoot, "preview.html"), preview, "utf8");
      writeFileSync(join(temporaryRoot, "source.json"), `${JSON.stringify({
        schemaVersion: 1,
        sourceKind: "imported_office",
        format,
        originalDigest: attachmentDigest,
        sourceDigest: attachmentDigest,
        targetCount: inspection.descriptors.length
      }, null, 2)}\n`, "utf8");
      writeFileSync(join(temporaryRoot, "validation.json"), `${JSON.stringify({
        schemaVersion: 1,
        invocationId,
        format,
        sourceDigest: attachmentDigest,
        previewDigest,
        targetCount: inspection.descriptors.length,
        validation: "passed"
      }, null, 2)}\n`, "utf8");
      mkdirSync(dirname(revisionRoot), { recursive: true });
      renameSync(temporaryRoot, revisionRoot);
    } catch (error) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      throw error;
    }

    const manifest = ImportedOfficeManifestSchema.parse({
      schemaVersion: 1,
      deliverableId,
      kind: "rich_document",
      sourceKind: "imported_office",
      title,
      originalFormat: format,
      originalDigest: attachmentDigest,
      originalAttachmentPath: normalizeWorkspaceRelative(input.attachmentPath),
      currentRevision: 1,
      currentRevisionPath: toWorkspaceRelative(workspace, revisionRoot),
      sourceDigest: attachmentDigest,
      previewDigest,
      files: [{ format, path: toWorkspaceRelative(workspace, join(revisionRoot, `document.${format}`)), digest: attachmentDigest, byteLength: bytes.byteLength }],
      createdByInvocationId: invocationId,
      updatedByInvocationId: invocationId
    });
    writeManifestAtomic(join(root, "manifest.nexora.json"), manifest);
    return factsFromManifest(workspace, manifest, [], inspection.descriptors.map(({ targetId }) => targetId), [], 0);
  });
}

export function inspectImportedOffice(
  workspace: string,
  input: RichDocumentInspectInput
): {
  readonly manifest: ImportedOfficeManifest;
  readonly outline: readonly { readonly blockId: string; readonly type: string; readonly depth: number }[];
  readonly blocks: readonly NativeDescriptor[];
  readonly blockCount: number;
} {
  const manifest = readImportedManifest(workspace, input.manifestPath);
  const bytes = readCurrentOfficeBytes(workspace, manifest);
  const inspection = inspectNativeBytes(manifest.originalFormat, bytes);
  const requested = new Set(input.blockIds ?? []);
  const blocks = input.mode === "blocks"
    ? inspection.descriptors.filter(({ targetId }) => requested.has(targetId))
    : [];
  if (input.mode === "blocks" && blocks.length !== requested.size) {
    throw new DeliverableError("INVALID_DOCUMENT_PATCH", "One or more requested Office targets do not exist in the current revision.");
  }
  return {
    manifest,
    outline: input.mode === "summary" ? [] : inspection.outline,
    blocks,
    blockCount: inspection.descriptors.length
  };
}

export async function patchImportedOffice(
  workspace: string,
  invocationId: string,
  input: ImportedOfficePatchInput,
  signal: AbortSignal
): Promise<RichDocumentWriteFacts> {
  const root = dirname(resolveWorkspaceTarget(workspace, input.manifestPath, true));
  return await withImportedLock(root, async () => {
    throwIfAborted(signal);
    const current = readImportedManifest(workspace, input.manifestPath);
    if (current.currentRevision !== input.expectedRevision || current.sourceDigest !== input.expectedSourceDigest) {
      throw new DeliverableError("DELIVERABLE_STALE_REVISION", `The imported Office Deliverable is revision ${current.currentRevision} with source digest ${current.sourceDigest}; inspect it before patching.`);
    }
    const before = readCurrentOfficeBytes(workspace, current);
    const beforeInspection = inspectNativeBytes(current.originalFormat, before);
    const patched = patchNativeBytes(workspace, current.originalFormat, before, input.operations);
    validateOfficeBytes(current.originalFormat, patched.bytes);
    const afterInspection = inspectNativeBytes(current.originalFormat, patched.bytes);
    const nextRevision = current.currentRevision + 1;
    const sourceDigest = digestBytes(patched.bytes);
    const preview = renderNativePreview(current.title, nextRevision, afterInspection);
    const previewDigest = digestText(preview);
    const revisionRoot = join(root, "revisions", String(nextRevision).padStart(6, "0"));
    const temporaryRoot = `${revisionRoot}.pending-${safeInvocationSegment(invocationId)}`;
    if (existsSync(revisionRoot)) {
      const validation = readJson(join(revisionRoot, "validation.json"));
      if (validation.invocationId === invocationId && validation.sourceDigest === sourceDigest) {
        const recovered = manifestForRevision(workspace, current, invocationId, nextRevision, sourceDigest, previewDigest, patched.bytes.byteLength);
        writeManifestAtomic(join(root, "manifest.nexora.json"), recovered);
        return factsFromManifest(workspace, recovered, patched.changedTargetIds, [], patched.removedTargetIds, Math.max(0, beforeInspection.descriptors.length - patched.changedTargetIds.length - patched.removedTargetIds.length));
      }
      throw new DeliverableError("DELIVERABLE_CONFLICT", `Revision ${nextRevision} already exists for another operation.`);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
    mkdirSync(temporaryRoot, { recursive: true });
    try {
      writeFileSync(join(temporaryRoot, `document.${current.originalFormat}`), patched.bytes);
      writeFileSync(join(temporaryRoot, "preview.html"), preview, "utf8");
      writeFileSync(join(temporaryRoot, "source.json"), `${JSON.stringify({
        schemaVersion: 1,
        sourceKind: "imported_office",
        format: current.originalFormat,
        originalDigest: current.originalDigest,
        sourceDigest,
        targetCount: afterInspection.descriptors.length
      }, null, 2)}\n`, "utf8");
      writeFileSync(join(temporaryRoot, "validation.json"), `${JSON.stringify({
        schemaVersion: 1,
        invocationId,
        format: current.originalFormat,
        sourceDigest,
        previewDigest,
        targetCount: afterInspection.descriptors.length,
        changedTargetIds: patched.changedTargetIds,
        removedTargetIds: patched.removedTargetIds,
        validation: "passed"
      }, null, 2)}\n`, "utf8");
      mkdirSync(dirname(revisionRoot), { recursive: true });
      renameSync(temporaryRoot, revisionRoot);
    } catch (error) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
    const next = manifestForRevision(workspace, current, invocationId, nextRevision, sourceDigest, previewDigest, patched.bytes.byteLength);
    writeManifestAtomic(join(root, "manifest.nexora.json"), next);
    return factsFromManifest(workspace, next, patched.changedTargetIds, [], patched.removedTargetIds, Math.max(0, beforeInspection.descriptors.length - patched.changedTargetIds.length - patched.removedTargetIds.length));
  });
}

export function readImportedOfficePreview(
  workspace: string,
  manifestPath: string,
  expectedRevision: number,
  expectedPreviewDigest: string
): { readonly manifest: ImportedOfficeManifest; readonly html: string } {
  const manifest = readImportedManifest(workspace, manifestPath);
  if (manifest.currentRevision !== expectedRevision || manifest.previewDigest !== expectedPreviewDigest) {
    throw new DeliverableError("DELIVERABLE_STALE_REVISION", "The imported Office preview no longer matches the selected revision.");
  }
  const previewPath = resolveWorkspaceTarget(workspace, `${manifest.currentRevisionPath}/preview.html`, true);
  const html = readFileSync(previewPath, "utf8");
  if (Buffer.byteLength(html) > MAX_PREVIEW_BYTES || digestText(html) !== manifest.previewDigest) {
    throw new DeliverableError("DELIVERABLE_INVALID", "The imported Office preview digest is invalid.");
  }
  return { manifest, html };
}

function patchNativeBytes(
  workspace: string,
  format: OfficeFormat,
  bytes: Buffer,
  operations: readonly ImportedOfficePatchOperation[]
): { readonly bytes: Buffer; readonly changedTargetIds: string[]; readonly removedTargetIds: string[] } {
  const entries = unzipSync(bytes);
  const changed = new Set<string>();
  const removed = new Set<string>();
  const prefix = `${format}.`;
  if (operations.flatMap(operationTargets).some((targetId) => !targetId.startsWith(prefix))) {
    throw new DeliverableError("INVALID_DOCUMENT_PATCH", `Every operation target must belong to the imported ${format.toUpperCase()} document.`);
  }
  if (format === "docx") patchDocx(entries, operations, changed, removed);
  else if (format === "xlsx") patchXlsx(entries, operations, changed, removed);
  else patchPptx(workspace, entries, operations, changed, removed);
  if (changed.size === 0 && removed.size === 0) throw new DeliverableError("INVALID_DOCUMENT_PATCH", "The Office patch did not address a supported target.");
  const output = Buffer.from(zipSync(entries, { level: 6 }));
  if (output.byteLength <= 0 || output.byteLength > MAX_OFFICE_BYTES) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The patched Office file is empty or exceeds 50 MB.");
  return { bytes: output, changedTargetIds: [...changed], removedTargetIds: [...removed] };
}

function patchDocx(entries: PackageEntries, operations: readonly ImportedOfficePatchOperation[], changed: Set<string>, removed: Set<string>): void {
  const document = parseXmlEntry(entries, "word/document.xml");
  const targets = new Map<string, Element>();
  for (const targetId of [...new Set(operations.flatMap(operationTargets))]) {
    const target = findDocxTarget(document, targetId);
    if (target === null) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `DOCX target ${targetId} does not exist.`);
    targets.set(targetId, target);
  }
  for (const operation of operations) {
    if (!operationTargets(operation).some((targetId) => targetId.startsWith("docx."))) continue;
    if (operation.type === "delete_targets") {
      for (const targetId of operation.targetIds) {
        targets.get(targetId)!.parentNode?.removeChild(targets.get(targetId)!);
        removed.add(targetId);
      }
    } else if (operation.type === "delete_target") {
      targets.get(operation.targetId)!.parentNode?.removeChild(targets.get(operation.targetId)!);
      removed.add(operation.targetId);
    } else if (operation.type === "replace_text" || operation.type === "set_table_cell") {
      const target = targets.get(operation.targetId)!;
      if (operation.type === "set_table_cell" && !/^docx\.table\.\d{4}\.cell\.r\d{4}\.c\d{4}$/u.test(operation.targetId)) {
        throw new DeliverableError("INVALID_DOCUMENT_PATCH", "set_table_cell requires an exact DOCX table-cell target.");
      }
      replaceTextNodes(document, target, operation.text, "w:t", "http://schemas.openxmlformats.org/wordprocessingml/2006/main");
      changed.add(operation.targetId);
    } else if (operation.type === "insert_paragraphs_after") {
      let anchor = targets.get(operation.targetId)!;
      if (elementLocalName(anchor) !== "p") throw new DeliverableError("DOCUMENT_UNSUPPORTED_TARGET", "Paragraph insertion requires a DOCX paragraph target.");
      for (const text of operation.paragraphs) anchor = insertDocxParagraphAfter(document, anchor, text);
      changed.add(operation.targetId);
    } else unsupported(operation, "DOCX supports replace_text, set_table_cell, insert_paragraphs_after, delete_target and delete_targets operations.");
  }
  entries["word/document.xml"] = serializeXml(document);
}

function patchXlsx(entries: PackageEntries, operations: readonly ImportedOfficePatchOperation[], changed: Set<string>, removed: Set<string>): void {
  const sheets = xlsxSheets(entries);
  for (const operation of operations) {
    if (operation.type === "delete_targets" || operation.type === "insert_paragraphs_after" || operation.type === "set_table_cell") {
      unsupported(operation, "XLSX supports set_cell, replace_text and delete_target operations on cells.");
    }
    if (!operation.targetId.startsWith("xlsx.")) continue;
    if (operation.type !== "set_cell" && operation.type !== "delete_target" && operation.type !== "replace_text") {
      unsupported(operation, "XLSX supports set_cell, replace_text and delete_target operations on cells.");
    }
    const parsed = /^xlsx\.sheet\.(\d{4})\.cell\.([a-z]+\d+)$/u.exec(operation.targetId);
    if (parsed === null) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `XLSX target ${operation.targetId} is not a cell target.`);
    const sheet = sheets[Number(parsed[1]) - 1];
    if (sheet === undefined) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `XLSX sheet target ${operation.targetId} does not exist.`);
    const document = parseXmlEntry(entries, sheet.path);
    const address = parsed[2]!.toUpperCase();
    if (operation.type === "delete_target") {
      const cell = findElementByAttribute(document, "c", "r", address);
      if (cell === null) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `XLSX cell ${address} does not exist.`);
      cell.parentNode?.removeChild(cell);
      removed.add(operation.targetId);
    } else {
      const value = operation.type === "replace_text" ? operation.text : operation.value;
      const formula = operation.type === "set_cell" ? operation.formula : undefined;
      setXlsxCell(document, address, value, formula);
      changed.add(operation.targetId);
    }
    entries[sheet.path] = serializeXml(document);
  }
  requestSpreadsheetRecalculation(entries);
}

function patchPptx(
  workspace: string,
  entries: PackageEntries,
  operations: readonly ImportedOfficePatchOperation[],
  changed: Set<string>,
  removed: Set<string>
): void {
  const slides = pptxSlides(entries);
  for (const operation of operations) {
    if (operation.type === "delete_targets" || operation.type === "insert_paragraphs_after" || operation.type === "set_table_cell") {
      unsupported(operation, "PPTX supports replace_text, replace_slide_text, delete_target and insert_image operations.");
    }
    if (!operation.targetId.startsWith("pptx.")) continue;
    const match = /^pptx\.slide\.(\d{4})(?:\.shape\.(\d+))?$/u.exec(operation.targetId);
    if (match === null) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `PPTX target ${operation.targetId} is invalid.`);
    const slide = slides[Number(match[1]) - 1];
    if (slide === undefined) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `PPTX slide target ${operation.targetId} does not exist.`);
    const document = parseXmlEntry(entries, slide.path);
    if (operation.type === "replace_slide_text") {
      if (match[2] !== undefined) throw new DeliverableError("INVALID_DOCUMENT_PATCH", "replace_slide_text requires a slide target.");
      const textShapes = topLevelPptxShapes(document).filter((shape) => descendants(shape, "t").length > 0);
      if (textShapes.length === 0) throw new DeliverableError("DOCUMENT_UNSUPPORTED_TARGET", "The selected slide has no editable text shapes.");
      replaceTextNodes(document, textShapes[0]!, operation.title, "a:t", DRAWING_NS);
      if (textShapes[1] !== undefined) replaceTextNodes(document, textShapes[1], operation.body, "a:t", DRAWING_NS);
      else appendTextShape(document, operation.body);
      changed.add(operation.targetId);
    } else if (operation.type === "insert_image") {
      if (match[2] !== undefined) throw new DeliverableError("INVALID_DOCUMENT_PATCH", "insert_image requires a slide target.");
      insertPptxImage(workspace, entries, document, slide.path, operation);
      changed.add(operation.targetId);
    } else if (operation.type === "replace_text" || operation.type === "delete_target") {
      const shapeId = match[2];
      if (shapeId === undefined) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `${operation.type} requires a PPTX shape target.`);
      const shape = findPptxShapeById(document, shapeId);
      if (shape === null) throw new DeliverableError("INVALID_DOCUMENT_PATCH", `PPTX shape ${operation.targetId} does not exist.`);
      if (operation.type === "delete_target") {
        shape.parentNode?.removeChild(shape);
        removed.add(operation.targetId);
      } else {
        replaceTextNodes(document, shape, operation.text, "a:t", DRAWING_NS);
        changed.add(operation.targetId);
      }
    } else unsupported(operation, "PPTX supports replace_text, replace_slide_text, delete_target and insert_image operations.");
    entries[slide.path] = serializeXml(document);
  }
}

function inspectNativeBytes(format: OfficeFormat, bytes: Uint8Array): NativeInspection {
  const entries = unzipSync(bytes);
  return format === "docx" ? inspectDocx(entries) : format === "xlsx" ? inspectXlsxNative(entries) : inspectPptx(entries);
}

function inspectDocx(entries: PackageEntries): NativeInspection {
  const document = parseXmlEntry(entries, "word/document.xml");
  const descriptors: NativeDescriptor[] = [];
  let paragraph = 0;
  let table = 0;
  for (const element of Array.from(descendants(document, "body")[0]?.childNodes ?? [])) {
    if (element.nodeType !== 1) continue;
    if (elementLocalName(element) === "p") {
      paragraph += 1;
      const text = nodeText(element);
      const style = descendants(element, "pStyle")[0]?.getAttribute("w:val") ?? descendants(element, "pStyle")[0]?.getAttribute("val") ?? "";
      const heading = /^heading|^标题/iu.test(style);
      descriptors.push({ targetId: docxParagraphId(paragraph), type: heading ? "heading" : "paragraph", text, style });
    } else if (elementLocalName(element) === "tbl") {
      table += 1;
      const tableId = docxTableId(table);
      const rows = descendants(element, "tr").map((row, rowIndex) => descendants(row, "tc").map((cell, columnIndex) => ({
        targetId: `${tableId}.cell.r${String(rowIndex + 1).padStart(4, "0")}.c${String(columnIndex + 1).padStart(4, "0")}`,
        text: nodeText(cell)
      })));
      descriptors.push({
        targetId: tableId,
        type: "table",
        text: nodeText(element),
        rows
      });
      descriptors.push(...rows.flat().map((cell) => ({ ...cell, type: "table_cell" })));
    }
    if (descriptors.length > MAX_INSPECT_TARGETS) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The DOCX structure exceeds the bounded inspection target count.");
  }
  return { format: "docx", descriptors, outline: descriptors.filter((item) => item.type === "heading" || item.type === "table" || String(item.text ?? "").trim()).map(({ targetId, type }) => ({ blockId: targetId, type, depth: 0 })) };
}

function inspectXlsxNative(entries: PackageEntries): NativeInspection {
  const shared = xlsxSharedStrings(entries);
  const sheets = xlsxSheets(entries);
  const descriptors: NativeDescriptor[] = [];
  for (const [index, sheet] of sheets.entries()) {
    const sheetId = xlsxSheetId(index + 1);
    const document = parseXmlEntry(entries, sheet.path);
    const cells = descendants(document, "c").slice(0, MAX_INSPECT_TARGETS).map((cell) => ({
      targetId: `${sheetId}.cell.${(cell.getAttribute("r") ?? "").toLowerCase()}`,
      type: "cell",
      address: cell.getAttribute("r"),
      value: xlsxCellValue(cell, shared),
      formula: descendants(cell, "f")[0]?.textContent ?? null
    }));
    descriptors.push({ targetId: sheetId, type: "sheet", name: sheet.name, cells });
    descriptors.push(...cells);
    if (descriptors.length > MAX_INSPECT_TARGETS) break;
  }
  return { format: "xlsx", descriptors, outline: sheets.map((sheet, index) => ({ blockId: xlsxSheetId(index + 1), type: `sheet:${sheet.name}`, depth: 0 })) };
}

function inspectPptx(entries: PackageEntries): NativeInspection {
  const slides = pptxSlides(entries);
  const descriptors: NativeDescriptor[] = [];
  const outline: Array<{ blockId: string; type: string; depth: number }> = [];
  for (const [index, slide] of slides.entries()) {
    const slideId = pptxSlideId(index + 1);
    const document = parseXmlEntry(entries, slide.path);
    const shapes = topLevelPptxShapes(document).map((shape, shapeIndex) => {
      const id = shapeIdentifier(shape) ?? String(shapeIndex + 1);
      const type = elementLocalName(shape) === "pic" ? "image" : elementLocalName(shape) === "graphicFrame" ? graphicFrameType(shape) : "shape";
      return { targetId: `${slideId}.shape.${id}`, type, text: nodeText(shape), name: shapeName(shape) };
    });
    const title = shapes.find(({ text }) => text.trim())?.text ?? `Slide ${index + 1}`;
    descriptors.push({ targetId: slideId, type: "slide", slideNumber: index + 1, title, shapes });
    descriptors.push(...shapes);
    outline.push({ blockId: slideId, type: `slide:${compactText(title, 80)}`, depth: 0 });
    if (descriptors.length > MAX_INSPECT_TARGETS) throw new DeliverableError("DOCUMENT_BUDGET_EXCEEDED", "The PPTX structure exceeds the bounded inspection target count.");
  }
  return { format: "pptx", descriptors, outline };
}

function renderNativePreview(title: string, revision: number, inspection: NativeInspection): string {
  const sections = inspection.format === "docx"
    ? inspection.descriptors.map((item) => item.type === "table"
      ? `<section data-target-id="${escapeAttribute(item.targetId)}"><strong>Table</strong><pre>${escapeHtml(JSON.stringify(item.rows ?? []))}</pre></section>`
      : `<section data-target-id="${escapeAttribute(item.targetId)}"><${item.type === "heading" ? "h2" : "p"}>${escapeHtml(String(item.text ?? ""))}</${item.type === "heading" ? "h2" : "p"}></section>`).join("\n")
    : inspection.format === "xlsx"
      ? inspection.descriptors.filter(({ type }) => type === "sheet").map((item) => `<section data-target-id="${escapeAttribute(item.targetId)}"><h2>${escapeHtml(String(item.name ?? "Sheet"))}</h2><table>${(item.cells as Array<Record<string, unknown>>).map((cell) => `<tr><th>${escapeHtml(String(cell.address ?? ""))}</th><td>${escapeHtml(String(cell.value ?? ""))}</td></tr>`).join("")}</table></section>`).join("\n")
      : inspection.descriptors.filter(({ type }) => type === "slide").map((item) => `<section class="slide" data-target-id="${escapeAttribute(item.targetId)}"><h2>${escapeHtml(String(item.title ?? "Slide"))}</h2>${(item.shapes as Array<Record<string, unknown>>).map((shape) => `<p><small>${escapeHtml(String(shape.type ?? "shape"))}</small> ${escapeHtml(String(shape.text ?? shape.name ?? ""))}</p>`).join("")}</section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:28px;color:#172033;background:#f8fafc}main{max-width:960px;margin:auto}header{margin-bottom:24px}.slide,section{background:white;border:1px solid #dbe3ee;border-radius:10px;padding:18px;margin:12px 0}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:6px;text-align:left}small{color:#64748b}pre{white-space:pre-wrap}</style></head><body><main data-source-kind="imported_office" data-format="${inspection.format}" data-revision="${revision}"><header><h1>${escapeHtml(title)}</h1><small>Imported ${inspection.format.toUpperCase()} · revision ${revision}</small></header>${sections}</main></body></html>`;
}

function readImportedManifest(workspace: string, manifestPath: string): ImportedOfficeManifest {
  try {
    return ImportedOfficeManifestSchema.parse(JSON.parse(readFileSync(resolveWorkspaceTarget(workspace, manifestPath, true), "utf8")));
  } catch (error) {
    throw new DeliverableError("DELIVERABLE_INVALID", `The imported Office manifest is invalid: ${errorMessage(error)}`);
  }
}

function readCurrentOfficeBytes(workspace: string, manifest: ImportedOfficeManifest): Buffer {
  const file = manifest.files[0]!;
  const path = resolveWorkspaceTarget(workspace, file.path, true);
  const bytes = readFileSync(path);
  if (digestBytes(bytes) !== manifest.sourceDigest || file.digest !== manifest.sourceDigest) {
    throw new DeliverableError("DELIVERABLE_INVALID", "The imported Office file digest does not match its manifest.");
  }
  validateOfficeBytes(manifest.originalFormat, bytes);
  return bytes;
}

function manifestForRevision(
  workspace: string,
  previous: ImportedOfficeManifest,
  invocationId: string,
  revision: number,
  sourceDigest: string,
  previewDigest: string,
  byteLength: number
): ImportedOfficeManifest {
  const root = dirname(dirname(resolveWorkspaceTarget(workspace, previous.currentRevisionPath, true)));
  const revisionRoot = join(root, "revisions", String(revision).padStart(6, "0"));
  return ImportedOfficeManifestSchema.parse({
    ...previous,
    currentRevision: revision,
    currentRevisionPath: toWorkspaceRelative(workspace, revisionRoot),
    sourceDigest,
    previewDigest,
    files: [{
      format: previous.originalFormat,
      path: toWorkspaceRelative(workspace, join(revisionRoot, `document.${previous.originalFormat}`)),
      digest: sourceDigest,
      byteLength
    }],
    updatedByInvocationId: invocationId
  });
}

function factsFromManifest(
  workspace: string,
  manifest: ImportedOfficeManifest,
  changedBlockIds: readonly string[],
  insertedBlockIds: readonly string[],
  removedBlockIds: readonly string[],
  preservedBlockCount: number
): RichDocumentWriteFacts {
  const inspection = inspectNativeBytes(manifest.originalFormat, readCurrentOfficeBytes(workspace, manifest));
  return {
    deliverableId: manifest.deliverableId,
    kind: "rich_document",
    title: manifest.title,
    manifestPath: toWorkspaceRelative(workspace, join(dirname(dirname(resolveWorkspaceTarget(workspace, manifest.currentRevisionPath, true))), "manifest.nexora.json")),
    previewPath: `${manifest.currentRevisionPath}/preview.html`,
    revision: manifest.currentRevision,
    sourceDigest: manifest.sourceDigest,
    previewDigest: manifest.previewDigest,
    files: manifest.files,
    blockCount: inspection.descriptors.length,
    assetCount: 0,
    validation: "passed",
    changedBlockIds: [...changedBlockIds],
    insertedBlockIds: [...insertedBlockIds],
    removedBlockIds: [...removedBlockIds],
    movedBlockIds: [],
    preservedBlockCount
  };
}

function validateOfficeBytes(format: OfficeFormat, bytes: Uint8Array): void {
  try {
    if (format === "docx") validateDocxPackage(bytes);
    else if (format === "xlsx") validateXlsxPackage(bytes);
    else validatePptxPackage(bytes);
  } catch (error) {
    throw new DeliverableError("DOCUMENT_UNSUPPORTED_OR_INVALID_OFFICE_FILE", `The ${format.toUpperCase()} attachment failed package or active-content validation: ${errorMessage(error)}`);
  }
}

function officeFormat(path: string): OfficeFormat {
  const extension = extname(path).toLowerCase().slice(1);
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") return extension;
  throw new DeliverableError("DOCUMENT_UNSUPPORTED_FORMAT", "Existing-file editing currently supports DOCX, XLSX and PPTX attachments.");
}

function parseXmlEntry(entries: PackageEntries, path: string): Document {
  const bytes = entries[path];
  if (bytes === undefined) throw new DeliverableError("DELIVERABLE_INVALID", `Office package entry ${path} is missing.`);
  const errors: string[] = [];
  const document = new DOMParser({ errorHandler: (level: string, message: unknown) => { if (level === "error" || level === "fatalError") errors.push(String(message)); } }).parseFromString(strFromU8(bytes), "application/xml");
  if (errors.length > 0 || document.documentElement === null) throw new DeliverableError("DELIVERABLE_INVALID", `Office XML ${path} is invalid.`);
  return document;
}

function serializeXml(document: Document): Uint8Array {
  return strToU8(new XMLSerializer().serializeToString(document));
}

function descendants(root: Node, localName: string): Element[] {
  const output: Element[] = [];
  const visit = (node: Node): void => {
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        if (elementLocalName(child) === localName) output.push(child as Element);
        visit(child);
      }
    }
  };
  visit(root);
  return output;
}

function elementLocalName(node: Node): string { return (node as Element).localName || node.nodeName.split(":").at(-1) || node.nodeName; }
function nodeText(node: Node): string { return descendants(node, "t").map((item) => item.textContent ?? "").join("").trim(); }

function replaceTextNodes(document: Document, target: Element, text: string, qualifiedName: string, namespace: string): void {
  const nodes = descendants(target, "t");
  if (nodes.length === 0) throw new DeliverableError("DOCUMENT_UNSUPPORTED_TARGET", "The selected Office target has no editable text run.");
  nodes[0]!.textContent = text;
  if (/^\s|\s$/u.test(text)) nodes[0]!.setAttribute("xml:space", "preserve");
  for (const node of nodes.slice(1)) node.textContent = "";
  if (nodes[0]!.namespaceURI === null) {
    const replacement = document.createElementNS(namespace, qualifiedName);
    replacement.textContent = text;
    nodes[0]!.parentNode?.replaceChild(replacement, nodes[0]!);
  }
}

function findDocxTarget(document: Document, targetId: string): Element | null {
  const paragraph = /^docx\.p\.(\d{4})$/u.exec(targetId);
  if (paragraph !== null) return descendants(document, "body")[0]?.childNodes
    ? Array.from(descendants(document, "body")[0]!.childNodes).filter((node): node is Element => node.nodeType === 1 && elementLocalName(node) === "p")[Number(paragraph[1]) - 1] ?? null
    : null;
  const table = /^docx\.table\.(\d{4})$/u.exec(targetId);
  if (table !== null) return descendants(document, "body")[0]?.childNodes
    ? Array.from(descendants(document, "body")[0]!.childNodes).filter((node): node is Element => node.nodeType === 1 && elementLocalName(node) === "tbl")[Number(table[1]) - 1] ?? null
    : null;
  const cell = /^docx\.table\.(\d{4})\.cell\.r(\d{4})\.c(\d{4})$/u.exec(targetId);
  if (cell !== null) {
    const tableTarget = findDocxTarget(document, `docx.table.${cell[1]}`);
    const row = tableTarget === null ? undefined : descendants(tableTarget, "tr")[Number(cell[2]) - 1];
    return row === undefined ? null : descendants(row, "tc")[Number(cell[3]) - 1] ?? null;
  }
  return null;
}

function insertDocxParagraphAfter(document: Document, anchor: Element, text: string): Element {
  const namespace = anchor.namespaceURI ?? "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const paragraph = document.createElementNS(namespace, "w:p");
  const properties = Array.from(anchor.childNodes).find((node) => node.nodeType === 1 && elementLocalName(node) === "pPr");
  if (properties !== undefined) paragraph.appendChild(properties.cloneNode(true));
  const run = document.createElementNS(namespace, "w:r");
  const runProperties = descendants(anchor, "rPr")[0];
  if (runProperties !== undefined) run.appendChild(runProperties.cloneNode(true));
  const textNode = document.createElementNS(namespace, "w:t");
  textNode.textContent = text;
  if (/^\s|\s$/u.test(text)) textNode.setAttribute("xml:space", "preserve");
  run.appendChild(textNode);
  paragraph.appendChild(run);
  anchor.parentNode?.insertBefore(paragraph, anchor.nextSibling);
  return paragraph;
}

function xlsxSheets(entries: PackageEntries): Array<{ readonly name: string; readonly path: string }> {
  const workbook = parseXmlEntry(entries, "xl/workbook.xml");
  const relationships = parseXmlEntry(entries, "xl/_rels/workbook.xml.rels");
  const targets = new Map(descendants(relationships, "Relationship").map((item) => [item.getAttribute("Id") ?? "", item.getAttribute("Target") ?? ""]));
  return descendants(workbook, "sheet").map((sheet) => {
    const relationId = sheet.getAttribute("r:id") ?? sheet.getAttributeNS(OFFICE_REL_NS, "id") ?? "";
    const target = targets.get(relationId);
    if (!target) throw new DeliverableError("DELIVERABLE_INVALID", "An XLSX worksheet relationship is missing.");
    return { name: sheet.getAttribute("name") ?? "Sheet", path: normalizePackagePath("xl", target) };
  });
}

function xlsxSharedStrings(entries: PackageEntries): string[] {
  if (entries["xl/sharedStrings.xml"] === undefined) return [];
  const document = parseXmlEntry(entries, "xl/sharedStrings.xml");
  return descendants(document, "si").map(nodeText);
}

function xlsxCellValue(cell: Element, shared: readonly string[]): string | number | boolean | null {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") return descendants(cell, "t").map((item) => item.textContent ?? "").join("");
  const raw = descendants(cell, "v")[0]?.textContent ?? "";
  if (type === "s") return shared[Number(raw)] ?? "";
  if (type === "b") return raw === "1";
  if (raw === "") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
}

function setXlsxCell(document: Document, address: string, value: string | number | boolean | null | undefined, formula?: string): void {
  let cell = findElementByAttribute(document, "c", "r", address);
  if (cell === null) {
    const rowNumber = Number(/\d+$/u.exec(address)?.[0]);
    const sheetData = descendants(document, "sheetData")[0];
    if (sheetData === undefined || !Number.isInteger(rowNumber)) throw new DeliverableError("DELIVERABLE_INVALID", "The XLSX sheet has no writable sheetData.");
    let row = findElementByAttribute(document, "row", "r", String(rowNumber));
    if (row === null) {
      row = document.createElementNS(sheetData.namespaceURI, "row");
      row.setAttribute("r", String(rowNumber));
      sheetData.appendChild(row);
    }
    cell = document.createElementNS(row.namespaceURI, "c");
    cell.setAttribute("r", address);
    row.appendChild(cell);
  }
  for (const child of Array.from(cell.childNodes)) if (["f", "v", "is"].includes(elementLocalName(child))) cell.removeChild(child);
  if (formula !== undefined) {
    const formulaNode = document.createElementNS(cell.namespaceURI, "f");
    formulaNode.textContent = formula.replace(/^=/u, "");
    cell.appendChild(formulaNode);
    cell.removeAttribute("t");
  }
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    cell.setAttribute("t", "inlineStr");
    const inline = document.createElementNS(cell.namespaceURI, "is");
    const text = document.createElementNS(cell.namespaceURI, "t");
    text.textContent = value;
    if (/^\s|\s$/u.test(value)) text.setAttribute("xml:space", "preserve");
    inline.appendChild(text);
    cell.appendChild(inline);
  } else {
    cell.setAttribute("t", typeof value === "boolean" ? "b" : "n");
    const node = document.createElementNS(cell.namespaceURI, "v");
    node.textContent = typeof value === "boolean" ? value ? "1" : "0" : String(value);
    cell.appendChild(node);
  }
}

function requestSpreadsheetRecalculation(entries: PackageEntries): void {
  const workbook = parseXmlEntry(entries, "xl/workbook.xml");
  let calc = descendants(workbook, "calcPr")[0];
  if (calc === undefined) {
    calc = workbook.createElementNS(workbook.documentElement.namespaceURI, "calcPr");
    workbook.documentElement.appendChild(calc);
  }
  calc.setAttribute("calcMode", "auto");
  calc.setAttribute("fullCalcOnLoad", "1");
  calc.setAttribute("forceFullCalc", "1");
  entries["xl/workbook.xml"] = serializeXml(workbook);
  delete entries["xl/calcChain.xml"];
}

function pptxSlides(entries: PackageEntries): Array<{ readonly path: string }> {
  const presentation = parseXmlEntry(entries, "ppt/presentation.xml");
  const relationships = parseXmlEntry(entries, "ppt/_rels/presentation.xml.rels");
  const targets = new Map(descendants(relationships, "Relationship").map((item) => [item.getAttribute("Id") ?? "", item.getAttribute("Target") ?? ""]));
  return descendants(presentation, "sldId").map((slide) => {
    const relationId = slide.getAttribute("r:id") ?? slide.getAttributeNS(OFFICE_REL_NS, "id") ?? "";
    const target = targets.get(relationId);
    if (!target) throw new DeliverableError("DELIVERABLE_INVALID", "A PPTX slide relationship is missing.");
    return { path: normalizePackagePath("ppt", target) };
  });
}

function topLevelPptxShapes(document: Document): Element[] {
  const tree = descendants(document, "spTree")[0];
  if (tree === undefined) return [];
  return Array.from(tree.childNodes).filter((node): node is Element => node.nodeType === 1 && ["sp", "pic", "graphicFrame", "cxnSp", "grpSp"].includes(elementLocalName(node)));
}

function shapeIdentifier(shape: Element): string | null { return descendants(shape, "cNvPr")[0]?.getAttribute("id") ?? null; }
function shapeName(shape: Element): string { return descendants(shape, "cNvPr")[0]?.getAttribute("name") ?? ""; }
function graphicFrameType(shape: Element): string {
  const uri = descendants(shape, "graphicData")[0]?.getAttribute("uri") ?? "";
  return uri.includes("chart") ? "chart" : uri.includes("table") ? "table" : "graphic";
}
function findPptxShapeById(document: Document, id: string): Element | null { return topLevelPptxShapes(document).find((shape) => shapeIdentifier(shape) === id) ?? null; }

function appendTextShape(document: Document, text: string): void {
  const tree = descendants(document, "spTree")[0];
  if (tree === undefined) throw new DeliverableError("DELIVERABLE_INVALID", "The PPTX slide has no shape tree.");
  const id = nextShapeId(document);
  const parser = new DOMParser();
  const fragment = parser.parseFromString(`<p:sp xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:nvSpPr><p:cNvPr id="${id}" name="Nexora body ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1828800"/><a:ext cx="10820400" cy="3657600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`, "application/xml").documentElement;
  tree.appendChild(document.importNode(fragment, true));
}

function insertPptxImage(
  workspace: string,
  entries: PackageEntries,
  slideDocument: Document,
  slidePath: string,
  operation: Extract<ImportedOfficePatchOperation, { type: "insert_image" }>
): void {
  const asset = resolveWorkspaceTarget(workspace, operation.assetPath, true);
  const stats = lstatSync(asset);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 10_000_000) throw new DeliverableError("INVALID_DOCUMENT_ASSET", "The inserted image must be a regular file no larger than 10 MB.");
  const extension = extname(asset).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new DeliverableError("INVALID_DOCUMENT_ASSET", "PPTX image insertion supports PNG and JPEG.");
  const bytes = readFileSync(asset);
  validateImageSignature(extension, bytes);
  const mediaExtension = extension === ".jpeg" ? "jpg" : extension.slice(1);
  const mediaName = `nexora-${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}.${mediaExtension}`;
  entries[`ppt/media/${mediaName}`] = bytes;

  const slideFile = basename(slidePath);
  const relPath = `ppt/slides/_rels/${slideFile}.rels`;
  let relationships: Document;
  if (entries[relPath] === undefined) relationships = new DOMParser().parseFromString(`<Relationships xmlns="${RELATIONSHIPS_NS}"/>`, "application/xml");
  else relationships = parseXmlEntry(entries, relPath);
  const ids = descendants(relationships, "Relationship").map((item) => Number(/^rId(\d+)$/u.exec(item.getAttribute("Id") ?? "")?.[1] ?? 0));
  const relationId = `rId${Math.max(0, ...ids) + 1}`;
  const relation = relationships.createElementNS(RELATIONSHIPS_NS, "Relationship");
  relation.setAttribute("Id", relationId);
  relation.setAttribute("Type", `${OFFICE_REL_NS}/image`);
  relation.setAttribute("Target", `../media/${mediaName}`);
  relationships.documentElement.appendChild(relation);
  entries[relPath] = serializeXml(relationships);
  ensureContentType(entries, mediaExtension, mediaExtension === "png" ? "image/png" : "image/jpeg");

  const tree = descendants(slideDocument, "spTree")[0];
  if (tree === undefined) throw new DeliverableError("DELIVERABLE_INVALID", "The PPTX slide has no shape tree.");
  const id = nextShapeId(slideDocument);
  const x = Math.round(operation.x * EMU_PER_INCH);
  const y = Math.round(operation.y * EMU_PER_INCH);
  const cx = Math.round(operation.width * EMU_PER_INCH);
  const cy = Math.round(operation.height * EMU_PER_INCH);
  const fragment = new DOMParser().parseFromString(`<p:pic xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}" xmlns:r="${OFFICE_REL_NS}"><p:nvPicPr><p:cNvPr id="${id}" name="Nexora image ${id}" descr="${escapeXml(operation.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`, "application/xml").documentElement;
  tree.appendChild(slideDocument.importNode(fragment, true));
}

function ensureContentType(entries: PackageEntries, extension: string, contentType: string): void {
  const document = parseXmlEntry(entries, "[Content_Types].xml");
  if (!descendants(document, "Default").some((item) => item.getAttribute("Extension")?.toLowerCase() === extension.toLowerCase())) {
    const node = document.createElementNS(document.documentElement.namespaceURI, "Default");
    node.setAttribute("Extension", extension);
    node.setAttribute("ContentType", contentType);
    document.documentElement.appendChild(node);
    entries["[Content_Types].xml"] = serializeXml(document);
  }
}

function nextShapeId(document: Document): number {
  return Math.max(1, ...descendants(document, "cNvPr").map((item) => Number(item.getAttribute("id") ?? 0))) + 1;
}

function findElementByAttribute(document: Document, localName: string, attribute: string, value: string): Element | null {
  return descendants(document, localName).find((item) => item.getAttribute(attribute) === value) ?? null;
}

function normalizePackagePath(base: string, target: string): string {
  const parts = `${base}/${target}`.replace(/\\/gu, "/").split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function operationTargets(operation: ImportedOfficePatchOperation): string[] {
  return operation.type === "delete_targets" ? operation.targetIds : [operation.targetId];
}
function requestTarget(operation: ImportedOfficePatchOperation): string { return operationTargets(operation).join(", "); }
function unsupported(operation: ImportedOfficePatchOperation, message: string): never {
  throw new DeliverableError("DOCUMENT_UNSUPPORTED_TARGET", `${message} Received ${operation.type} for ${requestTarget(operation)}.`);
}

function validateImageSignature(extension: string, bytes: Buffer): void {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((extension === ".png" && !png) || ([".jpg", ".jpeg"].includes(extension) && !jpeg)) throw new DeliverableError("INVALID_DOCUMENT_ASSET", "The image bytes do not match the file extension.");
}

function docxParagraphId(index: number): string { return `docx.p.${String(index).padStart(4, "0")}`; }
function docxTableId(index: number): string { return `docx.table.${String(index).padStart(4, "0")}`; }
function xlsxSheetId(index: number): string { return `xlsx.sheet.${String(index).padStart(4, "0")}`; }
function pptxSlideId(index: number): string { return `pptx.slide.${String(index).padStart(4, "0")}`; }

function readDirectoryNotEmpty(path: string): boolean {
  try { return readdirSync(path).length > 0; }
  catch { return false; }
}

function readJson(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
function deliverableIdFor(relativeDirectory: string): string { return `deliverable:${createHash("sha256").update(`imported-office:${relativeDirectory.toLowerCase()}`).digest("hex")}`; }
function digestBytes(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function digestText(value: string): string { return digestBytes(Buffer.from(value, "utf8")); }
function safeInvocationSegment(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function compactText(value: string, limit: number): string { const text = value.replace(/\s+/gu, " ").trim(); return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`; }
function escapeHtml(value: string): string { return value.replace(/[&<>]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!); }
function escapeAttribute(value: string): string { return escapeHtml(value).replace(/["']/gu, (character) => character === '"' ? "&quot;" : "&#39;"); }
function escapeXml(value: string): string { return escapeAttribute(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function normalizeWorkspaceRelative(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || normalized.split("/").includes("..")) {
    throw new DeliverableError("WORKSPACE_BOUNDARY_VIOLATION", `Invalid Workspace path: ${value}.`);
  }
  return normalized;
}

function resolveWorkspaceTarget(workspace: string, relativePath: string, mustExist: boolean): string {
  const root = workspaceRoot(workspace);
  const normalized = normalizeWorkspaceRelative(relativePath);
  const target = resolve(root, ...normalized.split("/"));
  assertWorkspaceContained(root, target);
  if (mustExist) {
    const real = realpathSync(target);
    assertWorkspaceContained(root, real);
    return real;
  }
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  assertWorkspaceContained(root, realpathSync(ancestor));
  return target;
}

function assertWorkspaceContained(workspace: string, target: string): void {
  const root = resolve(workspace);
  const candidate = resolve(target);
  if (candidate.toLowerCase() !== root.toLowerCase() && !candidate.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)) {
    throw new DeliverableError("WORKSPACE_BOUNDARY_VIOLATION", "Office path escapes the active Workspace.");
  }
}

function workspaceRoot(workspace: string): string {
  const root = resolve(workspace);
  return existsSync(root) ? realpathSync(root) : root;
}

function toWorkspaceRelative(workspace: string, target: string): string {
  assertWorkspaceContained(workspace, target);
  return relative(resolve(workspace), resolve(target)).replace(/\\/gu, "/");
}

function writeManifestAtomic(path: string, manifest: ImportedOfficeManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

async function withImportedLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = importedLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = previous.then(() => current);
  importedLocks.set(key, queued);
  await previous;
  try { return await action(); }
  finally { release(); if (importedLocks.get(key) === queued) importedLocks.delete(key); }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DeliverableError("DOCUMENT_CANCELLED", "The Office operation was cancelled.", true);
}
