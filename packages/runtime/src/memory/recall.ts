import type { RunSnapshot } from "../contracts.js";
import { digestCanonicalJson, stringCompare } from "../runtime-helpers.js";
import type { MemoryCandidate } from "../providers/model-client.js";
import type { MemoryRecord } from "./contracts.js";

export const MAX_MEMORY_CANDIDATES = 6;
export const MAX_MEMORY_CANDIDATE_BYTES = 4 * 1024;
export const MAX_MEMORY_CANDIDATE_ESTIMATED_TOKENS = 768;

type RankedCandidate = {
  readonly candidate: MemoryCandidate;
  readonly score: number;
};

/** Deterministic, rebuildable Memory navigation. It never returns statements. */
export function projectMemoryCandidates(args: {
  readonly run: RunSnapshot;
  readonly records: readonly MemoryRecord[];
  readonly asOf: string;
}): MemoryCandidate[] {
  const query = taskText(args.run);
  const querySignals = signals(query);
  if (querySignals.size === 0) return [];

  const ranked: RankedCandidate[] = [];
  for (const record of args.records) {
    if (
      record.status !== "active"
      || record.sensitivity !== "normal"
      || (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.parse(args.asOf))
    ) continue;

    const statement = normalize(record.statement);
    const statementSignals = signals(`${record.memoryType} ${statement}`);
    const overlap = [...querySignals].filter((signal) => statementSignals.has(signal));
    const reasons: MemoryCandidate["reasons"][number][] = [];
    let score = 0;
    if (query.length >= 4 && statement.length >= 4
      && (statement.includes(query) || query.includes(statement))) {
      reasons.push("exact_phrase");
      score += 100;
    }
    if (overlap.length > 0) {
      reasons.push("term_overlap");
      score += Math.min(overlap.length, 8) * 10;
    }
    const normalizedType = normalize(record.memoryType.replace(/[_-]+/g, " "));
    if (normalizedType.length >= 3 && query.includes(normalizedType)) {
      reasons.push("memory_type");
      score += 20;
    }
    if (score === 0) continue;
    if (record.verification.state === "verified") {
      reasons.push("verified");
      score += 1;
    }
    ranked.push({
      score,
      candidate: {
        ref: memoryRef(record.memoryId),
        memoryType: record.memoryType,
        reasons,
        hint: `Relevant ${record.memoryType} Memory matched current task signals.`,
        source: record.source,
        verification: record.verification.verifiedAt === undefined
          ? { state: record.verification.state, evidenceRefs: record.verification.evidenceRefs }
          : {
              state: record.verification.state,
              verifiedAt: record.verification.verifiedAt,
              evidenceRefs: record.verification.evidenceRefs
            },
        lifecycle: { status: "active", updatedAt: record.updatedAt },
        sensitivity: "normal",
        trust: "untrusted_memory_data",
        digest: digestCanonicalJson(record)
      }
    });
  }

  ranked.sort((left, right) => (
    right.score - left.score
    || right.candidate.lifecycle.updatedAt.localeCompare(left.candidate.lifecycle.updatedAt)
    || stringCompare(left.candidate.ref, right.candidate.ref)
  ));
  const selected: MemoryCandidate[] = [];
  for (const item of ranked) {
    if (selected.length >= MAX_MEMORY_CANDIDATES) break;
    const next = [...selected, item.candidate];
    const bytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    if (bytes > MAX_MEMORY_CANDIDATE_BYTES || Math.ceil(bytes / 4) > MAX_MEMORY_CANDIDATE_ESTIMATED_TOKENS) {
      continue;
    }
    selected.push(item.candidate);
  }
  return selected;
}

export function memoryRef(memoryId: string): `memory:${string}` {
  return `memory:${encodeURIComponent(memoryId)}`;
}

export function memoryIdFromRef(ref: string): string | null {
  if (!ref.startsWith("memory:")) return null;
  try {
    const decoded = decodeURIComponent(ref.slice("memory:".length));
    return decoded.length > 0 && memoryRef(decoded) === ref ? decoded : null;
  } catch {
    return null;
  }
}

function taskText(run: RunSnapshot): string {
  const latestInput = run.inputHistory.at(-1)?.text ?? "";
  const contract = run.taskContract;
  const plan = run.currentPlan;
  return normalize([
    latestInput,
    contract?.goal ?? "",
    ...(contract?.constraints ?? []),
    ...(contract?.acceptanceCriteria ?? []),
    ...(plan?.orderedSteps.map((step) => step.objective) ?? [])
  ].join(" "));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function signals(value: string): Set<string> {
  const normalized = normalize(value);
  const result = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._/-]{1,}/gu)) {
    if (!ASCII_STOP_WORDS.has(match[0])) result.add(match[0]);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const text = match[0];
    if (text.length === 1) result.add(text);
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2);
      if (!CJK_STOP_GRAMS.has(gram)) result.add(gram);
    }
  }
  return result;
}

const ASCII_STOP_WORDS = new Set([
  "and", "are", "for", "from", "into", "that", "the", "this", "with",
  "have", "has", "use", "using", "task", "memory", "context", "current",
  "must", "should"
]);

const CJK_STOP_GRAMS = new Set(["当前", "任务", "使用", "需要", "进行", "完成", "必须"]);
