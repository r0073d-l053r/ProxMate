import { WebSocket, type RawData } from 'ws';
import { getClient, getConnectionConfig } from './proxmox.service.js';

export interface VncTicket {
  ticket: string;
  port: string;
}

/**
 * Ask Proxmox for a VNC websocket proxy session. Returns the one-time VNC
 * ticket (used as the RFB password by noVNC) and the port to attach to.
 */
export async function requestVncProxy(node: string, vmid: number): Promise<VncTicket> {
  const client = await getClient();
  const params = new URLSearchParams({ websocket: '1' });
  const res = await client.post<{ data: { ticket: string; port: number | string } }>(
    `/nodes/${node}/qemu/${vmid}/vncproxy`,
    params,
  );
  return { ticket: String(res.data.data.ticket), port: String(res.data.data.port) };
}

/**
 * Open a WebSocket to the Proxmox node's vncwebsocket endpoint for the given
 * ticket/port. Authenticated with the stored API token; the browser never
 * sees the token.
 */
export async function connectVncTarget(
  node: string,
  vmid: number,
  port: string,
  ticket: string,
): Promise<WebSocket> {
  const { host, tokenId, tokenSecret, verifySsl } = await getConnectionConfig();
  // Proxmox's API/console listens on HTTPS only; force wss so a host saved as http://
  // (which REST tolerates via a 301 redirect, but the ws client does NOT) still works.
  const wsBase = `wss://${host.replace(/^[a-z]+:\/\//i, '')}`;
  const url =
    `${wsBase}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket` +
    `?port=${encodeURIComponent(port)}&vncticket=${encodeURIComponent(ticket)}`;

  return new WebSocket(url, ['binary'], {
    headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
    rejectUnauthorized: verifySsl,
  });
}

/** Pipe bytes bidirectionally between the browser and Proxmox sockets. */
export function relay(browser: WebSocket, target: WebSocket): void {
  const pending: RawData[] = [];

  target.on('open', () => {
    for (const msg of pending) target.send(msg);
    pending.length = 0;
  });

  target.on('message', (data) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data);
  });

  browser.on('message', (data) => {
    if (target.readyState === WebSocket.OPEN) target.send(data);
    else pending.push(data);
  });

  const closeBoth = () => {
    if (browser.readyState === WebSocket.OPEN) browser.close();
    if (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING) target.close();
  };

  target.on('close', (code, reason) => {
    if (code && code !== 1000) {
      console.error(`[console] Proxmox VNC target closed: code=${code} reason=${reason?.toString() || ''}`);
    }
    closeBoth();
  });
  browser.on('close', closeBoth);
  target.on('error', (err) => {
    console.error('[console] Proxmox VNC target error:', (err as Error)?.message ?? err);
    closeBoth();
  });
  browser.on('error', closeBoth);
}
