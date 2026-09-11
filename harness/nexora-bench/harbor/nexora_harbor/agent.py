from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from shlex import quote

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class NexoraRuntimeAgent(BaseAgent):
    """Runs the real Nexora Runtime inside a Harbor-owned environment.

    Harbor owns environment creation, isolation, task scheduling, attempts and
    artifact collection. This adapter only installs the current Nexora source,
    supplies Harbor's instruction to Runtime and exports Runtime facts.
    """

    @staticmethod
    def name() -> str:
        return "nexora-runtime"

    def version(self) -> str:
        return "1.0.0"

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *,
        scenario_id: str = "auto",
        manifest_path: str = "harness/nexora-bench/datasets/nexora-core-v1/dataset.json",
        repository_root: str | None = None,
        provider_mode: str = "deterministic",
        **kwargs,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        if provider_mode not in {"deterministic", "real"}:
            raise ValueError("provider_mode must be deterministic or real")
        self.scenario_id = scenario_id
        self.manifest_path = manifest_path
        self.provider_mode = provider_mode
        self.repository_root = (
            Path(repository_root).resolve()
            if repository_root
            else Path(__file__).resolve().parents[4]
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        bundle = Path(tempfile.mkdtemp(prefix="nexora-harbor-source-"))
        try:
            self._copy_runtime_source(bundle)
            await environment.upload_dir(bundle, "/opt/nexora")
        finally:
            shutil.rmtree(bundle, ignore_errors=True)

        # Generic Terminal-Bench style task images are often minimal
        # (Ubuntu/Alpine bases without Node).  Bootstrap a pinned Node runtime
        # when the task environment does not already provide one; Nexora
        # capability images skip this step because Node/pnpm are present.
        bootstrap = await environment.exec(
            command=self._ensure_node_command(),
            user="root",
        )
        if bootstrap.return_code != 0:
            raise RuntimeError(
                "Nexora Node bootstrap failed: "
                f"{bootstrap.stderr or bootstrap.stdout}"
            )

        # Some Terminal-Bench images have Node but no native build toolchain.
        # When the better-sqlite3 prebuilt binary cannot be fetched, pnpm falls
        # back to node-gyp, which requires python3/make/g++/gcc.  Install the
        # toolchain when it is missing (best-effort; images with a full
        # toolchain or prebuilt support skip this quickly).
        toolchain = await environment.exec(
            command=self._ensure_native_toolchain_command(),
            user="root",
        )
        if toolchain.return_code != 0:
            raise RuntimeError(
                "Nexora native toolchain bootstrap failed: "
                f"{toolchain.stderr or toolchain.stdout}"
            )

        install = await environment.exec(
            command=(
                "cd /opt/nexora && corepack enable && "
                "pnpm install --frozen-lockfile --filter @nexora/bench... && "
                "pnpm --filter @nexora/runtime build && "
                "pnpm --filter @nexora/harness build"
            ),
            user="root",
        )
        if install.return_code != 0:
            raise RuntimeError(
                f"Nexora install failed: {install.stderr or install.stdout}"
            )

    @staticmethod
    def _ensure_native_toolchain_command() -> str:
        """Return a bounded best-effort command that guarantees python3/make/g++.

        better-sqlite3 is a native dependency of the Runtime.  Most images
        download its prebuilt binary, but when that fetch fails pnpm compiles
        from source with node-gyp, which requires python3, make, g++ and gcc.
        This is idempotent: it exits early when the toolchain is present.
        """
        return (
            "set -e; "
            "if command -v python3 >/dev/null 2>&1 "
            "&& command -v make >/dev/null 2>&1 "
            "&& command -v g++ >/dev/null 2>&1; then "
            "exit 0; "
            "fi; "
            "export DEBIAN_FRONTEND=noninteractive; "
            "if command -v apt-get >/dev/null 2>&1; then "
            "apt-get update -qq && apt-get install -y -qq python3 make g++ gcc; "
            "elif command -v apk >/dev/null 2>&1; then "
            "apk add --no-cache python3 make g++ gcc; "
            "elif command -v microdnf >/dev/null 2>&1; then "
            "microdnf install -y python3 make gcc-c++ gcc; "
            "fi; "
            "command -v python3 >/dev/null 2>&1 || true; "
            "command -v make >/dev/null 2>&1 || true; "
            "command -v g++ >/dev/null 2>&1 || true"
        )

    @staticmethod
    def _ensure_node_command() -> str:
        """Return a bounded shell command that guarantees a usable Node 22.

        The command is idempotent and only exits early when the task image
        already provides Node >= 20 together with npm and corepack.  Minimal
        Terminal-Bench images often have no Node at all; some images ship a
        bare Node without npm/corepack (for example the extract-elf image),
        which breaks the later ``pnpm install`` step.  Whenever the required
        toolchain is incomplete, the pinned official Node binary (which
        includes node, npm and corepack) is installed through the available
        package manager.
        """
        node_version = "v22.17.0"
        return (
            "set -e; "
            "export DEBIAN_FRONTEND=noninteractive; "
            "node_version=$(command -v node >/dev/null 2>&1 && node --version 2>/dev/null || true); "
            "case \"$node_version\" in "
            "v2[0-9]*|v[3-9][0-9]*) ;; "
            "*) node_version= ;; esac; "
            "if [ -n \"$node_version\" ] "
            "&& command -v npm >/dev/null 2>&1 "
            "&& command -v corepack >/dev/null 2>&1 "
            "&& command -v pnpm >/dev/null 2>&1; then "
            "exit 0; "
            "fi; "
            "if command -v apt-get >/dev/null 2>&1; then "
            "apt-get update -qq && apt-get install -y -qq curl xz-utils ca-certificates; "
            "elif command -v apk >/dev/null 2>&1; then "
            "apk add --no-cache curl xz ca-certificates; "
            "elif command -v microdnf >/dev/null 2>&1; then "
            "microdnf install -y curl xz ca-certificates; "
            "else echo 'Nexora Node bootstrap: no supported package manager.'; exit 10; "
            "fi; "
            f"curl -fsSLO https://nodejs.org/dist/{node_version}/node-{node_version}-linux-x64.tar.xz && "
            f"tar -xJf node-{node_version}-linux-x64.tar.xz -C /opt && "
            f"rm node-{node_version}-linux-x64.tar.xz && "
            f"ln -sf /opt/node-{node_version}-linux-x64/bin/node /usr/local/bin/node && "
            f"ln -sf /opt/node-{node_version}-linux-x64/bin/npm /usr/local/bin/npm && "
            f"ln -sf /opt/node-{node_version}-linux-x64/bin/corepack /usr/local/bin/corepack && "
            "node --version"
        )
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        scenario_id = self._resolve_scenario_id()
        instruction_path = self.logs_dir / "harbor-instruction.md"
        instruction_path.write_text(instruction, encoding="utf-8")
        await environment.upload_file(instruction_path, "/tmp/harbor-instruction.md")

        result = await environment.exec(
            command=(
                "mkdir -p /app && cd /opt/nexora && "
                "node --import tsx harness/nexora-bench/src/cli.ts harbor-trial "
                f"--provider {quote(self.provider_mode)} "
                f"--task {quote(scenario_id)} "
                f"--manifest {quote(self.manifest_path)} "
                "--instruction-file /tmp/harbor-instruction.md "
                "--workspace /app "
                "--data-dir /logs/artifacts/nexora-run-data "
                "--fact-bundle /logs/artifacts/nexora-runtime-fact-bundle.json"
            ),
            env=self._runtime_env(),
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"Nexora Runtime trial failed: {result.stderr or result.stdout}"
            )

        context.metadata = {
            "runtime": "nexora",
            "scenario_id": scenario_id,
            "provider_mode": self.provider_mode,
            "fact_bundle": "nexora-runtime-fact-bundle.json",
        }
        (self.logs_dir / "adapter-result.json").write_text(
            json.dumps(context.metadata, indent=2), encoding="utf-8"
        )

    def _resolve_scenario_id(self) -> str:
        """Resolve the Nexora scenario for the Harbor task currently running.

        Harbor assigns every trial agent a durable session id of the form
        ``<task-id>__<trial-id>__agent``.  Nexora capability tasks in the
        Harbor dataset use the same id as the Nexora dataset scenario, so
        ``auto`` derives the scenario from the session id.  An explicit
        ``scenario_id`` remains available as an override for jobs that need it.
        """
        if self.scenario_id != "auto":
            return self.scenario_id
        if self.session_id is None:
            raise RuntimeError(
                "scenario_id='auto' requires Harbor to assign a trial session id "
                "before the agent runs."
            )
        task_name = self.session_id.split("__", 1)[0]
        if not task_name:
            raise RuntimeError(
                f"Could not derive a task name from Harbor session id {self.session_id!r}."
            )
        return task_name

    def _runtime_env(self) -> dict[str, str] | None:
        if self.provider_mode != "real":
            return None
        values = self._load_env_file()
        for key, value in self._get_env_prefixed("NEXORA_MODEL_").items():
            values[f"NEXORA_MODEL_{key}"] = value
        for key, value in self._get_env_prefixed("NEXORA_OPEN_").items():
            values[f"NEXORA_OPEN_{key}"] = value
        tavily = self._get_env("TAVILY_API_KEY")
        if tavily is not None:
            values["TAVILY_API_KEY"] = tavily
        return values or None

    def _load_env_file(self) -> dict[str, str]:
        env_file = self.repository_root / ".env"
        if not env_file.is_file():
            return {}
        values: dict[str, str] = {}
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'"}:
                value = value[1:-1]
            if key.startswith("NEXORA_MODEL_") or key == "TAVILY_API_KEY":
                values.setdefault(key, value)
        return values

    def _copy_runtime_source(self, target: Path) -> None:
        root = self.repository_root
        required_files = [
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "tsconfig.json",
            "tsconfig.runtime.json",
            "tsconfig.harness.json",
        ]
        for relative in required_files:
            source = root / relative
            if not source.is_file():
                raise FileNotFoundError(f"Missing Nexora source file: {source}")
            shutil.copy2(source, target / relative)

        for relative in [
            Path("packages/runtime"),
            Path("packages/harness"),
            Path("harness/nexora-bench"),
        ]:
            source = root / relative
            destination = target / relative
            shutil.copytree(
                source,
                destination,
                ignore=shutil.ignore_patterns(
                    "node_modules",
                    "dist",
                    "reports",
                    "reliability-reports",
                    ".tmp",
                    "__pycache__",
                    ".venv",
                    "harbor",
                ),
            )
