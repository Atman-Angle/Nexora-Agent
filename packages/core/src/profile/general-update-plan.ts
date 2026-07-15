import type { AgentAction } from "../../../contracts/src/index.js";
import { applyLedgerPatch } from "../ledger-progress/index.js";
import { createIteration } from "../agent-loop/iteration.js";
import type { HandlerDeps, HandlerOutcome } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";

/** Persists an Action Protocol plan without imposing a domain workflow. */
export async function handleGeneralUpdatePlan(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: Extract<AgentAction, { type: "update_plan" }>
): Promise<HandlerOutcome> {
  const ledger = applyLedgerPatch({ ledger: state.ledger, patch: action.patch, now: deps.input.now() });
  await deps.persistLedger(ledger);
  await deps.checkpoint("plan_formed");
  const iteration = createIteration({
    iterationId: deps.input.idGenerator(), runId: state.activeRun.runId, index: state.latestIterationIndex,
    actionType: action.type, status: "completed", usage: state.usage, summary: action.reason,
    evidenceRefs: [], now: deps.input.now()
  });
  deps.input.agentIterationStore.insertIteration(iteration);
  await deps.appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  Object.assign(state, { ledger, latestIterationIndex: state.latestIterationIndex + 1 });
  return { kind: "continue" };
}
