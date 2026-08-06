import {
  runtimeActionContract,
  type RunSnapshot,
  type ToolInvocation
} from "../contracts.js";
import {
  allowedActions,
  deepFreeze,
  digestJson
} from "../runtime-helpers.js";
import type { RuntimeTool } from "../runtime-types.js";
import { ArtifactStore } from "../store/artifacts.js";
import type { RunStore } from "../store/run-store.js";
import {
  isCheckpointValid,
  type CompactionAuthority,
  type PersistedCheckpoint
} from "./compaction.js";
import type {
  ContextCheckpoint,
  ModelDecisionContext
} from "../providers/model-client.js";
import {
  projectRelevantToolObservations,
  projectRunContext
} from "./projection.js";

/**
 * Builds the full ModelDecisionContext the Provider sees for one decision
 * call. Pure function of (run, invocations, checkpoint, tools, workspace).
 */
export function buildDecisionContext(args: {
  readonly run: RunSnapshot;
  readonly store: RunStore;
  readonly workspace: string;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly artifactDir: string;
}): ModelDecisionContext {
  const { run, store, workspace, tools, artifactDir } = args;
  const actions = allowedActions(run);
  const includeTaskContract = run.currentPlan === null || run.taskContract === null
    || run.taskContract.inputVersion < run.inputHistory.length;
  const allStepsCompleted = run.currentPlan !== null
    && run.stepProgress.length === run.currentPlan.orderedSteps.length
    && run.stepProgress.every((item) => item.status === "completed");
  const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
  const activeStep = run.currentPlan?.orderedSteps.find((step) => step.id === activeStepId);
  const callableTools = new Set(activeStep?.acceptanceChecks
    .filter((check) => check.kind === "tool_result")
    .map((check) => check.toolName) ?? []);
  const invocations = store.listToolInvocations(run.runId);
  const observations = projectRelevantToolObservations(run, invocations);
  const checkpoint = findActiveCheckpoint({
    run,
    invocations,
    store,
    artifactDir
  });
  const covered = checkpoint === null
    ? new Set<string>()
    : new Set(checkpoint.coveredInvocations);
  const checkpointView: ContextCheckpoint | null = checkpoint === null
    ? null
    : {
      checkpointId: checkpoint.checkpointId,
      digest: checkpoint.digest,
      summary: checkpoint.summary
    };
  const projection = deepFreeze(structuredClone({
    workspace,
    run: projectRunContext(run),
    allowedActions: actions,
    actionContract: runtimeActionContract(actions, {
      workspace,
      inputVersion: run.inputHistory.length,
      basedOnVersion: run.currentPlan?.version ?? null,
      includeTaskContract,
      currentPlan: run.currentPlan,
      finishEvidenceIds: allStepsCompleted ? run.evidence.map((item) => item.id) : []
    }),
    toolObservations: checkpoint === null
      ? observations
      : observations.filter((item) => !covered.has(item.invocationId)),
    contextCheckpoint: checkpointView,
    tools: [...tools.values()].map((tool) => ({
      identity: tool.contract.identity,
      capability: tool.contract.capability,
      decision: tool.contract.decision,
      execution: {
        effect: tool.contract.execution.effect,
        ...(actions.includes("call_tool") && callableTools.has(tool.contract.identity.name)
          ? { inputExample: tool.contract.execution.inputExample }
          : {})
      },
      evidence: { produces: tool.contract.evidence.produces }
    }))
  }));
  return deepFreeze({
    workspace: projection.workspace,
    run: projection.run,
    projection: {
      schemaVersion: 1,
      digest: digestJson(projection)
    },
    allowedActions: projection.allowedActions,
    actionContract: projection.actionContract,
    toolObservations: projection.toolObservations,
    contextCheckpoint: projection.contextCheckpoint,
    tools: projection.tools
  });
}

/**
 * Returns the latest valid checkpoint for this run, or null when no plan
 * exists, no checkpoint has been persisted, or the checkpoint is stale
 * (plan version drifted or a sourceDigest no longer matches authority).
 */
export function findActiveCheckpoint(args: {
  readonly run: RunSnapshot;
  readonly invocations: readonly ToolInvocation[];
  readonly store: RunStore;
  readonly artifactDir: string;
}): PersistedCheckpoint | null {
  const { run, invocations, store, artifactDir } = args;
  if (run.currentPlan === null) return null;
  const checkpoint = store.getLatestCheckpoint(run.runId);
  if (checkpoint === null) return null;
  if (!isCheckpointValid(
    checkpoint,
    run,
    invocations,
    store.listEvents(run.runId),
    (digest) => new ArtifactStore(artifactDir).has(digest)
  )) {
    return null;
  }
  return checkpoint;
}

/**
 * Assembles the authority bundle the compaction validator needs to
 * verify sourceRefs against.
 */
export function buildCompactionAuthority(args: {
  readonly run: RunSnapshot;
  readonly store: RunStore;
  readonly artifactDir: string;
}): CompactionAuthority {
  const { run, store, artifactDir } = args;
  const invocations = store.listToolInvocations(run.runId);
  return {
    run,
    invocations,
    events: store.listEvents(run.runId),
    evidence: new Map(run.evidence.map((item) => [item.id, item])),
    artifactExists: (digest) => new ArtifactStore(artifactDir).has(digest)
  };
}
