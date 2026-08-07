import {
  runtimeActionContract,
  type ForkContext,
  type RunSnapshot,
  type ToolInvocation
} from "../contracts.js";
import {
  allowedActions,
  deepFreeze,
  digestJson
} from "../runtime-helpers.js";
import type {
  ModelAction,
  ModelDecisionContext,
  RehydratedFact
} from "../providers/model-client.js";
import type { RuntimeTool } from "../runtime-types.js";
import { ArtifactStore } from "../store/artifacts.js";
import type { RunStore } from "../store/run-store.js";
import {
  isCheckpointValid,
  type CompactionAuthority,
  type PersistedCheckpoint
} from "./compaction.js";
import type {
  ContextCheckpoint
} from "../providers/model-client.js";
import {
  projectRelevantToolObservations,
  projectRunContext
} from "./projection.js";
import {
  admitRehydratedFacts,
  autoRehydrateForActiveStep,
  buildAvailableContextRefs,
  resolveRehydratedFact
} from "./rehydration.js";

export type DecisionContextResult = {
  readonly context: ModelDecisionContext;
  /** sourceRefs that were successfully restored into rehydratedFacts this turn. */
  readonly injectedRehydratedRefs: readonly string[];
};

/**
 * Builds the full ModelDecisionContext the Provider sees for one decision
 * call, including any rehydrated facts admitted this turn. Pure function of
 * (run, invocations, checkpoint, tools, workspace, rehydrateRequests).
 *
 * Rehydration integrates here: the Harness passes this turn's model-requested
 * refs (already validated against the previous turn's manifest) and the
 * Harness auto-candidates are derived from the active step. Facts are admitted
 * under a dedicated budget in priority order: harness_required >
 * model_request > harness_helpful. When forkContext is present, the child's
 * readable universe also includes the Fork Base inherited facts (read-only).
 */
export function buildDecisionContext(args: {
  readonly run: RunSnapshot;
  readonly store: RunStore;
  readonly workspace: string;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly artifactDir: string;
  readonly rehydrateRequests?: readonly string[];
  readonly forkContext?: ForkContext | null;
}): DecisionContextResult {
  const { run, store, workspace, tools, artifactDir } = args;
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

  const inherited = args.forkContext === undefined || args.forkContext === null
    ? undefined
    : (() => {
        const parentRun = store.getRun(args.forkContext!.parentRunId);
        return parentRun === null
          ? undefined
          : { parentRun, refs: args.forkContext!.forkBase.inheritedRefs };
      })();

  const manifest = buildAvailableContextRefs({
    run,
    observations,
    checkpoint,
    store,
    artifactDir,
    ...(inherited === undefined ? {} : { inheritedRefs: inherited.refs })
  });
  const hasAvailableRefs = manifest.size > 0 && run.currentPlan !== null;
  const actions = allowedActions(run, hasAvailableRefs);

  const autoCandidates = autoRehydrateForActiveStep({ run, observations, invocations });
  const modelRequests = args.rehydrateRequests ?? [];
  const candidates: RehydratedFact[] = [];
  for (const ref of autoCandidates.required) {
    candidates.push(resolveRehydratedFact({
      ref,
      run,
      store,
      artifactDir,
      manifest,
      origin: "harness_required",
      ...(inherited === undefined ? {} : { inherited })
    }));
  }
  for (const ref of modelRequests) {
    if (!candidates.some((candidate) => candidate.ref === ref)) {
      candidates.push(resolveRehydratedFact({
        ref,
        run,
        store,
        artifactDir,
        manifest,
        origin: "model_request",
        ...(inherited === undefined ? {} : { inherited })
      }));
    }
  }
  for (const ref of autoCandidates.helpful) {
    if (!candidates.some((candidate) => candidate.ref === ref)) {
      candidates.push(resolveRehydratedFact({
        ref,
        run,
        store,
        artifactDir,
        manifest,
        origin: "harness_helpful",
        ...(inherited === undefined ? {} : { inherited })
      }));
    }
  }
  const { accepted } = admitRehydratedFacts(candidates);
  const seenFacts = new Set<string>();
  const rehydratedFacts = accepted.filter((fact) => {
    if (seenFacts.has(fact.ref)) return false;
    seenFacts.add(fact.ref);
    return true;
  });
  const injectedRehydratedRefs = rehydratedFacts
    .filter((fact) => fact.error === null)
    .map((fact) => fact.ref);

  const includeTaskContract = run.currentPlan === null || run.taskContract === null
    || run.taskContract.inputVersion < run.inputHistory.length;
  const allStepsCompleted = run.currentPlan !== null
    && run.stepProgress.length === run.currentPlan.orderedSteps.length
    && run.stepProgress.every((item) => item.status === "completed");
  const baseContract = runtimeActionContract(
    actions.filter((item): item is "set_plan" | "call_tool" | "request_input" | "propose_finish" => item !== "request_context"),
    {
      workspace,
      inputVersion: run.inputHistory.length,
      basedOnVersion: run.currentPlan?.version ?? null,
      includeTaskContract,
      currentPlan: run.currentPlan,
      finishEvidenceIds: allStepsCompleted ? run.evidence.map((item) => item.id) : []
    }
  );
  const actionContract: readonly ModelAction[] = hasAvailableRefs
    ? [
        ...baseContract,
        Object.freeze({ type: "request_context" as const, refs: ["<source-ref>"] })
      ]
    : baseContract;

  const activeStepId = run.stepProgress.find((item) => item.status === "active")?.stepId;
  const activeStep = run.currentPlan?.orderedSteps.find((step) => step.id === activeStepId);
  const callableTools = new Set(activeStep?.acceptanceChecks
    .filter((check) => check.kind === "tool_result")
    .map((check) => check.toolName) ?? []);
  const projection = deepFreeze(structuredClone({
    workspace,
    run: projectRunContext(run),
    allowedActions: actions,
    actionContract,
    toolObservations: checkpoint === null
      ? observations
      : observations.filter((item) => !covered.has(item.invocationId)),
    contextCheckpoint: checkpointView,
    rehydratedFacts,
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
  const context = deepFreeze({
    workspace: projection.workspace,
    run: projection.run,
    projection: {
      schemaVersion: 1 as const,
      digest: digestJson(projection)
    },
    allowedActions: projection.allowedActions,
    actionContract: projection.actionContract,
    toolObservations: projection.toolObservations,
    contextCheckpoint: projection.contextCheckpoint,
    rehydratedFacts: projection.rehydratedFacts,
    tools: projection.tools
  });
  return { context, injectedRehydratedRefs };
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