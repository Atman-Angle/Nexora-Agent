import type { ContextBundle, ContextBundleItem, BuilderPlanStep, WorkingSet } from "../../../contracts/src/index.js";
import { ContextBundleSchema } from "../../../contracts/src/index.js";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function lookup(existence: Map<string, boolean>, path: string): boolean | undefined {
  const normalized = normalizePath(path);
  return existence.get(normalized) ?? existence.get(path);
}

function lookupHash(hashes: Map<string, string | null>, path: string): string | null | undefined {
  const normalized = normalizePath(path);
  return hashes.get(normalized) ?? hashes.get(path);
}

export function assembleContextBundle(input: {
  step: BuilderPlanStep;
  workingSet: WorkingSet | null;
  existence: Map<string, boolean>;
  hashes: Map<string, string | null>;
  repoFacts?: string[];
  notes?: string[];
}): ContextBundle {
  const step = input.step;
  const items: ContextBundleItem[] = [];

  for (const target of step.targetFiles) {
    const normalized = normalizePath(target);
    const exists = lookup(input.existence, normalized);
    const existenceValue =
      exists === undefined ? "unknown" : exists ? "exists" : "missing";
    const currentHash = lookupHash(input.hashes, normalized) ?? null;
    const role = step.operation === "create" ? "create_target" : "modify_target";
    items.push({
      path: normalized,
      score: 100,
      snippets: [],
      reasons: [`${role} for step ${step.stepId} (${step.operation})`],
      existence: existenceValue,
      currentHash,
      role
    });
  }

  const seen = new Set(step.targetFiles.map(normalizePath));
  const referenceItems =
    input.workingSet?.items.slice(0, 12).map((item) => {
      const normalized = normalizePath(item.path);
      const exists = lookup(input.existence, normalized);
      const existenceValue =
        exists === undefined ? "unknown" : exists ? "exists" : "missing";
      return {
        path: normalized,
        score: item.score,
        snippets: [...item.snippets],
        reasons: [...item.reasons],
        existence: existenceValue,
        currentHash: lookupHash(input.hashes, normalized) ?? null,
        ...(seen.has(normalized) ? {} : { role: "reference" as const })
      } satisfies ContextBundleItem;
    }) ?? [];

  for (const reference of referenceItems) {
    const existing = items.find((item) => item.path === reference.path);
    if (existing !== undefined) {
      existing.snippets = [...new Set([...existing.snippets, ...reference.snippets])];
      existing.reasons = [...new Set([...existing.reasons, ...reference.reasons])];
      continue;
    }
    items.push(reference);
    seen.add(reference.path);
  }

  const requiresHashRead = items.some(
    (item) => item.role === "modify_target" && item.currentHash === null && item.existence === "exists"
  );

  return ContextBundleSchema.parse({
    stepId: step.stepId,
    items,
    repoFacts: input.repoFacts ?? [],
    requiresHashRead,
    notes: input.notes ?? []
  });
}
