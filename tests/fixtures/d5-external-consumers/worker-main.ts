import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// @ts-expect-error internal package paths remain blocked
import type { RunStore } from "@nexora/runtime/dist/run-store.js";

import { createAcceptanceProvider } from "./provider.js";
import { runRuntimeWorker } from "./worker.js";

const workspace = requiredEnvironment("NEXORA_ACCEPTANCE_WORKSPACE");
let approvalBeforeMutation = "";
let approvalBeforeDiff = "";
const outcome = await runRuntimeWorker({
  workspace,
  input: "Mutate note.txt from before to after.",
  provider: createAcceptanceProvider(),
  approve(request) {
    if (
      request.toolName !== "filesystem.patch"
      || request.input === null
      || typeof request.input !== "object"
      || Array.isArray(request.input)
      || !("path" in request.input)
      || request.input.path !== "note.txt"
    ) {
      return false;
    }
    approvalBeforeMutation = readFileSync(join(workspace, "note.txt"), "utf8");
    approvalBeforeDiff = execFileSync("git", ["diff", "--name-only"], {
      cwd: workspace,
      encoding: "utf8"
    });
    return true;
  }
});

if (false) {
  const store: RunStore | null = null;
  // @ts-expect-error public Result is readonly
  outcome.result.status = "failed";
  // @ts-expect-error public Inspection is readonly
  outcome.inspection.status = "failed";
  console.log(store);
}

console.log(JSON.stringify({
  status: outcome.result.status,
  summary: outcome.result.summary,
  approvalBeforeMutation,
  approvalBeforeDiff,
  content: readFileSync(join(workspace, "note.txt"), "utf8"),
  evidence: outcome.result.evidence.length,
  invocations: outcome.inspection.invocations.map((item) => [
    item.toolName,
    item.status
  ]),
  firstEvent: outcome.events[0]?.type,
  lastEvent: outcome.events.at(-1)?.type,
  validationPassed: outcome.events.some(
    (event) => event.type === "validation.passed"
  )
}));

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
