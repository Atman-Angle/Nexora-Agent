import {
  requiresValidationRepairAction,
  isValidationRepairAction
} from "../../validation-repair/index.js";
import type { ActionPolicy, ActionPolicyInput, ActionPolicyOutcome } from "../types.js";

const MAX_ACTION_REPAIRS = 2;

/**
 * validationRepairPolicy — Block A (§6.1).
 *
 * When a fresh failed validation exists after a mutation and the current
 * action is not a valid repair action, reject with VALIDATION_REPAIR_ACTION_REQUIRED.
 */
export const validationRepairPolicy: ActionPolicy = {
  name: "validation_repair",

  async evaluate(input: ActionPolicyInput): Promise<ActionPolicyOutcome> {
    const { action, actionSignature, state } = input;

    if (
      !requiresValidationRepairAction(state.recentValidationResult) ||
      isValidationRepairAction(action, state.builderState, state.recentValidationResult)
    ) {
      return { kind: "accept" };
    }

    const attempt = state.validationRepairActionRejectionCount + 1;
    const message =
      "The latest fresh validation failed after a mutation; broad filesystem.read, off-target filesystem.read, filesystem.search, filesystem.list, project inspection, git tools, update_plan, and shell.execute source mutation are not repair actions now. Submit a focused repair execution plan or a Builder-directed repair mutation within the same Task executionConstraints, then rerun validation. filesystem.read is only repair evidence when it targets a changed file named in the failure summary or the current Builder modify target; repeated reads do not count as repair progress and must lead to a concrete mutation. Use shell.execute only to rerun validation, tests, or builds.";

    const failing = attempt > MAX_ACTION_REPAIRS;

    return {
      kind: "reject",
      category: "validation_repair",
      code: "VALIDATION_REPAIR_ACTION_REQUIRED",
      message,
      maxAttempts: MAX_ACTION_REPAIRS + 1,
      attempt,
      reason: "fresh_failed_validation_requires_repair_action",
      stateDelta: {
        validationRepairActionRejectionCount: attempt,
        pendingActionRejection: {
          category: "validation_repair",
          attempt,
          message
        }
      },
      events: [],
      ledgerPatch: { appendDecisions: [message] },
      ...(failing
        ? {
            failSignal: {
              code: "VALIDATION_REPAIR_ACTION_REQUIRED",
              message,
              retryable: false
            }
          }
        : {
            checkpoint: true as const,
            checkpointNote: "validation_repair_action_required",
            previousSnapshot: {
              actionSignature,
              errorCode: "VALIDATION_REPAIR_ACTION_REQUIRED",
              ledgerVersion: state.ledger.version,
              evidenceCount: state.ledger.evidenceRefs.length,
              validationStatus: state.recentValidationResult.status,
              artifactHash: null
            }
          })
    };
  }
};
