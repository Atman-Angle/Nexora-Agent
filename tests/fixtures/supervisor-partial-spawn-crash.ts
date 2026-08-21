import { createAgent, type ModelDecisionContext, type RuntimeProvider } from "../../packages/harness/src/index.js";
import { responseCall, responseText } from "../runtime/runtime-testkit.js";

const workspace = process.argv[2];
const dataDir = process.argv[3];
if (workspace === undefined || dataDir === undefined) throw new Error("workspace and dataDir are required");

let idCount = 0;
const provider: RuntimeProvider = {
  async decide(context: ModelDecisionContext) {
    if (context.workerRun === true) return responseText("Recovered Worker completed.");
    return responseCall("nexora_delegate_workers", { assignments: [
      { objective: "Recover independent assignment A" },
      { objective: "Recover independent assignment B" }
    ] });
  }
};

const runtime = createAgent({
  workspace,
  dataDir,
  provider,
  tools: [],
  createId: () => {
    idCount += 1;
    // owner, Parent, model call, attempt, delegation, two assignments,
    // first Branch + Child, then the second Branch. Exit at that boundary.
    if (idCount === 10) process.exit(91);
    return `crash-id-${idCount}`;
  },
  delegationPolicy: { mode: "allowed", maxConcurrentWorkers: 2 }
});

await runtime.start({ input: "Crash after only one accepted Worker is spawned." });
process.exit(92);
