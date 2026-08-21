import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAgent,
  DelegationPolicySchema,
  renderWorkerAssignmentPrompt,
  type ModelDecisionContext,
  type RuntimeOperationContext,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import { parseDelegationControl } from "../../packages/harness/src/planning.js";
import { responseCall, responseInput, responseText } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Supervisor / Coordinator completion Contract", () => {
  it("validates one closed, mechanically enforceable DelegationPolicy", () => {
    expect(DelegationPolicySchema.parse({ mode: "allowed" })).toEqual({
      mode: "allowed",
      maxConcurrentWorkers: 8
    });
    expect(() => DelegationPolicySchema.parse({
      mode: "allowed",
      allowedProfiles: ["researcher"],
      workerToolPolicies: {}
    })).toThrow(/explicit Tool allowlist/);
    expect(() => DelegationPolicySchema.parse({ mode: "allowed", maxConcurrentWorkers: 1 }))
      .toThrow();
  });

  it("forbidden hides the control and rejects a forged action with zero Children", async () => {
    const workspace = temporaryWorkspace("nexora-policy-forbidden-");
    const provider = new ForbiddenProbeProvider();
    const runtime = createAgent({
      workspace,
      provider,
      tools: [],
      delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
    });
    const result = await runtime.start({ input: "Complete without Workers." });
    expect(result.status).toBe("succeeded");
    expect(provider.controlNames).not.toContain("nexora_delegate_workers");
    expect(runtime.listBranches(result.runId)).toHaveLength(0);
    expect((await runtime.inspect(result.runId)).events.some((event) => (
      event.type === "response.rejected" && JSON.stringify(event.payload).includes("WORKER_DELEGATION_FORBIDDEN")
    ))).toBe(true);
    await runtime.close();
  });

  it("required cannot silently finish in Parent-only mode", async () => {
    const workspace = temporaryWorkspace("nexora-policy-required-");
    const runtime = createAgent({
      workspace,
      provider: new RequiredFallbackProvider(),
      tools: [],
      delegationPolicy: { mode: "required", maxConcurrentWorkers: 2 }
    });
    const result = await runtime.start({ input: "Need information before safe decomposition." });
    expect(result.status).toBe("waiting");
    expect((await runtime.inspect(result.runId)).events.some((event) => (
      event.type === "response.rejected" && JSON.stringify(event.payload).includes("DELEGATION_REQUIRED")
    ))).toBe(true);
    await runtime.close();
  });

  it("renders the canonical Worker boundary and compiles contribution guidance", () => {
    const prompt = renderWorkerAssignmentPrompt({
      role: "reviewer",
      objective: "Review the proposed patch.",
      finalDeliverable: "A release-readiness recommendation.",
      contribution: "Check the acceptance criteria."
    });
    expect(prompt).toContain("Role: reviewer");
    expect(prompt).toContain("Never delegate");
    const action = parseDelegationControl({
      callId: "delegation-quality",
      name: "nexora_delegate_workers",
      arguments: {
        finalDeliverable: "An evidence-based recommendation.",
        assignments: [
          { objective: "Inspect scheduler recovery.", contribution: "Find lifecycle facts." },
          { objective: "Inspect retry mapping.", contribution: "Find contradictory evidence." }
        ]
      }
    });
    expect(action.assignments[0]!.objective).toContain("Find lifecycle facts.");
    expect(action.assignments[1]!.objective).toContain("Find contradictory evidence.");
  });
});

class ForbiddenProbeProvider implements RuntimeProvider {
  controlNames: string[] = [];
  #calls = 0;
  async decide(_context: ModelDecisionContext, operation: RuntimeOperationContext) {
    this.controlNames = operation.compiledPrompt?.tools.map((tool) => tool.name) ?? [];
    this.#calls += 1;
    return this.#calls === 1
      ? responseCall("nexora_delegate_workers", { assignments: [{ objective: "A" }, { objective: "B" }] })
      : responseText("Completed locally.");
  }
}

class RequiredFallbackProvider implements RuntimeProvider {
  #calls = 0;
  async decide() {
    this.#calls += 1;
    return this.#calls === 1
      ? responseText("Unsafe Parent-only completion.")
      : responseInput("Which two independent targets should be inspected?", "Safe delegation needs user-exclusive scope.");
  }
}

function temporaryWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  roots.push(workspace);
  return workspace;
}
