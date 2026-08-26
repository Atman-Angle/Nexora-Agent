import { createHash } from "node:crypto";

import {
  defineProviderAdapter,
  modelResponses
} from "@nexora/harness";

const INITIAL_DIGEST = `sha256:${createHash("sha256")
  .update("before\n")
  .digest("hex")}`;

export function createAcceptanceProvider() {
  return defineProviderAdapter({
    transport: { kind: "structured_output", promptCache: { mode: "automatic" } },
    async complete(request, operation) {
      const payload = JSON.parse(request.input) as {
        readonly originalTaskContract: {
          readonly userInputs: readonly { readonly text: string }[];
          readonly derivedTaskContract: null | { readonly goal: string };
        };
        readonly currentPlanAndChecks: {
          readonly plan: unknown | null;
        };
        readonly observationsAndRepair: {
          readonly toolObservations: readonly {
            readonly status: string;
            readonly toolName: string;
          }[];
        };
      };
      const firstInput = payload.originalTaskContract.userInputs[0]?.text ?? "";
      const semanticInput = [
        ...payload.originalTaskContract.userInputs.map((entry) => entry.text),
        payload.originalTaskContract.derivedTaskContract?.goal ?? ""
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
        && payload.originalTaskContract.userInputs.length === 1
        && payload.currentPlanAndChecks.plan === null
      ) {
        return modelResponses.input({
          question: "Confirm the mutation.",
          reason: "The external caller must provide one input."
        });
      }

      const file = /\bnote(?:-[a-z])?\.txt\b/i.exec(semanticInput)?.[0]
        ?? "note.txt";
      if (payload.currentPlanAndChecks.plan === null) {
        return plan(file);
      }

      const completedTools = payload.observationsAndRepair.toolObservations.filter(
        (observation) => observation.status === "succeeded"
      ).map((observation) => observation.toolName);
      if (completedTools.length === 0) {
        return modelResponses.tool({ name: "filesystem.read", arguments: { path: file } });
      }
      if (completedTools.length === 1) {
        return modelResponses.tool({
          name: "filesystem.patch",
          arguments: {
                path: file,
                expectedDigest: INITIAL_DIGEST,
                find: "before",
                replace: "after"
              }
        });
      }
      if (completedTools.length === 2) {
        return modelResponses.tool({ name: "filesystem.read", arguments: { path: file } });
      }
      return modelResponses.direct({ text: `Changed and verified ${file}.` });
    }
  });
}

function plan(file: string) {
  return modelResponses.plan({
      goal: `Change ${file} from before to after and verify it`,
      tasks: [
        {
          objective: `Read ${file} before mutation`,
          checks: [{ toolName: "filesystem.read" }]
        },
        {
          objective: `Patch ${file}`,
          checks: [{ toolName: "filesystem.patch" }]
        },
        {
          objective: `Read ${file} after mutation`,
          checks: [{ toolName: "filesystem.read" }]
        }
      ]
    });
}
