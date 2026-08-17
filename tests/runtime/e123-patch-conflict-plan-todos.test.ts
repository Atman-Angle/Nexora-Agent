import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgent,
  createBuiltInTools,
  type ModelDecisionContext
} from "../../packages/harness/src/index.js";
import {
  ScriptedRuntimeProvider,
  responseCall,
  responseInput,
  responsePlanAndTools
} from "./runtime-testkit.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E123 patch conflict recovery and current Context", () => {
  it("publishes current patch facts and stops pinning the cleared objective-only failure", async () => {
    const workspace = tempRoot();
    const content = "alpha\nbeta\n";
    const currentDigest = digest(content);
    writeFileSync(join(workspace, "note.txt"), content, "utf8");
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools({
        goal: "Update note.txt safely.",
        tasks: [{ objective: "Patch and inspect note.txt" }]
      }, [{
        name: "filesystem.patch",
        arguments: {
          path: "note.txt",
          expectedDigest: digest("stale\n"),
          find: "alpha",
          replace: "ALPHA"
        }
      }]),
      responseCall("filesystem.read", { path: "note.txt" }),
      responseInput("Pause after recovery.", "Inspect projected currentness.")
    ]);
    const runtime = createAgent({
      workspace,
      provider,
      tools: createBuiltInTools()
    });

    const pending = await runtime.start({ input: "Patch note.txt, then inspect it." });
    expect(pending.status).toBe("waiting");
    expect(pending.stopReason).toBe("APPROVAL_REQUIRED");
    const request = (await runtime.inspect(pending.runId)).snapshot.pendingRequest;
    expect(request?.kind).toBe("approval");

    const result = await runtime.resume({
      runId: pending.runId,
      approvalDecision: { requestId: request!.id, approved: true }
    });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe(content);
    const failed = view.toolInvocations.find((invocation) => invocation.toolName === "filesystem.patch");
    expect(failed).toMatchObject({
      status: "failed",
      errorJson: {
        code: "CONTENT_CONFLICT",
        retryable: false,
        details: {
          path: "note.txt",
          currentDigest,
          findOccurrences: 1,
          recovery: "retry_with_current_digest"
        }
      }
    });
    expect(provider.contexts[1]?.toolObservations.find((observation) => (
      observation.toolName === "filesystem.patch"
    ))).toMatchObject({
      status: "failed",
      retention: { class: "unresolved_error", critical: true },
      error: { details: { currentDigest, recovery: "retry_with_current_digest" } }
    });
    expect(provider.contexts[2]?.run.lastError).toBeNull();
    expect(provider.contexts[2]?.toolObservations.find((observation) => (
      observation.toolName === "filesystem.patch"
    ))).toMatchObject({
      status: "failed",
      retention: { class: "active_step", critical: false }
    });
    expect(provider.contexts[2]?.toolObservations.find((observation) => (
      observation.toolName === "filesystem.read"
    ))).toMatchObject({
      status: "succeeded",
      facts: { path: "note.txt", content, digest: currentDigest }
    });
  });

  it("requires inspection when the stale patch target is no longer unique", async () => {
    const workspace = tempRoot();
    const content = "alpha\nalpha\n";
    writeFileSync(join(workspace, "note.txt"), content, "utf8");
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools({
        goal: "Update note.txt safely.",
        tasks: [{ objective: "Patch note.txt" }]
      }, [{
        name: "filesystem.patch",
        arguments: {
          path: "note.txt",
          expectedDigest: digest("stale\n"),
          find: "alpha",
          replace: "ALPHA"
        }
      }]),
      responseInput("Pause after conflict.", "The target requires inspection.")
    ]);
    const runtime = createAgent({ workspace, provider, tools: createBuiltInTools() });

    const pending = await runtime.start({ input: "Patch note.txt safely." });
    const request = (await runtime.inspect(pending.runId)).snapshot.pendingRequest;
    const result = await runtime.resume({
      runId: pending.runId,
      approvalDecision: { requestId: request!.id, approved: true }
    });
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations[0]?.errorJson).toMatchObject({
      code: "CONTENT_CONFLICT",
      details: {
        currentDigest: digest(content),
        findOccurrences: 2,
        recovery: "inspect_current_content"
      }
    });
    expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe(content);
  });

  it("retries a still-unique patch with the returned digest and no extra read", async () => {
    const workspace = tempRoot();
    const content = "alpha\nbeta\n";
    const currentDigest = digest(content);
    writeFileSync(join(workspace, "note.txt"), content, "utf8");
    const provider = new ScriptedRuntimeProvider([
      responsePlanAndTools({
        goal: "Update note.txt safely.",
        tasks: [{ objective: "Patch note.txt" }]
      }, [{
        name: "filesystem.patch",
        arguments: {
          path: "note.txt",
          expectedDigest: digest("stale\n"),
          find: "alpha",
          replace: "ALPHA"
        }
      }]),
      (context: ModelDecisionContext) => {
        expect(context.toolObservations.at(-1)?.error).toMatchObject({
          details: { currentDigest, findOccurrences: 1, recovery: "retry_with_current_digest" }
        });
        return responseCall("filesystem.patch", {
          path: "note.txt",
          expectedDigest: currentDigest,
          find: "alpha",
          replace: "ALPHA"
        });
      },
      responseInput("Pause after retry.", "Inspect the successful recovery.")
    ]);
    const runtime = createAgent({ workspace, provider, tools: createBuiltInTools() });

    let result = await runtime.start({ input: "Patch note.txt safely." });
    for (let approval = 0; approval < 2; approval += 1) {
      const request = (await runtime.inspect(result.runId)).snapshot.pendingRequest;
      expect(request?.kind).toBe("approval");
      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: request!.id, approved: true }
      });
    }
    const view = await runtime.inspect(result.runId);
    await runtime.close();

    expect(result.status).toBe("waiting");
    expect(view.toolInvocations.map((invocation) => [invocation.toolName, invocation.status])).toEqual([
      ["filesystem.patch", "failed"],
      ["filesystem.patch", "succeeded"]
    ]);
    expect(provider.contexts[2]?.run.lastError).toBeNull();
    expect(provider.contexts[2]?.toolObservations.find((observation) => (
      observation.status === "failed"
    ))?.retention).toMatchObject({ class: "active_step", critical: false });
    expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("ALPHA\nbeta\n");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e123-patch-conflict-"));
  roots.push(root);
  return root;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
