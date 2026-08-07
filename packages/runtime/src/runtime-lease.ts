import type { RunStore } from "./store/run-store.js";

/**
 * Owns the in-process lease cache and the heartbeat loop that keeps the
 * persistent lease alive while the Runtime is executing a Run.
 *
 * Each RuntimeEngine has one LeaseManager that tracks every Run it has
 * an active lease for. Methods are thin adapters over RunStore's
 * acquireLease/releaseLease/renewLease primitives.
 */
export class LeaseManager {
  readonly #leases = new Map<string, number>();
  readonly #store: RunStore;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #now: () => string;

  constructor(args: {
    readonly store: RunStore;
    readonly ownerId: string;
    readonly leaseTtlMs: number;
    readonly now: () => string;
  }) {
    this.#store = args.store;
    this.#ownerId = args.ownerId;
    this.#leaseTtlMs = args.leaseTtlMs;
    this.#now = args.now;
  }

  acquire(runId: string): void {
    const lease = this.#store.acquireLease({
      runId,
      ownerId: this.#ownerId,
      now: this.#now(),
      ttlMs: this.#leaseTtlMs
    });
    this.#leases.set(runId, lease.fencingToken);
  }

  release(runId: string): void {
    const fencingToken = this.#leases.get(runId);
    if (fencingToken === undefined) return;
    this.#store.releaseLease({ runId, ownerId: this.#ownerId, fencingToken });
    this.#leases.delete(runId);
  }

  requireFencingToken(runId: string): number {
    const token = this.#leases.get(runId);
    if (token === undefined) throw new Error(`RUN_LEASE_MISSING: ${runId}`);
    return token;
  }

  has(runId: string): boolean {
    return this.#leases.has(runId);
  }

  /**
   * Runs `operation` while renewing the lease on a heartbeat interval.
   * If renewal fails the error is captured and rethrown after the
   * operation completes so the caller can observe the lost lease.
   */
  async withHeartbeat<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const fencingToken = this.requireFencingToken(runId);
    this.#store.renewLease({
      runId,
      ownerId: this.#ownerId,
      fencingToken,
      now: this.#now(),
      ttlMs: this.#leaseTtlMs
    });
    let leaseError: unknown = null;
    const interval = setInterval(() => {
      if (leaseError !== null) return;
      try {
        this.#store.renewLease({
          runId,
          ownerId: this.#ownerId,
          fencingToken,
          now: this.#now(),
          ttlMs: this.#leaseTtlMs
        });
      } catch (error) {
        leaseError = error;
      }
    }, Math.max(10, Math.floor(this.#leaseTtlMs / 3)));
    try {
      const result = await operation();
      if (leaseError !== null) throw leaseError;
      return result;
    } finally {
      clearInterval(interval);
    }
  }
}
