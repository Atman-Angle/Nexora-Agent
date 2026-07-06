import type {
  AgentAction,
  BuilderPromptContext,
  BuilderState,
  Event,
  StrategyState,
  WorkingSet
} from "../../../contracts/src/index.js";
import { rehydrateWorkspaceFacts } from "../../../context/src/index.js";
import { assembleContextBundle } from "./context-bundle.js";
import { evaluateActToolCall, isMutationToolCall } from "./mutation-intent-validator.js";
import { buildBuilderPromptContext } from "./prompt-context.js";
import { markStepCompleted, setCurrentStep, setMutationIntent } from "./builder-state.js";
import { selectCurrentPlanStep } from "./step-selector.js";

export type BuilderEventDraft = {
  type: Event["type"];
  payload: Record<string, unknown>;
};

export type BuilderActionEvaluation = {
  state: BuilderState;
  rejection:
    | {
        code: string;
        message: string;
        reason: string;
      }
    | null;
  events: BuilderEventDraft[];
};

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function buildBuilderWorkspaceFacts(input: {
  workspaceRoot: string;
  paths: readonly string[];
  now: string;
}): { existence: Map<string, boolean>; hashes: Map<string, string | null> } {
  const filePaths = [...new Set(input.paths.map(normalizeWorkspacePath).filter((path) => path.length > 0))];
  const facts = rehydrateWorkspaceFacts({ workspaceRoot: input.workspaceRoot, filePaths, now: input.now });
  const existence = new Map<string, boolean>();
  const hashes = new Map<string, string | null>();
  for (const entry of facts.fileHashes) {
    const normalized = normalizeWorkspacePath(entry.path);
    existence.set(normalized, entry.hash !== null);
    hashes.set(normalized, entry.hash);
  }
  return { existence, hashes };
}

export function prepareBuilderTurn(input: {
  strategyState: StrategyState;
  builderState: BuilderState;
  workingSet: WorkingSet | null;
  workspaceRoot: string;
  now: string;
}): { state: BuilderState; context: BuilderPromptContext; events: BuilderEventDraft[] } | null {
  if (input.strategyState.phase !== "act") {
    return null;
  }
  if (input.builderState.planSteps.length === 0) {
    return null;
  }
  const selectedStep = selectCurrentPlanStep(input.builderState.planSteps);
  if (selectedStep === null) {
    return null;
  }

  let state = input.builderState;
  const events: BuilderEventDraft[] = [];
  if (state.currentStepId !== selectedStep.stepId) {
    state = setCurrentStep({ state, stepId: selectedStep.stepId, now: input.now });
    events.push({
      type: "builder.step.selected",
      payload: { stepId: selectedStep.stepId, operation: selectedStep.operation, targetFiles: selectedStep.targetFiles }
    });
  }

  const facts = buildBuilderWorkspaceFacts({
    workspaceRoot: input.workspaceRoot,
    paths: selectedStep.targetFiles,
    now: input.now
  });
  const bundle = assembleContextBundle({
    step: selectedStep,
    workingSet: input.workingSet,
    existence: facts.existence,
    hashes: facts.hashes
  });
  events.push({
    type: "builder.context.assembled",
    payload: { stepId: selectedStep.stepId, itemCount: bundle.items.length, requiresHashRead: bundle.requiresHashRead }
  });

  return {
    state,
    context: buildBuilderPromptContext({
      step: selectedStep,
      contextBundle: bundle,
      redirect: state.redirect
    }),
    events
  };
}

export function evaluateBuilderAction(input: {
  strategyBypassedForRecovery: boolean;
  strategyState: StrategyState;
  builderState: BuilderState;
  action: AgentAction;
  workspaceRoot: string;
  now: string;
}): BuilderActionEvaluation {
  if (
    input.strategyBypassedForRecovery ||
    input.strategyState.phase !== "act" ||
    input.builderState.currentStepId === null ||
    (input.action.type !== "tool_call" && input.action.type !== "request_approval")
  ) {
    return { state: input.builderState, rejection: null, events: [] };
  }

  const step = input.builderState.planSteps.find((candidate) => candidate.stepId === input.builderState.currentStepId) ?? null;
  if (step === null) {
    return { state: input.builderState, rejection: null, events: [] };
  }

  const facts = buildBuilderWorkspaceFacts({
    workspaceRoot: input.workspaceRoot,
    paths: step.targetFiles,
    now: input.now
  });
  const requiresHashRead =
    step.operation === "modify" &&
    step.targetFiles.some((target) => {
      const normalized = normalizeWorkspacePath(target);
      const hash = facts.hashes.get(normalized) ?? facts.hashes.get(target);
      return hash === null || hash === undefined;
    });
  const verdict = evaluateActToolCall({
    toolCall: input.action.toolCall,
    step,
    existence: facts.existence,
    requiresHashRead
  });

  if (verdict.kind === "permitted_read") {
    return { state: input.builderState, rejection: null, events: [] };
  }

  if (verdict.kind === "accepted") {
    const state = setMutationIntent({
      state: input.builderState,
      mutationIntent: null,
      redirect: null,
      now: input.now
    });
    return {
      state,
      rejection: null,
      events: [
        {
          type: "builder.mutation_intent.proposed",
          payload: { stepId: step.stepId, operation: verdict.intent.operation, targetFiles: verdict.intent.targetFiles, toolCallId: input.action.toolCall.toolCallId }
        },
        {
          type: "builder.mutation_intent.accepted",
          payload: { stepId: step.stepId, operation: verdict.intent.operation, targetFiles: verdict.intent.targetFiles, toolCallId: input.action.toolCall.toolCallId }
        }
      ]
    };
  }

  const events: BuilderEventDraft[] = [];
  if (isMutationToolCall(input.action.toolCall)) {
    events.push({
      type: "builder.mutation_intent.proposed",
      payload: { stepId: step.stepId, toolCallId: input.action.toolCall.toolCallId, toolName: input.action.toolCall.toolName }
    });
  }
  events.push({
    type: "builder.mutation_intent.rejected",
    payload: {
      stepId: step.stepId,
      code: verdict.code,
      reason: verdict.reason,
      toolCallId: input.action.toolCall.toolCallId,
      toolName: input.action.toolCall.toolName,
      redirect: verdict.redirect
    }
  });

  return {
    state: setMutationIntent({
      state: input.builderState,
      mutationIntent: null,
      redirect: verdict.redirect,
      now: input.now
    }),
    rejection: {
      code: verdict.code,
      message: verdict.message,
      reason: verdict.reason
    },
    events
  };
}

export function applyBuilderToolEvidence(input: {
  builderState: BuilderState;
  path: string;
  evidenceRefs: string[];
  now: string;
}): BuilderState {
  if (input.builderState.currentStepId === null) {
    return input.builderState;
  }
  const step = input.builderState.planSteps.find((candidate) => candidate.stepId === input.builderState.currentStepId);
  if (step === undefined) {
    return input.builderState;
  }
  const mutated = normalizeWorkspacePath(input.path);
  const matchesStepTarget = step.targetFiles.map(normalizeWorkspacePath).includes(mutated);
  if (!matchesStepTarget) {
    return input.builderState;
  }
  return markStepCompleted({
    state: input.builderState,
    stepId: step.stepId,
    evidenceRefs: input.evidenceRefs,
    now: input.now
  });
}
