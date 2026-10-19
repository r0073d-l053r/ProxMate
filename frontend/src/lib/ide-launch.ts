/**
 * Helpers for the VM page's "Open IDE" flow, which may wait minutes for an install
 * or a node move before the editor can open.
 */

export type PollResult<T> = { status: "done"; value: T } | { status: "timeout" } | { status: "cancelled" };

/**
 * Poll `fetch` every `intervalMs` until `done(value)`, the deadline passes, or
 * `cancelled()` turns true (the page unmounted) — so a long wait never keeps hitting
 * the API, or acting, after the user has left.
 */
export async function pollUntil<T>(opts: {
  fetch: () => Promise<T>;
  done: (value: T) => boolean;
  intervalMs: number;
  timeoutMs: number;
  cancelled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<PollResult<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  while (now() < deadline) {
    await sleep(opts.intervalMs);
    if (opts.cancelled()) return { status: "cancelled" };
    const value = await opts.fetch();
    if (opts.cancelled()) return { status: "cancelled" };
    if (opts.done(value)) return { status: "done", value };
  }
  return { status: "timeout" };
}

/**
 * `window.open`, reporting whether a window actually opened. Browsers only allow a
 * pop-up shortly after a click, so one opened at the end of a long wait is usually
 * blocked (null) — the caller then offers a button that opens it from a fresh click.
 */
export function openPopup(
  url: string,
  name: string,
  features: string,
  open: (url: string, name: string, features: string) => Window | null = (u, n, f) => window.open(u, n, f),
): boolean {
  return open(url, name, features) != null;
}
