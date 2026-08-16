import type { RunStore } from "./run-store.js";

/** Structural Store surface exposed across the Runtime/Harness package boundary. */
export type RuntimeStorePort = Pick<RunStore, keyof RunStore>;
