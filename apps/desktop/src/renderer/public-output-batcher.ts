export const PUBLIC_OUTPUT_FLUSH_MS = 80;

export function createPublicOutputBatcher(
  schedule: (flush: () => void) => number,
  flush: (keys: readonly string[]) => void
): { queue(key: string): void; discard(key: string): void } {
  const pending = new Set<string>();
  let scheduled = false;
  return {
    queue(key) {
      pending.add(key);
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        const keys = [...pending];
        pending.clear();
        if (keys.length > 0) flush(keys);
      });
    },
    discard(key) { pending.delete(key); }
  };
}
