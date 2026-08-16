import type { RunSnapshot } from "@nexora/runtime/internal";
import type { ModelDecisionContext } from "./providers/model-client.js";

export function automaticPublishedRefs(
  run: RunSnapshot,
  manifest: ReadonlyMap<string, string>,
  memoryCandidates: readonly ModelDecisionContext["memoryCandidates"][number][]
): string[] {
  const latestInput = run.inputHistory.at(-1)?.text ?? "";
  const explicit = [...manifest.keys()].filter((ref) => latestInput.includes(ref));
  const highestRankedMemory = memoryCandidates[0]?.ref;
  return [...new Set([
    ...(highestRankedMemory === undefined ? [] : [highestRankedMemory]),
    ...explicit
  ])];
}
