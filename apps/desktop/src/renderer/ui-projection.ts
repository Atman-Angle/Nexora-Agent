import type { RunInspection } from "@nexora/harness";

export type DesktopViewMode = "conversation" | "output";

export type ContentScrollMetrics = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

export function contentViewportKey(workspacePath: string, sessionId: string | null, mode: DesktopViewMode): string {
  return `${workspacePath.toLowerCase()}::${sessionId ?? "new-task"}::${mode}`;
}

export function isContentAtBottom(metrics: ContentScrollMetrics, threshold = 48): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function shouldShowTaskExecution(status: string): boolean {
  return status === "running" || status === "waiting_for_input" || status === "waiting_for_approval";
}

/**
 * The renderer's complete control surface is derived from this public Runtime
 * inspection. It deliberately does not infer recovery from stop-reason text or
 * audit history.
 */
export type RuntimeControlProjection =
  | { readonly kind: "input"; readonly requestId: string }
  | { readonly kind: "approval"; readonly requestId: string }
  | { readonly kind: "tool_recovery"; readonly invocationIds: readonly string[] }
  | { readonly kind: "provider_reconnecting" }
  | { readonly kind: "budget_extension"; readonly allowedDimensions: readonly ("iterations" | "modelCalls" | "toolCalls" | "retries")[] }
  | { readonly kind: "worker_recovery"; readonly childRunIds: readonly string[] }
  | { readonly kind: "legacy_blocked" }
  | { readonly kind: "failed" }
  | { readonly kind: "running" | "succeeded" | "cancelled" | "other" };

export function projectRuntimeControls(
  inspection: Pick<RunInspection, "status" | "pendingRequest" | "resumePredicate">
): RuntimeControlProjection {
  if (inspection.status === "waiting_for_input" && inspection.pendingRequest?.kind === "input") {
    return { kind: "input", requestId: inspection.pendingRequest.id };
  }
  if (inspection.status === "waiting_for_approval" && inspection.pendingRequest?.kind === "approval") {
    return { kind: "approval", requestId: inspection.pendingRequest.id };
  }
  if (inspection.status === "failed") return { kind: "failed" };
  if (inspection.status !== "blocked") {
    return { kind: inspection.status === "running" || inspection.status === "succeeded" || inspection.status === "cancelled" ? inspection.status : "other" };
  }

  const predicate = inspection.resumePredicate;
  if (predicate === null) return { kind: "legacy_blocked" };
  if (predicate.kind === "provider_reconnect") return { kind: "provider_reconnecting" };
  if (predicate.kind === "budget_extension") {
    return { kind: "budget_extension", allowedDimensions: predicate.allowedDimensions };
  }
  if (predicate.kind === "tool_recovery_decision") {
    return { kind: "tool_recovery", invocationIds: predicate.invocationIds };
  }
  return { kind: "worker_recovery", childRunIds: predicate.childRunIds };
}

const ModelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export function modelIdValidationMessage(value: string): string | null {
  const modelId = value.trim();
  if (modelId === "") return "请输入 Model ID。";
  if (!ModelIdPattern.test(modelId)) return "Model ID 不能包含空格或显示名称字符，仅支持字母、数字、点、短横线、下划线、斜线和冒号。";
  return null;
}
