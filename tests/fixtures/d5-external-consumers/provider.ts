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
          type: "request_input",
          question: "Confirm the mutation.",
          reason: "The external caller must provide one input."
        });
      }

      const file = /\bnote(?:-[a-z])?\.txt\b/i.exec(semanticInput)?.[0]
        ?? "note.txt";
      if (context.run.currentPlan === null) {
        return JSON.stringify(plan(context, file));
      }

      const activeStep = context.run.stepProgress.find(
        (step) => step.status === "active"
      )?.stepId;
      if (activeStep === "read-before") {
        return JSON.stringify({
          type: "call_tool",
          stepId: "read-before",
          checkIds: ["read-before-check"],
          toolName: "filesystem.read",
          input: { path: file }
        });
      }
      if (activeStep === "patch") {
        return JSON.stringify({
          type: "call_tool",
          stepId: "patch",
          checkIds: ["patch-check"],
          toolName: "filesystem.patch",
          input: {
            path: file,
            expectedDigest: INITIAL_DIGEST,
            find: "before",
            replace: "after"
          }
        });
      }
      if (activeStep === "read-after") {
        return JSON.stringify({
          type: "call_tool",
          stepId: "read-after",
          checkIds: ["read-after-check"],
          toolName: "filesystem.read",
          input: { path: file }
        });
      }
      return JSON.stringify({
        type: "propose_finish",
        summary: `Changed and verified ${file}.`,
        evidenceIds: context.run.evidence.map((evidence) => evidence.id)
      });
    }
  });
}

function plan(context: ModelDecisionContext, file: string) {
  return {
    type: "set_plan",
    basedOnVersion: null,
    taskContract: {
      version: 1,
      inputVersion: context.run.inputCount,
      goal: `Change ${file} from before to after and verify it`,
      workspace: context.workspace,
      constraints: [`Only change ${file}`],
      acceptanceCriteria: [`${file} contains after`]
    },
    orderedSteps: [
      {
        id: "read-before",
        objective: `Read ${file} before mutation`,
        acceptanceChecks: [{
          id: "read-before-check",
          kind: "tool_result",
          required: true,
          toolName: "filesystem.read",
          expectedStatus: "success"
        }]
      },
      {
        id: "patch",
        objective: `Patch ${file}`,
        acceptanceChecks: [{
          id: "patch-check",
          kind: "tool_result",
          required: true,
          toolName: "filesystem.patch",
          expectedStatus: "success"
        }]
      },
      {
        id: "read-after",
        objective: `Read ${file} after mutation`,
        acceptanceChecks: [{
          id: "read-after-check",
          kind: "tool_result",
          required: true,
          toolName: "filesystem.read",
          expectedStatus: "success"
        }]
      }
    ]
  };
}
