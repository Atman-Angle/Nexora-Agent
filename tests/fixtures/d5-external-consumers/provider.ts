import { createHash } from "node:crypto";

import {
  defineProviderAdapter,
  type ModelDecisionContext
} from "@nexora/runtime";

const INITIAL_DIGEST = `sha256:${createHash("sha256")
  .update("before\n")
  .digest("hex")}`;

export function createAcceptanceProvider() {
  return defineProviderAdapter({
    async complete(request, operation) {
      if (request.phase === "validation") {
        return JSON.stringify({ passed: true, issues: [] });
      }
      const payload = JSON.parse(request.input) as {
        readonly context: ModelDecisionContext;
      };
      const context = payload.context;
      const firstInput = context.run.inputHistory[0]?.text ?? "";
      const semanticInput = [
        ...context.run.inputHistory.map((entry) => entry.text),
        context.run.taskContract?.goal ?? ""
      ].join("\n");

      if (firstInput.startsWith("Cancel")) {
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            reject(operation.signal.reason);
          };
          if (operation.signal.aborted) abort();
          else operation.signal.addEventListener("abort", abort, { once: true });
        });
      }

      if (
        firstInput.startsWith("Ask")
        && context.run.inputCount === 1
        && context.run.currentPlan === null
      ) {
        return JSON.stringify({
          intent: {
            kind: "request_input",
            question: "Confirm the mutation.",
            reason: "The external caller must provide one input."
          }
        });
      }

      const file = /\bnote(?:-[a-z])?\.txt\b/i.exec(semanticInput)?.[0]
        ?? "note.txt";
      if (context.run.currentPlan === null) {
        return JSON.stringify(plan(file));
      }

      const activeStep = context.run.stepProgress.find(
        (step) => step.status === "active"
      )?.stepId;
      const activeObjective = context.run.currentPlan?.orderedSteps.find(
        (step) => step.id === activeStep
      )?.objective;
      if (activeObjective === `Read ${file} before mutation`) {
        return JSON.stringify({
          intent: {
            kind: "use_capabilities",
            calls: [{ capability: "filesystem.read", arguments: { path: file } }]
          }
        });
      }
      if (activeObjective === `Patch ${file}`) {
        return JSON.stringify({
          intent: {
            kind: "use_capabilities",
            calls: [{
              capability: "filesystem.patch",
              arguments: {
                path: file,
                expectedDigest: INITIAL_DIGEST,
                find: "before",
                replace: "after"
              }
            }]
          }
        });
      }
      if (activeObjective === `Read ${file} after mutation`) {
        return JSON.stringify({
          intent: {
            kind: "use_capabilities",
            calls: [{ capability: "filesystem.read", arguments: { path: file } }]
          }
        });
      }
      return JSON.stringify({
        intent: { kind: "finish", summary: `Changed and verified ${file}.` }
      });
    }
  });
}

function plan(file: string) {
  return {
    intent: {
      kind: "plan_tasks",
      taskContract: {
        goal: `Change ${file} from before to after and verify it`,
        constraints: [`Only change ${file}`],
        acceptanceCriteria: [`${file} contains after`]
      },
      tasks: [
        {
          objective: `Read ${file} before mutation`,
          completionRequirements: [{ kind: "capability_result", capability: "filesystem.read" }]
        },
        {
          objective: `Patch ${file}`,
          completionRequirements: [{ kind: "capability_result", capability: "filesystem.patch" }]
        },
        {
          objective: `Read ${file} after mutation`,
          completionRequirements: [{ kind: "capability_result", capability: "filesystem.read" }]
        }
      ]
    }
  };
}
