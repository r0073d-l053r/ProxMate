import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { migrateVm } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

describe('migrateVm', () => {
  it('sets online + with-local-disks for a live migration (works on local storage too)', async () => {
    const c = fakeClient();
    const upid = await migrateVm('pve-0', 100, 'pve-1', true, asClient(c));
    expect(upid).toBe('UPID:fake');
    expect(c.post).toHaveBeenCalledWith('/nodes/pve-0/qemu/100/migrate', expect.anything());
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body).toMatchObject({ target: 'pve-1', online: '1', 'with-local-disks': '1' });
  });

  it('omits online/with-local-disks for an offline (stopped) migration', async () => {
    const c = fakeClient();
    await migrateVm('pve-0', 100, 'pve-1', false, asClient(c));
    const body = bodyOf(c.post.mock.calls[0]!);
    expect(body['target']).toBe('pve-1');
    expect(body['online']).toBeUndefined();
    expect(body['with-local-disks']).toBeUndefined();
  });
});
