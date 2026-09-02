export function decisionHasSemanticPressure(input: string): boolean {
  try {
    const payload = JSON.parse(input) as {
      readonly currentRuntimeDirective?: { readonly kind?: unknown };
      readonly codingStrategy?: { readonly adaptiveReasoning?: unknown };
      readonly context?: {
        readonly recentOutcome?: unknown;
      };
    };
    const directive = payload.currentRuntimeDirective?.kind;
    if (directive === "invalid_response_repair") return false;
    if (typeof directive === "string" && directive !== "normal" && directive !== "delivery_only") return true;
    if (payload.codingStrategy?.adaptiveReasoning === "elevated"
      || payload.codingStrategy?.adaptiveReasoning === "moderate") return true;
    if (payload.codingStrategy?.adaptiveReasoning === "low") return false;
    return payload?.context?.recentOutcome !== null
      && payload?.context?.recentOutcome !== undefined;
  } catch {
    return false;
  }
}
