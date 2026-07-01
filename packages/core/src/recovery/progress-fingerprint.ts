import { computeArtifactHash, ProgressFingerprintSchema, type ProgressFingerprint } from "../../../contracts/src/index.js";

export function createProgressFingerprint(input: {
  workspaceHash?: string | undefined;
  changedFiles?: string[] | undefined;
  ledgerVersion: number;
  evidenceRefs: string[];
  acceptanceStatuses?: Array<{ id: string; status: string }> | undefined;
  validationStatus?: string | null | undefined;
  validationEvidenceCodes?: string[] | undefined;
  workingSetPaths?: string[] | undefined;
}): ProgressFingerprint {
  return ProgressFingerprintSchema.parse({
    ...(input.workspaceHash === undefined ? {} : { workspaceHash: input.workspaceHash }),
    changedFilesHash: hashArray(input.changedFiles ?? []),
    ledgerHash: computeArtifactHash(JSON.stringify({ version: input.ledgerVersion, evidenceRefs: input.evidenceRefs })),
    acceptanceHash: computeArtifactHash(JSON.stringify(input.acceptanceStatuses ?? [])),
    ...(input.validationStatus === undefined && input.validationEvidenceCodes === undefined
      ? {}
      : {
          validationHash: computeArtifactHash(
            JSON.stringify({
              status: input.validationStatus ?? null,
              evidenceCodes: input.validationEvidenceCodes ?? []
            })
          )
        }),
    workingSetHash: hashArray(input.workingSetPaths ?? [])
  });
}

export function hasProgressChanged(
  previous: ProgressFingerprint | null | undefined,
  current: ProgressFingerprint
): boolean {
  return previous === null || previous === undefined || JSON.stringify(previous) !== JSON.stringify(current);
}

function hashArray(values: string[]): string {
  return computeArtifactHash([...new Set(values)].sort().join("|"));
}
