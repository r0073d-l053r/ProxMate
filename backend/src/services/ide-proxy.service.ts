import httpProxy from 'http-proxy';
import type { Express } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { verifyToken } from './auth.service.js';
import { getOwnedVm } from './vm.service.js';
import { getIdeCapability } from './ide.service.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { logger } from '../lib/logger.js';

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
 * Auth mirrors the console relay: httpOnly session cookie + VM ownership + the
 * admin IDE policy (getIdeCapability). No ticket in the URL; the cookie is sent
 * on every same-origin sub-request automatically.
 *
 * Target: a real guest's `ip:port` (Phase 2b adds the host→guest firewall
 * pinhole). `IDE_TARGET_OVERRIDE` points every session at one code-server so the
 * transport can be proven on the rig without a live guest.
 */

const IDE_HTTP_PATH = /^\/api\/ide\/([^/]+)\/proxy(\/[^?]*)?(\?.*)?$/;
const IDE_WS_PATH = /^\/api\/ide\/([^/]+)\/proxy(\/.*)?$/;

// changeOrigin MUST stay false: code-server validates the WebSocket `Origin`
// against the request `Host`, so we forward the browser's original Host (which
// matches its Origin) instead of rewriting it to the guest. Rewriting it makes
// code-server reject the management WS with 403 → the workbench never connects
// (verified against real code-server 4.127 on musebot). http-proxy still dials
// the real target regardless of the Host header.
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false, xfwd: true });

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

/** Resolve the code-server target for a VM, enforcing ownership + the IDE policy. */
async function resolveTarget(vmId: string, user: { id: string; role: string }): Promise<string | null> {
  const vm = await getOwnedVm(vmId, user);
  if (!vm) return null;
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) return null;
  const override = process.env['IDE_TARGET_OVERRIDE'];
  if (override) return override;
  if (!vm.ipAddress) return null;
  const port = process.env['IDE_GUEST_PORT'] || '8080';
  return `http://${vm.ipAddress}:${port}`;
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
      const target = await resolveTarget(vmId, user);
      if (!target) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('ProxMate IDE is not available for this VM');
        return;
      }
      req.url = rest + query; // strip the /api/ide/:id/proxy prefix
      proxy.web(req, res, { target });
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
    const target = await resolveTarget(vmId, user);
    if (!target) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    req.url = (m[2] ?? '/') + (url.search ?? ''); // strip the prefix
    proxy.ws(req, socket as unknown as Socket, head, { target });
  })().catch(() => socket.destroy());
  return true;
}
