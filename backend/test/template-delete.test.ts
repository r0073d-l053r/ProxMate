import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { template: { findUnique: vi.fn(), delete: vi.fn() } },
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({})),
  deleteVm: vi.fn(),
  getVmConfig: vi.fn(),
  pveMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { unregister } from '../src/services/template.service.js';
import { notify } from '../src/services/notify.service.js';

const findUnique = vi.mocked(prisma.template.findUnique);
const del = vi.mocked(prisma.template.delete);
const deleteVm = vi.mocked(pve.deleteVm);

const tpl = { id: 't1', proxmoxVmId: 9000, proxmoxNode: 'pve-2' };

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(tpl as never);
  deleteVm.mockResolvedValue('UPID:ok' as never);
  del.mockResolvedValue({} as never);
  vi.mocked(pve.getVmConfig).mockResolvedValue({ template: '1', tags: 'proxmate-template-t1' });
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

  it('leaves a guest that no longer carries this template\'s tag in place, still removing the store row', async () => {
    vi.mocked(pve.getVmConfig).mockResolvedValue({ name: 'someone-else', tags: 'proxmate-rowb' });
    await unregister('t1');
    expect(deleteVm).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/9000/) }));
  });

  it('leaves an untagged guest at the VMID in place', async () => {
    vi.mocked(pve.getVmConfig).mockResolvedValue({ name: 'web' });
    await unregister('t1');
    expect(deleteVm).not.toHaveBeenCalled();
  });

  it('removes just the store row when no guest is at the VMID', async () => {
    vi.mocked(pve.getVmConfig).mockRejectedValue(new Error("Configuration file 'nodes/pve-2/qemu-server/9000.conf' does not exist"));
    await unregister('t1');
    expect(deleteVm).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the store row when the guest can\'t be checked', async () => {
    vi.mocked(pve.getVmConfig).mockRejectedValue(new Error('pveproxy timeout'));
    await expect(unregister('t1')).rejects.toThrow(/timeout/);
    expect(deleteVm).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
