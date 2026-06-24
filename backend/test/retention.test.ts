import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { mateState: { findMany: vi.fn(), delete: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  deleteBackup: vi.fn(),
  pveMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { pruneOldMateStates, MATESTATE_RETENTION } from '../src/services/matestate.service.js';

const findMany = vi.mocked(prisma.mateState.findMany);
const del = vi.mocked(prisma.mateState.delete);
const deleteBackup = vi.mocked(pve.deleteBackup);

// `findMany` is queried newest-first, so the array order here is newest → oldest.
const ms = (id: string) =>
  ({ id, vmId: 'vm1', proxmoxNode: 'pve-0', storage: 'backups', volid: `vol-${id}`, status: 'ready' });

beforeEach(() => {
  vi.clearAllMocks();
  deleteBackup.mockResolvedValue(undefined as never);
  del.mockResolvedValue({} as never);
});

describe('pruneOldMateStates (rolling retention)', () => {
  it('defaults to keeping MATESTATE_RETENTION = 2', () => {
    expect(MATESTATE_RETENTION).toBe(2);
  });

  it('keeps the 2 newest and deletes the rest (Proxmox file + DB row)', async () => {
    findMany.mockResolvedValue([ms('a'), ms('b'), ms('c'), ms('d')] as never);

    await pruneOldMateStates('vm1');

    expect(deleteBackup).toHaveBeenCalledTimes(2);
    expect(deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', 'vol-c');
    expect(deleteBackup).toHaveBeenCalledWith('pve-0', 'backups', 'vol-d');
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith({ where: { id: 'c' } });
    expect(del).toHaveBeenCalledWith({ where: { id: 'd' } });
  });

  it('deletes nothing when at or under the limit', async () => {
    findMany.mockResolvedValue([ms('a'), ms('b')] as never);
    await pruneOldMateStates('vm1');
    expect(deleteBackup).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('still removes the DB row when the Proxmox file delete fails (stale row is worse)', async () => {
    findMany.mockResolvedValue([ms('a'), ms('b'), ms('c')] as never);
    deleteBackup.mockRejectedValue(new Error('file gone'));

    await expect(pruneOldMateStates('vm1')).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith({ where: { id: 'c' } });
  });

  it('respects a custom keep count', async () => {
    findMany.mockResolvedValue([ms('a'), ms('b'), ms('c')] as never);
    await pruneOldMateStates('vm1', 1);
    expect(del).toHaveBeenCalledTimes(2);
  });
});
