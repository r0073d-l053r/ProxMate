import { describe, it, expect, vi, beforeEach } from 'vitest';

// A clone (or restore) gets its row's tag only after its task finishes. When the
// task outlives the wait, the guest at the VMID still carries the source's tags,
// and settling the failed create must not drop the row and leave that guest
// unowned.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1' })),
    },
    ideGuestSecret: { deleteMany: vi.fn(async () => ({})) },
    ideGatewayToken: { deleteMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
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
import { settleFailedCreate, guestMarker, templateMarker } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';
import { isInFlight } from '../src/lib/in-flight.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const row = { id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1' } as never;
const err = new Error('Proxmox task timed out');

/** Fake PVE: guest 100 has `tags` (null = no guest); the clone task reports `task`. */
function pveWith(tags: string | null, task: { status: string; exitstatus?: string } | null = null) {
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (/\/qemu\/100\/config$/.test(url)) {
      return tags === null ? Promise.reject(new Error("Configuration file 'qemu-server/100.conf' does not exist")) : ok({ name: 'web', tags });
    }
    if (/\/tasks\/.*\/status$/.test(url)) return task ? ok(task) : Promise.reject(new Error('no such task'));
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

const kept = () => {
  expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
  expect(prisma.virtualMachine.update).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: expect.objectContaining({ status: 'error', holdReason: expect.any(String) }) });
};
const dropped = () => expect(prisma.virtualMachine.delete).toHaveBeenCalledWith({ where: { id: 'rowa' } });

beforeEach(() => vi.clearAllMocks());

describe('settleFailedCreate for a clone whose task outlived the wait (C1)', () => {
  it('keeps the row when the guest carries only the template\'s tag', async () => {
    pveWith(templateMarker('tpl1'));
    await settleFailedCreate(row, err, false);
    kept();
  });

  it('keeps the row when the guest carries no tag at all', async () => {
    pveWith('');
    await settleFailedCreate(row, err, false);
    kept();
  });

  it('keeps the row when a duplicate\'s copy carries its source machine\'s tag', async () => {
    pveWith(guestMarker('source'));
    await settleFailedCreate(row, err, false, { cloneSourceId: 'source' });
    kept();
  });

  it('still drops the row when the VMID holds another machine\'s guest, or nothing', async () => {
    pveWith(guestMarker('rowb'));
    await settleFailedCreate(row, err, false);
    dropped();
    vi.clearAllMocks();
    pveWith(null);
    await settleFailedCreate(row, err, false);
    dropped();
  });

  it('tags the guest as the row\'s when the clone task finished after all', async () => {
    const c = pveWith(templateMarker('tpl1'), { status: 'stopped', exitstatus: 'OK' });
    await settleFailedCreate(row, err, false, { task: { node: 'pve1', upid: 'UPID:clone' } });
    kept();
    const tag = c.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve1/qemu/100/config');
    expect(bodyOf(tag!)['tags']).toBe(guestMarker('rowa'));
  });

  it('follows a clone task that is still running and tags the guest when it completes', async () => {
    const c = pveWith(templateMarker('tpl1'), { status: 'running' });
    await settleFailedCreate(row, err, false, { task: { node: 'pve1', upid: 'UPID:clone' } });
    kept();
    // Held, but its op fields stay while the task is followed (the restart
    // reconciler needs them if this follower is lost), and it counts as in flight.
    const hold = vi.mocked(prisma.virtualMachine.update).mock.calls.find((x) => (x[0] as { data: Record<string, unknown> }).data['status'] === 'error');
    expect((hold![0] as { data: Record<string, unknown> }).data).not.toHaveProperty('opUpid');
    expect(isInFlight('rowa')).toBe(true);
    // The task now finishes.
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) => (/\/tasks\/.*\/status$/.test(url) ? ok({ status: 'stopped', exitstatus: 'OK' }) : get(url)));
    await vi.waitFor(
      () => {
        const tag = c.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve1/qemu/100/config');
        expect(bodyOf(tag!)['tags']).toBe(guestMarker('rowa'));
      },
      { timeout: 5000 },
    );
    // Settled: its op fields are cleared (only while they still name this task).
    await vi.waitFor(() =>
      expect(prisma.virtualMachine.updateMany).toHaveBeenCalledWith({
        where: { id: 'rowa', opUpid: 'UPID:clone' },
        data: expect.objectContaining({ opUpid: null, opKind: null }),
      }),
    );
    expect(isInFlight('rowa')).toBe(false);
  });

  it('a follower that loses the task (poll error) leaves the op fields for the restart reconciler', async () => {
    const c = pveWith(templateMarker('tpl1'), { status: 'running' });
    const afterTask = vi.fn(async () => undefined);
    await settleFailedCreate(row, err, false, { task: { node: 'pve1', upid: 'UPID:clone', afterTask } });
    expect(isInFlight('rowa')).toBe(true);
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) => (/\/tasks\/.*\/status$/.test(url) ? Promise.reject(new Error('connect ETIMEDOUT')) : get(url)));
    await vi.waitFor(() => expect(isInFlight('rowa')).toBe(false), { timeout: 5000 });
    expect(prisma.virtualMachine.updateMany).not.toHaveBeenCalled();
    expect(afterTask).not.toHaveBeenCalled(); // the archive stays for whoever settles the row
    expect(c.put.mock.calls.some((x) => String(x[0]) === '/nodes/pve1/qemu/100/config')).toBe(false);
  });

  it('a follower whose task fails settles the row: cleanup runs and the op fields are cleared, nothing tagged', async () => {
    const c = pveWith(templateMarker('tpl1'), { status: 'running' });
    const afterTask = vi.fn(async () => undefined);
    await settleFailedCreate(row, err, false, { task: { node: 'pve1', upid: 'UPID:clone', afterTask } });
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) =>
      /\/tasks\/.*\/status$/.test(url) ? ok({ status: 'stopped', exitstatus: 'clone failed' }) : get(url),
    );
    await vi.waitFor(() => expect(isInFlight('rowa')).toBe(false), { timeout: 5000 });
    expect(afterTask).toHaveBeenCalled();
    expect(prisma.virtualMachine.updateMany).toHaveBeenCalledWith({
      where: { id: 'rowa', opUpid: 'UPID:clone' },
      data: expect.objectContaining({ opUpid: null }),
    });
    expect(c.put.mock.calls.some((x) => String(x[0]) === '/nodes/pve1/qemu/100/config')).toBe(false);
  });

  it('keeps a hold the row already has instead of overwriting it (audit round 3)', async () => {
    pveWith(guestMarker('rowa'));
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValueOnce({ holdReason: 'Over quota after a restore.' } as never);
    await settleFailedCreate(row, new Error('quota'), true);
    expect(prisma.virtualMachine.update).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
  });

  it('a clone task that failed falls back to what is at the VMID', async () => {
    pveWith(null, { status: 'stopped', exitstatus: 'clone failed' });
    await settleFailedCreate(row, err, false, { task: { node: 'pve1', upid: 'UPID:clone' } });
    dropped();
  });
});

describe('a restore task\'s verify step (the restored guest is checked whatever the row\'s state)', () => {
  const removed = () => Object.assign(new Error('settings ProxMate won\'t restore'), { guestRemoved: true });

  it('finished in time: a removed guest drops the row and is never tagged', async () => {
    const c = pveWith(null, { status: 'stopped', exitstatus: 'OK' });
    const beforeTag = vi.fn(async () => undefined);
    await settleFailedCreate(row, err, false, {
      task: { node: 'pve1', upid: 'UPID:r', verify: async () => { throw removed(); }, beforeTag },
    });
    dropped();
    expect(beforeTag).not.toHaveBeenCalled();
    expect(c.put).not.toHaveBeenCalled();
  });

  it('finished in time: a guest that failed but stayed keeps the row held, untagged', async () => {
    const c = pveWith(templateMarker('tpl1'), { status: 'stopped', exitstatus: 'OK' });
    await settleFailedCreate(row, err, false, {
      task: { node: 'pve1', upid: 'UPID:r', verify: async () => { throw Object.assign(new Error('x'), { guestRemoved: false }); } },
    });
    kept();
    expect(c.put).not.toHaveBeenCalled();
  });

  it('followed: verify runs even after the row is gone, and a removed guest drops the row if it still points here', async () => {
    const c = pveWith(templateMarker('tpl1'), { status: 'running' });
    const verify = vi.fn(async () => { throw removed(); });
    await settleFailedCreate(row, err, false, { task: { node: 'pve1', upid: 'UPID:r', verify } });
    kept();
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(null as never); // the row was deleted meanwhile
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) => (/\/tasks\/.*\/status$/.test(url) ? ok({ status: 'stopped', exitstatus: 'OK' }) : get(url)));
    await vi.waitFor(() => expect(verify).toHaveBeenCalled(), { timeout: 5000 });
    expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
    expect(c.put).not.toHaveBeenCalled();
  });

  it('followed: with the row still there, a removed guest drops it', async () => {
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue({ ...(row as object) } as never);
    const c = pveWith(templateMarker('tpl1'), { status: 'running' });
    const verify = vi.fn(async () => { throw removed(); });
    await settleFailedCreate(row, err, false, { task: { node: 'pve1', upid: 'UPID:r', verify } });
    const get = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) => (/\/tasks\/.*\/status$/.test(url) ? ok({ status: 'stopped', exitstatus: 'OK' }) : get(url)));
    await vi.waitFor(() => dropped(), { timeout: 5000 });
  });
});
