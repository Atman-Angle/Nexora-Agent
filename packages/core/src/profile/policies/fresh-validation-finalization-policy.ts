import { isFreshPassingValidation } from "../../validation-repair/index.js";
import type { ActionPolicy, ActionPolicyInput, ActionPolicyOutcome } from "../types.js";

const MAX_ACTION_REPAIRS = 2;

/**
 * freshValidationFinalizationPolicy — Block B (§6.2).
 *
 * When the action is submit_execution_plan and a fresh passing validation
 * already exists, reject with EXECUTION_PLAN_AFTER_FRESH_VALIDATION.
 */
export const freshValidationFinalizationPolicy: ActionPolicy = {
  name: "fresh_validation_finalization",

  async evaluate(input: ActionPolicyInput): Promise<ActionPolicyOutcome> {
    const { action, actionSignature, state } = input;

    if (
      action.type !== "submit_execution_plan" ||
      !isFreshPassingValidation(state.recentValidationResult)
    ) {
      return { kind: "accept" };
    }

    const attempt = state.finalizationPlanRejectionCount + 1;
    const message =
      "A fresh passing validation already exists after the latest mutation; submit a final action instead of a new execution plan.";

    const failing = attempt > MAX_ACTION_REPAIRS;

    return {
      kind: "reject",
      category: "completion_guidance",
      code: "EXECUTION_PLAN_AFTER_FRESH_VALIDATION",
      message,
      maxAttempts: MAX_ACTION_REPAIRS + 1,
      attempt,
      reason: "fresh_validation_requires_final",
      stateDelta: {
        finalizationPlanRejectionCount: attempt,
        pendingActionRejection: {
          category: "completion_guidance",
          attempt,
          message
        }
      },
      events: [],
      ledgerPatch: { appendDecisions: [message] },
      ...(failing
        ? {
            failSignal: {
              code: "EXECUTION_PLAN_UNEXPECTED",
              message,
              retryable: false
            }
          }
        : {
            checkpoint: true as const,
            checkpointNote: "fresh_validation_final_required",
            previousSnapshot: {
              actionSignature,
              errorCode: "EXECUTION_PLAN_AFTER_FRESH_VALIDATION",
              ledgerVersion: state.ledger.version,
              evidenceCount: state.ledger.evidenceRefs.length,
              validationStatus: state.recentValidationResult.status,
              artifactHash: null
            }
          })
    };
  }
};
