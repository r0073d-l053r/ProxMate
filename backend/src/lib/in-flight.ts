/**
 * Long-running operations running in THIS process, keyed by the id of the row
 * they drive (a VirtualMachine or MateState id). The startup/periodic reconciler
 * (task-reconcile.service.ts) never touches a row listed here: its operation is
 * alive and will settle the row itself. The API is a single Node process (see the
 * quota lock in vm.service), so an in-memory registry is the whole truth — after a
 * restart it is empty, which is exactly when stuck rows need settling.
 */
const active = new Map<string, number>();

/** Mark `ids` as having an operation in flight; returns an idempotent release. */
export function beginInFlight(...ids: string[]): () => void {
  for (const id of ids) active.set(id, (active.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) {
      const n = (active.get(id) ?? 1) - 1;
      if (n <= 0) active.delete(id);
      else active.set(id, n);
    }
  };
}

/** Whether an operation on this row is running in this process right now. */
export function isInFlight(id: string): boolean {
  return active.has(id);
}

/** How many operations on this row are running in this process. */
export function inFlightCount(id: string): number {
  return active.get(id) ?? 0;
}

/** Test hook: forget every registration. */
export function resetInFlight(): void {
  active.clear();
}
