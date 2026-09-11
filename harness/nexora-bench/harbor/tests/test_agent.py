import tempfile
import unittest
from pathlib import Path

from nexora_harbor.agent import NexoraRuntimeAgent


class AgentTest(unittest.TestCase):
    def test_auto_scenario_resolves_from_harbor_session_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = NexoraRuntimeAgent(logs_dir=Path(directory))
            agent.session_id = "cap-env-coherent-mapping__AbCd123__agent"
            self.assertEqual(
                agent._resolve_scenario_id(), "cap-env-coherent-mapping"
            )

    def test_auto_scenario_requires_harbor_session_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = NexoraRuntimeAgent(logs_dir=Path(directory))
            with self.assertRaisesRegex(RuntimeError, "session id"):
                agent._resolve_scenario_id()

    def test_explicit_scenario_overrides_auto_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = NexoraRuntimeAgent(
                logs_dir=Path(directory),
                scenario_id="cap-data-ordered-report",
            )
            agent.session_id = "cap-env-coherent-mapping__AbCd123__agent"
            self.assertEqual(
                agent._resolve_scenario_id(), "cap-data-ordered-report"
            )

    def test_real_provider_env_is_explicitly_forwarded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = NexoraRuntimeAgent(
                logs_dir=Path(directory),
                scenario_id="task-a",
                provider_mode="real",
                extra_env={
                    "NEXORA_MODEL_NAME": "model-a",
                    "NEXORA_MODEL_API_KEY": "secret",
                    "UNRELATED_SECRET": "must-not-forward",
                },
            )
            runtime_env = agent._runtime_env()
            self.assertEqual(runtime_env["NEXORA_MODEL_NAME"], "model-a")
            self.assertEqual(runtime_env["NEXORA_MODEL_API_KEY"], "secret")
            self.assertNotIn("UNRELATED_SECRET", runtime_env)

    def test_deterministic_mode_forwards_no_provider_env(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = NexoraRuntimeAgent(
                logs_dir=Path(directory),
                scenario_id="task-a",
                provider_mode="deterministic",
                extra_env={"NEXORA_MODEL_API_KEY": "secret"},
            )
            self.assertIsNone(agent._runtime_env())


    def test_open_budget_env_is_forwarded_for_real_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = NexoraRuntimeAgent(
                logs_dir=Path(directory),
                scenario_id="regex-log",
                provider_mode="real",
                extra_env={
                    "NEXORA_MODEL_NAME": "model-a",
                    "NEXORA_OPEN_MAX_DURATION_MS": "780000",
                    "NEXORA_OPEN_MAX_TOOL_CALLS": "240",
                },
            )
            runtime_env = agent._runtime_env()
            self.assertEqual(runtime_env["NEXORA_OPEN_MAX_DURATION_MS"], "780000")
            self.assertEqual(runtime_env["NEXORA_OPEN_MAX_TOOL_CALLS"], "240")

    def test_node_bootstrap_is_idempotent_and_pins_node(self) -> None:
        command = NexoraRuntimeAgent._ensure_node_command()
        # Fast path requires a complete toolchain: Node >= 20 plus npm, corepack and pnpm.
        self.assertIn("command -v node", command)
        self.assertIn("command -v corepack", command)
        self.assertIn("command -v pnpm", command)
        self.assertIn("v2[0-9]*|v[3-9][0-9]*)", command)
        # Download path installs the pinned Node binary when the toolchain is incomplete.
        self.assertIn("https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-x64.tar.xz", command)
        self.assertIn("ln -sf /opt/node-v22.17.0-linux-x64/bin/node /usr/local/bin/node", command)
        self.assertIn("ln -sf /opt/node-v22.17.0-linux-x64/bin/corepack /usr/local/bin/corepack", command)

    def test_native_toolchain_bootstrap_is_idempotent(self) -> None:
        command = NexoraRuntimeAgent._ensure_native_toolchain_command()
        # Fast path when the toolchain already exists.
        self.assertIn("command -v python3", command)
        self.assertIn("command -v make", command)
        self.assertIn("command -v g++", command)
        # Install path installs the native build toolchain for better-sqlite3.
        self.assertIn("apt-get install -y -qq python3 make g++ gcc", command)

if __name__ == "__main__":
    unittest.main()
