import { z } from "zod";

export const ApprovalScopeSchema = z.enum(["once", "current_run"]);
export const ApprovalStatusSchema = z.enum(["pending", "approved", "denied", "expired", "cancelled"]);

export const ApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  actionId: z.string().min(1),
  toolCallId: z.string().min(1),
  riskLevel: z.enum(["write", "execute"]),
  reason: z.string().min(1),
  requestedCapabilities: z.array(z.string().min(1)),
  resourceScope: z.string().min(1),
  actionSummary: z.string().min(1),
  expiresAt: z.string().datetime(),
  status: ApprovalStatusSchema,
  createdAt: z.string().datetime()
});

export const ApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  decision: z.enum(["approved", "denied"]),
  scope: ApprovalScopeSchema,
  decidedAt: z.string().datetime(),
  optionalReason: z.string().min(1).optional()
});

export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
