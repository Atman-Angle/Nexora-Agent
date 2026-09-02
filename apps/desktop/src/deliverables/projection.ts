import type { DeliverableSummary } from "../shared.js";
import { RichDocumentExportFactsSchema, RichDocumentWriteFactsSchema } from "./contracts.js";

type InvocationProjection = {
  readonly toolName: string;
  readonly status: string;
  readonly resultJson?: unknown;
};

export function projectDeliverables(
  runs: readonly { readonly runId: string; readonly invocations: readonly InvocationProjection[] }[]
): DeliverableSummary[] {
  const byId = new Map<string, DeliverableSummary>();
  for (const run of runs) {
    for (const invocation of run.invocations) {
      if (invocation.status !== "succeeded" || !["document.create", "document.import", "document.apply_patch", "document.apply_native_patch", "document.export"].includes(invocation.toolName)) continue;
      const parsed = invocation.toolName === "document.export"
        ? RichDocumentExportFactsSchema.safeParse(invocation.resultJson)
        : RichDocumentWriteFactsSchema.safeParse(invocation.resultJson);
      if (!parsed.success) continue;
      const facts = parsed.data;
      const existing = byId.get(facts.deliverableId);
      if (existing !== undefined && existing.revision > facts.revision) continue;
      byId.set(facts.deliverableId, {
        deliverableId: facts.deliverableId,
        kind: "rich_document",
        title: facts.title,
        manifestPath: facts.manifestPath,
        previewPath: facts.previewPath,
        revision: facts.revision,
        sourceDigest: facts.sourceDigest,
        previewDigest: facts.previewDigest,
        files: facts.files,
        validation: "passed",
        stage: invocation.toolName === "document.import"
          ? "imported"
          : invocation.toolName === "document.export"
            ? "exported"
            : invocation.toolName === "document.create"
              ? "created"
              : "modified",
        sourceRunId: run.runId,
        changedBlockIds: [...new Set([
          ...facts.changedBlockIds,
          ...facts.insertedBlockIds,
          ...facts.removedBlockIds,
          ...facts.movedBlockIds
        ])],
        preservedBlockCount: facts.preservedBlockCount
      });
    }
  }
  return [...byId.values()];
}
