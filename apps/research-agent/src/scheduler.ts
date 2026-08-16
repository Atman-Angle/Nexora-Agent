import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RunInspection, RunOptions } from "@nexora/harness";
import { z } from "zod";

import {
  parseResearchProfile,
  type ResearchAgent,
  type ResearchProfile
} from "./index.js";
import { getDailyScheduleState } from "./schedule.js";

const PROFILE_JOURNAL_SCHEMA_VERSION = 1;
const EXECUTION_SCHEMA_VERSION = 1;
const DAILY_PACKAGE_SCHEMA_VERSION = 1;

const ResearchIntentSchema = z.enum(["article", "ideas", "script", "monitor"]);
const ValidatedDeliverableInputSchema = z.object({
  intent: ResearchIntentSchema,
  draft: z.string().min(1),
  selectedSourceUrls: z.array(z.string().url()).min(1),
  citedSourceUrls: z.array(z.string().url()).min(1)
}).strict();
const DailyResearchPackageSchema = z.object({
  schemaVersion: z.literal(DAILY_PACKAGE_SCHEMA_VERSION),
  profileId: z.string().min(1),
  profileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  resultSummary: z.string().min(1),
  corpus: z.object({
    rawItemCount: z.number().int().nonnegative(),
    uniqueItemCount: z.number().int().nonnegative(),
    returnedItemCount: z.number().int().nonnegative(),
    urlDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  }).strict(),
  hotspots: z.array(z.object({
    subject: z.string().min(1),
    sourceCount: z.number().int().positive(),
    reason: z.string().min(1)
  }).strict()),
  deliverables: z.array(ValidatedDeliverableInputSchema.extend({
    citedSourceCount: z.number().int().positive()
  }).strict()).min(1).max(4)
}).strict();

export type DailyResearchPackage = z.infer<typeof DailyResearchPackageSchema>;

export type PersistedResearchProfile = {
  readonly profile: ResearchProfile;
  readonly savedAt: string;
  readonly digest: string;
};

export type DailyExecutionRecord = {
  readonly profileId: string;
  readonly profileDigest: string;
  readonly businessDate: string;
  readonly scheduledLocalTime: string;
  readonly claimedAt: string;
  readonly claimId: string;
  readonly runId: string | null;
  readonly runStartedAt: string | null;
  readonly runtimeWorkspace: string | null;
};

export type ResearchApplicationStore = {
  saveProfile(profile: ResearchProfile, savedAt?: Date): Promise<PersistedResearchProfile>;
  getProfile(profileId: string): Promise<PersistedResearchProfile | null>;
  listProfiles(): Promise<readonly PersistedResearchProfile[]>;
  getDailyExecution(profileId: string, businessDate: string): Promise<DailyExecutionRecord | null>;
  getDailyPackage(profileId: string, businessDate: string): Promise<DailyResearchPackage | null>;
  claimDailyExecution(input: {
    readonly profile: PersistedResearchProfile;
    readonly businessDate: string;
    readonly scheduledLocalTime: string;
    readonly claimedAt: Date;
  }): Promise<{ readonly claimed: boolean; readonly record: DailyExecutionRecord }>;
  attachRun(input: {
    readonly claim: DailyExecutionRecord;
    readonly runId: string;
    readonly runStartedAt: Date;
    readonly runtimeWorkspace: string;
  }): Promise<DailyExecutionRecord>;
  saveDailyPackage(value: DailyResearchPackage): Promise<DailyResearchPackage>;
};

export type ResearchAgentFactory = (input: {
  readonly profile: ResearchProfile;
  readonly workspace: string;
}) => ResearchAgent;

export type ScheduledResearchRun = {
  readonly profileId: string;
  readonly businessDate: string;
  readonly runId: string;
  readonly runtimeWorkspace: string;
  readonly completion: Promise<RunInspection>;
};

export type SchedulerTickResult = {
  readonly checkedProfileCount: number;
  readonly dueProfileCount: number;
  readonly started: readonly ScheduledResearchRun[];
  readonly existing: readonly DailyExecutionRecord[];
  readonly issues: readonly {
    readonly profileId: string;
    readonly message: string;
  }[];
};

export type ResearchScheduler = {
  tick(now?: Date): Promise<SchedulerTickResult>;
  start(options?: {
    readonly intervalMs?: number;
    readonly onError?: (error: unknown) => void;
  }): { stop(): void };
};

export function createResearchApplicationStore(stateDirectory: string): ResearchApplicationStore {
  const root = resolve(stateDirectory);
  const profileJournal = join(root, "profiles.jsonl");

  return Object.freeze({
    async saveProfile(profile, savedAt = new Date()) {
      const parsed = parseResearchProfile(profile);
      const timestamp = validIsoDate(savedAt, "Profile savedAt");
      const persisted = toPersistedProfile(parsed, timestamp);
      await mkdir(root, { recursive: true });
      await appendFile(profileJournal, `${JSON.stringify({
        schemaVersion: PROFILE_JOURNAL_SCHEMA_VERSION,
        savedAt: persisted.savedAt,
        profile: persisted.profile
      })}\n`, { encoding: "utf8", flag: "a" });
      return persisted;
    },

    async getProfile(profileId) {
      const profiles = await readProfiles(profileJournal);
      return profiles.get(profileId) ?? null;
    },

    async listProfiles() {
      return [...(await readProfiles(profileJournal)).values()]
        .sort((left, right) => left.profile.id.localeCompare(right.profile.id));
    },

    async getDailyExecution(profileId, businessDate) {
      validateBusinessDate(businessDate);
      return await readDailyExecution(root, profileId, businessDate);
    },

    async getDailyPackage(profileId, businessDate) {
      validateBusinessDate(businessDate);
      return await readDailyPackage(root, profileId, businessDate);
    },

    async claimDailyExecution(input) {
      validateBusinessDate(input.businessDate);
      const claimedAt = validIsoDate(input.claimedAt, "Execution claimedAt");
      const claim: DailyExecutionRecord = {
        profileId: input.profile.profile.id,
        profileDigest: input.profile.digest,
        businessDate: input.businessDate,
        scheduledLocalTime: input.scheduledLocalTime,
        claimedAt,
        claimId: randomUUID(),
        runId: null,
        runStartedAt: null,
        runtimeWorkspace: null
      };
      const claimPath = dailyClaimPath(root, claim.profileId, claim.businessDate);
      await mkdir(dirname(claimPath), { recursive: true });
      try {
        await writeFile(claimPath, serializeExecutionClaim(claim), { encoding: "utf8", flag: "wx" });
        return { claimed: true, record: claim };
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const existing = await readDailyExecution(root, claim.profileId, claim.businessDate);
        if (existing === null) throw new Error("Daily execution claim exists but cannot be read.");
        return { claimed: false, record: existing };
      }
    },

    async attachRun(input) {
      if (input.claim.runId !== null) {
        if (input.claim.runId !== input.runId) throw new Error("Daily execution is already attached to another Run.");
        return input.claim;
      }
      const current = await readDailyExecution(root, input.claim.profileId, input.claim.businessDate);
      if (current === null || current.claimId !== input.claim.claimId) {
        throw new Error("Daily execution claim is missing or no longer owned by this scheduler.");
      }
      if (current.runId !== null) {
        if (current.runId !== input.runId) throw new Error("Daily execution is already attached to another Run.");
        return current;
      }
      const attached: DailyExecutionRecord = {
        ...current,
        runId: input.runId,
        runStartedAt: validIsoDate(input.runStartedAt, "Run startedAt"),
        runtimeWorkspace: resolve(input.runtimeWorkspace)
      };
      const runPath = dailyRunPath(root, attached.profileId, attached.businessDate);
      try {
        await writeFile(runPath, serializeExecutionRun(attached), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const existing = await readDailyExecution(root, attached.profileId, attached.businessDate);
        if (existing?.runId !== input.runId) throw new Error("Daily execution was concurrently attached to another Run.");
        return existing;
      }
      return attached;
    },

    async saveDailyPackage(value) {
      const researchPackage = DailyResearchPackageSchema.parse(value);
      const execution = await readDailyExecution(root, researchPackage.profileId, researchPackage.businessDate);
      if (execution?.runId !== researchPackage.runId) {
        throw new Error("Daily research package Run does not match the persisted execution mapping.");
      }
      const path = dailyPackagePath(root, researchPackage.profileId, researchPackage.businessDate);
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, `${JSON.stringify(researchPackage, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        return researchPackage;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const existing = await readDailyPackage(root, researchPackage.profileId, researchPackage.businessDate);
        if (existing?.runId !== researchPackage.runId) {
          throw new Error("Daily research package already belongs to another Run.");
        }
        return existing;
      }
    }
  });
}

export function createResearchScheduler(options: {
  readonly store: ResearchApplicationStore;
  readonly runWorkspaceDirectory: string;
  readonly createAgent: ResearchAgentFactory;
  readonly runOptions?: RunOptions;
  readonly now?: () => Date;
}): ResearchScheduler {
  const now = options.now ?? (() => new Date());
  const runWorkspaceDirectory = resolve(options.runWorkspaceDirectory);
  let tickInFlight: Promise<SchedulerTickResult> | null = null;

  const tick = async (tickNow: Date = now()): Promise<SchedulerTickResult> => {
    if (tickInFlight !== null) return await tickInFlight;
    tickInFlight = executeTick(tickNow);
    try {
      return await tickInFlight;
    } finally {
      tickInFlight = null;
    }
  };

  const executeTick = async (tickNow: Date): Promise<SchedulerTickResult> => {
    validIsoDate(tickNow, "Scheduler tick time");
    const profiles = await options.store.listProfiles();
    const started: ScheduledResearchRun[] = [];
    const existing: DailyExecutionRecord[] = [];
    const issues: { profileId: string; message: string }[] = [];
    let dueProfileCount = 0;

    for (const persisted of profiles) {
      const schedule = getDailyScheduleState(persisted.profile.schedule, tickNow);
      if (!schedule.due) continue;
      dueProfileCount += 1;
      try {
        const claimResult = await options.store.claimDailyExecution({
          profile: persisted,
          businessDate: schedule.businessDate,
          scheduledLocalTime: schedule.scheduledLocalTime,
          claimedAt: tickNow
        });
        if (!claimResult.claimed) {
          existing.push(claimResult.record);
          continue;
        }

        const runtimeWorkspace = join(
          runWorkspaceDirectory,
          profilePathSegment(persisted.profile.id),
          schedule.businessDate
        );
        await mkdir(runtimeWorkspace, { recursive: true });
        const agent = options.createAgent({ profile: persisted.profile, workspace: runtimeWorkspace });
        const run = agent.runDaily(tickNow, options.runOptions);
        try {
          await options.store.attachRun({
            claim: claimResult.record,
            runId: run.id,
            runStartedAt: tickNow,
            runtimeWorkspace
          });
        } catch (error) {
          await run.cancel("Scheduler could not persist the daily Run mapping.").catch(() => undefined);
          await agent.close();
          throw error;
        }

        const completion = (async () => {
          try {
            try {
              await run.result();
            } catch {
              // The persisted inspection is the scheduler's read-only outcome for blocked/failed Runs.
            }
            const inspection = await run.inspect();
            if (inspection.status === "succeeded") {
              const execution = await options.store.getDailyExecution(persisted.profile.id, schedule.businessDate);
              if (execution === null) throw new Error("Succeeded scheduled Run has no application execution mapping.");
              await options.store.saveDailyPackage(buildDailyResearchPackage({
                profile: persisted,
                execution,
                inspection,
                generatedAt: now()
              }));
            }
            return inspection;
          } finally {
            await agent.close();
          }
        })();
        started.push({
          profileId: persisted.profile.id,
          businessDate: schedule.businessDate,
          runId: run.id,
          runtimeWorkspace,
          completion
        });
      } catch (error) {
        issues.push({ profileId: persisted.profile.id, message: errorMessage(error) });
      }
    }

    return {
      checkedProfileCount: profiles.length,
      dueProfileCount,
      started,
      existing,
      issues
    };
  };

  return Object.freeze({
    tick,
    start(startOptions = {}) {
      const intervalMs = startOptions.intervalMs ?? 60_000;
      if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
        throw new Error("Research Scheduler intervalMs must be an integer of at least 1000.");
      }
      let stopped = false;
      const poll = () => {
        void tick().catch((error: unknown) => startOptions.onError?.(error));
      };
      poll();
      const timer = setInterval(poll, intervalMs);
      return Object.freeze({
        stop() {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
        }
      });
    }
  });
}

async function readProfiles(profileJournal: string): Promise<Map<string, PersistedResearchProfile>> {
  let content: string;
  try {
    content = await readFile(profileJournal, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return new Map();
    throw error;
  }
  const profiles = new Map<string, PersistedResearchProfile>();
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`Research Profile journal line ${index + 1} is invalid JSON.`);
    }
    if (!isRecord(record) || record.schemaVersion !== PROFILE_JOURNAL_SCHEMA_VERSION || typeof record.savedAt !== "string") {
      throw new Error(`Research Profile journal line ${index + 1} has an unsupported schema.`);
    }
    const profile = parseResearchProfile(record.profile);
    const savedAt = validIsoString(record.savedAt, `Research Profile journal line ${index + 1} savedAt`);
    profiles.set(profile.id, toPersistedProfile(profile, savedAt));
  }
  return profiles;
}

async function readDailyExecution(
  root: string,
  profileId: string,
  businessDate: string
): Promise<DailyExecutionRecord | null> {
  const claimPath = dailyClaimPath(root, profileId, businessDate);
  let claimValue: unknown;
  try {
    claimValue = JSON.parse(await readFile(claimPath, "utf8"));
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw new Error(`Daily execution claim is unreadable: ${errorMessage(error)}`);
  }
  const claim = parseExecutionClaim(claimValue);
  const runPath = dailyRunPath(root, profileId, businessDate);
  let runValue: unknown;
  try {
    runValue = JSON.parse(await readFile(runPath, "utf8"));
  } catch (error) {
    if (isFileNotFoundError(error)) return claim;
    throw new Error(`Daily execution Run record is unreadable: ${errorMessage(error)}`);
  }
  return parseExecutionRun(runValue, claim);
}

async function readDailyPackage(
  root: string,
  profileId: string,
  businessDate: string
): Promise<DailyResearchPackage | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(dailyPackagePath(root, profileId, businessDate), "utf8"));
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw new Error(`Daily research package is unreadable: ${errorMessage(error)}`);
  }
  const researchPackage = DailyResearchPackageSchema.parse(value);
  if (researchPackage.profileId !== profileId || researchPackage.businessDate !== businessDate) {
    throw new Error("Daily research package path does not match its identity.");
  }
  return researchPackage;
}

function buildDailyResearchPackage(input: {
  readonly profile: PersistedResearchProfile;
  readonly execution: DailyExecutionRecord;
  readonly inspection: RunInspection;
  readonly generatedAt: Date;
}): DailyResearchPackage {
  if (input.inspection.status !== "succeeded" || input.inspection.result?.status !== "succeeded") {
    throw new Error("Only a succeeded validated Run can produce a daily research package.");
  }
  if (input.execution.runId !== input.inspection.runId) {
    throw new Error("Daily research package inspection does not match the scheduled Run.");
  }
  const discovery = latestSucceededInvocation(input.inspection, "news.discover");
  const validation = latestSucceededInvocation(input.inspection, "news.validate_output");
  const discoveryOutput = z.object({
    corpus: DailyResearchPackageSchema.shape.corpus,
    hotspots: z.array(z.object({
      subject: z.string().min(1),
      sourceCount: z.number().int().positive(),
      reason: z.string().min(1)
    }).passthrough())
  }).passthrough().parse(discovery.resultJson);
  const validationInput = z.object({
    deliverables: z.array(ValidatedDeliverableInputSchema).min(1).max(4)
  }).strict().parse(validation.inputJson);
  const validationOutput = z.object({
    valid: z.literal(true),
    deliverables: z.array(z.object({
      intent: ResearchIntentSchema,
      citedSourceCount: z.number().int().positive(),
      draft: z.string().min(1)
    }).strict()).min(1).max(4)
  }).strict().parse(validation.resultJson);
  const requiredIntents = [...new Set(input.profile.profile.outputs)].sort();
  const receivedIntents = validationInput.deliverables.map((item) => item.intent).sort();
  if (JSON.stringify(requiredIntents) !== JSON.stringify(receivedIntents)) {
    throw new Error("Validated deliverables do not match the persisted Research Profile outputs.");
  }
  const outputByIntent = new Map(validationOutput.deliverables.map((item) => [item.intent, item]));
  const deliverables = validationInput.deliverables.map((deliverable) => {
    const output = outputByIntent.get(deliverable.intent);
    const selected = [...new Set(deliverable.selectedSourceUrls)].sort();
    const cited = [...new Set(deliverable.citedSourceUrls)].sort();
    if (
      output === undefined
      || output.draft !== deliverable.draft
      || output.citedSourceCount !== cited.length
      || JSON.stringify(selected) !== JSON.stringify(cited)
      || cited.some((url) => !deliverable.draft.includes(url))
    ) {
      throw new Error(`Validated ${deliverable.intent} output cannot be safely archived.`);
    }
    return {
      ...deliverable,
      citedSourceCount: output.citedSourceCount
    };
  });
  return DailyResearchPackageSchema.parse({
    schemaVersion: DAILY_PACKAGE_SCHEMA_VERSION,
    profileId: input.profile.profile.id,
    profileDigest: input.profile.digest,
    businessDate: input.execution.businessDate,
    runId: input.inspection.runId,
    generatedAt: validIsoDate(input.generatedAt, "Daily research package generatedAt"),
    resultSummary: input.inspection.result.summary,
    corpus: discoveryOutput.corpus,
    hotspots: discoveryOutput.hotspots.map((hotspot) => ({
      subject: hotspot.subject,
      sourceCount: hotspot.sourceCount,
      reason: hotspot.reason
    })),
    deliverables
  });
}

function latestSucceededInvocation(inspection: RunInspection, toolName: string) {
  for (let index = inspection.invocations.length - 1; index >= 0; index -= 1) {
    const invocation = inspection.invocations[index];
    if (invocation?.toolName === toolName && invocation.status === "succeeded") return invocation;
  }
  throw new Error(`Succeeded Run is missing a successful ${toolName} Invocation.`);
}

function parseExecutionClaim(value: unknown): DailyExecutionRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== EXECUTION_SCHEMA_VERSION
    || value.kind !== "daily-execution-claim"
    || typeof value.profileId !== "string"
    || typeof value.profileDigest !== "string"
    || typeof value.businessDate !== "string"
    || typeof value.scheduledLocalTime !== "string"
    || typeof value.claimedAt !== "string"
    || typeof value.claimId !== "string"
  ) {
    throw new Error("Daily execution claim has an unsupported schema.");
  }
  validateBusinessDate(value.businessDate);
  return {
    profileId: value.profileId,
    profileDigest: value.profileDigest,
    businessDate: value.businessDate,
    scheduledLocalTime: value.scheduledLocalTime,
    claimedAt: validIsoString(value.claimedAt, "Daily execution claimedAt"),
    claimId: value.claimId,
    runId: null,
    runStartedAt: null,
    runtimeWorkspace: null
  };
}

function parseExecutionRun(value: unknown, claim: DailyExecutionRecord): DailyExecutionRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== EXECUTION_SCHEMA_VERSION
    || value.kind !== "daily-execution-run"
    || value.claimId !== claim.claimId
    || typeof value.runId !== "string"
    || typeof value.runStartedAt !== "string"
    || typeof value.runtimeWorkspace !== "string"
  ) {
    throw new Error("Daily execution Run record has an unsupported schema or mismatched claim.");
  }
  return {
    ...claim,
    runId: value.runId,
    runStartedAt: validIsoString(value.runStartedAt, "Daily execution runStartedAt"),
    runtimeWorkspace: resolve(value.runtimeWorkspace)
  };
}

function serializeExecutionClaim(record: DailyExecutionRecord): string {
  return `${JSON.stringify({
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    kind: "daily-execution-claim",
    profileId: record.profileId,
    profileDigest: record.profileDigest,
    businessDate: record.businessDate,
    scheduledLocalTime: record.scheduledLocalTime,
    claimedAt: record.claimedAt,
    claimId: record.claimId
  }, null, 2)}\n`;
}

function serializeExecutionRun(record: DailyExecutionRecord): string {
  return `${JSON.stringify({
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    kind: "daily-execution-run",
    claimId: record.claimId,
    runId: record.runId,
    runStartedAt: record.runStartedAt,
    runtimeWorkspace: record.runtimeWorkspace
  }, null, 2)}\n`;
}

function dailyClaimPath(root: string, profileId: string, businessDate: string): string {
  return join(root, "executions", profilePathSegment(profileId), `${businessDate}.claim.json`);
}

function dailyRunPath(root: string, profileId: string, businessDate: string): string {
  return join(root, "executions", profilePathSegment(profileId), `${businessDate}.run.json`);
}

function dailyPackagePath(root: string, profileId: string, businessDate: string): string {
  return join(root, "packages", profilePathSegment(profileId), `${businessDate}.json`);
}

function profilePathSegment(profileId: string): string {
  return createHash("sha256").update(profileId).digest("hex");
}

function toPersistedProfile(profile: ResearchProfile, savedAt: string): PersistedResearchProfile {
  const snapshot = structuredClone(profile);
  return Object.freeze({
    profile: snapshot,
    savedAt,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`
  });
}

function validateBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Business date must use YYYY-MM-DD.");
}

function validIsoDate(value: Date, label: string): string {
  if (Number.isNaN(value.getTime())) throw new Error(`${label} must be a valid Date.`);
  return value.toISOString();
}

function validIsoString(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is Error & { readonly code?: string } {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
