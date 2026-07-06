import type {
  ContextSnapshot,
  ProgressLedger,
  Task,
  TaskAnchor,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../../contracts/src/index.js";
import {
  buildContextSnapshot,
  collectRehydrationFilePaths,
  rehydrateWorkspaceFacts
} from "../../../context/src/index.js";
import type { ApprovalStore } from "../../../storage/src/approval-store.js";
import type { UserInputStore } from "../../../storage/src/user-input-store.js";

export function buildLoopContextSnapshot(input: {
  runId: string;
  anchor: TaskAnchor;
  ledger: ProgressLedger;
  workingSet: WorkingSet | null;
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  approvalStore: ApprovalStore;
  userInputStore: UserInputStore;
  regroundedAt: string | null;
  now: string;
}): ContextSnapshot {
  const openApprovals = input.approvalStore.hasPendingByRun(input.runId) ? countPendingApprovals(input.approvalStore, input.runId) : 0;
  const openUserInputs = input.userInputStore.hasPendingByRun(input.runId) ? countPendingUserInputs(input.userInputStore, input.runId) : 0;
  return buildContextSnapshot({
    runId: input.runId,
    anchor: input.anchor,
    ledger: input.ledger,
    workingSet: input.workingSet,
    recentToolResult: input.recentToolResult,
    recentValidationResult: input.recentValidationResult,
    openApprovals,
    openUserInputs,
    regroundedAt: input.regroundedAt,
    now: input.now
  });
}

export function countPendingApprovals(approvalStore: ApprovalStore, runId: string): number {
  return approvalStore.listByRun(runId).filter((entry) => entry.request.status === "pending").length;
}

export function countPendingUserInputs(userInputStore: UserInputStore, runId: string): number {
  return userInputStore.listByRun(runId).filter((entry) => entry.request.status === "pending").length;
}

export function reGroundNow(
  input: {
    workspaceRoot: string;
    task: Task;
  },
  workingSet: WorkingSet | null,
  now: string
): string | null {
  const workingSetPaths = workingSet?.items.map((item) => item.path) ?? [];
  const pendingPatchPath = input.task.input.patchRequest?.path;
  const facts = rehydrateWorkspaceFacts({
    workspaceRoot: input.workspaceRoot,
    filePaths: collectRehydrationFilePaths({ workingSetPaths, pendingPatchPath }),
    now
  });
  return facts.regroundedAt;
}
