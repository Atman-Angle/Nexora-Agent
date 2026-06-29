import { z } from "zod";

export const EvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  runId: z.string().min(1),
  type: z.enum(["command_result", "completion_gate"]),
  source: z.enum(["shell.execute", "completion_gate"]),
  status: z.enum(["passed", "failed", "error"]),
  summary: z.string().min(1),
  artifactRefs: z.array(z.string().min(1)),
  createdAt: z.string().datetime()
});

export type Evidence = z.infer<typeof EvidenceSchema>;
