/**
 * A small in-process key/value store whose entries expire after a fixed TTL.
 * Used for short-lived, single-use login state (2FA challenge attempts, WebAuthn
 * challenges) that must be remembered server-side but does not need to survive a
 * restart: losing it only means an in-flight sign-in starts over.
 *
 * In-process is deliberate: the backend runs as one Node process (SQLite, no
 * horizontal scaling), so a Map is authoritative, and it avoids a DB write per
 * sign-in step. Size is capped so an unauthenticated caller requesting many
 * challenges cannot grow it without bound; the oldest entries go first.
 */
export class EphemeralStore<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  set(key: string, value: V): void {
    this.prune();
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** The live value for `key`, or undefined when absent or expired. */
  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  /**
   * Remove and return the live value for `key`. Synchronous, so of two
   * concurrent callers exactly one gets the value — this is what makes an
   * entry single-use.
   */
  take(key: string): V | undefined {
    const v = this.get(key);
    this.entries.delete(key);
    return v;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
  }
}
