import { RegroundManifestSchema, type FailureEnvelope, type RegroundManifest, type WorkingSet } from "../../../contracts/src/index.js";

export function createRegroundManifest(input: {
  manifestId: string;
  runId: string;
  failure: FailureEnvelope;
  reason: string;
  workingSet: WorkingSet | null;
  readHashes?: Record<string, string> | undefined;
  validationRef?: string | undefined;
  createdAt: string;
}): RegroundManifest {
  const inspectedPaths = input.workingSet?.items.map((item) => item.path) ?? [];
  return RegroundManifestSchema.parse({
    schemaVersion: "1",
    manifestId: input.manifestId,
    runId: input.runId,
    failureId: input.failure.failureId,
    reason: input.reason,
    inspectedPaths,
    readHashes: input.readHashes ?? {},
    ...(input.validationRef === undefined ? {} : { validationRef: input.validationRef }),
    staleContextInvalidated: true,
    createdAt: input.createdAt
  });
}
