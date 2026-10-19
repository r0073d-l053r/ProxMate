import { describe, it, expect, vi, beforeEach } from 'vitest';

// A guest moved outside ProxMate (Proxmox HA, the PVE UI) leaves the row's stored
// node stale. A migration is judged against where the guest actually is.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => null) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { migrateVmToNode, guestMarker } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.virtualMachine.update).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: 'rowa', ...data }) as never,
  );
});

describe('migrateVmToNode after an out-of-band move (BUG-060)', () => {
  it('moves the guest from where it really is to a target equal to its stale stored node', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url.startsWith('/cluster/resources')) {
        return ok([
          { type: 'qemu', vmid: 100, node: 'pve2' },
          { type: 'node', node: 'pve1', status: 'online' },
          { type: 'node', node: 'pve2', status: 'online' },
        ]);
      }
      if (url === '/nodes') return ok([{ node: 'pve1', status: 'online' }, { node: 'pve2', status: 'online' }]);
      if (url === '/nodes/pve2/qemu/100/config') return ok({ name: 'web', tags: guestMarker('rowa') });
      if (/\/status\/current$/.test(url)) return ok({ status: 'stopped' });
      if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
      return ok(null);
    });
    vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
    vi.mocked(prisma.virtualMachine.update).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        ({ id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', ...data }) as never,
    );

    const row = { id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', hasPassthrough: false } as never;
    const moved = await migrateVmToNode(row, 'pve1', { offline: true });

    const migrate = c.post.mock.calls.find((x) => String(x[0]).endsWith('/migrate'));
    expect(migrate?.[0]).toBe('/nodes/pve2/qemu/100/migrate');
    expect(bodyOf(migrate!)['target']).toBe('pve1');
    expect(moved.proxmoxNode).toBe('pve1');
  });
});
