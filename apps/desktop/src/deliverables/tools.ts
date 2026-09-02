import { z } from "zod";

import type { RuntimeTool, RuntimeToolResult } from "@nexora/harness";

import {
  ImportedOfficeCreateInputSchema,
  ImportedOfficePatchInputSchema,
  OfficeSourceInspectInputSchema,
  RichDocumentInspectInputSchema,
  RichDocumentExportFactsSchema,
  RichDocumentExportInputSchema,
  RichDocumentWriteFactsSchema,
  type RichDocumentBlock
} from "./contracts.js";
import {
  compileAuthoringCreateInput,
  compileAuthoringPatchInput,
  RichDocumentAuthoringCreateInputSchema,
  RichDocumentAuthoringPatchInputSchema
} from "./authoring.js";
import {
  createRichDocument,
  DeliverableError,
  exportRichDocumentFormat,
  inspectRichDocument,
  patchRichDocument
} from "./rich-document.js";
import {
  importOfficeDocument,
  inspectOfficeSource,
  inspectImportedOffice,
  isImportedOfficeDeliverable,
  patchImportedOffice
} from "./imported-office.js";

const InspectFactsSchema = z.object({
  deliverableId: z.string().min(1),
  kind: z.literal("rich_document"),
  title: z.string().min(1),
  manifestPath: z.string().min(1),
  revision: z.number().int().positive(),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  previewDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  validation: z.literal("passed"),
  blockCount: z.number().int().nonnegative(),
  outline: z.array(z.object({ blockId: z.string(), type: z.string(), depth: z.number().int().nonnegative() }).strict()),
  blocks: z.array(z.unknown())
}).strict();

export function createRichDocumentTools(): readonly RuntimeTool[] {
  return [createTool(), importTool(), sourceReadTool(), inspectTool(), patchTool(), nativePatchTool(), exportTool()];
}

const OfficeSourceFactsSchema = z.object({
  path: z.string().min(1),
  format: z.enum(["docx", "xlsx", "pptx"]),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  byteLength: z.number().int().positive(),
  validation: z.literal("passed"),
  targetCount: z.number().int().nonnegative(),
  outline: z.array(z.object({ blockId: z.string(), type: z.string(), depth: z.number().int().nonnegative() }).strict()),
  blocks: z.array(z.unknown())
}).strict();

function sourceReadTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "document.read_source" },
      capability: {
        purpose: "Read bounded validated content and structure from an existing Workspace DOCX, XLSX or PPTX as reference material without creating a Deliverable.",
        nonGoals: ["Modify the source file.", "Import the source as an editable Deliverable.", "Read PDF or arbitrary binary formats."]
      },
      decision: {
        useWhen: [
          "A Workspace Office file or Host-verified Office attachment is reference material for a new output.",
          "Use expectedDigest when the Host supplied one for an attachment."
        ],
        avoidWhen: [
          "The user wants to modify the existing Office file; import it once, then inspect and use document.apply_native_patch.",
          "The source is plain UTF-8 text; use filesystem.read."
        ]
      },
      execution: {
        effect: { kind: "read", description: "Validates and returns one bounded Office source projection without writing a manifest or revision." },
        idempotent: true,
        readCache: { mode: "until_mutation" },
        inputSchema: OfficeSourceInspectInputSchema,
        inputExample: { path: "references/report.docx", mode: "outline" }
      },
      evidence: {
        produces: ["The source path, format, digest, package validation, bounded outline and optionally exact target content."],
        factsSchema: OfficeSourceFactsSchema
      }
    },
    async execute(input, context) {
      try {
        const parsed = OfficeSourceInspectInputSchema.parse(input);
        return success(parsed.path, OfficeSourceFactsSchema.parse(inspectOfficeSource(context.workspace, parsed)));
      } catch (error) { return failure("office-document:read-source", error); }
    }
  };
}

function importTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "document.import" },
      capability: {
        purpose: "Import one host-verified existing DOCX, XLSX or PPTX attachment as revision one of a restart-safe Deliverable without regenerating the file.",
        nonGoals: ["Import PDF as an editable Office source.", "Execute macros, ActiveX, OLE, external links or embedded code.", "Modify the attachment during import."]
      },
      decision: {
        useWhen: [
          "The current user input contains a [HOST-VERIFIED ATTACHMENTS] entry for an existing DOCX, XLSX or PPTX that the user wants to edit.",
          "Use the exact attachment workspacePath and digest supplied by the Host; choose a new bounded outputs directory."
        ],
        avoidWhen: ["The attachment is only reference material for a new document; read it with an appropriate bounded capability instead.", "A Deliverable manifest for this same imported file already exists in the current Session; inspect and patch it instead."]
      },
      execution: {
        effect: { kind: "write", description: "Commits an immutable imported Office revision and manifest while preserving the original package bytes." },
        idempotent: true,
        inputSchema: ImportedOfficeCreateInputSchema,
        inputExample: {
          attachmentPath: ".nexora/attachments/0123456789abcdef/report.docx",
          attachmentDigest: `sha256:${"0".repeat(64)}`,
          outputDirectory: "outputs/imported-report",
          title: "Imported report"
        }
      },
      evidence: {
        produces: ["The imported Deliverable identity, exact original/current digest, revision, preview, real Office file and passed package validation."],
        factsSchema: RichDocumentWriteFactsSchema
      }
    },
    async execute(input, context) {
      try {
        const parsed = ImportedOfficeCreateInputSchema.parse(input);
        const facts = await importOfficeDocument(context.workspace, context.invocationId, parsed, context.signal);
        return success(facts.manifestPath, facts);
      } catch (error) { return failure("office-document:import", error); }
    }
  };
}

function createTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "document.create" },
      capability: {
        purpose: "Create the bounded first revision of one general structured Deliverable and commit any requested real DOCX, XLSX, PPTX or PDF representations after low-cost mechanical checks.",
        nonGoals: ["Modify an existing Deliverable.", "Create arbitrary HTML, CSS, JavaScript, macros or executable Office content.", "Perform a default post-generation semantic review."]
      },
      decision: {
        useWhen: [
          "The user requested a durable polished report, brief or other rich document rather than a chat-only answer.",
          "The same logical content needs one or more requested Office representations in the formats array.",
          "The exact output directory and first bounded document section are known; every image path was confirmed by a filesystem Tool fact."
        ],
        avoidWhen: [
          "The user asked to revise an existing rich document; inspect and patch it instead.",
          "The document is too large for one bounded call, or an image path has not been verified; create a smaller first revision or inspect Workspace files first."
        ]
      },
      execution: {
        effect: { kind: "write", description: "Creates one immutable rich-document revision and atomically commits its manifest." },
        idempotent: true,
        inputSchema: RichDocumentAuthoringCreateInputSchema,
        inputExample: {
          outputDirectory: "outputs/quarterly-review",
          title: "Quarterly Review",
          locale: "en-US",
          formats: ["docx", "xlsx", "pptx", "pdf"],
          theme: { pageWidth: "standard", surface: "light", primaryColor: "#2563eb", accentColor: "#0ea5e9", font: "system", spacing: "comfortable", corners: "rounded" },
          blocks: [
            { blockId: "title", type: "heading", level: 1, runs: "Quarterly Review" },
            { blockId: "summary", type: "paragraph", runs: "Verified management summary." },
            { blockId: "performance", type: "table", headers: ["Department", "Revenue"], rows: [["Sales", "3150"]] }
          ]
        }
      },
      evidence: {
        produces: ["The Deliverable identity, manifest/preview paths, revision, source/preview digests, content counts and passed validation."],
        factsSchema: RichDocumentWriteFactsSchema
      }
    },
    async execute(input, context) {
      try {
        const parsed = compileAuthoringCreateInput(input);
        const facts = await createRichDocument(context.workspace, context.invocationId, parsed, context.signal);
        return success(facts.manifestPath, facts);
      } catch (error) { return failure("rich-document:create", error); }
    }
  };
}

function inspectTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "document.inspect" },
      capability: {
        purpose: "Read the validated current revision, outline or exact blocks of one existing rich-document Deliverable.",
        nonGoals: ["Modify a Deliverable.", "Read arbitrary Workspace files or return an unbounded document body."]
      },
      decision: {
        useWhen: [
          "An existing rich document must be revised and its current revision/digest or target block structure is required.",
          "A previous document write fact identifies the exact manifest path.",
          "A planned final document write needs one low-cost mechanical verification fact before Runtime Completion; use summary mode, which returns no document body."
        ],
        avoidWhen: ["No existing rich-document manifest is known.", "Existing current facts already contain the exact required blocks and digest and Runtime does not require a separate verification check."]
      },
      execution: {
        effect: { kind: "read", description: "Reads one bounded validated rich-document projection." },
        idempotent: true,
        readCache: { mode: "until_mutation" },
        inputSchema: RichDocumentInspectInputSchema,
        inputExample: { manifestPath: "outputs/quarterly-review/manifest.nexora.json", mode: "outline" }
      },
      evidence: {
        produces: ["The current revision/digests, bounded outline and optionally exact requested blocks."],
        factsSchema: InspectFactsSchema
      }
    },
    async execute(input, context) {
      try {
        const parsed = RichDocumentInspectInputSchema.parse(input);
        if (isImportedOfficeDeliverable(context.workspace, parsed.manifestPath)) {
          const inspected = inspectImportedOffice(context.workspace, parsed);
          return success(parsed.manifestPath, InspectFactsSchema.parse({
            deliverableId: inspected.manifest.deliverableId,
            kind: "rich_document",
            title: inspected.manifest.title,
            manifestPath: parsed.manifestPath,
            revision: inspected.manifest.currentRevision,
            sourceDigest: inspected.manifest.sourceDigest,
            previewDigest: inspected.manifest.previewDigest,
            validation: "passed",
            blockCount: inspected.blockCount,
            outline: inspected.outline,
            blocks: inspected.blocks
          }));
        }
        const { manifest, source } = inspectRichDocument(context.workspace, parsed.manifestPath);
        const requested = new Set(parsed.blockIds ?? []);
        const blocks = parsed.mode === "blocks"
          ? flattenBlocks(source.blocks).filter((block) => requested.has(block.blockId))
          : [];
        if (parsed.mode === "blocks" && blocks.length !== requested.size) {
          return { status: "failure", subjectRef: parsed.manifestPath, error: { code: "INVALID_DOCUMENT_PATCH", message: "One or more exact block IDs do not exist in the current document.", retryable: false } };
        }
        return success(parsed.manifestPath, InspectFactsSchema.parse({
          deliverableId: manifest.deliverableId,
          kind: "rich_document",
          title: source.title,
          manifestPath: parsed.manifestPath,
          revision: manifest.currentRevision,
          sourceDigest: manifest.sourceDigest,
          previewDigest: manifest.previewDigest,
          validation: "passed",
          blockCount: outline(source.blocks).length,
          outline: parsed.mode === "summary" ? [] : outline(source.blocks),
          blocks
        }));
      } catch (error) { return failure("rich-document:inspect", error); }
    }
  };
}

function patchTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "document.apply_patch" },
      capability: {
        purpose: "Apply an atomic, revision-guarded set of block-level edits to one Nexora-generated structured Deliverable and regenerate its requested committed DOCX, XLSX, PPTX or PDF representations.",
        nonGoals: ["Create a new Deliverable.", "Replace unspecified blocks or accept array-index edits, arbitrary HTML, CSS or scripts."]
      },
      decision: {
        useWhen: [
          "The user requested changes to a Nexora-generated rich document and the current manifest, revision, digest and exact block IDs were inspected.",
          "The requested change can be expressed as a bounded batch of block insert, replace, remove, move, title or theme operations."
        ],
        avoidWhen: [
          "The current revision or target block IDs are unknown; inspect first.",
          "The user requested a separate new document, or the batch is too large; use another revision for the remaining blocks."
        ]
      },
      execution: {
        effect: { kind: "write", description: "Commits one new immutable revision after CAS, structure, asset and render validation." },
        idempotent: true,
        inputSchema: RichDocumentAuthoringPatchInputSchema,
        inputExample: {
          manifestPath: "outputs/quarterly-review/manifest.nexora.json",
          expectedRevision: 1,
          expectedSourceDigest: `sha256:${"0".repeat(64)}`,
          operations: [{ type: "replace_block", targetBlockId: "summary", block: { blockId: "summary", type: "paragraph", runs: [{ text: "Updated summary." }] } }]
        }
      },
      evidence: {
        produces: ["The new revision/digests, exact changed/inserted/removed/moved block IDs, preserved block count and passed validation."],
        factsSchema: RichDocumentWriteFactsSchema
      }
    },
    async execute(input, context) {
      try {
        const parsed = compileAuthoringPatchInput(input);
        const facts = await patchRichDocument(context.workspace, context.invocationId, parsed, context.signal);
        return success(facts.manifestPath, facts);
      } catch (error) { return failure("rich-document:patch", error); }
    }
  };
}

function nativePatchTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "document.apply_native_patch" },
      capability: {
        purpose: "Apply an atomic revision-guarded patch to an imported native DOCX, XLSX or PPTX while preserving unrelated package content.",
        nonGoals: ["Patch a Nexora-generated structured document.", "Convert an imported Office file to PDF.", "Execute macros or embedded code."]
      },
      decision: {
        useWhen: [
          "The user wants to modify an imported Office Deliverable and document.inspect supplied its current revision, digest and native target IDs.",
          "Use one bounded batch so all native targets resolve against the same input revision."
        ],
        avoidWhen: [
          "The Office file is only reference material; use document.read_source.",
          "The Deliverable was created by document.create; use document.apply_patch."
        ]
      },
      execution: {
        effect: { kind: "write", description: "Commits one immutable native Office revision after CAS, package validation and bounded preview generation." },
        idempotent: true,
        inputSchema: ImportedOfficePatchInputSchema,
        inputExample: {
          manifestPath: "outputs/imported-report/manifest.nexora.json",
          expectedRevision: 1,
          expectedSourceDigest: `sha256:${"0".repeat(64)}`,
          operations: [{ type: "replace_text", targetId: "docx.p.0004", text: "Updated paragraph." }]
        }
      },
      evidence: {
        produces: ["The new native Office revision, digest, exact changed/removed target IDs, preserved target count and passed validation."],
        factsSchema: RichDocumentWriteFactsSchema
      }
    },
    async execute(input, context) {
      try {
        const parsed = ImportedOfficePatchInputSchema.parse(input);
        if (!isImportedOfficeDeliverable(context.workspace, parsed.manifestPath)) {
          throw new DeliverableError("INVALID_DOCUMENT_PATCH", "document.apply_native_patch requires an imported Office Deliverable.");
        }
        const facts = await patchImportedOffice(context.workspace, context.invocationId, parsed, context.signal);
        return success(facts.manifestPath, facts);
      } catch (error) { return failure("office-document:native-patch", error); }
    }
  };
}

function exportTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "document.export" },
      capability: {
        purpose: "Export one additional DOCX, XLSX, PPTX or PDF representation from an exact committed source revision without changing its content.",
        nonGoals: ["Edit document content.", "Export more than one new format in one Invocation.", "Perform semantic review."]
      },
      decision: {
        useWhen: ["An existing Deliverable needs one additional Office format and its current revision and source digest were inspected."],
        avoidWhen: [
          "The content must change; apply a patch instead.",
          "The requested format is already committed.",
          "The Deliverable is an imported native Office file; arbitrary high-fidelity native Office conversion is not available in this Feature."
        ]
      },
      execution: {
        effect: { kind: "write", description: "Commits one new immutable revision containing the prior representations plus one newly rendered format." },
        idempotent: true,
        inputSchema: RichDocumentExportInputSchema,
        inputExample: {
          manifestPath: "outputs/quarterly-review/manifest.nexora.json",
          expectedRevision: 1,
          expectedSourceDigest: `sha256:${"0".repeat(64)}`,
          format: "pdf"
        }
      },
      evidence: {
        produces: ["The exact source revision/digest, exported format and new committed revision with all representation facts."],
        factsSchema: RichDocumentExportFactsSchema
      }
    },
    async execute(input, context) {
      try {
        const parsed = RichDocumentExportInputSchema.parse(input);
        if (isImportedOfficeDeliverable(context.workspace, parsed.manifestPath)) {
          throw new DeliverableError(
            "DOCUMENT_CONVERSION_UNAVAILABLE",
            "High-fidelity conversion of an imported native Office file is not available; the current native revision was left unchanged."
          );
        }
        const facts = await exportRichDocumentFormat(context.workspace, context.invocationId, parsed, context.signal);
        return success(facts.manifestPath, facts);
      } catch (error) { return failure("rich-document:export", error); }
    }
  };
}

function outline(blocks: readonly RichDocumentBlock[], depth = 0): Array<{ blockId: string; type: string; depth: number }> {
  return blocks.flatMap((block) => [
    { blockId: block.blockId, type: block.type, depth },
    ...(block.type === "columns" ? block.columns.flatMap((column) => outline(column, depth + 1)) : [])
  ]);
}

function flattenBlocks(blocks: readonly RichDocumentBlock[]): RichDocumentBlock[] {
  return blocks.flatMap((block) => [block, ...(block.type === "columns" ? block.columns.flatMap((column) => flattenBlocks(column)) : [])]);
}

function success(subjectRef: string, facts: unknown): RuntimeToolResult {
  return { status: "success", subjectRef, facts: facts as RuntimeToolResult extends { facts: infer T } ? T : never };
}

function failure(subjectRef: string, error: unknown): RuntimeToolResult {
  if (error instanceof DeliverableError) {
    return { status: "failure", subjectRef, error: { code: error.code, message: error.message, retryable: error.retryable } };
  }
  if (error instanceof z.ZodError) {
    const unsupportedFormat = error.issues.some((issue) => issue.path[0] === "formats" && issue.code === "invalid_enum_value");
    return {
      status: "failure",
      subjectRef,
      error: {
        code: unsupportedFormat ? "DOCUMENT_UNSUPPORTED_FORMAT" : "DOCUMENT_INVALID_INPUT",
        message: unsupportedFormat ? "One or more requested document formats are unsupported." : "The document input does not satisfy the capability contract.",
        retryable: false
      }
    };
  }
  return {
    status: "failure",
    subjectRef,
    error: { code: "DOCUMENT_TOOL_FAILED", message: error instanceof Error ? error.message : String(error), retryable: false }
  };
}
