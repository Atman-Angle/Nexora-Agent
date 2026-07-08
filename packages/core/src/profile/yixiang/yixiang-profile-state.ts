import { z } from "zod";

import type { AgentLoopState } from "../../agent-loop/state.js";

/**
 * YixiangProfileState — the Yixiang (product-content) profile's owned domain
 * state, carried in the opaque `state.profileState` blob (F029 boundary).
 * The runtime never inspects these fields; Yixiang owns the lifecycle via
 * AgentProfile.state hooks (init/serialize/restore/validate).
 *
 * F030 first phase defines the domain shape but only exercises the lifecycle
 * (init/checkpoint/resume/validate-fail), not the full business chain.
 */
export type YixiangStage =
  | "init"
  | "assets_analyzed"
  | "facts_confirmed"
  | "content_generated"
  | "compliance_checked"
  | "completed";

export type ProductFact = {
  readonly factId: string;
  readonly key: string;
  readonly value: string;
  readonly confidence: number;
  readonly source: "asset_analysis" | "user_confirmed";
};

export type GeneratedContent = {
  readonly contentId: string;
  readonly platform: string;
  readonly artifactRef: string;
  readonly status: "draft" | "approved";
};

export type ComplianceResult =
  | { readonly status: "pending" }
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly violations: string[] };

export type YixiangProfileState = {
  readonly projectId: string;
  readonly currentStage: YixiangStage;
  readonly productFacts: ProductFact[];
  readonly confirmedFacts: ProductFact[];
  readonly targetPlatforms: string[];
  readonly generatedContents: GeneratedContent[];
  readonly complianceResult: ComplianceResult;
  readonly artifactRefs: string[];
};

const ProductFactSchema = z.object({
  factId: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source: z.enum(["asset_analysis", "user_confirmed"])
});

const GeneratedContentSchema = z.object({
  contentId: z.string().min(1),
  platform: z.string().min(1),
  artifactRef: z.string().min(1),
  status: z.enum(["draft", "approved"])
});

const ComplianceResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("passed") }),
  z.object({ status: z.literal("failed"), violations: z.array(z.string().min(1)) })
]);

export const YixiangProfileStateSchema = z.object({
  projectId: z.string().min(1),
  currentStage: z.enum(["init", "assets_analyzed", "facts_confirmed", "content_generated", "compliance_checked", "completed"]),
  productFacts: z.array(ProductFactSchema),
  confirmedFacts: z.array(ProductFactSchema),
  targetPlatforms: z.array(z.string().min(1)),
  generatedContents: z.array(GeneratedContentSchema),
  complianceResult: ComplianceResultSchema,
  artifactRefs: z.array(z.string().min(1))
});

/**
 * parseYixiangProfileState — Zod guard used by restoreState/validateState/
 * readYixiangState to validate the opaque profileState blob.
 */
export function parseYixiangProfileState(input: unknown): YixiangProfileState {
  return YixiangProfileStateSchema.parse(input);
}

/**
 * readYixiangState — the single read accessor Yixiang handlers use to reach
 * their domain state. Casts the opaque `state.profileState` and Zod-validates.
 *
 * Hosted in this leaf module (not yixiang-profile.ts) to avoid a circular
 * import: yixiang handlers/policies import readYixiangState, and
 * yixiang-profile.ts imports the handlers. Keeping the accessor here means
 * handlers → this module → agent-loop/state.js, with no back-edge into
 * yixiang-profile.ts (mirrors the F029 coding-profile-state.ts fix).
 */
export function readYixiangState(state: AgentLoopState): YixiangProfileState {
  return parseYixiangProfileState(state.profileState);
}
