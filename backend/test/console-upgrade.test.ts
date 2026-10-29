import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

// The console WebSocket gate: the upgrade must present a ticket ProxMate minted
// (same VM, user, transport, port; single use), re-checks access through the same
// capability rule as the mint, and relays a view-only session through the input
// filter. The end-to-end cases run the real relay against a stand-in Proxmox
// socket and check what actually arrives there.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/vm.service.js', () => ({
  resolveVmAccess: vi.fn(),
  syncVmNode: vi.fn(async (vm: unknown) => vm),
  kindOf: vi.fn().mockReturnValue('qemu'),
}));
vi.mock('../src/services/auth.service.js', () => ({ verifyToken: vi.fn() }));
vi.mock('../src/services/vnc-proxy.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vnc-proxy.service.js')>();
  return { ...actual, connectVncTarget: vi.fn(), connectSerialTarget: vi.fn() };
});

import { resolveVmAccess, syncVmNode } from '../src/services/vm.service.js';
import { verifyToken } from '../src/services/auth.service.js';
import { connectVncTarget, connectSerialTarget, recordConsoleGrant } from '../src/services/vnc-proxy.service.js';
import { CAPS_BY_ROLE, ALL_CAPS, type ConsoleMode, type ShareRole } from '../src/services/vm-share.service.js';
import { handleConsoleUpgrade } from '../src/routes/console.routes.js';
import { SESSION_COOKIE } from '../src/lib/cookies.js';

const resolve = vi.mocked(resolveVmAccess);
const verify = vi.mocked(verifyToken);
const ORIGIN = process.env.FRONTEND_URL || 'http://localhost:3000';
const VM = { id: 'vm1', userId: 'owner', name: 'web', proxmoxNode: 'pve1', proxmoxVmId: 100 };

function asRole(role: ShareRole | 'owner') {
  resolve.mockResolvedValue({
    vm: VM,
    access: role,
    caps: role === 'owner' ? ALL_CAPS : CAPS_BY_ROLE[role],
  } as never);
}

// ─── Gate checks (no relay) ──────────────────────────────────────────────────

function fakeReq(path: string): IncomingMessage {
  return { url: path, headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=tok` } } as unknown as IncomingMessage;
}
function fakeSocket() {
  return { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex & {
    write: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}
const flush = () => new Promise((r) => setImmediate(r));

let ticketSeq = 0;
function grant(over: Partial<{ vmId: string; userId: string; transport: 'vnc' | 'serial'; port: string; mode: ConsoleMode }> = {}) {
  const ticket = `PVEVNC:t${++ticketSeq}`;
  recordConsoleGrant(ticket, { vmId: 'vm1', userId: 'u1', transport: 'vnc', port: '5900', mode: 'interactive', ...over });
  return ticket;
}
const q = (ticket: string, port = '5900') => `vncticket=${encodeURIComponent(ticket)}&port=${port}`;

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue({ id: 'u1', role: 'user' } as never);
  asRole('operator');
});

describe('handleConsoleUpgrade — gate', () => {
  it('ignores non-console paths (returns false, socket untouched)', () => {
    const sock = fakeSocket();
    expect(handleConsoleUpgrade(fakeReq('/api/ide/vm1/proxy/'), sock, Buffer.alloc(0))).toBe(false);
    expect(sock.destroy).not.toHaveBeenCalled();
  });

  it('refuses a ticket ProxMate never minted', async () => {
    const sock = fakeSocket();
    expect(handleConsoleUpgrade(fakeReq(`/api/vms/vm1/console?${q('PVEVNC:forged')}`), sock, Buffer.alloc(0))).toBe(true);
    await flush();
    expect(sock.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['another VM', { vmId: 'vm2' }],
    ['another user', { userId: 'u2' }],
    ['the other transport', { transport: 'serial' as const }],
    ['another port', { port: '5901' }],
  ])('refuses a grant minted for %s', async (_label, over) => {
    const sock = fakeSocket();
    handleConsoleUpgrade(fakeReq(`/api/vms/vm1/console?${q(grant(over))}`), sock, Buffer.alloc(0));
    await flush();
    expect(sock.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  it('a mismatched attempt does not use up the grant', async () => {
    const ticket = grant({ mode: 'view' });
    verify.mockResolvedValue({ id: 'u2', role: 'user' } as never);
    const other = fakeSocket();
    handleConsoleUpgrade(fakeReq(`/api/vms/vm1/console?${q(ticket)}`), other, Buffer.alloc(0));
    await flush();
    expect(other.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
    // The owner of the ticket still gets past the gate with it.
    verify.mockResolvedValue({ id: 'u1', role: 'user' } as never);
    handleConsoleUpgrade(fakeReq(`/api/vms/vm1/console?${q(ticket)}`), fakeSocket(), Buffer.alloc(0));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a grant is single use', async () => {
    const ticket = grant({ transport: 'serial', mode: 'view' });
    const first = fakeSocket();
    handleConsoleUpgrade(fakeReq(`/api/vms/vm1/serial?${q(ticket)}`), first, Buffer.alloc(0));
    await flush();
    // The first upgrade got past the gate (it would now hand the socket to ws).
    expect(resolve).toHaveBeenCalledTimes(1);
    const second = fakeSocket();
    handleConsoleUpgrade(fakeReq(`/api/vms/vm1/serial?${q(ticket)}`), second, Buffer.alloc(0));
    await flush();
    expect(second.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller who no longer holds either console capability', async () => {
    resolve.mockResolvedValue({ vm: VM, access: 'viewer', caps: new Set(['view']) } as never);
    const sock = fakeSocket();
    handleConsoleUpgrade(fakeReq(`/api/vms/vm1/console?${q(grant({ mode: 'view' }))}`), sock, Buffer.alloc(0));
    await flush();
    expect(sock.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  it('refuses a missing session and a foreign Origin', async () => {
    verify.mockResolvedValue(null as never);
    const a = fakeSocket();
    handleConsoleUpgrade(fakeReq(`/api/vms/vm1/console?${q(grant())}`), a, Buffer.alloc(0));
    await flush();
    expect(a.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n');

    const b = fakeSocket();
    const req = { url: `/api/vms/vm1/console?${q(grant())}`, headers: { origin: 'https://elsewhere.example' } } as unknown as IncomingMessage;
    handleConsoleUpgrade(req, b, Buffer.alloc(0));
    await flush();
    expect(b.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
});

// ─── End to end through the real relay ───────────────────────────────────────

let app: http.Server;
let appUrl: string;
let pve: WebSocketServer;
let pveUrl: string;
/** Every byte the stand-in Proxmox socket received, per connection. */
let received: Buffer[] = [];
let pveClosed: Promise<void>;

beforeAll(async () => {
  app = http.createServer();
  app.on('upgrade', (req, socket, head) => {
    if (!handleConsoleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  appUrl = `ws://127.0.0.1:${(app.address() as AddressInfo).port}`;

  pve = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => pve.on('listening', r));
  pveUrl = `ws://127.0.0.1:${(pve.address() as AddressInfo).port}`;
  pve.on('connection', (ws) => {
    pveClosed = new Promise((r) => ws.on('close', () => r()));
    ws.on('message', (data) => received.push(Buffer.from(data as Buffer)));
  });
});
afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => pve.close(() => r()));
});
beforeEach(() => {
  received = [];
  vi.mocked(connectVncTarget).mockImplementation(async () => new WebSocket(pveUrl));
  vi.mocked(connectSerialTarget).mockImplementation(async () => new WebSocket(pveUrl));
});

/** Open the browser side, send `frames` one by one, and return what reached Proxmox. */
async function session(path: string, frames: Array<Buffer | string>): Promise<{ bytes: Buffer; closeCode: number | null }> {
  const ws = new WebSocket(`${appUrl}${path}`, { headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=tok` } });
  await new Promise<void>((resolveOpen, reject) => {
    ws.on('open', () => resolveOpen());
    ws.on('error', reject);
  });
  let closeCode: number | null = null;
  const closed = new Promise<void>((r) => ws.on('close', (code) => { closeCode = code; r(); }));
  for (const f of frames) ws.send(f, { binary: typeof f !== 'string' });
  // Give the relay time to forward, then end the session.
  await new Promise((r) => setTimeout(r, 150));
  if (ws.readyState === WebSocket.OPEN) ws.close();
  await closed;
  await pveClosed;
  return { bytes: Buffer.concat(received), closeCode };
}

const RFB_HANDSHAKE = Buffer.concat([
  Buffer.from('RFB 003.008\n', 'latin1'),
  Buffer.from([2]), // VNC auth
  Buffer.alloc(16, 0xaa), // DES response
  Buffer.from([0]), // ClientInit, exclusive
]);
const KEY_A = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const POINTER = Buffer.from([5, 1, 0, 10, 0, 20]);
const CUT = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('abc')]);
const FBUR = Buffer.from([3, 1, 0, 0, 0, 0, 0, 100, 0, 100]);

describe('end to end: graphical console', () => {
  it('a viewer session reaches Proxmox with no input and a shared ClientInit', async () => {
    asRole('viewer');
    const ticket = grant({ mode: 'view' });
    const { bytes } = await session(`/api/vms/vm1/console?${q(ticket)}`, [
      RFB_HANDSHAKE.subarray(0, 5),
      Buffer.concat([RFB_HANDSHAKE.subarray(5), KEY_A.subarray(0, 3)]),
      Buffer.concat([KEY_A.subarray(3), POINTER, FBUR, CUT]),
    ]);
    const expected = Buffer.concat([RFB_HANDSHAKE.subarray(0, RFB_HANDSHAKE.length - 1), Buffer.from([1]), FBUR]);
    expect(bytes.equals(expected)).toBe(true);
  });

  it('an operator session is relayed unchanged', async () => {
    const ticket = grant({ mode: 'interactive' });
    const all = Buffer.concat([RFB_HANDSHAKE, KEY_A, POINTER, FBUR, CUT]);
    const { bytes } = await session(`/api/vms/vm1/console?${q(ticket)}`, [all]);
    expect(bytes.equals(all)).toBe(true);
  });

  it('a view-only grant stays view-only even for a caller who now holds console', async () => {
    const ticket = grant({ mode: 'view' }); // operator caps (beforeEach)
    const { bytes } = await session(`/api/vms/vm1/console?${q(ticket)}`, [Buffer.concat([RFB_HANDSHAKE, KEY_A])]);
    expect(bytes.includes(KEY_A)).toBe(false);
    expect(bytes[bytes.length - 1]).toBe(1);
  });

  it('an interactive grant drops to view-only when the share was downgraded since the mint', async () => {
    const ticket = grant({ mode: 'interactive' });
    asRole('viewer');
    const { bytes } = await session(`/api/vms/vm1/console?${q(ticket)}`, [Buffer.concat([RFB_HANDSHAKE, KEY_A, FBUR])]);
    expect(bytes.includes(KEY_A)).toBe(false);
    expect(bytes.subarray(bytes.length - FBUR.length).equals(FBUR)).toBe(true);
  });

  it('an unknown message type closes a view-only session without forwarding it', async () => {
    asRole('viewer');
    const ticket = grant({ mode: 'view' });
    const { bytes, closeCode } = await session(`/api/vms/vm1/console?${q(ticket)}`, [
      Buffer.concat([RFB_HANDSHAKE, Buffer.from([0x77, 1, 2, 3]), FBUR]),
    ]);
    expect(closeCode).toBe(1008);
    expect(bytes.includes(Buffer.from([0x77, 1, 2, 3]))).toBe(false);
    expect(bytes.includes(FBUR)).toBe(false);
  });
});

describe('end to end: text console', () => {
  it('a viewer session forwards the auth line and one keepalive only', async () => {
    asRole('viewer');
    const ticket = grant({ transport: 'serial', mode: 'view' });
    const { bytes } = await session(`/api/vms/vm1/serial?${q(ticket)}`, [
      'root@pam:PVEVNC:t\n',
      '1:80:24:',
      '0:3:ls\r',
      '0:5:',
      'rm -r',
      '2',
      '0:1:x1:100:40:',
    ]);
    // Resizes and input are dropped; the second keepalive comes within a second of the first.
    expect(bytes.toString('latin1')).toBe('root@pam:PVEVNC:t\n2');
  });

  it('an operator session is relayed unchanged', async () => {
    const ticket = grant({ transport: 'serial', mode: 'interactive' });
    const { bytes } = await session(`/api/vms/vm1/serial?${q(ticket)}`, ['root@pam:t\n', '0:3:ls\r', '1:80:24:']);
    expect(bytes.toString('latin1')).toBe('root@pam:t\n0:3:ls\r1:80:24:');
  });

  it('the auth line sent the moment the socket opens survives a slow node lookup', async () => {
    // The text console's client speaks first, before Proxmox says anything; the
    // node lookup (a real /cluster/resources call) must not swallow that line.
    vi.mocked(syncVmNode).mockImplementationOnce(async (vm) => {
      await new Promise((r) => setTimeout(r, 100));
      return vm;
    });
    const ticket = grant({ transport: 'serial', mode: 'interactive' });
    const { bytes } = await session(`/api/vms/vm1/serial?${q(ticket)}`, ['root@pam:t\n', '1:80:24:']);
    expect(bytes.toString('latin1')).toBe('root@pam:t\n1:80:24:');
  });

  it('a viewer\'s early messages still go through the filter', async () => {
    vi.mocked(syncVmNode).mockImplementationOnce(async (vm) => {
      await new Promise((r) => setTimeout(r, 100));
      return vm;
    });
    asRole('viewer');
    const ticket = grant({ transport: 'serial', mode: 'view' });
    const { bytes } = await session(`/api/vms/vm1/serial?${q(ticket)}`, ['root@pam:t\n', '0:3:ls\r', '2']);
    expect(bytes.toString('latin1')).toBe('root@pam:t\n2');
  });

  it('a malformed message closes a view-only session', async () => {
    asRole('viewer');
    const ticket = grant({ transport: 'serial', mode: 'view' });
    const { bytes, closeCode } = await session(`/api/vms/vm1/serial?${q(ticket)}`, ['root@pam:t\n', 'ls\r', '1:80:24:']);
    expect(closeCode).toBe(1008);
    // Nothing from or after the bad message is forwarded (the session may close
    // before the Proxmox side even opens, so the auth line itself may not arrive).
    expect(bytes.toString('latin1')).not.toContain('ls');
    expect(bytes.toString('latin1')).not.toContain('1:80:24:');
  });
});
