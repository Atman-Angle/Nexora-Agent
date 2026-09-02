import { z } from "zod";

import {
  ChartSeriesSchema,
  InlineRunSchema,
  RichDocumentCreateInputSchema,
  RichDocumentInspectInputSchema,
  RichDocumentPatchInputSchema,
  RichDocumentThemeSchema,
  type InlineRun,
  type RichDocumentCreateInput,
  type RichDocumentPatchInput
} from "./contracts.js";

const BlockIdSchema = z.string().trim().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/iu);
const WorkspacePathSchema = z.string().trim().min(1).max(1_024);
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const AuthoringTextSchema = z.union([
  z.string().max(20_000),
  z.array(InlineRunSchema).max(256)
]).describe("Plain text or an array of inline runs. Do not JSON-encode this value into a string.");
const BaseSchema = z.object({ blockId: BlockIdSchema });

const HeadingSchema = BaseSchema.extend({
  type: z.literal("heading"), level: z.number().int().min(1).max(4), runs: AuthoringTextSchema
}).strict();
const ParagraphSchema = BaseSchema.extend({ type: z.literal("paragraph"), runs: AuthoringTextSchema }).strict();
const ListSchema = BaseSchema.extend({
  type: z.literal("list"), ordered: z.boolean(), items: z.array(AuthoringTextSchema).min(1).max(128)
}).strict();
const TableSchema = BaseSchema.extend({
  type: z.literal("table"),
  headers: z.array(AuthoringTextSchema).min(1).max(32)
    .describe("One entry per column, for example [\"Department\", \"Revenue\"]."),
  rows: z.array(z.array(AuthoringTextSchema).min(1).max(32)).max(500)
    .describe("One array per row and one entry per cell, for example [[\"Sales\", \"3150\"]]."),
  align: z.array(z.enum(["left", "center", "right"])).max(32).optional(),
  caption: AuthoringTextSchema.optional()
}).strict().superRefine((value, context) => {
  value.rows.forEach((row, rowIndex) => {
    if (row.length !== value.headers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows", rowIndex],
        message: `Expected ${value.headers.length} cells to match the table headers, received ${row.length}.`
      });
    }
  });
  if (value.align !== undefined && value.align.length !== value.headers.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["align"],
      message: `Expected ${value.headers.length} alignment entries to match the table headers, received ${value.align.length}.`
    });
  }
});
const MetricSchema = BaseSchema.extend({
  type: z.literal("metric"), label: AuthoringTextSchema, value: AuthoringTextSchema,
  delta: AuthoringTextSchema.optional(), note: AuthoringTextSchema.optional()
}).strict();
const CalloutSchema = BaseSchema.extend({
  type: z.literal("callout"), tone: z.enum(["info", "warning", "success"]), runs: AuthoringTextSchema
}).strict();
const ImageSchema = BaseSchema.extend({
  type: z.literal("image"),
  assetPath: WorkspacePathSchema.describe("An existing Workspace-relative PNG, JPEG or WebP path confirmed by a filesystem fact."),
  alt: z.string().trim().min(1).max(500),
  caption: AuthoringTextSchema.optional(),
  fit: z.enum(["contain", "cover"]).default("contain")
}).strict();
const ChartSchema = BaseSchema.extend({
  type: z.literal("chart"), chartType: z.enum(["bar", "line", "pie"]),
  title: z.string().trim().max(500).optional(), categories: z.array(z.string().max(200)).min(1).max(2_000),
  series: z.array(ChartSeriesSchema).min(1).max(12), showLegend: z.boolean().default(true)
}).strict();
const DividerSchema = BaseSchema.extend({ type: z.literal("divider") }).strict();

export const RichDocumentAuthoringLeafBlockSchema = z.union([
  HeadingSchema, ParagraphSchema, ListSchema, TableSchema, MetricSchema, CalloutSchema, ImageSchema, ChartSchema, DividerSchema
]);
const ColumnsSchema = BaseSchema.extend({
  type: z.literal("columns"),
  columns: z.array(z.array(RichDocumentAuthoringLeafBlockSchema).min(1).max(24)).min(2).max(3)
}).strict();
export const RichDocumentAuthoringBlockSchema = z.union([
  HeadingSchema, ParagraphSchema, ListSchema, TableSchema, MetricSchema, CalloutSchema, ImageSchema, ChartSchema, DividerSchema, ColumnsSchema
]);

export const RichDocumentAuthoringCreateInputSchema = z.object({
  outputDirectory: WorkspacePathSchema,
  title: z.string().trim().min(1).max(300),
  locale: z.string().trim().min(2).max(32).default("zh-CN"),
  formats: z.array(z.enum(["rich_document", "docx", "xlsx", "pptx", "pdf"])).min(1).max(5).default(["rich_document"])
    .describe("Requested committed representations: docx for Word, xlsx for Excel, pptx for PowerPoint and pdf for PDF."),
  theme: RichDocumentThemeSchema,
  blocks: z.array(RichDocumentAuthoringBlockSchema).min(1).max(32)
    .describe("A real JSON array of at most 32 blocks. For longer documents, create a bounded first revision and append blocks with document.apply_patch.")
}).strict();

const AuthoringPatchOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("replace_block"), targetBlockId: BlockIdSchema, block: RichDocumentAuthoringBlockSchema }).strict(),
  z.object({ type: z.literal("insert_before"), targetBlockId: BlockIdSchema, blocks: z.array(RichDocumentAuthoringBlockSchema).min(1).max(16) }).strict(),
  z.object({ type: z.literal("insert_after"), targetBlockId: BlockIdSchema, blocks: z.array(RichDocumentAuthoringBlockSchema).min(1).max(16) }).strict(),
  z.object({ type: z.literal("remove_block"), targetBlockId: BlockIdSchema }).strict(),
  z.object({ type: z.literal("move_before"), targetBlockId: BlockIdSchema, anchorBlockId: BlockIdSchema }).strict(),
  z.object({ type: z.literal("move_after"), targetBlockId: BlockIdSchema, anchorBlockId: BlockIdSchema }).strict(),
  z.object({ type: z.literal("set_title"), title: z.string().trim().min(1).max(300) }).strict(),
  z.object({ type: z.literal("set_theme"), theme: RichDocumentThemeSchema }).strict()
]);

export const RichDocumentAuthoringPatchInputSchema = z.object({
  manifestPath: WorkspacePathSchema,
  expectedRevision: z.number().int().positive(),
  expectedSourceDigest: Sha256Schema,
  operations: z.array(AuthoringPatchOperationSchema).min(1).max(16)
}).strict();

export { RichDocumentInspectInputSchema };

export function compileAuthoringCreateInput(input: unknown): RichDocumentCreateInput {
  const parsed = RichDocumentAuthoringCreateInputSchema.parse(input);
  return RichDocumentCreateInputSchema.parse({ ...parsed, blocks: parsed.blocks.map(compileBlock) });
}

export function compileAuthoringPatchInput(input: unknown): RichDocumentPatchInput {
  const parsed = RichDocumentAuthoringPatchInputSchema.parse(input);
  return RichDocumentPatchInputSchema.parse({
    ...parsed,
    operations: parsed.operations.map((operation) => {
      if (operation.type === "replace_block") return { ...operation, block: compileBlock(operation.block) };
      if (operation.type === "insert_before" || operation.type === "insert_after") {
        return { ...operation, blocks: operation.blocks.map(compileBlock) };
      }
      return operation;
    })
  });
}

function compileBlock(block: z.infer<typeof RichDocumentAuthoringBlockSchema>): unknown {
  if (block.type === "columns") {
    return { ...block, columns: block.columns.map((column) => column.map(compileLeafBlock)) };
  }
  return compileLeafBlock(block);
}

function compileLeafBlock(block: z.infer<typeof RichDocumentAuthoringLeafBlockSchema>): unknown {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "callout": return { ...block, runs: compileText(block.runs) };
    case "list": return { ...block, items: block.items.map(compileText) };
    case "table": return {
      blockId: block.blockId,
      type: block.type,
      headers: block.headers.map(compileText),
      rows: block.rows.map((row) => row.map(compileText)),
      ...(block.align === undefined ? {} : { align: block.align }),
      ...(block.caption === undefined ? {} : { caption: compileText(block.caption) })
    };
    case "metric": return {
      blockId: block.blockId,
      type: block.type,
      label: compileText(block.label), value: compileText(block.value),
      ...(block.delta === undefined ? {} : { delta: compileText(block.delta) }),
      ...(block.note === undefined ? {} : { note: compileText(block.note) })
    };
    case "image": return {
      blockId: block.blockId,
      type: block.type,
      assetPath: block.assetPath,
      alt: block.alt,
      fit: block.fit,
      ...(block.caption === undefined ? {} : { caption: compileText(block.caption) })
    };
    case "chart":
    case "divider": return block;
  }
}

function compileText(value: string | InlineRun[]): InlineRun[] {
  return typeof value === "string" ? [{ text: value }] : value;
}
