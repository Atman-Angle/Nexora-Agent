import type { AgentProfile } from "../profile/types.js";
import type { AgentDeployment } from "../application/agent-registry.js";
import { computeArtifactHash } from "../../../contracts/src/index.js";
import type { CompilationEvidenceStore } from "../../../storage/src/index.js";

/** Small declarative alpha: composes existing Profile seams only. */
export type AgentDeclaration = AgentProfile & { readonly version: string };

export type AgentCompilationEvaluation =
  | { readonly kind: "accepted"; readonly deployment: AgentDeployment; readonly evidence: readonly string[] }
  | { readonly kind: "rejected"; readonly issues: readonly string[]; readonly revision: number };

export function defineAgent(declaration: AgentDeclaration): AgentDeployment {
  if (!declaration.name.trim() || !declaration.version.trim()) throw new Error("Agent declaration name and version must be non-empty.");
  const { version, ...profile } = declaration;
  return Object.freeze({ name: profile.name, version, profile: Object.freeze(profile) });
}

/** Deterministic pre-deployment gate; callers must revise rejected declarations. */
export function evaluateAgentDeclaration(declaration: Partial<AgentDeclaration>, revision = 1): AgentCompilationEvaluation {
  const issues: string[] = [];
  if (typeof declaration.name !== "string" || !declaration.name.trim()) issues.push("name is required");
  if (typeof declaration.version !== "string" || !declaration.version.trim()) issues.push("version is required");
  if (declaration.state === undefined) issues.push("state hooks are required");
  if (declaration.generateAction === undefined) issues.push("generateAction is required");
  if (declaration.actionHandlers === undefined) issues.push("actionHandlers are required");
  if (declaration.completionGate === undefined) issues.push("completionGate is required");
  if (issues.length > 0) return { kind: "rejected", issues, revision };
  const deployment = defineAgent(declaration as AgentDeclaration);
  return { kind: "accepted", deployment, evidence: [`agent:${deployment.name}`, `version:${deployment.version}`, "compiled_to:AgentProfile"] };
}

export function persistCompilationEvidence(input: { declaration: Partial<AgentDeclaration>; compilerVersion: string; evaluation: AgentCompilationEvaluation; store: CompilationEvidenceStore; now: string }) {
  const definitionHash = computeArtifactHash(JSON.stringify({ name: input.declaration.name ?? null, version: input.declaration.version ?? null }));
  const reportJson = JSON.stringify(input.evaluation);
  return input.store.putIfAbsent({ definitionHash, compilerVersion: input.compilerVersion, reportJson, contentHash: computeArtifactHash(reportJson), createdAt: input.now });
}
