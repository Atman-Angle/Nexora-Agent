"""Execution Closure classification for open (Terminal-Bench style) trials.

A run is EXECUTION_CLOSED when it reached a semantic, explainable terminal:
the model finished (SUCCEEDED), the task was bounded and could not be completed
(FAILED_TASK), the run waits on the user (WAITING_INPUT / WAITING_APPROVAL),
an external condition blocks it with a resume path (BLOCKED_EXTERNAL), or the
user cancelled (CANCELLED).  Anything else is an UNEXPECTED_RUNTIME_DEAD_END:
the Runtime/Harness lost a legitimate continuation path.

This classifier is read-only and consumes the persisted Nexora Runtime fact
bundle task report only.  Task correctness remains owned by the official
external verifier; this metric answers "did Nexora close the run cleanly?".
"""

from __future__ import annotations

from typing import Any

SUCCEEDED = "SUCCEEDED"
FAILED_TASK = "FAILED_TASK"
WAITING_APPROVAL = "WAITING_APPROVAL"
WAITING_INPUT = "WAITING_INPUT"
BLOCKED_EXTERNAL = "BLOCKED_EXTERNAL"
CANCELLED = "CANCELLED"
UNEXPECTED_RUNTIME_DEAD_END = "UNEXPECTED_RUNTIME_DEAD_END"

PROVIDER_STOP_REASONS = {
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_ERROR",
    "PROVIDER_CONNECT_TIMEOUT",
    "CONTEXT_CAPACITY_EXCEEDED",
}

BUDGET_STOP_REASONS = {
    "DURATION_BUDGET_EXCEEDED",
    "ITERATION_BUDGET_EXCEEDED",
    "MODEL_CALL_BUDGET_EXCEEDED",
    "TOOL_CALL_BUDGET_EXCEEDED",
    "RETRY_BUDGET_EXCEEDED",
}


def classify_execution_closure(task: dict[str, Any]) -> str:
    """Classify the execution closure of one persisted Nexora task report.

    ``task`` is the ``task`` member of a ``nexora-runtime-fact-bundle`` (the
    TypeScript TaskReport shape).  Unknown or missing fields degrade to the
    conservative UNEXPECTED_RUNTIME_DEAD_END so a missing explanation is never
    reported as a clean closure.
    """
    terminal = task.get("actualTerminal")
    diagnostics = task.get("diagnostics")
    diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
    stop_reason = diagnostics.get("stopReason")
    run_error = diagnostics.get("runErrorCode")
    if not isinstance(stop_reason, str) or not stop_reason:
        stop_reason = None
    if not isinstance(run_error, str) or not run_error:
        run_error = None

    if terminal == "succeeded":
        return SUCCEEDED
    if terminal == "cancelled":
        return CANCELLED
    if terminal == "waiting_for_approval":
        return WAITING_APPROVAL
    if terminal == "waiting_for_input":
        return WAITING_INPUT
    if terminal == "blocked":
        return _classify_blocked(stop_reason, run_error)
    if terminal == "failed":
        return _classify_failed(stop_reason, run_error, diagnostics)
    return UNEXPECTED_RUNTIME_DEAD_END


def _classify_blocked(
    stop_reason: str | None, run_error: str | None
) -> str:
    if stop_reason in PROVIDER_STOP_REASONS or run_error in PROVIDER_STOP_REASONS:
        return BLOCKED_EXTERNAL
    if stop_reason in BUDGET_STOP_REASONS or run_error in BUDGET_STOP_REASONS:
        return FAILED_TASK
    if stop_reason == "NO_PROGRESS_DETECTED" or run_error == "NO_PROGRESS_DETECTED":
        # A NO_PROGRESS block requires corrective user input to resume.
        return WAITING_INPUT
    if stop_reason == "WORKER_RECOVERY_REQUIRED" or run_error == "WORKER_RECOVERY_REQUIRED":
        # Recoverable unfinished work was abandoned without a recovery decision.
        return UNEXPECTED_RUNTIME_DEAD_END
    return UNEXPECTED_RUNTIME_DEAD_END


def _classify_failed(
    stop_reason: str | None,
    run_error: str | None,
    diagnostics: dict[str, Any],
) -> str:
    if stop_reason == "NO_PROGRESS_DETECTED" or run_error == "NO_PROGRESS_DETECTED":
        # Bounded convergence stop after repeated invalid responses.  The
        # Runtime closed with an explicit reason; the cause is model-side.
        return FAILED_TASK
    internal = str(stop_reason or "").startswith("INTERNAL") or str(
        run_error or ""
    ).startswith("INTERNAL")
    if internal:
        return UNEXPECTED_RUNTIME_DEAD_END
    # An explicit runtime failure terminal with a persisted reason.
    return FAILED_TASK
