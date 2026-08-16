import { Buffer } from "node:buffer";

import { z } from "zod";

import { digestCanonicalJson } from "@nexora/runtime/internal";

const Identifier = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const Version = z.string().trim().min(1).max(100);
const BoundedText = z.string().trim().min(1).max(4_096);
const TextList = z.array(BoundedText).max(32);

export const AgentProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: Identifier,
  version: Version,
  role: z.object({
    identity: BoundedText,
    objective: BoundedText,
    expertise: TextList.optional()
  }).strict(),
  strategy: z.object({
    principles: TextList.optional(),
    workflows: z.array(z.object({
      when: BoundedText,
      steps: TextList.min(1)
    }).strict()).max(16).optional(),
    toolGuidance: z.object({
      prefer: TextList.optional(),
      avoid: TextList.optional()
    }).strict().optional()
  }).strict().optional(),
  communication: z.object({
    language: BoundedText.optional(),
    audience: BoundedText.optional(),
    tone: BoundedText.optional(),
    outputGuidance: TextList.optional()
  }).strict().optional()
}).strict().superRefine((profile, context) => {
  enforceByteLimit(profile, 32 * 1_024, context, "Agent Profile");
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentProfileSourceSchema = z.object({
  kind: z.enum(["host", "user"]),
  ref: BoundedText
}).strict();
export type AgentProfileSource = z.infer<typeof AgentProfileSourceSchema>;

export const AgentProfileSnapshotSchema = z.object({
  profile: AgentProfileSchema,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source: AgentProfileSourceSchema
}).strict().superRefine((snapshot, context) => {
  if (snapshot.digest !== digestCanonicalJson(snapshot.profile)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["digest"],
      message: "Agent Profile digest does not match its canonical content."
    });
  }
});
export type AgentProfileSnapshot = z.infer<typeof AgentProfileSnapshotSchema>;

export const HostAgentPolicySchema = z.object({
  schemaVersion: z.literal(1),
  id: Identifier,
  version: Version,
  instructions: TextList.min(1),
  taskMode: z.enum(["infer", "inquiry", "diagnose", "change", "review", "research", "monitor"]).default("infer"),
  promptCache: z.enum(["allow", "disable"]).default("allow")
}).strict().superRefine((policy, context) => {
  enforceByteLimit(policy, 24 * 1_024, context, "Host Policy");
});
export type HostAgentPolicy = z.infer<typeof HostAgentPolicySchema>;

export const ProjectInstructionSchema = z.object({
  sourceRef: BoundedText,
  scope: BoundedText,
  content: z.string().trim().min(1).max(16_384),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  authority: z.literal("host_project_policy")
}).strict().superRefine((instruction, context) => {
  const expected = digestCanonicalJson({
    sourceRef: instruction.sourceRef,
    scope: instruction.scope,
    content: instruction.content,
    authority: instruction.authority
  });
  if (instruction.digest !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["digest"],
      message: "Project Instruction digest does not match its canonical content and provenance."
    });
  }
});
export type ProjectInstruction = z.infer<typeof ProjectInstructionSchema>;

export type StrategyRevision = {
  readonly actor: string;
  readonly reason: string;
};

export type PromptHostConfiguration = {
  readonly hostPolicy: HostAgentPolicy | null;
  readonly hostPolicyDigest: string | null;
  readonly profile: AgentProfileSnapshot | null;
  readonly projectInstructions: readonly ProjectInstruction[];
  readonly projectInstructionsDigest: string;
  readonly strategyRevision: StrategyRevision | null;
};

export function createAgentProfileSnapshot(
  profileInput: AgentProfile,
  sourceInput: AgentProfileSource
): AgentProfileSnapshot {
  const profile = AgentProfileSchema.parse(profileInput);
  return AgentProfileSnapshotSchema.parse({
    profile,
    digest: digestCanonicalJson(profile),
    source: AgentProfileSourceSchema.parse(sourceInput)
  });
}

export function createProjectInstruction(
  input: Omit<ProjectInstruction, "digest" | "authority">
): ProjectInstruction {
  const base = {
    sourceRef: input.sourceRef.trim(),
    scope: input.scope.trim(),
    content: input.content.trim(),
    authority: "host_project_policy" as const
  };
  return ProjectInstructionSchema.parse({
    ...base,
    digest: digestCanonicalJson(base)
  });
}

export class AgentProfileRegistry {
  readonly #profiles = new Map<string, AgentProfileSnapshot>();

  constructor(snapshots: readonly AgentProfileSnapshot[] = []) {
    for (const snapshot of snapshots) this.register(snapshot);
  }

  register(snapshotInput: AgentProfileSnapshot): void {
    const snapshot = AgentProfileSnapshotSchema.parse(snapshotInput);
    const key = profileKey(snapshot.profile.id, snapshot.profile.version);
    if (this.#profiles.has(key)) {
      throw new Error(`Agent Profile is already registered: ${key}`);
    }
    this.#profiles.set(key, Object.freeze(structuredClone(snapshot)));
  }

  select(id: string, version: string): AgentProfileSnapshot {
    const key = profileKey(Identifier.parse(id), Version.parse(version));
    const snapshot = this.#profiles.get(key);
    if (snapshot === undefined) throw new Error(`Agent Profile is not registered: ${key}`);
    return snapshot;
  }
}

export function resolvePromptHostConfiguration(input: {
  readonly hostPolicy?: HostAgentPolicy;
  readonly profile?: AgentProfileSnapshot;
  readonly projectInstructions?: readonly ProjectInstruction[];
  readonly strategyRevision?: StrategyRevision;
}): PromptHostConfiguration {
  const hostPolicy = input.hostPolicy === undefined
    ? null
    : HostAgentPolicySchema.parse(input.hostPolicy);
  const profile = input.profile === undefined
    ? null
    : AgentProfileSnapshotSchema.parse(input.profile);
  const projectInstructions = z.array(ProjectInstructionSchema).max(64).parse(
    input.projectInstructions ?? []
  );
  if (Buffer.byteLength(JSON.stringify(projectInstructions), "utf8") > 64 * 1_024) {
    throw new Error("Project Instructions exceed the 65536-byte total limit.");
  }
  const revision = input.strategyRevision === undefined
    ? null
    : {
        actor: BoundedText.parse(input.strategyRevision.actor),
        reason: BoundedText.parse(input.strategyRevision.reason)
      };
  return Object.freeze({
    hostPolicy,
    hostPolicyDigest: hostPolicy === null ? null : digestCanonicalJson(hostPolicy),
    profile,
    projectInstructions: Object.freeze(structuredClone(projectInstructions)),
    projectInstructionsDigest: digestCanonicalJson(projectInstructions),
    strategyRevision: revision
  });
}

function profileKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function enforceByteLimit(
  value: unknown,
  maximum: number,
  context: z.RefinementCtx,
  label: string
): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maximum) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${label} exceeds the ${maximum}-byte limit.`
  });
}
