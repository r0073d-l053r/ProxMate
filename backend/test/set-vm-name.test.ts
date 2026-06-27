import { describe, it, expect, vi } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { setVmName } from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

describe('setVmName', () => {
  it('PUTs the new name to the VM config endpoint', async () => {
    const c = fakeClient();
    await setVmName('pve-1', 101, 'web-server-02', asClient(c));
    expect(c.put.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/config');
    expect(bodyOf(c.put.mock.calls[0]!)).toEqual({ name: 'web-server-02' });
  });
});
