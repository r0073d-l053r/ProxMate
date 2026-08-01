import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce CSP (Next 16 "proxy" — formerly middleware).
 *
 * `script-src 'nonce-…' 'strict-dynamic'` is the real XSS win: only scripts
 * carrying this request's nonce (and what they load) can run — inline-injected
 * script is dead even if a stored-XSS sink ever appears. Next injects the nonce
 * into its own framework/bundle <script> tags by parsing this header during SSR
 * (which is why nonce'd pages render dynamically).
 *
 * Deliberate relaxations so nothing breaks:
 *  - style-src allows 'unsafe-inline' (React sets inline style= attributes everywhere;
 *    style injection is far lower-risk than script injection).
 *  - connect-src is permissive (or operator-pinned via CSP_CONNECT_SRC) because the
 *    API + console WebSocket can live on a different origin (NEXT_PUBLIC_API_URL),
 *    unknown to this server process.
 *  - dev needs 'unsafe-eval' (React debug) + 'unsafe-inline' (Turbopack HMR).
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  // Operators behind a known API origin can pin this to e.g.
  // "'self' https://proxmate.example.com wss://proxmate.example.com". A blank/unset
  // value (e.g. an empty `${CSP_CONNECT_SRC:-}` from compose) falls back to the default.
  const pinnedConnect = process.env.CSP_CONNECT_SRC?.trim();
  const connectSrc = pinnedConnect || (isDev ? "'self' https: http: wss: ws:" : "'self' https: wss:");

  // `upgrade-insecure-requests` rewrites every http:// URL on the page to https://.
  // On an HTTPS deployment that is useful hardening; on a plain-HTTP one it is fatal
  // — the browser upgrades the page's OWN script/style/font URLs, nothing is
  // listening on :3000 over TLS, and every asset dies with ERR_SSL_PROTOCOL_ERROR
  // before the app can render. So send it only when the browser is actually on HTTPS.
  //
  // Decided per request, from the scheme the browser used, in this order:
  //   1. X-Forwarded-Proto — set by any sane reverse proxy, and the only signal that
  //      is right regardless of how the image was built.
  //   2. NEXT_PUBLIC_SITE_URL — a fallback for a direct-exposure deployment with no
  //      proxy. Note this is INLINED AT BUILD TIME by Next, so it reflects the build
  //      arg, not the current .env; passing it as a runtime env var does nothing.
  //      That is exactly why it must not be the primary signal: an operator who runs
  //      HTTPS but never set the build arg would get compose's `http://localhost:3000`
  //      default baked in and silently lose this header.
  //   3. The request's own scheme.
  //
  // Trusting a client-settable header is safe *here*: the response is per-request, so
  // forging it only changes the forger's own page. It cannot weaken anyone else's.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const isHttps = forwardedProto
    ? forwardedProto === "https"
    : siteUrl
      ? siteUrl.startsWith("https://")
      : request.nextUrl.protocol === "https:";

  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' 'unsafe-inline'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isHttps ? [`upgrade-insecure-requests`] : []),
  ].join("; ");

  // Forward the nonce on the request so Next can apply it during SSR…
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // …and emit it on the response so the browser enforces it.
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Skip Next internals + static assets + prefetches (which don't need a nonce).
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
