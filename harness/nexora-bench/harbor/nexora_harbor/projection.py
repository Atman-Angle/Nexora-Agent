from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def project_job(job_dir: Path) -> dict[str, Any]:
    harbor_result = _read_object(job_dir / "result.json")
    trials = [
        _read_object(path)
        for path in sorted(job_dir.glob("*/verifier/nexora-projection.json"))
    ]
    if not trials:
        raise ValueError(f"No Nexora verifier projections found under {job_dir}")

    strict_count = sum(item.get("strictPass") == 1 for item in trials)
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in trials:
        by_task[str(item.get("taskId") or "unknown")].append(item)

    return {
        "schemaVersion": 1,
        "source": {
            "kind": "harbor-job-result",
            "jobId": harbor_result.get("id"),
            "path": str(job_dir.resolve()),
        },
        "trialCount": len(trials),
        "empiricalStrictPassRate": strict_count / len(trials),
        "strictPassCount": strict_count,
        "observedAll3": _all_k(by_task, 3),
        "observedAll5": _all_k(by_task, 5),
        "terminalDistribution": dict(sorted(Counter(
            str(item.get("terminal") or "unknown") for item in trials
        ).items())),
        "firstBrokenBoundaryDistribution": dict(sorted(Counter(
            str(item.get("firstBrokenBoundary") or "none") for item in trials
        ).items())),
        "closureDistribution": dict(sorted(Counter(
            str(item.get("closure") or "UNEXPECTED_RUNTIME_DEAD_END") for item in trials
        ).items())),
        "externalPassRate": _rate(trials, "externalResult"),
        "runtimeIntegrityPassRate": _rate(trials, "runtimeIntegrity"),
        "authorityPassRate": _rate(trials, "authority"),
        "safetyPassRate": _rate(trials, "safety"),
        "expectedOutcomePassRate": _rate(trials, "expectedOutcome"),
    }


def _all_k(by_task: dict[str, list[dict[str, Any]]], k: int) -> bool | None:
    if not by_task or any(len(items) < k for items in by_task.values()):
        return None
    return all(all(item.get("strictPass") == 1 for item in items[:k]) for items in by_task.values())


def _rate(items: list[dict[str, Any]], key: str) -> float:
    return sum(item.get(key) == 1 for item in items) / len(items)


def _read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Project Harbor trial results into Nexora-specific reliability metrics."
    )
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    projection = project_job(args.job_dir)
    rendered = json.dumps(projection, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()

