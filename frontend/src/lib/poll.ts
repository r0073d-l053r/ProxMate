/**
 * The page-level live refresh (the VM page polls its VM every few seconds), kept
 * free of React so its timing can be tested on its own.
 */

/** How long one poll request may take before it is abandoned and the next tick retries. */
export const POLL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Run `run` now and then every `intervalMs` until the returned stop function is
 * called. A tick is skipped while `active()` is false (e.g. the tab is hidden) or
 * while the previous run is still going — but never for longer than `timeoutMs`:
 * each run gets a signal that aborts at that point, and a run that still hasn't
 * settled by then no longer holds the poll back.
 */
export function startPoll(opts: {
  run: (signal: AbortSignal) => Promise<unknown>;
  intervalMs: number;
  timeoutMs?: number;
  active?: () => boolean;
}): () => void {
  const timeoutMs = opts.timeoutMs ?? POLL_REQUEST_TIMEOUT_MS;
  let runningSince: number | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped || (opts.active && !opts.active())) return;
    if (runningSince !== null && Date.now() - runningSince < timeoutMs) return;
    const started = Date.now();
    runningSince = started;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await opts.run(ctrl.signal);
    } catch {
      // A failed or abandoned run is retried on the next tick.
    } finally {
      clearTimeout(timer);
      if (runningSince === started) runningSince = null;
    }
  };

  void tick();
  const iv = setInterval(() => void tick(), opts.intervalMs);
  return () => {
    stopped = true;
    clearInterval(iv);
  };
}
