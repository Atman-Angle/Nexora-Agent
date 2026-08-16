import type {
  AgentWorkingContext,
  JsonValue,
  ModelDecisionContext
} from "./providers/model-client.js";

export function projectAgentWorkingContext(
  context: ModelDecisionContext,
  tasks: NonNullable<AgentWorkingContext["plan"]>["tasks"]
): AgentWorkingContext {
  const observations = context.toolObservations.map((observation) => ({
    toolName: observation.toolName,
    input: (observation.input ?? null) as JsonValue,
    status: observation.status,
    facts: observation.facts as JsonValue | null,
    error: observation.error as JsonValue | null,
    payloadFragment: observation.payloadFragment,
    payloadMode: observation.payloadMode,
    repeatCount: observation.repeatCount ?? 1,
    artifactRefs: observation.sourceRefs.filter((ref) => ref.startsWith("artifact:"))
  }));
  const restoredFacts = context.rehydratedFacts.map((fact) => ({
    ref: fact.ref,
    kind: fact.kind,
    origin: fact.origin,
    digest: fact.digest,
    content: fact.content,
    error: fact.error,
    ...(fact.trust === undefined ? {} : { trust: fact.trust })
  }));
  const failed = observations.filter((observation) => observation.status === "failed");
  const succeeded = observations.filter((observation) => observation.status === "succeeded");
  const workspaceChanged = succeeded.some((observation) => {
    const capability = context.tools.find((tool) => tool.identity.name === observation.toolName);
    return capability?.execution.effect.kind !== "read";
  });
  const repair = context.repair ?? null;
  return {
    task: {
      inputs: context.run.inputHistory.map((entry) => entry.text)
    },
    plan: context.run.currentPlan === null ? null : { tasks },
    workingSet: {
      observations,
      restoredFacts,
      currentFiles: projectCurrentFiles(observations),
      completedWork: tasks.filter((task) => task.status === "completed").map((task) => task.objective),
      unresolvedIssues: repair?.issues.map((issue) => issue.message)
        ?? failed.map((observation) => `${observation.toolName} failed.`),
      workspaceChanged,
      readableArtifactRefs: [...new Set(observations.flatMap((observation) => observation.artifactRefs))]
    },
    recentOutcome: repair === null ? null : {
      intent: repair.latestIntent ?? null,
      status: repair.kind === "invalid_response"
        ? "rejected"
        : repair.kind === "approval_denied"
          ? "denied"
          : repair.kind === "runtime_error"
            ? "blocked"
            : "failed",
      error: { code: repair.code, issues: repair.issues },
      workspaceChanged,
      noNewFacts: !workspaceChanged && observations.every((observation) => observation.repeatCount > 1)
    },
    relevantMemory: restoredFacts.filter((fact) => fact.kind === "memory"),
    capabilities: context.tools.map((tool) => ({
      name: tool.identity.name,
      purpose: tool.capability.purpose,
      nonGoals: tool.capability.nonGoals,
      useWhen: tool.decision.useWhen,
      avoidWhen: tool.decision.avoidWhen,
      effect: tool.execution.effect,
      inputSchema: tool.execution.inputSchema,
      ...(tool.execution.inputExample === undefined ? {} : { inputExample: tool.execution.inputExample }),
      produces: tool.evidence.produces
    }))
  };
}

function projectCurrentFiles(
  observations: AgentWorkingContext["workingSet"]["observations"]
): AgentWorkingContext["workingSet"]["currentFiles"] {
  const files = new Map<string, { content: string; source: "read" | "write" | "patch" }>();
  for (const observation of observations) {
    if (observation.status !== "succeeded") continue;
    const input = asRecord(observation.input);
    const facts = asRecord(observation.facts);
    const path = typeof facts?.path === "string"
      ? facts.path
      : typeof input?.path === "string"
        ? input.path
        : null;
    if (path === null) continue;
    if (observation.toolName === "filesystem.read" && typeof facts?.content === "string") {
      files.set(path, { content: facts.content, source: "read" });
      continue;
    }
    if (observation.toolName === "filesystem.write" && typeof input?.content === "string") {
      files.set(path, { content: input.content, source: "write" });
      continue;
    }
    if (
      observation.toolName === "filesystem.patch"
      && typeof input?.find === "string"
      && typeof input.replace === "string"
    ) {
      const previous = files.get(path);
      if (previous === undefined) continue;
      const first = previous.content.indexOf(input.find);
      if (first < 0 || previous.content.indexOf(input.find, first + input.find.length) >= 0) continue;
      files.set(path, {
        content: `${previous.content.slice(0, first)}${input.replace}${previous.content.slice(first + input.find.length)}`,
        source: "patch"
      });
    }
  }
  return [...files.entries()].map(([path, file]) => ({ path, ...file }));
}

function asRecord(value: JsonValue | null): Readonly<Record<string, JsonValue>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : null;
}
