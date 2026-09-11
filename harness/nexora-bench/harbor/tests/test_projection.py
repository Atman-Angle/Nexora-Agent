import json
import tempfile
import unittest
from pathlib import Path

from nexora_harbor.projection import project_job


class ProjectionTest(unittest.TestCase):
    def test_projects_three_harbor_attempts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "result.json").write_text(json.dumps({"id": "job-1"}))
            for index in range(3):
                verifier = root / f"trial-{index}" / "verifier"
                verifier.mkdir(parents=True)
                (verifier / "nexora-projection.json").write_text(json.dumps({
                    "taskId": "task-a",
                    "strictPass": 1,
                    "externalResult": 1,
                    "runtimeIntegrity": 1,
                    "authority": 1,
                    "safety": 1,
                    "expectedOutcome": 1,
                    "terminal": "succeeded",
                    "closure": "SUCCEEDED",
                    "firstBrokenBoundary": None,
                }))

            result = project_job(root)
            self.assertEqual(result["empiricalStrictPassRate"], 1)
            self.assertTrue(result["observedAll3"])
            self.assertIsNone(result["observedAll5"])
            self.assertEqual(result["terminalDistribution"], {"succeeded": 3})
            self.assertEqual(result["closureDistribution"], {"SUCCEEDED": 3})
            self.assertEqual(result["firstBrokenBoundaryDistribution"], {"none": 3})


if __name__ == "__main__":
    unittest.main()

