import { describe, it, expect, vi } from 'vitest';

// The console WebSocket to Proxmox trusts the same custom CA as the REST client,
// so a cluster with a private CA and TLS verification on gets working consoles.

const wsCtor = vi.fn();
vi.mock('ws', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(...args: unknown[]) {
      wsCtor(...args);
    }
  }
  return { WebSocket: FakeWebSocket, default: FakeWebSocket };
});
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(),
  getConnectionConfig: vi.fn(async () => ({
    host: 'https://pve.example:8006',
    tokenId: 'root@pam!pm',
    tokenSecret: 'secret',
    verifySsl: true,
    ca: '-----BEGIN CERTIFICATE-----\nPRIVATE-CA\n-----END CERTIFICATE-----',
  })),
}));

import { connectVncTarget, connectSerialTarget } from '../src/services/vnc-proxy.service.js';

describe('console WebSocket TLS', () => {
  it('passes the configured CA for both graphical and serial consoles', async () => {
    await connectVncTarget('pve1', 100, '5900', 'ticket');
    await connectSerialTarget('pve1', 100, '5901', 'ticket');
    expect(wsCtor).toHaveBeenCalledTimes(2);
    for (const call of wsCtor.mock.calls) {
      expect(call[2]).toMatchObject({ rejectUnauthorized: true, ca: expect.stringContaining('PRIVATE-CA') });
    }
  });
});
