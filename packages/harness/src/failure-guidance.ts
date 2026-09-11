export function providerBoundaryGuidance(input: {
  readonly outcome: "blocked" | "failed";
  readonly errorCode: "PROVIDER_UNAVAILABLE" | "CONTEXT_CAPACITY_EXCEEDED" | "STRATEGY_SNAPSHOT_UNAVAILABLE";
  readonly message: string;
  readonly remainingRecoverySegments: number;
}): { readonly summary: string; readonly nextAction: string } {
  if (input.errorCode === "STRATEGY_SNAPSHOT_UNAVAILABLE") {
    return {
      summary: `This Run cannot continue because its previous Model Call was created with a different Host, Profile, Project, Tool or Transport snapshot. Persisted facts are safe, but the snapshot change prevents in-place resume. ${input.message}`,
      nextAction: "Start a new continuation Run from the persisted facts so the current Nexora build and Tool catalog can be used."
    };
  }
  if (input.errorCode === "CONTEXT_CAPACITY_EXCEEDED") {
    return {
      summary: `The Run stopped because the model context could not fit the current execution state. ${input.message}`,
      nextAction: "Reduce the active context or select a model with a larger context window, then resume the Run."
    };
  }
  if (input.outcome === "failed") {
    return {
      summary: `The Run stopped because the model provider remained unavailable after recovery was exhausted. ${input.message}`,
      nextAction: "Restore Provider connectivity, then start a new continuation Run from the persisted facts."
    };
  }
  return {
    summary: `The Run paused because the model provider is temporarily unavailable. ${input.message}`,
    nextAction: input.remainingRecoverySegments > 0
      ? "Restore Provider connectivity, then resume this Run."
      : "Restore Provider connectivity, then start a new continuation Run from the persisted facts."
  };
}

export function noProgressGuidance(input: {
  readonly kind: string;
  readonly repeatCount: number;
  readonly message: string;
}): { readonly summary: string; readonly nextAction: string } {
  return {
    summary: `The Run stopped because no new progress was observed (${input.kind}, repeated ${input.repeatCount} time(s)). ${input.message}`,
    nextAction: "Provide a different instruction or start a continuation Run with a changed approach."
  };
}
