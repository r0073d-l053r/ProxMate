import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { verifyToken } from '../services/auth.service.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { getOwnedVm, syncVmNode } from '../services/vm.service.js';
import { connectVncTarget, relay } from '../services/vnc-proxy.service.js';

const CONSOLE_PATH = /^\/api\/vms\/([^/]+)\/console$/;

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
 * received from `POST /api/vms/:id/console`.
 */
export function setupConsoleWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const match = url.pathname.match(CONSOLE_PATH);
      if (!match) {
        socket.destroy();
        return;
      }

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

      const vm = await getOwnedVm(vmId, user);
      if (!vm || !vncticket || !port) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const baseVm = vm;
      wss.handleUpgrade(req, socket, head, async (browserWs) => {
        try {
          const activeVm = await syncVmNode(baseVm);
          const target = await connectVncTarget(activeVm.proxmoxNode, activeVm.proxmoxVmId, port, vncticket);
          relay(browserWs, target);
        } catch {
          browserWs.close(1011, 'Failed to reach Proxmox VNC');
        }
      });
    })().catch(() => socket.destroy());
  });
}
