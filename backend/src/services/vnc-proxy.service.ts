import { WebSocket, type RawData } from 'ws';
import type { AxiosInstance } from 'axios';
import { getClient, getConnectionConfig, type ProxmoxConnection, type GuestKind } from './proxmox.service.js';

export interface VncTicket {
  ticket: string;
  port: string;
}

export interface TermTicket {
  ticket: string;
  port: string;
  /** The Proxmox user the ticket was issued for — the browser sends `${user}:${ticket}` to authenticate the serial stream. */
  user: string;
}

/**
 * Ask Proxmox for a VNC websocket proxy session. Returns the one-time VNC
 * ticket (used as the RFB password by noVNC) and the port to attach to.
 */
export async function requestVncProxy(node: string, vmid: number, kind: GuestKind = 'qemu'): Promise<VncTicket> {
  const client = await getClient();
  const params = new URLSearchParams({ websocket: '1' });
  const res = await client.post<{ data: { ticket: string; port: number | string } }>(
    `/nodes/${node}/${kind}/${vmid}/vncproxy`,
    params,
  );
  return { ticket: String(res.data.data.ticket), port: String(res.data.data.port) };
}

/**
 * Ask Proxmox for a serial/terminal proxy session (`termproxy`), the text-console
 * counterpart to `vncproxy`. Returns the one-time ticket, the port to attach to,
 * and the `user` the ticket is bound to — the xterm.js client authenticates the
 * stream in-band by sending `${user}:${ticket}\n` as its first message.
 */
export async function requestTermProxy(node: string, vmid: number, client?: AxiosInstance, kind: GuestKind = 'qemu'): Promise<TermTicket> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: { ticket: string; port: number | string; user: string } }>(
    `/nodes/${node}/${kind}/${vmid}/termproxy`,
    new URLSearchParams(),
  );
  return {
    ticket: String(res.data.data.ticket),
    port: String(res.data.data.port),
    user: String(res.data.data.user),
  };
}

/**
 * Open a WebSocket to the Proxmox node's `vncwebsocket` endpoint for the given
 * ticket/port. Both the graphical (VNC/RFB) and the text (serial/termproxy)
 * consoles ride this same transport — only the wire protocol flowing over it
 * differs — so they share this connector. Authenticated with the stored API
 * token; the browser never sees the token.
 */
function connectConsoleTarget(node: string, vmid: number, port: string, ticket: string, config: ProxmoxConnection, kind: GuestKind): WebSocket {
  const { host, tokenId, tokenSecret, verifySsl } = config;
  // Proxmox's API/console listens on HTTPS only; force wss so a host saved as http://
  // (which REST tolerates via a 301 redirect, but the ws client does NOT) still works.
  const wsBase = `wss://${host.replace(/^[a-z]+:\/\//i, '')}`;
  const url =
    `${wsBase}/api2/json/nodes/${node}/${kind}/${vmid}/vncwebsocket` +
    `?port=${encodeURIComponent(port)}&vncticket=${encodeURIComponent(ticket)}`;

  return new WebSocket(url, ['binary'], {
    headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
    rejectUnauthorized: verifySsl,
  });
}

/** Open the Proxmox vncwebsocket for a graphical (noVNC) console session. */
export async function connectVncTarget(
  node: string,
  vmid: number,
  port: string,
  ticket: string,
  kind: GuestKind = 'qemu',
): Promise<WebSocket> {
  return connectConsoleTarget(node, vmid, port, ticket, await getConnectionConfig(), kind);
}

/** Open the Proxmox vncwebsocket for a text (serial/termproxy) console session. */
export async function connectSerialTarget(
  node: string,
  vmid: number,
  port: string,
  ticket: string,
  kind: GuestKind = 'qemu',
): Promise<WebSocket> {
  return connectConsoleTarget(node, vmid, port, ticket, await getConnectionConfig(), kind);
}

/** Pipe bytes bidirectionally between the browser and Proxmox sockets. */
export function relay(browser: WebSocket, target: WebSocket): void {
  const pending: Array<{ data: RawData; isBinary: boolean }> = [];

  target.on('open', () => {
    for (const msg of pending) target.send(msg.data, { binary: msg.isBinary });
    pending.length = 0;
  });

  // Preserve the text/binary opcode in both directions. The VNC (RFB) stream is
  // always binary; the serial (termproxy) stream's control frames are text
  // (`0:len:data`, `1:cols:rows:`, `2`) — forwarding those as binary could
  // confuse the terminal parser, so we relay them with the opcode they arrived
  // with rather than coercing everything to binary.
  target.on('message', (data, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
  });

  browser.on('message', (data, isBinary) => {
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
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
