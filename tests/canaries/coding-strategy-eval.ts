export function scopeExpansionRate(requiredOutcomeCount: number, optionalOutcomeCount: number): number {
  const total = requiredOutcomeCount + optionalOutcomeCount;
  return total === 0 ? 0 : optionalOutcomeCount / total;
}

export function usefulVerificationCount(invocations: readonly {
  readonly status: string;
  readonly payloadDigest: string | null;
  readonly toolName: string;
  readonly inputDigest: string;
}[]): number {
  const seen = new Set<string>();
  let useful = 0;
  for (const invocation of invocations) {
    if (invocation.status !== "succeeded") continue;
    const evidenceKey = invocation.payloadDigest ?? `${invocation.toolName}:${invocation.inputDigest}`;
    if (seen.has(evidenceKey)) continue;
    seen.add(evidenceKey);
    useful += 1;
  }
  return useful;
}
