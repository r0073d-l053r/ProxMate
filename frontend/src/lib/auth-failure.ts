import { AxiosError } from "axios";

/**
 * Why a session check (`/setup/status`, `/auth/me`) failed:
 *  - "signed-out": the API answered and this browser has no usable account —
 *    the session is gone (401) or the account no longer exists (404). Go to /login.
 *  - "unavailable": the API is unreachable or broken (network error, 5xx, …).
 *    The session may be fine, so redirecting would only bounce between pages
 *    (/login sends a cached user straight back); show a retry state instead.
 */
export function authFailure(err: unknown): "signed-out" | "unavailable" {
  const status = err instanceof AxiosError ? err.response?.status : undefined;
  return status === 401 || status === 404 ? "signed-out" : "unavailable";
}

/**
 * Delay before the next automatic retry after `failures` consecutive "unavailable"
 * results: 5s, 10s, 20s, … capped at 60s — so an unattended screen (e.g. a kiosk
 * panel) recovers by itself once the backend is back, without hammering it meanwhile.
 */
export function retryDelayMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}
