import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { template: { findUnique: vi.fn(), delete: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({})),
  deleteVm: vi.fn(),
  pveMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { unregister } from '../src/services/template.service.js';

const findUnique = vi.mocked(prisma.template.findUnique);
const del = vi.mocked(prisma.template.delete);
const deleteVm = vi.mocked(pve.deleteVm);

const tpl = { id: 't1', proxmoxVmId: 9000, proxmoxNode: 'pve-2' };

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(tpl as never);
  deleteVm.mockResolvedValue('UPID:ok' as never);
  del.mockResolvedValue({} as never);
});

describe('unregister (delete template from store + Proxmox)', () => {
  it('deletes the Proxmox template VM, then the store row', async () => {
    await unregister('t1');
    expect(deleteVm).toHaveBeenCalledWith('pve-2', 9000, expect.anything());
    expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
  });

  it('is a no-op when the store row is already gone', async () => {
    findUnique.mockResolvedValue(null);
    await unregister('missing');
    expect(deleteVm).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('still removes the store row when the Proxmox template is already gone', async () => {
    deleteVm.mockRejectedValue(new Error('Configuration file does not exist'));
    await expect(unregister('t1')).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
  });

  it('re-throws and keeps the store row when linked clones still exist', async () => {
    deleteVm.mockRejectedValue(new Error("can't remove VM 9000 - it is a base for linked clone 103"));
    await expect(unregister('t1')).rejects.toThrow(/linked clone/i);
    expect(del).not.toHaveBeenCalled();
  });
});
