import { AgentActionSchema } from "../../../contracts/src/index.js";
import type { AgentAction, SelectionHandle } from "../../../contracts/src/index.js";
import { ensureBudget } from "../agent-loop/budget.js";
import type { GenerateActionOutcome } from "./types.js";
import type { HandlerDeps } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import { buildAgentActionPrompt, measureAgentActionPrompt } from "./shared/action-prompt.js";
import { buildLoopContextSnapshot } from "../agent-loop/context-snapshot.js";
import { buildContextEnvelope } from "../../../context/src/index.js";
import { buildAgentActionSchemaText } from "../../../model-gateway/src/model-tool-definition.js";
import { resolveChatSelectionAction } from "./chat-selection-handle.js";

/**
 * Chat's convergent action generation. It intentionally does not build
 * coding Strategy/Builder context or create coding compaction state.
 */
export async function generateChatAction(
  state: AgentLoopState,
  deps: HandlerDeps
): Promise<GenerateActionOutcome> {
  const startedAt = deps.input.now();
  return generateNaturalLanguageAction(state, deps, {
    startedAt,
    selectionAction: state.recentToolResult === null
      ? resolveChatSelectionAction({
          requestText: selectionRequestText(deps.input.runtimeContext, deps.input.task.input.text),
          selectionHandles: selectionHandles(deps.input.runtimeContext),
          toolCallId: deps.input.idGenerator()
        })
      : null,
    profileContext: {
      mode: "chat",
      instructions: [
        "Answer directly with final when the available information is sufficient.",
        "Use filesystem.search to find matching files; do not list the repository root to explore broadly.",
        "After a read tool result, answer from that result instead of repeating the same tool call.",
        "For final, cite source paths in the text if useful, but omit evidenceRefs because chat has no ledger-evidence reference contract.",
        "Do not emit update_plan or submit_execution_plan in chat."
      ]
    },
    additionalSegments: chatRuntimeSegments(deps.input.runtimeContext, startedAt)
  });
}

export async function generateNaturalLanguageAction(
  state: AgentLoopState,
  deps: HandlerDeps,
  options: {
    readonly startedAt: string;
    readonly selectionAction: AgentAction | null;
    readonly profileContext: { mode: string; instructions: string[] };
    readonly additionalSegments: ReturnType<typeof chatRuntimeSegments>;
  }
): Promise<GenerateActionOutcome> {
  await ensureBudget({
    appendEvent: deps.appendEvent,
    now: deps.input.now(),
    phase: "model",
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    reserveVerification: false
  });

  const startedAt = options.startedAt;
  await deps.appendEvent("iteration.started", { index: state.latestIterationIndex }, startedAt);
  state.usage.loopCount += 1;
  const envelopeStartedAt = performance.now();
  const contextEnvelope = buildContextEnvelope({
    snapshot: buildLoopContextSnapshot({
      runId: state.activeRun.runId, anchor: deps.anchor, ledger: state.ledger,
      workingSet: state.currentWorkingSet, recentToolResult: state.recentToolResult,
      recentValidationResult: state.recentValidationResult, approvalStore: deps.input.approvalStore,
      userInputStore: deps.input.userInputStore, regroundedAt: state.regroundedAt, now: startedAt
    }),
    now: startedAt, profileContext: options.profileContext, capabilitySchema: buildAgentActionSchemaText(deps.availableTools),
    additionalSegments: options.additionalSegments
  });
  const contextEnvelopeBuildDurationMs = performance.now() - envelopeStartedAt;

  const modelResult = options.selectionAction === null
    ? await nextChatModelAction({
      state, deps, contextEnvelope, profileContext: options.profileContext
    })
    : null;
  const action = options.selectionAction ?? AgentActionSchema.parse(modelResult!.action);

  await deps.appendEvent(
    "model.action.generated",
    {
      type: action.type,
      ...(action.type === "tool_call" || action.type === "request_approval"
        ? { toolCallId: action.toolCall.toolCallId, toolName: action.toolCall.toolName }
        : {}),
      ...(modelResult === null ? {} : {
        measurement: {
          ...modelResult.measurement,
          contextEnvelopeBuildDurationMs,
          modelCalls: state.usage.modelCalls,
          providerRetryCount: state.usage.providerRetryCount
        }
      })
    },
    deps.input.now()
  );
  return { kind: "action", action };
}

async function nextChatModelAction(input: {
  state: AgentLoopState;
  deps: HandlerDeps;
  contextEnvelope: ReturnType<typeof buildContextEnvelope>;
  profileContext: { mode: string; instructions: string[] };
}): Promise<{ action: unknown; measurement: ReturnType<typeof measureAgentActionPrompt> & { promptBuildDurationMs: number; providerDurationMs: number } }> {
  input.state.usage.modelCalls += 1;
  const promptInput = {
    runId: input.state.activeRun.runId,
    goal: input.deps.anchor.goal,
    constraints: input.deps.anchor.constraints,
    successCriteria: input.deps.anchor.successCriteria,
    ledger: input.state.ledger,
    workingSet: input.state.currentWorkingSet,
    recentToolResult: input.state.recentToolResult,
    recentValidationResult: input.state.recentValidationResult,
    budget: input.deps.input.task.input.agentRequest!.budget,
    usage: input.state.usage,
    availableTools: input.deps.availableTools,
    regroundRequested: input.state.regroundRequested,
    replanRequested: input.state.replanRequested,
    profileContext: input.profileContext,
    contextEnvelope: input.contextEnvelope
  };
  const promptStartedAt = performance.now();
  const prompt = buildAgentActionPrompt(promptInput);
  const promptBuildDurationMs = performance.now() - promptStartedAt;
  const providerStartedAt = performance.now();
  const action = await input.deps.input.modelProvider.nextAction({
    ...promptInput,
    prompt
  });
  return { action, measurement: { ...measureAgentActionPrompt(promptInput, prompt), promptBuildDurationMs, providerDurationMs: performance.now() - providerStartedAt } };
}

function selectionHandles(value: unknown): SelectionHandle[] { return typeof value === "object" && value !== null && Array.isArray((value as { selectionHandles?: unknown }).selectionHandles) ? (value as { selectionHandles: SelectionHandle[] }).selectionHandles : []; }
function selectionRequestText(value: unknown, fallback: string) { return typeof value === "object" && value !== null && typeof (value as { selectionRequestText?: unknown }).selectionRequestText === "string" ? (value as { selectionRequestText: string }).selectionRequestText : fallback; }

function chatRuntimeSegments(value: unknown, sourceVersion: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const context = value as { conversation?: unknown; memory?: unknown };
  const segments: Array<{ id: string; pool: "conversation" | "memory"; required: false; priority: number; sourceVersion: string; content: string; artifactRefs: string[] }> = [];
  if (Array.isArray(context.conversation)) segments.push({ id: "conversation", pool: "conversation", required: false, priority: 6, sourceVersion, content: JSON.stringify(context.conversation), artifactRefs: [] });
  if (Array.isArray(context.memory)) segments.push({ id: "memory", pool: "memory", required: false, priority: 5, sourceVersion, content: JSON.stringify(context.memory), artifactRefs: [] });
  return segments;
}
