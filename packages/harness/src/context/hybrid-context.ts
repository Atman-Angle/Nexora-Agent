import { digestCanonicalJson } from "@nexora/runtime/internal";

import type { ModelDecisionContext } from "../providers/model-client.js";
import { projectAgentWorkingContext } from "../working-context.js";

export type HybridDecisionProjection = ReturnType<typeof projectHybridDecisionContext>;

// Keep the model-visible index bounded while leaving full Invocation/Evidence
// history in the Runtime authority for deterministic rehydration.
export const MAX_OLDER_OBSERVATION_REFS = 24;

function projectOlderObservationRefs(
  observations: readonly ModelDecisionContext["toolObservations"][number][],
  recentCount: number
) {
  const older = observations.slice(0, Math.max(0, observations.length - recentCount));
  const priority = (item: typeof older[number]) => {
    const retention = item.retention;
    const classRank: Record<string, number> = {
      unresolved_error: 6,
      safety_constraint: 5,
      active_check: 4,
      current_resource: 3,
      active_step: 2,
      predecessor_evidence: 1
    };
    return (retention.critical ? 100 : 0)
      + (classRank[retention.class] ?? 0);
  };
  return older
    .map((observation, index) => ({ observation, index }))
    .sort((left, right) => priority(right.observation) - priority(left.observation)
      || right.observation.retention.invocationSequence - left.observation.retention.invocationSequence
      || right.index - left.index)
    .slice(0, MAX_OLDER_OBSERVATION_REFS)
    .sort((left, right) => left.index - right.index)
    .map(({ observation }) => ({ digest: observation.digest, sourceRefs: observation.sourceRefs }));
}

export function projectHybridDecisionContext(context: ModelDecisionContext) {
  const progressByStep = new Map(context.run.stepProgress.map((item) => [item.stepId, item.status]));
  const tasks = (context.run.currentPlan?.orderedSteps ?? []).map((step) => ({
    objective: step.objective,
    status: progressByStep.get(step.id) ?? "pending" as const
  }));
  const working = projectAgentWorkingContext(context, tasks);
  const recentObservations = context.toolObservations.slice(-3);
  const latestObservation = recentObservations.at(-1) ?? null;
  const active = tasks.find((task) => task.status === "active")?.objective
    ?? tasks.find((task) => task.status !== "completed")?.objective
    ?? null;

  return Object.freeze({
    currentState: {
      goal: context.run.taskContract?.goal ?? context.run.inputHistory.at(-1)?.text ?? null,
      strategyProfile: context.strategyRouting?.strategyProfile ?? "general",
      taskShape: context.strategyRouting?.codingTaskShape ?? null,
      contractRevision: context.run.taskContract?.version ?? null,
      planRevision: context.run.currentPlan?.version ?? null,
      completed: tasks.filter((task) => task.status === "completed").map((task) => task.objective),
      active,
      unfinished: tasks.filter((task) => task.status !== "completed").map((task) => task.objective),
      invalidated: context.repair?.failedObjective == null ? [] : [context.repair.failedObjective],
      latestObservation: latestObservation === null ? null : {
        kind: latestObservation.status === "failed" ? "tool_failure" : "tool_result",
        toolName: latestObservation.toolName,
        status: latestObservation.status,
        digest: latestObservation.digest,
        sourceRefs: latestObservation.sourceRefs
      },
      currentBoundary: context.repair == null
        ? active === null ? "completion" : "execution"
        : "failure_repair"
    },
    recentTrajectory: recentObservations.map((observation) => ({
      actionIntent: { toolName: observation.toolName, input: observation.input ?? null },
      result: {
        status: observation.status,
        summary: observation.status === "failed"
          ? observation.error
          : observation.payloadFragment,
        payloadFragment: observation.payloadFragment,
        payloadMode: observation.payloadMode,
        digest: observation.digest,
        sourceRefs: observation.sourceRefs
      },
      activeOutcome: (context.run.currentPlan?.orderedSteps ?? [])
        .find((step) => step.id === observation.stepId)?.objective ?? null
    })),
    workingSet: {
      files: working.workingSet.currentFiles.map((file) => ({ path: file.path, source: file.source })),
      restoredFactRefs: working.workingSet.restoredFacts.map((fact) => ({
        ref: fact.ref,
        kind: fact.kind,
        digest: fact.digest
      })),
      unresolvedIssues: working.workingSet.unresolvedIssues,
      readableArtifactRefs: working.workingSet.readableArtifactRefs,
      workspaceChanged: working.workingSet.workspaceChanged
    },
    olderContext: {
      continuation: context.continuation ?? [],
      historyCandidates: context.historyCandidates,
      memoryCandidates: context.memoryCandidates,
      olderObservationRefs: projectOlderObservationRefs(context.toolObservations, recentObservations.length)
    }
  });
}

export function contextSection(value: unknown) {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  return Object.freeze({
    bytes,
    tokens: Math.ceil(bytes / 4),
    digest: digestCanonicalJson(value)
  });
}
