import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// Regression guard for the console WebSocket gate: the WS upgrade and the POST
// that mints the ticket must use the SAME capability ('console') — a past bug
// was exactly these two paths diverging after Share-a-VM landed.
vi.mock('../src/services/vm.service.js', () => ({
  getVmWithCap: vi.fn(),
  syncVmNode: vi.fn(),
  kindOf: vi.fn().mockReturnValue('qemu'),
}));
vi.mock('../src/services/auth.service.js', () => ({ verifyToken: vi.fn() }));
vi.mock('../src/services/vnc-proxy.service.js', () => ({
  connectVncTarget: vi.fn(),
  connectSerialTarget: vi.fn(),
  relay: vi.fn(),
}));

import { getVmWithCap } from '../src/services/vm.service.js';
import { verifyToken } from '../src/services/auth.service.js';
import { handleConsoleUpgrade } from '../src/routes/console.routes.js';
import { SESSION_COOKIE } from '../src/lib/cookies.js';

const cap = vi.mocked(getVmWithCap);
const verify = vi.mocked(verifyToken);

const ORIGIN = process.env.FRONTEND_URL || 'http://localhost:3000';

function fakeReq(path: string): IncomingMessage {
  return {
    url: path,
    headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=tok` },
  } as unknown as IncomingMessage;
}

function fakeSocket() {
  return { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex & {
    write: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue({ id: 'u1', role: 'user' } as never);
});

describe('handleConsoleUpgrade — capability gate', () => {
  it("authorizes through the 'console' capability (same gate as the ticket mint)", async () => {
    cap.mockResolvedValue(null as never);
    const sock = fakeSocket();
    const matched = handleConsoleUpgrade(fakeReq('/api/vms/vm1/console?vncticket=t&port=59'), sock, Buffer.alloc(0));
    expect(matched).toBe(true);
    await flush();
    expect(cap).toHaveBeenCalledWith('vm1', { id: 'u1', role: 'user' }, 'console');
  });

  it('rejects a caller without the console capability (e.g. a viewer share) with 403', async () => {
    cap.mockResolvedValue(null as never);
    const sock = fakeSocket();
    handleConsoleUpgrade(fakeReq('/api/vms/vm1/console?vncticket=t&port=59'), sock, Buffer.alloc(0));
    await flush();
    expect(sock.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('the serial (text console) path uses the same gate', async () => {
    cap.mockResolvedValue(null as never);
    const sock = fakeSocket();
    const matched = handleConsoleUpgrade(fakeReq('/api/vms/vm2/serial?vncticket=t&port=59'), sock, Buffer.alloc(0));
    expect(matched).toBe(true);
    await flush();
    expect(cap).toHaveBeenCalledWith('vm2', expect.anything(), 'console');
  });

  it('ignores non-console paths (returns false, socket untouched)', () => {
    const sock = fakeSocket();
    expect(handleConsoleUpgrade(fakeReq('/api/ide/vm1/proxy/'), sock, Buffer.alloc(0))).toBe(false);
    expect(sock.destroy).not.toHaveBeenCalled();
  });
});
