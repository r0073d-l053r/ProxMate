import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { verifyToken } from '../services/auth.service.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { resolveVmAccess, syncVmNode, kindOf } from '../services/vm.service.js';
import { consoleModeFor } from '../services/vm-share.service.js';
import { connectVncTarget, connectSerialTarget, relay, claimConsoleGrant, holdBrowserMessages } from '../services/vnc-proxy.service.js';
import { RfbViewOnlyFilter, TermViewOnlyFilter } from '../lib/console-view-filter.js';

const CONSOLE_PATH = /^\/api\/vms\/([^/]+)\/console$/;
const SERIAL_PATH = /^\/api\/vms\/([^/]+)\/serial$/;

/** Pull a single cookie value out of a raw `Cookie` header. */
function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

/**
 * Attach the noVNC console relay to the HTTP server's `upgrade` event.
 *
 * We use a noServer `ws` instance (rather than express-ws) so the relay is
 * independent of the Express 5 router internals. The browser authenticates via
 * the **httpOnly session cookie** (no JWT in the URL) and an **Origin check**
 * (anti cross-site-WS-hijacking), and supplies the `vncticket`/`port` it
 * received from `POST /api/vms/:id/console` (or `/serial`). A session whose
 * ticket was minted view-only is relayed through an input filter that drops
 * every keyboard, mouse and clipboard message before it reaches Proxmox.
 */
const wss = new WebSocketServer({ noServer: true });

/**
 * Handle a console/serial WebSocket upgrade. Returns **true** if the path is a
 * console transport (it then owns the socket — auth failures still close it) and
 * **false** if the path isn't ours, so the caller's dispatcher can offer the
 * socket to the next handler (e.g. the IDE proxy). The path match is synchronous
 * so the dispatcher never races the async auth.
 */
export function handleConsoleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? '', 'http://localhost');
  // Two console transports share this handler: the graphical noVNC console
  // (/console → vncproxy) and the xterm.js text console (/serial → termproxy).
  const consoleMatch = url.pathname.match(CONSOLE_PATH);
  const serialMatch = url.pathname.match(SERIAL_PATH);
  const match = consoleMatch ?? serialMatch;
  if (!match) return false;
  const isSerial = serialMatch !== null;

  void (async () => {
    // Anti cross-site-WS-hijacking: browsers always send Origin on a WS
    // handshake; require it to match our app origin.
    const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
    if (req.headers.origin !== allowedOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const vmId = match[1] as string;
    // Auth via the httpOnly session cookie — no token in the URL.
    const token = getCookie(req.headers.cookie, SESSION_COOKIE);
    const vncticket = url.searchParams.get('vncticket');
    const port = url.searchParams.get('port');

    const user = token ? await verifyToken(token) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // The ticket must be one ProxMate minted, for this VM, user, transport and
    // port; the grant is single use (a mismatched attempt leaves it unused). Its
    // recorded mode is the most this session gets — the browser never says
    // whether it is view-only.
    const transport = isSerial ? 'serial' : 'vnc';
    const grant = vncticket && port
      ? claimConsoleGrant(vncticket, { vmId, userId: user.id, transport, port })
      : undefined;
    if (!vncticket || !port || !grant) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Re-check access now, through the same capability rule as the ticket mint
    // (`consoleModeFor`): a past bug was these two paths diverging, so keep them in
    // lockstep. A share downgraded since the mint drops to view-only (or is refused).
    const access = await resolveVmAccess(vmId, user);
    const allowed = access ? consoleModeFor(access.caps) : null;
    if (!access || !allowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = allowed === 'interactive' && grant.mode === 'interactive' ? 'interactive' : 'view';

    const baseVm = access.vm;
    wss.handleUpgrade(req, socket, head, async (browserWs) => {
      // Hold what the browser sends while the target is set up (see holdBrowserMessages).
      const held = holdBrowserMessages(browserWs);
      try {
        const activeVm = await syncVmNode(baseVm);
        const kind = kindOf(activeVm);
        const target = isSerial
          ? await connectSerialTarget(activeVm.proxmoxNode, activeVm.proxmoxVmId, port, vncticket, kind)
          : await connectVncTarget(activeVm.proxmoxNode, activeVm.proxmoxVmId, port, vncticket, kind);
        const filter = mode === 'view' ? (isSerial ? new TermViewOnlyFilter() : new RfbViewOnlyFilter()) : undefined;
        relay(browserWs, target, filter, held.release());
      } catch {
        held.release();
        browserWs.close(1011, 'Failed to reach Proxmox console');
      }
    });
  })().catch(() => socket.destroy());
  return true;
}

/**
 * Back-compat helper: attach a standalone console-only upgrade listener. The
 * unified dispatcher in index.ts calls handleConsoleUpgrade directly so it can
 * also offer non-console upgrades to the IDE proxy.
 */
export function setupConsoleWebSocket(server: Server): void {
  server.on('upgrade', (req, socket, head) => {
    if (!handleConsoleUpgrade(req, socket, head)) socket.destroy();
  });
}
