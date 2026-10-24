/**
 * Why a recent create failed, for a row its failure removed. A create answers as
 * soon as its row exists, so a failure that drops the row (settleFailedCreate) is
 * no longer in any response; the VM page asks for the row, gets a 404, and reads
 * the reason from here instead. Kept in memory for an hour, for the row's owner and
 * admins only (see `createFailureFor`). Single process, like lib/in-flight.
 */
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

interface CreateFailure {
  ownerId: string;
  message: string;
  at: number;
}

const failures = new Map<string, CreateFailure>();

/** Record that the create of row `vmId` (owned by `ownerId`) failed with `message`. */
export function recordCreateFailure(vmId: string, ownerId: string, message: string): void {
  const now = Date.now();
  for (const [id, f] of failures) {
    if (now - f.at > TTL_MS) failures.delete(id);
  }
  // Oldest first (insertion order): drop from the front to stay bounded.
  while (failures.size >= MAX_ENTRIES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
  failures.delete(vmId);
  failures.set(vmId, { ownerId, message, at: now });
}

/** The failure message for row `vmId`, if `user` is its owner or an admin and it is recent. */
export function createFailureFor(vmId: string, user: { id: string; role: string }): string | null {
  const f = failures.get(vmId);
  if (!f) return null;
  if (Date.now() - f.at > TTL_MS) {
    failures.delete(vmId);
    return null;
  }
  return user.role === 'admin' || user.id === f.ownerId ? f.message : null;
}

/** Test hook: forget every failure. */
export function resetCreateFailures(): void {
  failures.clear();
}
