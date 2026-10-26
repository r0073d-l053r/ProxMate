import { WebSocket, type RawData } from 'ws';
import type { AxiosInstance } from 'axios';
import { getClient, getConnectionConfig, type ProxmoxConnection, type GuestKind } from './proxmox.service.js';
import { EphemeralStore } from '../lib/ephemeral-store.js';
import type { ConsoleInputFilter } from '../lib/console-view-filter.js';
import type { ConsoleMode } from './vm-share.service.js';

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
  const { host, tokenId, tokenSecret, verifySsl, ca } = config;
  // Proxmox's API/console listens on HTTPS only; force wss so a host saved as http://
  // (which REST tolerates via a 301 redirect, but the ws client does NOT) still works.
  const wsBase = `wss://${host.replace(/^[a-z]+:\/\//i, '')}`;
  const url =
    `${wsBase}/api2/json/nodes/${node}/${kind}/${vmid}/vncwebsocket` +
    `?port=${encodeURIComponent(port)}&vncticket=${encodeURIComponent(ticket)}`;

  return new WebSocket(url, ['binary'], {
    headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
    rejectUnauthorized: verifySsl,
    // Same trust anchor as the REST client: with a private CA and verification on,
    // the console handshake must accept the certificate the API calls accept.
    ...(ca ? { ca } : {}),
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

export type ConsoleTransport = 'vnc' | 'serial';

/** What ProxMate recorded when it minted a console ticket. */
export interface ConsoleTicketGrant {
  vmId: string;
  userId: string;
  transport: ConsoleTransport;
  port: string;
  mode: ConsoleMode;
}

/**
 * Console tickets ProxMate minted, keyed by ticket. The WebSocket upgrade takes
 * the grant (single use) and must match it — same VM, user, transport and port —
 * so the session's mode is the one decided when the ticket was minted, never a
 * flag from the browser. Proxmox expects the socket within seconds of the mint;
 * a minute is generous.
 */
const consoleGrants = new EphemeralStore<ConsoleTicketGrant>(60_000);

export function recordConsoleGrant(ticket: string, grant: ConsoleTicketGrant): void {
  consoleGrants.set(ticket, grant);
}

/** Remove and return the grant for a ticket, or undefined if none is live. */
export function takeConsoleGrant(ticket: string): ConsoleTicketGrant | undefined {
  return consoleGrants.take(ticket);
}

/**
 * Claim a ticket's grant for a WebSocket upgrade: the grant is removed and
 * returned only when it was minted for this VM, user, transport and port. A
 * mismatched attempt leaves it in place, so presenting someone else's ticket
 * can't use it up. Synchronous, so of two matching claims exactly one wins.
 */
export function claimConsoleGrant(
  ticket: string,
  expect: Omit<ConsoleTicketGrant, 'mode'>,
): ConsoleTicketGrant | undefined {
  const g = consoleGrants.get(ticket);
  if (!g || g.vmId !== expect.vmId || g.userId !== expect.userId || g.transport !== expect.transport || g.port !== expect.port) {
    return undefined;
  }
  return consoleGrants.take(ticket);
}

export interface BrowserMessage {
  data: RawData;
  isBinary: boolean;
}

/**
 * Start collecting the browser's messages right away, before anything is
 * awaited. `ws` drops a message that arrives with no listener, and the text
 * console's client speaks first (its `${user}:${ticket}` line, sent the moment
 * the socket opens), so without this the line is lost while the target is
 * looked up and Proxmox closes the session unauthenticated. Call `release` to
 * stop collecting and get what arrived, then hand it to `relay`.
 */
export function holdBrowserMessages(browser: WebSocket): { release(): BrowserMessage[] } {
  const held: BrowserMessage[] = [];
  const hold = (data: RawData, isBinary: boolean) => held.push({ data, isBinary });
  browser.on('message', hold);
  return {
    release() {
      browser.off('message', hold);
      return held;
    },
  };
}

/** Flatten a ws message payload to one Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Pipe bytes bidirectionally between the browser and Proxmox sockets. With an
 * `inputFilter` (view-only sessions) every browser message passes through it
 * first; only what it returns is forwarded, and a message it can't frame closes
 * both sockets. `early` is what the browser sent before the relay was attached
 * (see `holdBrowserMessages`); it is handled first, exactly like live input.
 */
export function relay(
  browser: WebSocket,
  target: WebSocket,
  inputFilter?: ConsoleInputFilter,
  early: BrowserMessage[] = [],
): void {
  const pending: BrowserMessage[] = [];

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

  const onBrowserMessage = (raw: RawData, isBinary: boolean) => {
    let data: RawData = raw;
    if (inputFilter) {
      let allowed: Buffer;
      try {
        allowed = inputFilter.push(toBuffer(raw));
      } catch {
        if (browser.readyState === WebSocket.OPEN) browser.close(1008, 'View-only console');
        closeBoth();
        return;
      }
      if (allowed.length === 0) return;
      data = allowed;
    }
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
  };
  browser.on('message', onBrowserMessage);

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

  for (const msg of early) onBrowserMessage(msg.data, msg.isBinary);
  // The browser may have gone while the relay was being set up.
  if (browser.readyState !== WebSocket.OPEN) closeBoth();
}
