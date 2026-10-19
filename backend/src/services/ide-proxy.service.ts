import httpProxy from 'http-proxy';
import type { Express } from 'express';
import { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { verifyToken } from './auth.service.js';
import { getVmWithCap } from './vm.service.js';
import { getIdeCapability, isIdeOwner, IDE_OWNER_ONLY_MESSAGE } from './ide.service.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { logger } from '../lib/logger.js';
import {
  IDE_GUEST_COOKIE,
  ideGuestCookieValue,
  loadIdeGuestSecret,
  proveIdeGuestTarget,
  resolveIdeTargetUrl,
} from './ide-guest-auth.service.js';

/**
 * ProxMate IDE transport (Phase 2): reverse-proxy an in-guest code-server (HTTP +
 * the WebSockets it uses for terminals / the extension host) through the backend,
 * so the browser only ever talks to ProxMate — the guest is never exposed.
 *
 * Path model: the IDE is served at `/api/ide/:id/proxy/`. code-server emits
 * *relative* asset URLs (`./_static/…`, `stable-<hash>/static/…`) and a relative
 * redirect, so we simply strip the `/api/ide/:id/proxy` prefix and forward the
 * rest — every asset/WS then resolves back under our prefix. The one rule that
 * makes relative resolution correct is that the entry URL must end in `/`.
 *
 * Auth: httpOnly session cookie + the VM's OWNER (admins and sharees are refused,
 * see ide.service IDE_OWNER_ONLY_MESSAGE) + the admin IDE policy
 * (getIdeCapability). No ticket in the URL; the cookie is sent on every
 * same-origin sub-request automatically.
 *
 * Header hygiene: everything the guest serves is controlled by its root user, and
 * it is served on the ProxMate origin. So ProxMate's own credentials (every
 * `proxmate_*` cookie and the Authorization header) are removed before a request
 * reaches the guest, and a guest response can neither set or overwrite a
 * ProxMate cookie nor widen a service worker's scope (`Service-Worker-Allowed`).
 *
 * Target resolution (per-VM — see {@link resolveIdeTargetUrl}):
 *   1. `IDE_TARGET_OVERRIDE` — a single fixed URL for the rig (no live guest).
 *      TEST-ONLY: it clobbers per-VM routing, so it must NOT be set in a
 *      multi-VM deployment (doing so sends every VM's IDE to the same box).
 *   2. The guest's own LAN `ipAddress:port` (`IDE_GUEST_PORT` overrides 8080).
 *
 * Guest authentication (see ide-guest-auth.service): the address comes from the
 * guest's own agent, so before relaying anything the proxy makes the code-server
 * there prove it holds THIS VM's per-install secret, then attaches the matching
 * session cookie to every request. An address that answers without the secret
 * (another VM, an unrelated service, an install from before guest auth existed)
 * is never relayed to. This applies to the rig override too.
 *
 * Reaching code-server on the guest requires punching through the per-VM tenant
 * isolation firewall — that is done as a MANAGED, infra-scoped `:8080` pinhole at
 * IDE-enable (see ide-provision.service.ensureIdePinhole), consistent with how the
 * isolation rules themselves are managed. On non-flat networks the ProxMate host
 * reaches the guest LAN via its own routing (e.g. a Tailscale subnet route); the
 * proxy target stays the guest's real LAN IP either way.
 */

const IDE_HTTP_PATH = /^\/api\/ide\/([^/]+)\/proxy(\/[^?]*)?(\?.*)?$/;
const IDE_WS_PATH = /^\/api\/ide\/([^/]+)\/proxy(\/.*)?$/;

// changeOrigin MUST stay false: code-server validates the WebSocket `Origin`
// against the request `Host`, so we forward the browser's original Host (which
// matches its Origin) instead of rewriting it to the guest. Rewriting it makes
// code-server reject the management WS with 403 → the workbench never connects
// (verified against real code-server 4.127 on the lab cluster). http-proxy still dials
// the real target regardless of the Host header.
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false, xfwd: true });

/** Every ProxMate cookie (lib/cookies.ts) uses this prefix. */
const PROXMATE_COOKIE_PREFIX = 'proxmate_';

/**
 * Strip what a guest response must not deliver to the browser on the ProxMate
 * origin: Set-Cookie for ProxMate's cookie names (and code-server's session
 * cookie, which the proxy supplies itself) and Service-Worker-Allowed.
 */
export function sanitizeGuestResponseHeaders(headers: IncomingHttpHeaders): void {
  delete headers['service-worker-allowed'];
  const set = headers['set-cookie'];
  if (!set) return;
  const kept = set.filter((line) => {
    const pair = line.split(';', 1)[0] ?? '';
    const name = (pair.split('=', 1)[0] ?? '').trim();
    // Browsers differ on nameless cookies (`=a=b` can be stored as cookie `a`),
    // so drop any without a name, and judge the rest by the pair with leading
    // '=' and whitespace removed as well as by the parsed name.
    if (!name) return false;
    const bare = pair.replace(/^[\s=]+/, '');
    return ![name, bare].some((s) => s.startsWith(PROXMATE_COOKIE_PREFIX) || s.startsWith(IDE_GUEST_COOKIE));
  });
  if (kept.length) headers['set-cookie'] = kept;
  else delete headers['set-cookie'];
}

// Runs before http-proxy copies the upstream headers onto the browser response.
proxy.on('proxyRes', (proxyRes) => sanitizeGuestResponseHeaders(proxyRes.headers));
// WebSocket upgrades have no proxyRes event; listeners added here run before
// http-proxy's own, so the 101 (or a refusal) is cleaned before it is relayed.
proxy.on('proxyReqWs', (proxyReq) => {
  proxyReq.on('response', (r) => sanitizeGuestResponseHeaders(r.headers));
  proxyReq.on('upgrade', (r) => sanitizeGuestResponseHeaders(r.headers));
});

proxy.on('error', (err, _req, target) => {
  logger.warn({ err: (err as Error)?.message }, 'ide proxy upstream error');
  const t = target as ServerResponse | Socket | undefined;
  if (t && 'writeHead' in t) {
    const res = t as ServerResponse;
    try {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('ProxMate IDE: upstream unreachable');
    } catch {
      /* response already torn down */
    }
  } else if (t) {
    try {
      (t as Socket).destroy();
    } catch {
      /* socket already gone */
    }
  }
});

function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// Target resolution lives with the guest proof; re-exported for callers/tests.
export { resolveIdeTargetUrl };

type ResolvedTarget =
  | { ok: true; target: string; guestCookie: string }
  | { ok: false; status: number; message: string };

const NOT_AVAILABLE: ResolvedTarget = { ok: false, status: 403, message: 'ProxMate IDE is not available for this VM' };

/**
 * Resolve the code-server target for a VM, enforcing ownership + the IDE policy,
 * and prove the guest at that address is this VM's install before returning it.
 */
async function resolveTarget(vmId: string, user: { id: string; role: string }): Promise<ResolvedTarget> {
  const vm = await getVmWithCap(vmId, user, 'ide');
  if (!vm) return NOT_AVAILABLE;
  if (!isIdeOwner(vm, user)) return { ok: false, status: 403, message: IDE_OWNER_ONLY_MESSAGE };
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) return NOT_AVAILABLE;
  if (vm.status !== 'running') {
    return { ok: false, status: 409, message: 'Start the VM to open its ProxMate IDE.' };
  }
  // A held machine (vm.service isHeld: `holdReason` set, or `error`) may be
  // neither started nor handed over — whatever status a sync last recorded.
  if (vm.holdReason) {
    return { ok: false, status: 409, message: vm.holdReason };
  }
  const secret = await loadIdeGuestSecret(vm.id);
  if (!secret) {
    // Installed before guest authentication existed (or the secret is gone):
    // there is nothing to prove the guest with, so fail closed until reinstalled.
    return {
      ok: false,
      status: 409,
      message: 'This IDE install is out of date. Reinstall the IDE from the VM page (Console → ProxMate IDE) to open it.',
    };
  }
  const target = await proveIdeGuestTarget(vm, secret);
  if (!target) {
    return {
      ok: false,
      status: 502,
      message: "ProxMate IDE: couldn't verify this VM's IDE. If it was just reinstalled, wait a moment; otherwise reinstall the IDE.",
    };
  }
  return { ok: true, target, guestCookie: ideGuestCookieValue(secret) };
}

/**
 * The Cookie header sent to the guest: whatever the browser sent, minus every
 * ProxMate cookie and any code-server session cookie of its own, plus the
 * server-held guest cookie.
 */
export function guestCookieHeader(header: string | undefined, guestCookie: string): string {
  const kept = (header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => {
      if (!p) return false;
      const name = p.split('=', 1)[0]!.trim();
      return !name.startsWith(PROXMATE_COOKIE_PREFIX) && !name.startsWith(IDE_GUEST_COOKIE);
    });
  kept.push(`${IDE_GUEST_COOKIE}=${guestCookie}`);
  return kept.join('; ');
}

/**
 * Register the HTTP reverse proxy. Claims `/api/ide/:id/proxy/*` and forwards it;
 * everything else falls through with `next()`. Mounted EARLY (before the JSON body
 * parser) so the request body stream reaches code-server untouched.
 */
export function mountIdeProxy(appInstance: Express): void {
  appInstance.use((req, res, next) => {
    const m = req.url.match(IDE_HTTP_PATH);
    if (!m) {
      next();
      return;
    }
    const vmId = m[1] as string;
    const rest = m[2]; // '/…' after /proxy, or undefined when there's no trailing slash
    const query = m[3] ?? '';
    // code-server uses relative URLs, so the base page must end in '/'.
    if (rest === undefined) {
      res.writeHead(302, { location: `/api/ide/${vmId}/proxy/${query}` });
      res.end();
      return;
    }
    void (async () => {
      const token = getCookie(req.headers.cookie, SESSION_COOKIE);
      const user = token ? await verifyToken(token) : null;
      if (!user) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized');
        return;
      }
      const resolved = await resolveTarget(vmId, user);
      if (!resolved.ok) {
        res.writeHead(resolved.status, { 'content-type': 'text/plain' }).end(resolved.message);
        return;
      }
      req.url = rest + query; // strip the /api/ide/:id/proxy prefix
      req.headers.cookie = guestCookieHeader(req.headers.cookie, resolved.guestCookie);
      delete req.headers.authorization; // a ProxMate credential, never the guest's
      proxy.web(req, res, { target: resolved.target });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('IDE proxy error');
    });
  });
}

/**
 * WebSocket upgrade hook for the IDE (terminals, extension host, file watcher).
 * Returns true if it claimed the upgrade (an IDE path), false so the caller can
 * try the next handler. Auth = session cookie + ownership + a lenient same-origin
 * Origin check (the IDE page is served from the backend origin, so its WS Origin
 * is the backend, not FRONTEND_URL); the cookie + ownership are the real gate.
 */
export function handleIdeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? '', 'http://localhost');
  const m = url.pathname.match(IDE_WS_PATH);
  if (!m) return false;
  void (async () => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const allowed =
      !origin ||
      origin === (process.env['FRONTEND_URL'] || 'http://localhost:3000') ||
      origin === `http://${host}` ||
      origin === `https://${host}`;
    if (!allowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const vmId = m[1] as string;
    const token = getCookie(req.headers.cookie, SESSION_COOKIE);
    const user = token ? await verifyToken(token) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const resolved = await resolveTarget(vmId, user);
    if (!resolved.ok) {
      socket.write(`HTTP/1.1 ${resolved.status} ${STATUS_CODES[resolved.status] ?? 'Error'}\r\n\r\n`);
      socket.destroy();
      return;
    }
    req.url = (m[2] ?? '/') + (url.search ?? ''); // strip the prefix
    req.headers.cookie = guestCookieHeader(req.headers.cookie, resolved.guestCookie);
    delete req.headers.authorization; // a ProxMate credential, never the guest's
    proxy.ws(req, socket as unknown as Socket, head, { target: resolved.target });
  })().catch(() => socket.destroy());
  return true;
}
