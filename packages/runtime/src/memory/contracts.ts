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

export const MemoryStatusSchema = z.enum(["active", "archived", "invalidated"]);
export const MemorySensitivitySchema = z.enum(["normal", "sensitive"]);

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
  expiresAt: TimestampSchema.optional()
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
  status: MemoryStatusSchema,
  updatedAt: TimestampSchema
}).strict();

export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export type MemoryVerification = z.infer<typeof MemoryVerificationSchema>;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>;
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
export type CreateMemoryInput = z.input<typeof MemoryRecordSchema>;
export type MemoryListOptions = z.input<typeof MemoryListOptionsSchema>;
export type MemoryStatusUpdate = z.infer<typeof MemoryStatusUpdateSchema>;
