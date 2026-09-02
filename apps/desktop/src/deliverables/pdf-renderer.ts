import { existsSync } from "node:fs";
import { extname } from "node:path";

import { PDFDocument as PdfParser } from "pdf-lib";
import PDFDocument from "pdfkit";

import type { InlineRun, RichDocumentBlock, RichDocumentLeafBlock, RichDocumentSource } from "./contracts.js";

export type PdfValidation = {
  readonly format: "pdf";
  readonly byteLength: number;
  readonly pageCount: number;
  readonly embeddedFont: string;
};

const MAX_PDF_BYTES = 50_000_000;
const PAGE_BOTTOM = 770;

export async function renderPdf(
  source: RichDocumentSource,
  resolveAsset: (workspacePath: string) => string
): Promise<{ readonly bytes: Buffer; readonly validation: PdfValidation }> {
  const font = fontFor(source);
  const document = new PDFDocument({ autoFirstPage: false, size: "A4", margins: { top: 54, right: 54, bottom: 54, left: 54 }, info: { Title: source.title, Author: "Nexora", Creator: "Nexora Office capability", CreationDate: new Date(0), ModDate: new Date(0) }, compress: true });
  const chunks: Buffer[] = [];
  const completed = new Promise<void>((resolveDone, rejectDone) => {
    document.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    document.once("end", resolveDone);
    document.once("error", rejectDone);
  });
  addPage(document, font.path);
  document.fontSize(25).fillColor(source.theme.primaryColor).text(source.title, { align: "left" });
  document.moveDown(0.7);
  for (const block of source.blocks) renderBlock(document, block, source, resolveAsset, font.path);
  document.end();
  await completed;
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES) throw new Error(`Generated PDF byte length ${bytes.byteLength} is outside the safe limit.`);
  const reopened = await PdfParser.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  if (reopened.isEncrypted) throw new Error("Generated PDF unexpectedly requires encryption.");
  const pageCount = reopened.getPageCount();
  if (pageCount === 0) throw new Error("Generated PDF contains no pages.");
  return { bytes, validation: { format: "pdf", byteLength: bytes.byteLength, pageCount, embeddedFont: font.name } };
}

export async function validatePdf(bytes: Uint8Array): Promise<{ readonly pageCount: number }> {
  const reopened = await PdfParser.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  if (reopened.isEncrypted) throw new Error("PDF is encrypted.");
  const pageCount = reopened.getPageCount();
  if (pageCount === 0) throw new Error("PDF contains no pages.");
  return { pageCount };
}

function renderBlock(document: PDFKit.PDFDocument, block: RichDocumentBlock, source: RichDocumentSource, resolveAsset: (workspacePath: string) => string, fontPath: string | null): void {
  if (block.type === "columns") {
    for (const column of block.columns) for (const leaf of column) renderLeaf(document, leaf, source, resolveAsset, fontPath);
    return;
  }
  renderLeaf(document, block, source, resolveAsset, fontPath);
}

function renderLeaf(document: PDFKit.PDFDocument, block: RichDocumentLeafBlock, source: RichDocumentSource, resolveAsset: (workspacePath: string) => string, fontPath: string | null): void {
  ensureSpace(document, 90, fontPath);
  switch (block.type) {
    case "heading":
      document.fontSize(Math.max(13, 23 - block.level * 2)).fillColor(source.theme.primaryColor).text(text(block.runs), { lineGap: 4 });
      document.moveDown(0.45);
      break;
    case "paragraph":
      document.fontSize(11).fillColor("#172033").text(text(block.runs), { lineGap: 4, align: "justify" });
      document.moveDown(0.65);
      break;
    case "list":
      for (const [index, item] of block.items.entries()) {
        ensureSpace(document, 32, fontPath);
        document.fontSize(11).fillColor("#172033").text(`${block.ordered ? `${index + 1}.` : "•"} ${text(item)}`, { indent: 12, lineGap: 3 });
      }
      document.moveDown(0.55);
      break;
    case "table":
      renderTable(document, block.headers.map(text), block.rows.map((row) => row.map(text)), source.theme.primaryColor, fontPath);
      break;
    case "metric": {
      ensureSpace(document, 80, fontPath);
      const y = document.y;
      document.roundedRect(54, y, 487, 64, 6).fillAndStroke("#EFF6FF", source.theme.accentColor);
      document.fillColor("#334155").fontSize(10).text(text(block.label), 70, y + 10, { width: 180 });
      document.fillColor(source.theme.primaryColor).fontSize(21).text(text(block.value), 70, y + 28, { width: 250 });
      if (block.delta !== undefined) document.fillColor(source.theme.accentColor).fontSize(12).text(text(block.delta), 350, y + 28, { width: 160, align: "right" });
      document.y = y + 78;
      if (block.note !== undefined) document.fillColor("#475569").fontSize(9).text(text(block.note));
      break;
    }
    case "callout": {
      const body = text(block.runs);
      const height = Math.max(54, document.heightOfString(body, { width: 445 }) + 26);
      ensureSpace(document, height, fontPath);
      const y = document.y;
      const fill = block.tone === "warning" ? "#FEF3C7" : block.tone === "success" ? "#DCFCE7" : "#DBEAFE";
      document.roundedRect(54, y, 487, height, 5).fill(fill);
      document.fillColor("#172033").fontSize(10).text(body, 72, y + 13, { width: 445, lineGap: 3 });
      document.y = y + height + 12;
      break;
    }
    case "image": {
      const path = resolveAsset(block.assetPath);
      const extension = extname(path).toLowerCase();
      if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new Error(`PDF supports PNG and JPEG image assets; ${block.assetPath} is ${extension || "unknown"}.`);
      ensureSpace(document, 310, fontPath);
      document.image(path, 80, document.y, { fit: [435, 270], align: "center", valign: "center" });
      document.y += 282;
      if (block.caption !== undefined) document.fontSize(9).fillColor("#64748B").text(text(block.caption), { align: "center" });
      document.moveDown(0.5);
      break;
    }
    case "chart":
      renderChart(document, block, source.theme.accentColor, fontPath);
      break;
    case "divider":
      document.moveTo(54, document.y + 6).lineTo(541, document.y + 6).strokeColor("#CBD5E1").stroke();
      document.moveDown(1.2);
      break;
  }
}

function renderTable(document: PDFKit.PDFDocument, headers: string[], rows: string[][], color: string, fontPath: string | null): void {
  const columns = Math.max(1, headers.length);
  const width = 487 / columns;
  const allRows = [headers, ...rows];
  for (const [rowIndex, row] of allRows.entries()) {
    ensureSpace(document, 34, fontPath);
    const y = document.y;
    for (let column = 0; column < columns; column += 1) {
      const x = 54 + column * width;
      document.rect(x, y, width, 30).fillAndStroke(rowIndex === 0 ? color : "#FFFFFF", "#CBD5E1");
      document.fillColor(rowIndex === 0 ? "#FFFFFF" : "#172033").fontSize(9).text(row[column] ?? "", x + 5, y + 8, { width: width - 10, height: 16, ellipsis: true });
    }
    document.y = y + 30;
  }
  document.moveDown(0.65);
}

function renderChart(document: PDFKit.PDFDocument, block: Extract<RichDocumentLeafBlock, { type: "chart" }>, color: string, fontPath: string | null): void {
  ensureSpace(document, 245, fontPath);
  document.fontSize(13).fillColor("#172033").text(block.title ?? "Chart");
  const x = 76;
  const y = document.y + 12;
  const width = 440;
  const height = 170;
  const values = block.series.flatMap(({ values: seriesValues }) => seriesValues);
  const maximum = Math.max(1, ...values.map((value) => Math.abs(value)));
  const groupWidth = width / Math.max(1, block.categories.length);
  const seriesWidth = groupWidth / Math.max(1, block.series.length + 0.4);
  block.categories.forEach((category, categoryIndex) => {
    block.series.forEach((series, seriesIndex) => {
      const value = series.values[categoryIndex] ?? 0;
      const barHeight = Math.max(1, Math.abs(value) / maximum * (height - 30));
      document.rect(x + categoryIndex * groupWidth + seriesIndex * seriesWidth, y + height - 24 - barHeight, Math.max(3, seriesWidth - 3), barHeight).fill(series.color ?? color);
    });
    document.fillColor("#475569").fontSize(7).text(category, x + categoryIndex * groupWidth, y + height - 18, { width: groupWidth, align: "center", ellipsis: true });
  });
  document.moveTo(x, y + height - 24).lineTo(x + width, y + height - 24).strokeColor("#94A3B8").stroke();
  document.y = y + height + 8;
}

function ensureSpace(document: PDFKit.PDFDocument, required: number, fontPath: string | null): void {
  if (document.y + required <= PAGE_BOTTOM) return;
  addPage(document, fontPath);
}

function addPage(document: PDFKit.PDFDocument, fontPath: string | null): void {
  document.addPage();
  if (fontPath !== null) document.font(fontPath);
  else document.font("Helvetica");
}

function fontFor(source: RichDocumentSource): { readonly name: string; readonly path: string | null } {
  const allText = JSON.stringify(source.blocks);
  if (/^[\x00-\x7F]*$/u.test(allText)) return { name: "Helvetica", path: null };
  const configured = process.env.NEXORA_OFFICE_FONT_PATH?.trim();
  const candidates = [
    configured,
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc"
  ].filter((value): value is string => Boolean(value));
  const selected = candidates.find((path) => existsSync(path));
  if (selected === undefined) throw new Error("PDF generation needs a local Unicode font; set NEXORA_OFFICE_FONT_PATH to a trusted font file.");
  return { name: selected.replace(/^.*[\\/]/u, ""), path: selected };
}

function text(runs: readonly InlineRun[]): string { return runs.map(({ text: value }) => value).join(""); }
