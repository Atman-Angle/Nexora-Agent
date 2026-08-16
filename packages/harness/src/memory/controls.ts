import { MemoryIdSchema, MemoryScopeSchema, type MemoryControlEvent, type MemoryControlInput, type MemoryControlResult, type MemoryRecord, type MemoryScope } from "./contracts.js";
import type { MemoryStore } from "./store.js";

export type MemoryRecallEligibilityReason =
  | "eligible"
  | "scope_disabled"
  | "not_active"
  | "expired"
  | "sensitive";

export type MemoryInspection = {
  readonly record: MemoryRecord;
  readonly recall: {
    readonly eligible: boolean;
    readonly reasons: readonly MemoryRecallEligibilityReason[];
  };
};

/** Host-facing, auditable user control surface over one Memory Store. */
export class MemoryControls {
  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  inspect(input: { readonly scope: MemoryScope; readonly memoryId: string; readonly asOf: string }): MemoryInspection | null {
    const scope = MemoryScopeSchema.parse(input.scope);
    const memoryId = MemoryIdSchema.parse(input.memoryId);
    const asOf = new Date(input.asOf);
    if (Number.isNaN(asOf.valueOf())) throw new Error("Memory inspection asOf must be a valid timestamp.");
    const record = this.#store.get(scope, memoryId);
    if (record === null) return null;
    const reasons: MemoryRecallEligibilityReason[] = [];
    if (!this.#store.isRecallEnabled(scope)) reasons.push("scope_disabled");
    if (record.status !== "active") reasons.push("not_active");
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= asOf.valueOf()) reasons.push("expired");
    if (record.sensitivity !== "normal") reasons.push("sensitive");
    return {
      record,
      recall: reasons.length === 0
        ? { eligible: true, reasons: ["eligible"] }
        : { eligible: false, reasons }
    };
  }

  apply(input: MemoryControlInput): MemoryControlResult {
    return this.#store.applyControl(input);
  }

  correct(input: Extract<MemoryControlInput, { readonly action: "correct" }>): MemoryControlResult {
    return this.apply(input);
  }

  invalidate(input: Extract<MemoryControlInput, { readonly action: "invalidate" }>): MemoryControlResult {
    return this.apply(input);
  }

  delete(input: Extract<MemoryControlInput, { readonly action: "delete" }>): MemoryControlResult {
    return this.apply(input);
  }

  setScopeRecall(input: Extract<MemoryControlInput, { readonly action: "set_scope_recall" }>): MemoryControlResult {
    return this.apply(input);
  }

  clearScope(input: Extract<MemoryControlInput, { readonly action: "clear_scope" }>): MemoryControlResult {
    return this.apply(input);
  }

  exportAudit(input: { readonly scope: MemoryScope; readonly limit?: number }): readonly MemoryControlEvent[] {
    return this.#store.listControlEvents(MemoryScopeSchema.parse(input.scope), input.limit ?? 500);
  }
}

export function createMemoryControls(store: MemoryStore): MemoryControls {
  return new MemoryControls(store);
}
