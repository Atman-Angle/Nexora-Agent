import unittest

from nexora_harbor.closure import (
    BLOCKED_EXTERNAL,
    CANCELLED,
    FAILED_TASK,
    SUCCEEDED,
    UNEXPECTED_RUNTIME_DEAD_END,
    WAITING_APPROVAL,
    WAITING_INPUT,
    classify_execution_closure,
)


class ClosureTest(unittest.TestCase):
    def test_succeeded_is_closed(self) -> None:
        self.assertEqual(
            classify_execution_closure({"actualTerminal": "succeeded"}), SUCCEEDED
        )

    def test_cancelled_and_waiting_terminals(self) -> None:
        self.assertEqual(
            classify_execution_closure({"actualTerminal": "cancelled"}), CANCELLED
        )
        self.assertEqual(
            classify_execution_closure({"actualTerminal": "waiting_for_approval"}),
            WAITING_APPROVAL,
        )
        self.assertEqual(
            classify_execution_closure({"actualTerminal": "waiting_for_input"}),
            WAITING_INPUT,
        )

    def test_no_progress_failure_is_bounded_task_failure(self) -> None:
        task = {
            "actualTerminal": "failed",
            "diagnostics": {
                "stopReason": "NO_PROGRESS_DETECTED",
                "runErrorCode": "NO_PROGRESS_DETECTED",
                "responseRejectedCount": 2,
                "providerFailureCount": 0,
            },
        }
        self.assertEqual(classify_execution_closure(task), FAILED_TASK)

    def test_internal_failure_is_unexpected_dead_end(self) -> None:
        task = {
            "actualTerminal": "failed",
            "diagnostics": {
                "stopReason": "INTERNAL_ERROR",
                "runErrorCode": "INTERNAL_ERROR",
            },
        }
        self.assertEqual(classify_execution_closure(task), UNEXPECTED_RUNTIME_DEAD_END)

    def test_provider_blocked_is_external_and_resumable(self) -> None:
        task = {
            "actualTerminal": "blocked",
            "diagnostics": {"stopReason": "PROVIDER_UNAVAILABLE"},
        }
        self.assertEqual(classify_execution_closure(task), BLOCKED_EXTERNAL)

    def test_worker_recovery_blocked_is_dead_end(self) -> None:
        task = {
            "actualTerminal": "blocked",
            "diagnostics": {"stopReason": "WORKER_RECOVERY_REQUIRED"},
        }
        self.assertEqual(classify_execution_closure(task), UNEXPECTED_RUNTIME_DEAD_END)

    def test_unknown_terminal_is_dead_end(self) -> None:
        self.assertEqual(classify_execution_closure({}), UNEXPECTED_RUNTIME_DEAD_END)


if __name__ == "__main__":
    unittest.main()
