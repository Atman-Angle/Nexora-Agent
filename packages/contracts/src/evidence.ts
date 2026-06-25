import { z } from "zod";

export const EvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  runId: z.string().min(1),
  type: z.literal("command_result"),
  source: z.literal("shell.execute"),
  status: z.enum(["passed", "failed", "error"]),
  summary: z.string().min(1),
  artifactRefs: z.array(z.string().min(1)),
  createdAt: z.string().datetime()
});

export type Evidence = z.infer<typeof EvidenceSchema>;
