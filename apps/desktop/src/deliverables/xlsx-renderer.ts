import { readFileSync } from "node:fs";
import { extname } from "node:path";

import ExcelJS from "exceljs";
import { unzipSync } from "fflate";

import type { InlineRun, RichDocumentBlock, RichDocumentLeafBlock, RichDocumentSource } from "./contracts.js";

export type XlsxValidation = {
  readonly format: "xlsx";
  readonly byteLength: number;
  readonly sheetCount: number;
  readonly populatedCellCount: number;
  readonly packageEntryCount: number;
};

const MAX_XLSX_BYTES = 50_000_000;

export async function renderXlsx(
  source: RichDocumentSource,
  resolveAsset: (workspacePath: string) => string
): Promise<{ readonly bytes: Buffer; readonly validation: XlsxValidation }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Nexora";
  workbook.title = source.title;
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  const summary = workbook.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  summary.columns = [{ width: 28 }, { width: 52 }, { width: 24 }, { width: 24 }];
  summary.addRow([source.title]);
  summary.mergeCells("A1:D1");
  summary.getCell("A1").font = { bold: true, size: 18, color: { argb: argb(source.theme.primaryColor) } };
  let populatedCellCount = 1;
  let tableIndex = 0;

  for (const block of flatten(source.blocks)) {
    switch (block.type) {
      case "heading":
        summary.addRow([text(block.runs)]);
        summary.getCell(summary.rowCount, 1).font = { bold: true, size: Math.max(11, 17 - block.level * 2), color: { argb: argb(source.theme.primaryColor) } };
        populatedCellCount += 1;
        break;
      case "paragraph":
      case "callout":
        summary.addRow([text(block.runs)]);
        summary.mergeCells(summary.rowCount, 1, summary.rowCount, 4);
        summary.getCell(summary.rowCount, 1).alignment = { wrapText: true, vertical: "top" };
        populatedCellCount += 1;
        break;
      case "list":
        for (const [index, item] of block.items.entries()) {
          summary.addRow([block.ordered ? `${index + 1}.` : "•", text(item)]);
          populatedCellCount += 2;
        }
        break;
      case "metric":
        summary.addRow([text(block.label), text(block.value), block.delta === undefined ? "" : text(block.delta), block.note === undefined ? "" : text(block.note)]);
        populatedCellCount += 2 + Number(block.delta !== undefined) + Number(block.note !== undefined);
        break;
      case "table": {
        tableIndex += 1;
        const sheet = workbook.addWorksheet(safeSheetName(block.caption === undefined ? block.blockId : text(block.caption), tableIndex), { views: [{ state: "frozen", ySplit: 1 }] });
        sheet.addRow(block.headers.map(text));
        for (const row of block.rows) sheet.addRow(row.map(text));
        styleHeader(sheet, source.theme.primaryColor);
        autoWidth(sheet);
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: Math.max(1, block.headers.length) } };
        populatedCellCount += block.headers.length + block.rows.reduce((total, row) => total + row.length, 0);
        summary.addRow(["Table", sheet.name, `${block.rows.length} rows`, `${block.headers.length} columns`]);
        populatedCellCount += 4;
        break;
      }
      case "chart": {
        tableIndex += 1;
        const sheet = workbook.addWorksheet(safeSheetName(block.title ?? block.blockId, tableIndex), { views: [{ state: "frozen", ySplit: 1 }] });
        sheet.addRow(["Category", ...block.series.map(({ name }) => name)]);
        for (const [index, category] of block.categories.entries()) {
          sheet.addRow([category, ...block.series.map(({ values }) => values[index] ?? null)]);
        }
        styleHeader(sheet, source.theme.accentColor);
        autoWidth(sheet);
        populatedCellCount += 1 + block.series.length + block.categories.length * (1 + block.series.length);
        summary.addRow(["Chart data", block.title ?? block.blockId, block.chartType, sheet.name]);
        populatedCellCount += 4;
        break;
      }
      case "image": {
        const path = resolveAsset(block.assetPath);
        const extension = extname(path).toLowerCase();
        if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new Error(`XLSX supports PNG and JPEG image assets; ${block.assetPath} is ${extension || "unknown"}.`);
        const imageId = workbook.addImage({ base64: readFileSync(path).toString("base64"), extension: extension === ".png" ? "png" : "jpeg" });
        const row = summary.rowCount + 1;
        summary.addRow([block.alt]);
        summary.addImage(imageId, { tl: { col: 0, row }, ext: { width: 480, height: 270 } });
        for (let index = 0; index < 15; index += 1) summary.addRow([]);
        populatedCellCount += 1;
        break;
      }
      case "divider": summary.addRow([]); break;
    }
  }
  styleHeader(summary, source.theme.primaryColor);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_XLSX_BYTES) throw new Error(`Generated XLSX byte length ${bytes.byteLength} is outside the safe limit.`);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  if (reopened.worksheets.length !== workbook.worksheets.length) throw new Error("Generated XLSX sheet count changed during reopen validation.");
  const packageValidation = validateXlsxPackage(bytes);
  return { bytes, validation: { format: "xlsx", byteLength: bytes.byteLength, sheetCount: reopened.worksheets.length, populatedCellCount, packageEntryCount: packageValidation.packageEntryCount } };
}

export function validateXlsxPackage(bytes: Uint8Array): { readonly packageEntryCount: number } {
  const entries = unzipSync(bytes);
  for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]) {
    if (entries[required] === undefined) throw new Error(`Generated XLSX is missing required package entry ${required}.`);
  }
  const forbidden = Object.keys(entries).find((name) => !name.endsWith("/") && /(?:vbaProject|activeX|embeddings)/iu.test(name));
  if (forbidden !== undefined) throw new Error(`Generated XLSX contains forbidden active content: ${forbidden}.`);
  return { packageEntryCount: Object.keys(entries).length };
}

export async function inspectXlsx(bytes: Uint8Array): Promise<{ readonly sheetNames: readonly string[]; readonly values: readonly string[] }> {
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(bytes);
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
  const values: string[] = [];
  for (const sheet of workbook.worksheets) sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
  return { sheetNames: workbook.worksheets.map(({ name }) => name), values };
}

function flatten(blocks: readonly RichDocumentBlock[]): RichDocumentLeafBlock[] {
  return blocks.flatMap((block) => block.type === "columns" ? block.columns.flatMap(flatten) : [block]);
}

function text(runs: readonly InlineRun[]): string { return runs.map(({ text: value }) => value).join(""); }
function argb(color: string): string { return `FF${color.slice(1).toUpperCase()}`; }

function styleHeader(sheet: ExcelJS.Worksheet, color: string): void {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(color) } };
  row.alignment = { vertical: "middle", wrapText: true };
}

function autoWidth(sheet: ExcelJS.Worksheet): void {
  sheet.columns.forEach((column) => {
    let maximum = 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => { maximum = Math.max(maximum, String(cell.value ?? "").length + 2); });
    column.width = Math.min(48, maximum);
  });
}

function safeSheetName(value: string, index: number): string {
  const normalized = value.replace(/[\\/*?:[\]]/gu, " ").trim().replace(/\s+/gu, " ").slice(0, 31);
  return normalized || `Table ${index}`;
}
