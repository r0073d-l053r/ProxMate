import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { verifyToken } from '../services/auth.service.js';
import { getOwnedVm } from '../services/vm.service.js';
import { connectVncTarget, relay } from '../services/vnc-proxy.service.js';

const CONSOLE_PATH = /^\/api\/vms\/([^/]+)\/console$/;

/**
 * Attach the noVNC console relay to the HTTP server's `upgrade` event.
 *
 * We use a noServer `ws` instance (rather than express-ws) so the relay is
 * independent of the Express 5 router internals. The browser authenticates via
 * `?token=<JWT>` and supplies the `vncticket`/`port` it received from
 * `POST /api/vms/:id/console`.
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

      const vmId = match[1] as string;
      const token = url.searchParams.get('token');
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

      wss.handleUpgrade(req, socket, head, async (browserWs) => {
        try {
          const target = await connectVncTarget(vm.proxmoxNode, vm.proxmoxVmId, port, vncticket);
          relay(browserWs, target);
        } catch {
          browserWs.close(1011, 'Failed to reach Proxmox VNC');
        }
      });
    })().catch(() => socket.destroy());
  });
}
