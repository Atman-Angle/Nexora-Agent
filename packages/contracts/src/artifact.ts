import { createHash } from "node:crypto";

import { z } from "zod";

export const ArtifactSchema = z.object({
  schemaVersion: z.literal("1"),
  artifactId: z.string().min(1),
  runId: z.string().min(1),
  type: z.enum(["text", "file"]),
  mimeType: z.string().min(1),
  content: z.string(),
  hash: z.string().min(1),
  createdAt: z.string().datetime(),
  filePath: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional()
}).superRefine((artifact, context) => {
  if (artifact.type === "text" && artifact.mimeType !== "text/plain") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Text artifacts must use text/plain."
    });
  }

  if (artifact.type === "file" && artifact.filePath === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "File artifacts require filePath."
    });
  }
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export function computeArtifactHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createTextArtifact(input: {
  artifactId: string;
  runId: string;
  content: string;
  createdAt: string;
}): Artifact {
  return ArtifactSchema.parse({
    schemaVersion: "1",
    artifactId: input.artifactId,
    runId: input.runId,
    type: "text",
    mimeType: "text/plain",
    content: input.content,
    hash: computeArtifactHash(input.content),
    createdAt: input.createdAt
  });
}

export function createFileArtifact(input: {
  artifactId: string;
  runId: string;
  mimeType: string;
  content: string;
  filePath: string;
  sizeBytes: number;
  hash: string;
  createdAt: string;
}): Artifact {
  return ArtifactSchema.parse({
    schemaVersion: "1",
    artifactId: input.artifactId,
    runId: input.runId,
    type: "file",
    mimeType: input.mimeType,
    content: input.content,
    hash: input.hash,
    createdAt: input.createdAt,
    filePath: input.filePath,
    sizeBytes: input.sizeBytes
  });
}
