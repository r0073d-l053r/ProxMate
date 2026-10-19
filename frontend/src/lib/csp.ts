/**
 * CSP `connect-src` for the per-request policy in `src/proxy.ts`.
 *
 * Kept free of Next imports so it can be unit tested.
 *
 *  - An operator-pinned value (CSP_CONNECT_SRC) always wins.
 *  - Otherwise the generic default is extended with the configured API's origin and
 *    its matching WebSocket origin. The generic production default only covers
 *    same-origin and HTTPS/WSS, so an API on another origin over plain HTTP (the
 *    documented two-port LOCAL setup, http://host:4000) would otherwise have every
 *    XHR, EventSource and console WebSocket refused by the browser.
 *  - A relative API URL (e.g. "/api") is same-origin and already covered by 'self'.
 */
export function buildConnectSrc(opts: { pinned: string | undefined; apiUrl: string | undefined; isDev: boolean }): string {
  const pinned = opts.pinned?.trim();
  if (pinned) return pinned;

  const sources = opts.isDev ? ["'self'", "https:", "http:", "wss:", "ws:"] : ["'self'", "https:", "wss:"];
  for (const origin of apiOrigins(opts.apiUrl)) {
    if (!sources.includes(origin)) sources.push(origin);
  }
  return sources.join(" ");
}

/** The API URL's HTTP origin plus the ws/wss origin the console socket uses. */
function apiOrigins(apiUrl: string | undefined): string[] {
  const raw = apiUrl?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return [url.origin, `${wsProtocol}//${url.host}`];
}
