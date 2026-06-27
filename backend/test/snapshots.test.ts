import { describe, it, expect, vi } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  listSnapshots,
  createSnapshot,
  deleteSnapshot,
  rollbackSnapshot,
} from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

describe('listSnapshots', () => {
  it('drops the synthetic "current" entry and sorts newest first', async () => {
    const c = fakeClient();
    c.get.mockResolvedValue({
      data: {
        data: [
          { name: 'before-upgrade', snaptime: 1000 },
          { name: 'current', snaptime: 9999 }, // live state, must be filtered
          { name: 'fresh', snaptime: 2000 },
        ],
      },
    });
    const snaps = await listSnapshots('pve-1', 101, asClient(c));
    expect(c.get.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/snapshot');
    expect(snaps.map((s) => s.name)).toEqual(['fresh', 'before-upgrade']);
  });
});

describe('createSnapshot', () => {
  it('posts the snapname and includes vmstate only when asked', async () => {
    const c = fakeClient();
    await createSnapshot('pve-1', 101, 'snap1', { description: 'hi', vmstate: true }, asClient(c));
    expect(c.post.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/snapshot');
    expect(bodyOf(c.post.mock.calls[0]!)).toEqual({ snapname: 'snap1', description: 'hi', vmstate: '1' });
  });

  it('omits vmstate when not requested', async () => {
    const c = fakeClient();
    await createSnapshot('pve-1', 101, 'snap2', {}, asClient(c));
    expect(bodyOf(c.post.mock.calls[0]!)).toEqual({ snapname: 'snap2' });
  });
});

describe('deleteSnapshot / rollbackSnapshot', () => {
  it('deletes by encoded snapshot name', async () => {
    const c = fakeClient();
    await deleteSnapshot('pve-1', 101, 'snap1', asClient(c));
    expect(c.delete.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/snapshot/snap1');
  });

  it('rolls back via the snapshot rollback endpoint', async () => {
    const c = fakeClient();
    await rollbackSnapshot('pve-1', 101, 'snap1', asClient(c));
    expect(c.post.mock.calls[0]![0]).toBe('/nodes/pve-1/qemu/101/snapshot/snap1/rollback');
  });
});
