import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryLifecycleError,
  openMemoryStore,
  type CreateMemoryInput,
  type MemoryPromotion
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
const BASE = "2026-08-11T00:00:00.000Z";
const LATER = "2026-08-11T01:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E092 Memory promotion and supersession", () => {
  it("promotes an unverified candidate only through an explicit actor/time decision", () => {
    const store = openMemoryStore({ stateDir: fixture() });
    const candidate = store.create(memory({ status: "candidate" }));

    const result = store.promote({
      scope: candidate.scope,
      memoryId: candidate.memoryId,
      promotion: explicitPromotion()
    });

    expect(result).toEqual({
      outcome: "promoted",
      record: expect.objectContaining({
        memoryId: candidate.memoryId,
        status: "active",
        updatedAt: LATER,
        promotion: explicitPromotion()
      })
    });
    expect(store.promote({
      scope: candidate.scope,
      memoryId: candidate.memoryId,
      promotion: explicitPromotion()
    })).toEqual(result);
    store.close();
  });

  it("requires persisted verification for verified promotion and supports explicit revalidation", () => {
    const store = openMemoryStore({ stateDir: fixture() });
    const candidate = store.create(memory({ status: "candidate" }));
    const verifiedPromotion: MemoryPromotion = {
      mode: "verified",
      promotedBy: "verification-policy",
      promotedAt: LATER
    };

    expectLifecycleCode(() => store.promote({
      scope: candidate.scope,
      memoryId: candidate.memoryId,
      promotion: verifiedPromotion
    }), "MEMORY_NOT_VERIFIED");

    const revalidated = store.revalidate({
      scope: candidate.scope,
      memoryId: candidate.memoryId,
      verification: {
        state: "verified",
        verifiedAt: "2026-08-11T00:30:00.000Z",
        evidenceRefs: ["evidence:verification-2"]
      },
      updatedAt: "2026-08-11T00:30:00.000Z"
    });
    const promoted = store.promote({
      scope: candidate.scope,
      memoryId: candidate.memoryId,
      promotion: verifiedPromotion
    });

    expect(revalidated?.verification).toEqual(expect.objectContaining({ state: "verified" }));
    expect(promoted.outcome).toBe("promoted");
    expect(promoted.record.status).toBe("active");
    store.close();
  });

  it("deduplicates exact scoped type/statement/sensitivity matches and preserves the duplicate", () => {
    const store = openMemoryStore({ stateDir: fixture() });
    const active = store.create(memory({ memoryId: "active-memory", status: "active" }));
    const duplicate = store.create(memory({
      memoryId: "duplicate-candidate",
      status: "candidate",
      source: {
        sourceRunId: "run-b",
        ref: "input:2",
        digest: `sha256:${"b".repeat(64)}`
      }
    }));

    const result = store.promote({
      scope: duplicate.scope,
      memoryId: duplicate.memoryId,
      promotion: explicitPromotion()
    });

    expect(result).toEqual({
      outcome: "deduplicated",
      record: active,
      duplicate: expect.objectContaining({
        memoryId: duplicate.memoryId,
        status: "superseded",
        supersededByMemoryId: active.memoryId,
        updatedAt: LATER
      })
    });
    expect(store.list({ scope: active.scope, status: "active" })).toEqual([active]);
    store.close();
  });

  it("updates through one atomic supersession path and persists bidirectional lineage", () => {
    const root = fixture();
    const first = openMemoryStore({ stateDir: root });
    const predecessor = first.create(memory({ memoryId: "old", status: "active" }));
    const replacement = first.create(memory({
      memoryId: "new",
      status: "candidate",
      statement: "Prefer exact scoped retrieval before broader retrieval."
    }));

    const supersession = {
      scope: replacement.scope,
      replacementMemoryId: replacement.memoryId,
      predecessorMemoryIds: [predecessor.memoryId],
      promotion: explicitPromotion(),
      reason: "The preference was clarified."
    };
    const result = first.supersede(supersession);
    first.close();

    const second = openMemoryStore({ stateDir: root });
    expect(result.replacement).toEqual(expect.objectContaining({
      status: "active",
      supersedesMemoryIds: [predecessor.memoryId],
      supersession: { reason: "The preference was clarified.", occurredAt: LATER }
    }));
    expect(second.get(predecessor.scope, predecessor.memoryId)).toEqual(expect.objectContaining({
      status: "superseded",
      supersededByMemoryId: replacement.memoryId
    }));
    expect(second.get(replacement.scope, replacement.memoryId)).toEqual(result.replacement);
    expect(second.supersede(supersession)).toEqual(result);
    second.close();
  });

  it("merges multiple active Memories through the same supersession transaction", () => {
    const store = openMemoryStore({ stateDir: fixture() });
    const first = store.create(memory({ memoryId: "first", status: "active", statement: "Use exact scope." }));
    const second = store.create(memory({ memoryId: "second", status: "active", statement: "Keep provenance." }));
    const merged = store.create(memory({
      memoryId: "merged",
      status: "candidate",
      statement: "Use exact scope and keep provenance."
    }));

    const result = store.supersede({
      scope: merged.scope,
      replacementMemoryId: merged.memoryId,
      predecessorMemoryIds: [second.memoryId, first.memoryId],
      promotion: explicitPromotion(),
      reason: "The two compatible preferences were consolidated."
    });

    expect(result.replacement.supersedesMemoryIds).toEqual([first.memoryId, second.memoryId]);
    expect(result.predecessors).toEqual([
      expect.objectContaining({ memoryId: first.memoryId, status: "superseded" }),
      expect.objectContaining({ memoryId: second.memoryId, status: "superseded" })
    ]);
    expect(store.list({ scope: merged.scope, status: "active" })).toEqual([result.replacement]);
    store.close();
  });

  it("rejects missing, non-active and unchanged predecessors without partial writes", () => {
    const store = openMemoryStore({ stateDir: fixture() });
    const active = store.create(memory({ memoryId: "active", status: "active" }));
    const candidate = store.create(memory({
      memoryId: "candidate",
      status: "candidate",
      statement: "A changed statement."
    }));

    expectLifecycleCode(() => store.supersede({
      scope: candidate.scope,
      replacementMemoryId: candidate.memoryId,
      predecessorMemoryIds: [active.memoryId, "missing"],
      promotion: explicitPromotion(),
      reason: "Must be atomic."
    }), "MEMORY_NOT_FOUND");
    expect(store.get(active.scope, active.memoryId)).toEqual(active);
    expect(store.get(candidate.scope, candidate.memoryId)).toEqual(candidate);

    const unchanged = store.create(memory({ memoryId: "unchanged", status: "candidate" }));
    expectLifecycleCode(() => store.supersede({
      scope: unchanged.scope,
      replacementMemoryId: unchanged.memoryId,
      predecessorMemoryIds: [active.memoryId],
      promotion: explicitPromotion(),
      reason: "No content changed."
    }), "MEMORY_UNCHANGED_REPLACEMENT");
    expect(store.get(active.scope, active.memoryId)).toEqual(active);
    expect(store.get(unchanged.scope, unchanged.memoryId)).toEqual(unchanged);

    expectLifecycleCode(() => store.supersede({
      scope: candidate.scope,
      replacementMemoryId: candidate.memoryId,
      predecessorMemoryIds: [unchanged.memoryId],
      promotion: explicitPromotion(),
      reason: "Candidate cannot be a predecessor."
    }), "MEMORY_PREDECESSOR_NOT_ACTIVE");
    store.close();
  });

  it("expires only due candidate/active records in the exact scope", () => {
    const store = openMemoryStore({ stateDir: fixture() });
    const dueCandidate = store.create(memory({
      memoryId: "due-candidate",
      status: "candidate",
      expiresAt: "2026-08-11T00:30:00.000Z"
    }));
    const dueActive = store.create(memory({
      memoryId: "due-active",
      status: "active",
      statement: "Another due record.",
      expiresAt: "2026-08-11T00:45:00.000Z"
    }));
    const future = store.create(memory({
      memoryId: "future",
      status: "active",
      statement: "A future record.",
      expiresAt: "2026-08-12T00:00:00.000Z"
    }));
    const otherScope = store.create(memory({
      memoryId: "other-scope",
      status: "active",
      statement: "A different user record.",
      scope: { ...future.scope, userId: "user-b" },
      expiresAt: "2026-08-11T00:30:00.000Z"
    }));

    const expired = store.expire({ scope: future.scope, asOf: LATER });

    expect(expired.map((record) => record.memoryId)).toEqual([dueActive.memoryId, dueCandidate.memoryId]);
    expect(expired.every((record) => record.status === "expired" && record.updatedAt === LATER)).toBe(true);
    expect(store.get(future.scope, future.memoryId)).toEqual(future);
    expect(store.get(otherScope.scope, otherScope.memoryId)).toEqual(otherScope);
    expect(store.expire({ scope: future.scope, asOf: LATER })).toEqual([]);
    store.close();
  });

  it("prevents manual lifecycle bypass and hides records behind wrong scope", () => {
    const store = openMemoryStore({ stateDir: fixture() });
    const candidate = store.create(memory({ status: "candidate" }));
    const seededActive = store.create(memory({
      memoryId: "seeded-active",
      status: "active",
      statement: "A trusted Host-seeded Memory."
    }));
    const wrongScope = { ...candidate.scope, workspaceId: "workspace-b" };

    expect(() => store.setStatus({
      scope: candidate.scope,
      memoryId: candidate.memoryId,
      status: "active",
      updatedAt: LATER
    } as never)).toThrow();
    expectLifecycleCode(() => store.promote({
      scope: wrongScope,
      memoryId: candidate.memoryId,
      promotion: explicitPromotion()
    }), "MEMORY_NOT_FOUND");
    expectLifecycleCode(() => store.promote({
      scope: seededActive.scope,
      memoryId: seededActive.memoryId,
      promotion: explicitPromotion()
    }), "MEMORY_NOT_CANDIDATE");
    expect(store.get(candidate.scope, candidate.memoryId)).toEqual(candidate);
    store.close();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e092-memory-lifecycle-"));
  roots.push(root);
  return root;
}

function memory(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    memoryId: "memory-1",
    memoryType: "preference",
    statement: "Prefer deterministic retrieval before semantic search.",
    scope: {
      userId: "user-a",
      projectId: "project-a",
      workspaceId: "workspace-a"
    },
    source: {
      sourceRunId: "run-a",
      ref: "input:1",
      digest: DIGEST
    },
    verification: { state: "unverified" },
    status: "candidate",
    sensitivity: "normal",
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides
  };
}

function explicitPromotion(): MemoryPromotion {
  return {
    mode: "explicit",
    promotedBy: "user-operator",
    promotedAt: LATER
  };
}

function expectLifecycleCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected lifecycle error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryLifecycleError);
    expect((error as MemoryLifecycleError).code).toBe(code);
  }
}
