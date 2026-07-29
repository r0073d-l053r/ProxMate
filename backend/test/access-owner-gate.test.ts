import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the OWNER-side power-on gate.
 *
 * An adversarial review found that suspension was decorative on any shared VM:
 * a co-owner whose own access is fine holds the `power` capability, so one click
 * on Start (or Resume, or Rescue) revived a suspended tenant's machine. The gate
 * therefore keys on the VM OWNER's window, never the caller's — these tests pin
 * that, one per power-on path, so a future refactor that drops one fails CI.
 */

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique },
    virtualMachine: { update: vi.fn(async () => ({})), findUnique: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({}) as never),
    // Any of these firing means the gate let a power-on through.
    startVm: vi.fn(async () => 'UPID:start'),
    resumeVm: vi.fn(async () => 'UPID:resume'),
    rebootVm: vi.fn(async () => 'UPID:reboot'),
    getVmStatus: vi.fn(async () => ({ status: 'stopped' })),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import { startVm, restartVm } from '../src/services/vm.service.js';

const VM = {
  id: 'vm1',
  userId: 'owner1',
  proxmoxVmId: 100,
  proxmoxNode: 'pve-0',
  name: 'web-01',
  type: 'qemu',
} as never;

const EXPIRED_OWNER = { role: 'user', accessExpiresAt: new Date(Date.now() - 86_400_000) };
const ACTIVE_OWNER = { role: 'user', accessExpiresAt: new Date(Date.now() + 86_400_000) };
const NEVER_EXPIRES = { role: 'user', accessExpiresAt: null };

beforeEach(() => {
  vi.mocked(pve.startVm).mockClear();
  vi.mocked(pve.rebootVm).mockClear();
  findUnique.mockReset();
});

describe('power-on gate keys on the VM OWNER, not the caller', () => {
  it('refuses to start a suspended owner\'s VM — the shared-VM bypass', async () => {
    findUnique.mockResolvedValue(EXPIRED_OWNER);
    await expect(startVm(VM)).rejects.toThrow(/compute access window/i);
    expect(pve.startVm).not.toHaveBeenCalled(); // never reached Proxmox
  });

  it('refuses to restart a suspended owner\'s VM', async () => {
    findUnique.mockResolvedValue(EXPIRED_OWNER);
    await expect(restartVm(VM)).rejects.toThrow(/compute access window/i);
    expect(pve.rebootVm).not.toHaveBeenCalled();
  });

  it('allows a start while the owner is inside their window', async () => {
    findUnique.mockResolvedValue(ACTIVE_OWNER);
    await expect(startVm(VM)).resolves.toBeUndefined();
    expect(pve.startVm).toHaveBeenCalledOnce();
  });

  it('allows a start when the owner never expires (the default)', async () => {
    findUnique.mockResolvedValue(NEVER_EXPIRES);
    await expect(startVm(VM)).resolves.toBeUndefined();
    expect(pve.startVm).toHaveBeenCalledOnce();
  });

  it('never blocks an admin owner, even with a stale past expiry on the row', async () => {
    // A tenant promoted to admin keeps the accessExpiresAt from their invite.
    findUnique.mockResolvedValue({ role: 'admin', accessExpiresAt: new Date(Date.now() - 86_400_000) });
    await expect(startVm(VM)).resolves.toBeUndefined();
    expect(pve.startVm).toHaveBeenCalledOnce();
  });

  it('does not block when the owner row is missing (fail-open on a broken FK)', async () => {
    findUnique.mockResolvedValue(null);
    await expect(startVm(VM)).resolves.toBeUndefined();
  });
});
