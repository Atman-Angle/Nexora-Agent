import { z } from "zod";

const StableIdentitySchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), "Identity must not have leading or trailing whitespace.")
  .refine(
    (value) => !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }),
    "Identity must not contain control characters."
  );

const TimestampSchema = z.string().datetime({ offset: true });
const SourceRefSchema = z.string()
  .min(3)
  .max(512)
  .regex(
    /^(?:input:[1-9][0-9]*|event:[1-9][0-9]*|invocation:[a-zA-Z0-9._-]{1,100}|evidence:[a-zA-Z0-9._-]{1,100}|artifact:sha256:[0-9a-f]{64})$/u,
    "Source ref must identify persisted Run Authority."
  );
const EvidenceRefSchema = z.string()
  .min(10)
  .max(512)
  .regex(
    /^evidence:[a-zA-Z0-9._-]{1,100}$/u,
    "Verification ref must identify persisted Evidence."
  );

export const MemoryDigestSchema = z.string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "Digest must be a lowercase sha256 digest.");

export const MemoryIdSchema = StableIdentitySchema;

export const MemoryScopeSchema = z.object({
  userId: StableIdentitySchema,
  projectId: StableIdentitySchema,
  workspaceId: StableIdentitySchema,
  branchId: StableIdentitySchema.optional()
}).strict();

export const MemorySourceSchema = z.object({
  sourceRunId: StableIdentitySchema,
  ref: SourceRefSchema,
  digest: MemoryDigestSchema
}).strict();

export const MemoryVerificationSchema = z.object({
  state: z.enum(["unverified", "verified"]),
  verifiedAt: TimestampSchema.optional(),
  evidenceRefs: z.array(EvidenceRefSchema).max(16).default([])
}).strict().superRefine((verification, context) => {
  if (new Set(verification.evidenceRefs).size !== verification.evidenceRefs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceRefs"],
      message: "Verification Evidence refs must be unique."
    });
  }
  if (verification.state === "verified") {
    if (verification.verifiedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifiedAt"],
        message: "Verified Memory requires verifiedAt."
      });
    }
    if (verification.evidenceRefs.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceRefs"],
        message: "Verified Memory requires at least one evidence ref."
      });
    }
  } else if (verification.verifiedAt !== undefined || verification.evidenceRefs.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Unverified Memory cannot claim verification time or Evidence."
    });
  }
});

export const MemoryStatusSchema = z.enum([
  "candidate",
  "active",
  "archived",
  "invalidated",
  "superseded",
  "expired"
]);
export const MemorySensitivitySchema = z.enum(["normal", "sensitive"]);

export const MemoryPromotionSchema = z.object({
  mode: z.enum(["explicit", "verified"]),
  promotedBy: StableIdentitySchema,
  promotedAt: TimestampSchema
}).strict();

export const MemorySupersessionSchema = z.object({
  reason: z.string()
    .min(1)
    .max(500)
    .refine((value) => value === value.trim(), "Supersession reason must be trimmed."),
  occurredAt: TimestampSchema
}).strict();

export const MemoryRecordSchema = z.object({
  memoryId: MemoryIdSchema,
  memoryType: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u),
  statement: z.string()
    .min(1)
    .max(4096)
    .refine((value) => value === value.trim(), "Statement must not have leading or trailing whitespace."),
  scope: MemoryScopeSchema,
  source: MemorySourceSchema,
  verification: MemoryVerificationSchema,
  status: MemoryStatusSchema,
  sensitivity: MemorySensitivitySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  promotion: MemoryPromotionSchema.optional(),
  supersedesMemoryIds: z.array(MemoryIdSchema).min(1).max(32).optional(),
  supersededByMemoryId: MemoryIdSchema.optional(),
  supersession: MemorySupersessionSchema.optional()
}).strict().superRefine((record, context) => {
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["updatedAt"],
      message: "updatedAt must not precede createdAt."
    });
  }
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "expiresAt must follow createdAt."
    });
  }
  if (
    record.verification.verifiedAt !== undefined
    && Date.parse(record.verification.verifiedAt) < Date.parse(record.createdAt)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verification", "verifiedAt"],
      message: "verifiedAt must not precede createdAt."
    });
  }
  if (
    record.verification.verifiedAt !== undefined
    && Date.parse(record.verification.verifiedAt) > Date.parse(record.updatedAt)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verification", "verifiedAt"],
      message: "verifiedAt must not follow updatedAt."
    });
  }
  if (record.promotion !== undefined) {
    if (Date.parse(record.promotion.promotedAt) > Date.parse(record.updatedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["promotion", "promotedAt"],
        message: "promotedAt must not follow updatedAt."
      });
    }
    if (record.promotion.mode === "verified" && record.verification.state !== "verified") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["promotion", "mode"],
        message: "Verified promotion requires verified Memory."
      });
    }
  }
  if (record.supersedesMemoryIds !== undefined) {
    if (new Set(record.supersedesMemoryIds).size !== record.supersedesMemoryIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersedesMemoryIds"],
        message: "Superseded Memory IDs must be unique."
      });
    }
    if (record.supersedesMemoryIds.includes(record.memoryId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersedesMemoryIds"],
        message: "Memory cannot supersede itself."
      });
    }
  }
  if (record.supersededByMemoryId === record.memoryId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersededByMemoryId"],
      message: "Memory cannot be superseded by itself."
    });
  }
  if (record.status === "candidate" && (
    record.promotion !== undefined
    || record.supersedesMemoryIds !== undefined
    || record.supersededByMemoryId !== undefined
    || record.supersession !== undefined
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Candidate Memory cannot claim promotion or supersession lifecycle."
    });
  }
  if (record.status === "superseded" && record.supersededByMemoryId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersededByMemoryId"],
      message: "Superseded Memory requires its replacement ID."
    });
  }
  if (record.status !== "superseded" && record.supersededByMemoryId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersededByMemoryId"],
      message: "Only superseded Memory may point to a replacement."
    });
  }
  if (record.supersession !== undefined && Date.parse(record.supersession.occurredAt) > Date.parse(record.updatedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersession", "occurredAt"],
      message: "Supersession time must not follow updatedAt."
    });
  }
  if (
    record.status === "expired"
    && (record.expiresAt === undefined || Date.parse(record.expiresAt) > Date.parse(record.updatedAt))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Expired Memory requires an expiration time at or before updatedAt."
    });
  }
});

export const MemoryListOptionsSchema = z.object({
  scope: MemoryScopeSchema,
  status: MemoryStatusSchema.optional(),
  memoryType: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u).optional(),
  limit: z.number().int().min(1).max(500).default(100)
}).strict();

export const MemoryStatusUpdateSchema = z.object({
  scope: MemoryScopeSchema,
  memoryId: StableIdentitySchema,
  status: z.enum(["archived", "invalidated"]),
  updatedAt: TimestampSchema
}).strict();

export const MemoryPromotionInputSchema = z.object({
  scope: MemoryScopeSchema,
  memoryId: MemoryIdSchema,
  promotion: MemoryPromotionSchema
}).strict();

export const MemorySupersedeInputSchema = z.object({
  scope: MemoryScopeSchema,
  replacementMemoryId: MemoryIdSchema,
  predecessorMemoryIds: z.array(MemoryIdSchema).min(1).max(32).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Predecessor IDs must be unique." });
    }
  }),
  promotion: MemoryPromotionSchema,
  reason: MemorySupersessionSchema.shape.reason
}).strict();

export const MemoryRevalidationInputSchema = z.object({
  scope: MemoryScopeSchema,
  memoryId: MemoryIdSchema,
  verification: MemoryVerificationSchema.refine(
    (verification) => verification.state === "verified",
    "Revalidation requires verified Evidence."
  ),
  updatedAt: TimestampSchema
}).strict();

export const MemoryExpirationInputSchema = z.object({
  scope: MemoryScopeSchema,
  asOf: TimestampSchema
}).strict();

export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export type MemoryVerification = z.infer<typeof MemoryVerificationSchema>;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>;
export type MemoryPromotion = z.infer<typeof MemoryPromotionSchema>;
export type MemorySupersession = z.infer<typeof MemorySupersessionSchema>;
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
export type CreateMemoryInput = z.input<typeof MemoryRecordSchema>;
export type MemoryListOptions = z.input<typeof MemoryListOptionsSchema>;
export type MemoryStatusUpdate = z.infer<typeof MemoryStatusUpdateSchema>;
export type MemoryPromotionInput = z.infer<typeof MemoryPromotionInputSchema>;
export type MemorySupersedeInput = z.infer<typeof MemorySupersedeInputSchema>;
export type MemoryRevalidationInput = z.infer<typeof MemoryRevalidationInputSchema>;
export type MemoryExpirationInput = z.infer<typeof MemoryExpirationInputSchema>;
export type MemoryPromotionResult =
  | { readonly outcome: "promoted"; readonly record: MemoryRecord }
  | {
      readonly outcome: "deduplicated";
      readonly record: MemoryRecord;
      readonly duplicate: MemoryRecord;
    };
export type MemorySupersedeResult = {
  readonly replacement: MemoryRecord;
  readonly predecessors: readonly MemoryRecord[];
};
