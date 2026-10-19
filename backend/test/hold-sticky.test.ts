import { describe, it, expect, vi, beforeEach } from 'vitest';

// A held row stays held: viewing it (live-status sync), stopping it or detaching
// its PCI device must not make it startable again. Only repair paths clear a hold.

const db: { row: Record<string, unknown> } = { row: {} };

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findUnique: vi.fn(async () => ({ ...db.row })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.row = { ...db.row, ...data };
        return { ...db.row };
      }),
    },
    user: { findUnique: vi.fn(async () => ({ role: 'user', accessExpiresAt: null })) },
  },
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => null) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    getVmStatus: vi.fn(async () => ({ status: 'stopped' })),
    stopVm: vi.fn(async () => 'UPID:stop'),
    shutdownVm: vi.fn(async () => 'UPID:shutdown'),
    startVm: vi.fn(async () => 'UPID:start'),
    detachPci: vi.fn(async () => undefined),
    // stopVm now awaits the power task's outcome; this suite is about whether a
    // hold survives the stop, so let the task simply succeed.
    waitForTask: vi.fn(async () => undefined),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import { getVmWithLiveStatus, startVm, stopVm, guestMarker, GuestErroredError } from '../src/services/vm.service.js';
import { detachPassthrough } from '../src/services/passthrough-request.service.js';
import { fakeClient, asClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });

beforeEach(() => {
  vi.clearAllMocks();
  db.row = {
    id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1',
    status: 'error', holdReason: 'Over quota after a restore.', hasPassthrough: true,
  };
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) return ok([{ type: 'qemu', vmid: 100, node: 'pve1', tags: guestMarker('rowa') }]);
    if (/\/qemu\/100\/config$/.test(url)) return ok({ name: 'web', tags: guestMarker('rowa') });
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
});

const current = () => ({ ...db.row }) as never;

describe('a held row stays held (audit round 2, blocker 1)', () => {
  it('view, then start: the live-status sync does not lift the hold', async () => {
    await getVmWithLiveStatus(current());
    expect(db.row['status']).toBe('error');
    await expect(startVm(current())).rejects.toBeInstanceOf(GuestErroredError);
    expect(pve.startVm).not.toHaveBeenCalled();
  });

  it('stop, then start', async () => {
    await stopVm(current(), true);
    expect(pve.stopVm).toHaveBeenCalled();
    expect(db.row['status']).toBe('error');
    await expect(startVm(current())).rejects.toBeInstanceOf(GuestErroredError);
  });

  it('detach the PCI device, then start', async () => {
    vi.mocked(pve.getVmStatus).mockResolvedValueOnce({ status: 'running' } as never);
    await detachPassthrough(current(), 0);
    expect(db.row['status']).toBe('error');
    await expect(startVm(current())).rejects.toBeInstanceOf(GuestErroredError);
  });

  it('even with a status a sync wrote earlier, the hold alone refuses start', async () => {
    db.row['status'] = 'stopped';
    await expect(startVm(current())).rejects.toThrow('Over quota after a restore.');
  });
});
