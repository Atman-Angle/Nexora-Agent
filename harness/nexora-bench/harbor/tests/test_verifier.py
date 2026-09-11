import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from harbor.models.verifier.result import VerifierResult

from nexora_harbor.verifier import NexoraRuntimeVerifier


class VerifierTest(unittest.IsolatedAsyncioTestCase):
    async def test_missing_fact_bundle_is_retained_as_failed_grade(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            verifier_dir = Path(directory)
            trial_paths = SimpleNamespace(verifier_dir=verifier_dir)
            environment = MagicMock()
            environment.download_file = AsyncMock(side_effect=FileNotFoundError("missing"))
            verifier = NexoraRuntimeVerifier(
                task=MagicMock(),
                trial_paths=trial_paths,
                environment=environment,
            )
            with patch(
                "nexora_harbor.verifier.Verifier.verify",
                new=AsyncMock(return_value=VerifierResult(rewards={"reward": 1})),
            ):
                result = await verifier.verify()

            self.assertEqual(result.rewards["external_result"], 1)
            self.assertEqual(result.rewards["reward"], 0)
            projection = json.loads(
                (verifier_dir / "nexora-projection.json").read_text(encoding="utf-8")
            )
            self.assertEqual(projection["firstBrokenBoundary"], "RUNTIME_FACT_EXPORT")


    async def test_projection_carries_execution_closure_from_fact_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            verifier_dir = Path(directory)
            bundle = verifier_dir / "nexora-runtime-fact-bundle.json"
            bundle.write_text(json.dumps({
                "schemaVersion": 1,
                "kind": "nexora-runtime-fact-bundle",
                "task": {
                    "taskId": "regex-log",
                    "runId": "run-1",
                    "actualTerminal": "failed",
                    "falseSuccess": False,
                    "firstBrokenBoundary": "CONVERGENCE",
                    "suite": {
                        "runtimePassed": True,
                        "authorityPassed": True,
                        "safetyPassed": True,
                        "expectedOutcomePassed": True,
                    },
                    "diagnostics": {
                        "stopReason": "NO_PROGRESS_DETECTED",
                        "runErrorCode": "NO_PROGRESS_DETECTED",
                        "responseRejectedCount": 2,
                        "providerFailureCount": 0,
                    },
                },
            }), encoding="utf-8")
            trial_paths = SimpleNamespace(verifier_dir=verifier_dir)
            environment = MagicMock()
            environment.download_file = AsyncMock()
            verifier = NexoraRuntimeVerifier(
                task=MagicMock(),
                trial_paths=trial_paths,
                environment=environment,
            )
            with patch(
                "nexora_harbor.verifier.Verifier.verify",
                new=AsyncMock(return_value=VerifierResult(rewards={"reward": 0})),
            ):
                result = await verifier.verify()

            self.assertEqual(result.rewards["external_result"], 0)
            self.assertEqual(result.rewards["reward"], 0)
            projection = json.loads(
                (verifier_dir / "nexora-projection.json").read_text(encoding="utf-8")
            )
            self.assertEqual(projection["closure"], "FAILED_TASK")
            self.assertEqual(projection["terminal"], "failed")
            self.assertEqual(projection["stopReason"], "NO_PROGRESS_DETECTED")
            self.assertFalse(projection["falseSuccess"])

    async def test_projection_cross_product_fields_combine_terminal_and_external(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            verifier_dir = Path(directory)
            bundle = verifier_dir / "nexora-runtime-fact-bundle.json"
            bundle.write_text(json.dumps({
                "schemaVersion": 1,
                "kind": "nexora-runtime-fact-bundle",
                "task": {
                    "taskId": "open-task",
                    "runId": "run-2",
                    "actualTerminal": "succeeded",
                    "falseSuccess": False,
                    "firstBrokenBoundary": None,
                    "suite": {
                        "runtimePassed": True,
                        "authorityPassed": True,
                        "safetyPassed": True,
                        "expectedOutcomePassed": True,
                    },
                    "diagnostics": {},
                },
            }), encoding="utf-8")
            trial_paths = SimpleNamespace(verifier_dir=verifier_dir)
            environment = MagicMock()
            environment.download_file = AsyncMock()
            verifier = NexoraRuntimeVerifier(
                task=MagicMock(),
                trial_paths=trial_paths,
                environment=environment,
            )
            with patch(
                "nexora_harbor.verifier.Verifier.verify",
                new=AsyncMock(return_value=VerifierResult(rewards={"reward": 0})),
            ):
                result = await verifier.verify()

            self.assertEqual(result.rewards["external_result"], 0)
            projection = json.loads(
                (verifier_dir / "nexora-projection.json").read_text(encoding="utf-8")
            )
            self.assertEqual(projection["terminal"], "succeeded")
            self.assertEqual(projection["validatedSuccess"], 0)
            self.assertEqual(projection["externalFailedAfterRuntimeSucceeded"], 1)
            self.assertFalse(projection["internalFalseSuccess"])


    async def test_projection_marks_validated_success_when_terminal_and_external_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            verifier_dir = Path(directory)
            bundle = verifier_dir / "nexora-runtime-fact-bundle.json"
            bundle.write_text(json.dumps({
                "schemaVersion": 1,
                "kind": "nexora-runtime-fact-bundle",
                "task": {
                    "taskId": "open-task",
                    "runId": "run-3",
                    "actualTerminal": "succeeded",
                    "falseSuccess": False,
                    "firstBrokenBoundary": None,
                    "suite": {
                        "runtimePassed": True,
                        "authorityPassed": True,
                        "safetyPassed": True,
                        "expectedOutcomePassed": True,
                    },
                    "diagnostics": {},
                },
            }), encoding="utf-8")
            trial_paths = SimpleNamespace(verifier_dir=verifier_dir)
            environment = MagicMock()
            environment.download_file = AsyncMock()
            verifier = NexoraRuntimeVerifier(
                task=MagicMock(),
                trial_paths=trial_paths,
                environment=environment,
            )
            with patch(
                "nexora_harbor.verifier.Verifier.verify",
                new=AsyncMock(return_value=VerifierResult(rewards={"reward": 1})),
            ):
                result = await verifier.verify()

            projection = json.loads(
                (verifier_dir / "nexora-projection.json").read_text(encoding="utf-8")
            )
            self.assertEqual(projection["validatedSuccess"], 1)
            self.assertEqual(projection["externalFailedAfterRuntimeSucceeded"], 0)


if __name__ == "__main__":
    unittest.main()
