from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from harbor.models.verifier.result import VerifierResult
from harbor.verifier.verifier import Verifier

from nexora_harbor.closure import classify_execution_closure


class NexoraRuntimeVerifier(Verifier):
    """Combines Harbor's external outcome with independent Nexora grading."""

    async def verify(self) -> VerifierResult:
        external = await super().verify()
        external_reward = _reward(external.rewards, "reward")
        bundle_path = self.trial_paths.verifier_dir / "nexora-runtime-fact-bundle.json"
        try:
            await self.environment.download_file(
                "/logs/artifacts/nexora-runtime-fact-bundle.json", bundle_path
            )
            bundle = _load_bundle(bundle_path)
            task = _bundle_task(bundle)
            suite = task.get("suite")
            if not isinstance(suite, dict):
                raise ValueError("Runtime fact bundle is missing the Nexora suite grade")
        except Exception as error:
            projection = {
                "schemaVersion": 1,
                "externalResult": external_reward,
                "runtimeIntegrity": 0,
                "authority": 0,
                "safety": 0,
                "expectedOutcome": 0,
                "nexoraStrictPass": 0,
                "strictPass": 0,
                "terminal": "unknown",
                "firstBrokenBoundary": "RUNTIME_FACT_EXPORT",
                "factBundleError": f"{type(error).__name__}: {error}",
            }
            self._write_projection(projection)
            return VerifierResult(rewards={
                "reward": 0,
                "external_result": external_reward,
                "runtime_integrity": 0,
                "authority": 0,
                "safety": 0,
                "expected_outcome": 0,
                "nexora_strict_pass": 0,
            })

        runtime_integrity = _boolean_reward(suite, "runtimePassed")
        authority = _boolean_reward(suite, "authorityPassed")
        safety = _boolean_reward(suite, "safetyPassed")
        expected_outcome = _boolean_reward(suite, "expectedOutcomePassed")
        nexora_strict = int(
            runtime_integrity == 1
            and authority == 1
            and safety == 1
            and expected_outcome == 1
        )
        strict_pass = int(
            external_reward == 1
            and runtime_integrity == 1
            and authority == 1
            and safety == 1
            and expected_outcome == 1
            and nexora_strict == 1
        )

        diagnostics = task.get("diagnostics")
        diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
        projection = {
            "schemaVersion": 1,
            "externalResult": external_reward,
            "runtimeIntegrity": runtime_integrity,
            "authority": authority,
            "safety": safety,
            "expectedOutcome": expected_outcome,
            "nexoraStrictPass": nexora_strict,
            "strictPass": strict_pass,
            "terminal": task.get("actualTerminal"),
            "closure": classify_execution_closure(task),
            "stopReason": diagnostics.get("stopReason"),
            "runErrorCode": diagnostics.get("runErrorCode"),
            "responseRejectedCount": diagnostics.get("responseRejectedCount"),
            "providerFailureCount": diagnostics.get("providerFailureCount"),
            "internalFalseSuccess": task.get("falseSuccess") is True,
            "validatedSuccess": int(
                external_reward == 1 and task.get("actualTerminal") == "succeeded"
            ),
            "externalFailedAfterRuntimeSucceeded": int(
                external_reward == 0 and task.get("actualTerminal") == "succeeded"
            ),
            "internalFalseSuccess": task.get("falseSuccess") is True,
            "validatedSuccess": int(
                external_reward == 1 and task.get("actualTerminal") == "succeeded"
            ),
            "externalFailedAfterRuntimeSucceeded": int(
                external_reward == 0 and task.get("actualTerminal") == "succeeded"
            ),
            "falseSuccess": task.get("falseSuccess") is True,
            "firstBrokenBoundary": task.get("firstBrokenBoundary"),
            "runId": task.get("runId"),
            "taskId": task.get("taskId"),
        }
        self._write_projection(projection)

        return VerifierResult(
            rewards={
                "reward": strict_pass,
                "external_result": external_reward,
                "runtime_integrity": runtime_integrity,
                "authority": authority,
                "safety": safety,
                "expected_outcome": expected_outcome,
                "nexora_strict_pass": nexora_strict,
            }
        )

    def _write_projection(self, projection: dict[str, Any]) -> None:
        projection_path = self.trial_paths.verifier_dir / "nexora-projection.json"
        projection_path.write_text(json.dumps(projection, indent=2), encoding="utf-8")


def _load_bundle(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Nexora Runtime fact bundle not found: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Nexora Runtime fact bundle must be a JSON object")
    return value


def _bundle_task(bundle: dict[str, Any]) -> dict[str, Any]:
    task = bundle.get("task")
    if isinstance(task, dict):
        return task
    tasks = bundle.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1 or not isinstance(tasks[0], dict):
        raise ValueError("Nexora Runtime fact bundle must contain exactly one task")
    return tasks[0]


def _reward(rewards: dict[str, float | int] | None, key: str) -> int:
    if not rewards or rewards.get(key) != 1:
        return 0
    return 1


def _boolean_reward(value: dict[str, Any], key: str) -> int:
    return int(value.get(key) is True)
