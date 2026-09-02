import { z } from "zod";

const BlockIdSchema = z.string().trim().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/iu);
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const WorkspacePathSchema = z.string().trim().min(1).max(1_024);
const NativeTargetIdSchema = z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/iu);
const PositiveRevisionSchema = z.preprocess((value) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}, z.number().int().positive());
export const DeliverableFormatSchema = z.enum(["rich_document", "docx", "xlsx", "pptx", "pdf"]);
const OfficeFileFormatSchema = z.enum(["docx", "xlsx", "pptx", "pdf"]);
const SafeUrlSchema = z.string().trim().min(1).max(8_000).refine((value) => {
  try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol); }
  catch { return false; }
}, "Only http, https and mailto links are allowed.");

export const InlineRunSchema = z.object({
  text: z.string().max(20_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  code: z.boolean().optional(),
  href: SafeUrlSchema.optional()
}).strict();

export const RichTextSchema = z.array(InlineRunSchema).max(256);
const BlockBaseSchema = z.object({ blockId: BlockIdSchema });

export const HeadingBlockSchema = BlockBaseSchema.extend({
  type: z.literal("heading"),
  level: z.number().int().min(1).max(4),
  runs: RichTextSchema
}).strict();

export const ParagraphBlockSchema = BlockBaseSchema.extend({
  type: z.literal("paragraph"),
  runs: RichTextSchema
}).strict();

export const ListBlockSchema = BlockBaseSchema.extend({
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z.array(RichTextSchema).min(1).max(128)
}).strict();

export const TableBlockSchema = BlockBaseSchema.extend({
  type: z.literal("table"),
  headers: z.array(RichTextSchema).max(32),
  rows: z.array(z.array(RichTextSchema).max(32)).max(500),
  align: z.array(z.enum(["left", "center", "right"])).max(32).optional(),
  caption: RichTextSchema.optional()
}).strict();

export const MetricBlockSchema = BlockBaseSchema.extend({
  type: z.literal("metric"),
  label: RichTextSchema,
  value: RichTextSchema,
  delta: RichTextSchema.optional(),
  note: RichTextSchema.optional()
}).strict();

export const CalloutBlockSchema = BlockBaseSchema.extend({
  type: z.literal("callout"),
  tone: z.enum(["info", "warning", "success"]),
  runs: RichTextSchema
}).strict();

export const ImageBlockSchema = BlockBaseSchema.extend({
  type: z.literal("image"),
  assetPath: WorkspacePathSchema,
  alt: z.string().trim().min(1).max(500),
  caption: RichTextSchema.optional(),
  fit: z.enum(["contain", "cover"]).default("contain")
}).strict();

export const ChartSeriesSchema = z.object({
  name: z.string().trim().min(1).max(200),
  values: z.array(z.number().finite()).min(1).max(2_000),
  color: z.string().regex(/^#[0-9a-f]{6}$/iu).optional()
}).strict();

export const ChartBlockSchema = BlockBaseSchema.extend({
  type: z.literal("chart"),
  chartType: z.enum(["bar", "line", "pie"]),
  title: z.string().trim().max(500).optional(),
  categories: z.array(z.string().max(200)).min(1).max(2_000),
  series: z.array(ChartSeriesSchema).min(1).max(12),
  showLegend: z.boolean().default(true)
}).strict();

export const DividerBlockSchema = BlockBaseSchema.extend({ type: z.literal("divider") }).strict();

export const RichDocumentLeafBlockSchema = z.discriminatedUnion("type", [
  HeadingBlockSchema,
  ParagraphBlockSchema,
  ListBlockSchema,
  TableBlockSchema,
  MetricBlockSchema,
  CalloutBlockSchema,
  ImageBlockSchema,
  ChartBlockSchema,
  DividerBlockSchema
]);

export const ColumnsBlockSchema = BlockBaseSchema.extend({
  type: z.literal("columns"),
  columns: z.array(z.array(RichDocumentLeafBlockSchema).min(1).max(24)).min(2).max(3)
}).strict();

export const RichDocumentBlockSchema = z.union([RichDocumentLeafBlockSchema, ColumnsBlockSchema]);

export const RichDocumentThemeSchema = z.object({
  pageWidth: z.enum(["narrow", "standard", "wide"]).default("standard"),
  surface: z.enum(["light", "dark"]).default("light"),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/iu).default("#2563eb"),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/iu).default("#0ea5e9"),
  font: z.enum(["system", "serif"]).default("system"),
  spacing: z.enum(["compact", "comfortable"]).default("comfortable"),
  corners: z.enum(["square", "rounded"]).default("rounded")
}).strict();

export const RichDocumentCreateInputSchema = z.object({
  outputDirectory: WorkspacePathSchema,
  title: z.string().trim().min(1).max(300),
  locale: z.string().trim().min(2).max(32).default("zh-CN"),
  formats: z.array(DeliverableFormatSchema).min(1).max(5).default(["rich_document"])
    .refine((formats) => new Set(formats).size === formats.length, "Deliverable formats must be unique."),
  theme: RichDocumentThemeSchema,
  blocks: z.array(RichDocumentBlockSchema).min(1).max(256)
}).strict();

export const RichDocumentSourceSchema = z.object({
  schemaVersion: z.literal(1),
  deliverableId: z.string().regex(/^deliverable:[a-f0-9]{64}$/u),
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(300),
  locale: z.string().trim().min(2).max(32),
  formats: z.array(DeliverableFormatSchema).min(1).max(5).default(["rich_document"])
    .refine((formats) => new Set(formats).size === formats.length, "Deliverable formats must be unique."),
  theme: RichDocumentThemeSchema,
  blocks: z.array(RichDocumentBlockSchema).min(1).max(256)
}).strict();

export const RichDocumentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  deliverableId: z.string().regex(/^deliverable:[a-f0-9]{64}$/u),
  kind: z.literal("rich_document"),
  title: z.string().trim().min(1).max(300),
  currentRevision: z.number().int().positive(),
  currentRevisionPath: WorkspacePathSchema,
  sourceDigest: Sha256Schema,
  previewDigest: Sha256Schema,
  files: z.array(z.object({
    format: OfficeFileFormatSchema,
    path: WorkspacePathSchema,
    digest: Sha256Schema,
    byteLength: z.number().int().positive()
  }).strict()).max(4).default([]),
  createdByInvocationId: z.string().trim().min(1).max(256),
  updatedByInvocationId: z.string().trim().min(1).max(256)
}).strict();

const ReplaceBlockOperationSchema = z.object({
  type: z.literal("replace_block"),
  targetBlockId: BlockIdSchema,
  block: RichDocumentBlockSchema
}).strict();
const InsertOperationSchema = z.object({
  type: z.enum(["insert_before", "insert_after"]),
  targetBlockId: BlockIdSchema,
  blocks: z.array(RichDocumentBlockSchema).min(1).max(32)
}).strict();
const RemoveOperationSchema = z.object({ type: z.literal("remove_block"), targetBlockId: BlockIdSchema }).strict();
const MoveOperationSchema = z.object({
  type: z.enum(["move_before", "move_after"]),
  targetBlockId: BlockIdSchema,
  anchorBlockId: BlockIdSchema
}).strict().refine((value) => value.targetBlockId !== value.anchorBlockId, "Move target and anchor must differ.");
const SetTitleOperationSchema = z.object({ type: z.literal("set_title"), title: z.string().trim().min(1).max(300) }).strict();
const SetThemeOperationSchema = z.object({ type: z.literal("set_theme"), theme: RichDocumentThemeSchema }).strict();

export const RichDocumentPatchOperationSchema = z.union([
  ReplaceBlockOperationSchema,
  InsertOperationSchema,
  RemoveOperationSchema,
  MoveOperationSchema,
  SetTitleOperationSchema,
  SetThemeOperationSchema
]);

export const RichDocumentPatchInputSchema = z.object({
  manifestPath: WorkspacePathSchema,
  expectedRevision: z.number().int().positive(),
  expectedSourceDigest: Sha256Schema,
  operations: z.array(RichDocumentPatchOperationSchema).min(1).max(32)
}).strict();

export const RichDocumentExportInputSchema = z.object({
  manifestPath: WorkspacePathSchema,
  expectedRevision: z.number().int().positive(),
  expectedSourceDigest: Sha256Schema,
  format: OfficeFileFormatSchema
}).strict();

export const RichDocumentInspectInputSchema = z.object({
  manifestPath: WorkspacePathSchema,
  mode: z.enum(["summary", "outline", "blocks"]).default("summary"),
  blockIds: z.array(BlockIdSchema).max(32).optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "blocks" && (value.blockIds?.length ?? 0) === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blockIds"], message: "blocks mode requires exact block IDs." });
  }
});

export const ImportedOfficeCreateInputSchema = z.object({
  attachmentPath: WorkspacePathSchema,
  attachmentDigest: Sha256Schema,
  outputDirectory: WorkspacePathSchema,
  title: z.string().trim().min(1).max(300).optional()
}).strict();

export const OfficeSourceInspectInputSchema = z.object({
  path: WorkspacePathSchema,
  expectedDigest: Sha256Schema.optional(),
  mode: z.enum(["summary", "outline", "blocks"]).default("outline"),
  targetIds: z.array(NativeTargetIdSchema).max(32).optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "blocks" && (value.targetIds?.length ?? 0) === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetIds"], message: "blocks mode requires exact target IDs." });
  }
});

const ReplaceNativeTextOperationSchema = z.object({
  type: z.literal("replace_text"),
  targetId: NativeTargetIdSchema,
  text: z.string().max(100_000)
}).strict();

const DeleteNativeTargetOperationSchema = z.object({
  type: z.literal("delete_target"),
  targetId: NativeTargetIdSchema
}).strict();

const DeleteNativeTargetsOperationSchema = z.object({
  type: z.literal("delete_targets"),
  targetIds: z.array(NativeTargetIdSchema).min(1).max(32)
}).strict();

const InsertNativeParagraphsOperationSchema = z.object({
  type: z.literal("insert_paragraphs_after"),
  targetId: NativeTargetIdSchema,
  paragraphs: z.array(z.string().max(100_000)).min(1).max(32)
}).strict();

const SetWordTableCellOperationSchema = z.object({
  type: z.literal("set_table_cell"),
  targetId: NativeTargetIdSchema,
  text: z.string().max(100_000)
}).strict();

const SetSpreadsheetCellOperationSchema = z.object({
  type: z.literal("set_cell"),
  targetId: NativeTargetIdSchema,
  value: z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.null()]).optional(),
  formula: z.string().trim().min(1).max(8_000).optional()
}).strict().refine((value) => value.value !== undefined || value.formula !== undefined, "A cell value or formula is required.");

const ReplaceSlideTextOperationSchema = z.object({
  type: z.literal("replace_slide_text"),
  targetId: NativeTargetIdSchema,
  title: z.string().max(10_000),
  body: z.string().max(50_000)
}).strict();

const InsertSlideImageOperationSchema = z.object({
  type: z.literal("insert_image"),
  targetId: NativeTargetIdSchema,
  assetPath: WorkspacePathSchema,
  alt: z.string().trim().min(1).max(500),
  x: z.number().finite().min(0).max(13.333).default(7.1),
  y: z.number().finite().min(0).max(7.5).default(1.45),
  width: z.number().finite().positive().max(13.333).default(5.4),
  height: z.number().finite().positive().max(7.5).default(4.8)
}).strict();

export const ImportedOfficePatchOperationSchema = z.union([
  ReplaceNativeTextOperationSchema,
  DeleteNativeTargetOperationSchema,
  DeleteNativeTargetsOperationSchema,
  InsertNativeParagraphsOperationSchema,
  SetWordTableCellOperationSchema,
  SetSpreadsheetCellOperationSchema,
  ReplaceSlideTextOperationSchema,
  InsertSlideImageOperationSchema
]);

export const ImportedOfficePatchInputSchema = z.object({
  manifestPath: WorkspacePathSchema,
  expectedRevision: PositiveRevisionSchema,
  expectedSourceDigest: Sha256Schema,
  operations: z.array(ImportedOfficePatchOperationSchema).min(1).max(64)
}).strict();

export const RichDocumentWriteFactsSchema = z.object({
  deliverableId: z.string().regex(/^deliverable:[a-f0-9]{64}$/u),
  kind: z.literal("rich_document"),
  title: z.string().min(1),
  manifestPath: WorkspacePathSchema,
  previewPath: WorkspacePathSchema,
  revision: z.number().int().positive(),
  sourceDigest: Sha256Schema,
  previewDigest: Sha256Schema,
  files: z.array(z.object({
    format: OfficeFileFormatSchema,
    path: WorkspacePathSchema,
    digest: Sha256Schema,
    byteLength: z.number().int().positive()
  }).strict()).max(4),
  blockCount: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
  validation: z.literal("passed"),
  changedBlockIds: z.array(BlockIdSchema),
  insertedBlockIds: z.array(BlockIdSchema),
  removedBlockIds: z.array(BlockIdSchema),
  movedBlockIds: z.array(BlockIdSchema),
  preservedBlockCount: z.number().int().nonnegative()
}).strict();

export const RichDocumentExportFactsSchema = RichDocumentWriteFactsSchema.extend({
  exportedFromRevision: z.number().int().positive(),
  exportedFromSourceDigest: Sha256Schema,
  exportedFormat: OfficeFileFormatSchema
}).strict();

export type InlineRun = z.infer<typeof InlineRunSchema>;
export type RichDocumentBlock = z.infer<typeof RichDocumentBlockSchema>;
export type RichDocumentLeafBlock = z.infer<typeof RichDocumentLeafBlockSchema>;
export type RichDocumentCreateInput = z.infer<typeof RichDocumentCreateInputSchema>;
export type RichDocumentSource = z.infer<typeof RichDocumentSourceSchema>;
export type RichDocumentManifest = z.infer<typeof RichDocumentManifestSchema>;
export type RichDocumentPatchInput = z.infer<typeof RichDocumentPatchInputSchema>;
export type RichDocumentExportInput = z.infer<typeof RichDocumentExportInputSchema>;
export type RichDocumentExportFacts = z.infer<typeof RichDocumentExportFactsSchema>;
export type RichDocumentPatchOperation = z.infer<typeof RichDocumentPatchOperationSchema>;
export type RichDocumentInspectInput = z.infer<typeof RichDocumentInspectInputSchema>;
export type RichDocumentWriteFacts = z.infer<typeof RichDocumentWriteFactsSchema>;
export type ImportedOfficeCreateInput = z.infer<typeof ImportedOfficeCreateInputSchema>;
export type OfficeSourceInspectInput = z.infer<typeof OfficeSourceInspectInputSchema>;
export type ImportedOfficePatchInput = z.infer<typeof ImportedOfficePatchInputSchema>;
export type ImportedOfficePatchOperation = z.infer<typeof ImportedOfficePatchOperationSchema>;
