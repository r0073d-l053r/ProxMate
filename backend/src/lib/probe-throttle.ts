/**
 * Rate-limit a slow per-row probe (a guest-agent call, a dial into the guest) that
 * a page polls every few seconds. At most one probe per key per `intervalMs`:
 * callers while one is running share it, and callers inside the interval after it
 * get `idle` without probing. In memory, like lib/in-flight — the API is a single
 * Node process.
 */
export interface ProbeThrottle<T> {
  run(key: string, idle: T, probe: () => Promise<T>): Promise<T>;
  /** Drop a key's record (its state is final, so it won't be probed again). */
  forget(key: string): void;
  /** Test hook: forget every key. */
  reset(): void;
}

export function probeThrottle<T>(intervalMs: number): ProbeThrottle<T> {
  const lastProbeAt = new Map<string, number>();
  const running = new Map<string, Promise<T>>();
  return {
    run(key, idle, probe) {
      const shared = running.get(key);
      if (shared) return shared;
      const last = lastProbeAt.get(key);
      if (last !== undefined && Date.now() - last < intervalMs) return Promise.resolve(idle);
      if (lastProbeAt.size > 1000) lastProbeAt.clear();
      lastProbeAt.set(key, Date.now());
      const p = (async () => {
        try {
          return await probe();
        } finally {
          running.delete(key);
        }
      })();
      running.set(key, p);
      return p;
    },
    forget(key) {
      lastProbeAt.delete(key);
    },
    reset() {
      lastProbeAt.clear();
      running.clear();
    },
  };
}
