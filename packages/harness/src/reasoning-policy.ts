export function decisionHasSemanticPressure(input: string): boolean {
  try {
    const payload = JSON.parse(input) as {
      readonly currentRuntimeDirective?: { readonly kind?: unknown };
      readonly context?: {
        readonly recentOutcome?: unknown;
      };
    };
    if (
      typeof payload.currentRuntimeDirective?.kind === "string"
      && payload.currentRuntimeDirective.kind !== "normal"
      && payload.currentRuntimeDirective.kind !== "delivery_only"
    ) return true;
    return payload?.context?.recentOutcome !== null
      && payload?.context?.recentOutcome !== undefined;
  } catch {
    return false;
  }
}
