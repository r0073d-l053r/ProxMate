import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeClient, asClient, bodyOf } from './helpers.js';

// The committed pool-isolation proof script (backend/_verify_pools.ts) runs
// against a real cluster with an admin token. Its cleanup must only ever remove
// guests this run created — never whatever happens to sit at a neighbouring VMID.
vi.mock('../src/lib/prisma.js', () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(),
  getConnectionConfig: vi.fn(),
  getNodes: vi.fn(),
  buildClient: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({ data: { data: [] } }),
    post: vi.fn().mockResolvedValue({ data: { data: '' } }),
  })),
  getNextVmId: vi.fn(async (c: { get: (p: string) => Promise<{ data: { data: string } }> }) =>
    parseInt((await c.get('/cluster/nextid')).data.data, 10),
  ),
}));

import { runPoolIsolationProof } from '../_verify_pools.js';

const conn = { host: 'pve.test', tokenId: 'root@pam!pm', verifySsl: true };

function clusterWithGap() {
  // VMs 100 and 102 exist; 101 is a gap. /cluster/nextid returns the lowest
  // free id, so once 101 is taken it answers 103.
  const taken = new Set([100, 102]);
  const admin = fakeClient();
  admin.get.mockImplementation(async (p: string) => {
    if (p === '/cluster/nextid') {
      let id = 100;
      while (taken.has(id)) id++;
      return { data: { data: String(id) } };
    }
    return { data: { data: [] } };
  });
  const post = async (p: string, body: URLSearchParams) => {
    if (p.endsWith('/qemu')) {
      const vmid = Number(body.get('vmid'));
      if (taken.has(vmid)) throw new Error(`VM ${vmid} already exists`);
      taken.add(vmid);
    }
    if (p.includes('/token/')) return { data: { data: { value: 'secret' } } };
    return { data: { data: 'UPID:fake' } };
  };
  admin.post.mockImplementation(post);
  return { admin, post };
}

const deletedGuests = (admin: ReturnType<typeof fakeClient>) =>
  admin.delete.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('/qemu/'));

beforeEach(() => {
  // The script waits a few seconds between VM and pool deletes; skip the wait.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('_verify_pools.ts cleanup', () => {
  it('never targets an existing VM next to the free id, and deletes only what it created', async () => {
    const { admin } = clusterWithGap();
    await runPoolIsolationProof(asClient(admin), conn, 'pve1');

    const created = admin.post.mock.calls
      .filter((c) => String(c[0]).endsWith('/qemu'))
      .map((c) => bodyOf(c).vmid);
    expect(created).toEqual(['101', '103']);
    expect(deletedGuests(admin).sort()).toEqual(['/nodes/pve1/qemu/101', '/nodes/pve1/qemu/103']);
  });

  it('when creating the second VM fails, cleanup removes only the first', async () => {
    const { admin, post } = clusterWithGap();
    admin.post.mockImplementation(async (p: string, body: URLSearchParams) => {
      if (p.endsWith('/qemu') && body.get('name') === 'verify-b') throw new Error('storage full');
      return post(p, body);
    });
    await expect(runPoolIsolationProof(asClient(admin), conn, 'pve1')).rejects.toThrow(/storage full/);
    expect(deletedGuests(admin)).toEqual(['/nodes/pve1/qemu/101']);
  });
});
