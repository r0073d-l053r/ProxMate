import { describe, it, expect, vi, beforeEach } from 'vitest';

// A row in `error` holds a guest that never got (or lost) the isolation, sizing
// and device checks a guest needs before it runs. Nothing may start it or hand
// over control of it; only delete and repair paths are allowed.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findUnique: vi.fn(), update: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => ({ role: 'user', accessExpiresAt: null })) },
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
import {
  startVm,
  restartVm,
  resumeVm,
  stopVm,
  requireOurGuest,
  settleFailedCreate,
  GuestErroredError,
  guestMarker,
  templateMarker,
} from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const row = (over: Record<string, unknown> = {}) =>
  ({ id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'error', holdReason: null, ...over }) as never;

function pve1(tags: string, task: { status: string; exitstatus?: string } = { status: 'stopped', exitstatus: 'OK' }) {
  const c = fakeClient();
  const state = { task };
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) return ok([{ type: 'qemu', vmid: 100, node: 'pve1' }]);
    if (/\/qemu\/100\/config$/.test(url)) return ok({ name: 'web', tags });
    if (/\/status\/current$/.test(url)) return ok({ status: 'stopped' });
    if (/\/tasks\/.*\/status$/.test(url)) return ok(state.task);
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return { c, state };
}

beforeEach(() => vi.clearAllMocks());

describe('a row in error can\'t be started or handed over (audit MAJOR 1)', () => {
  it('start, restart and resume are refused without touching Proxmox', async () => {
    const { c } = pve1(guestMarker('rowa'));
    await expect(startVm(row())).rejects.toBeInstanceOf(GuestErroredError);
    await expect(restartVm(row())).rejects.toBeInstanceOf(GuestErroredError);
    await expect(resumeVm(row())).rejects.toBeInstanceOf(GuestErroredError);
    expect(c.post).not.toHaveBeenCalled();
  });

  it('the shared gate (console, serial, IDE install, rename, …) refuses it, with the row\'s own explanation', async () => {
    pve1(guestMarker('rowa'));
    await expect(requireOurGuest(row({ holdReason: 'Over quota after a restore.' }))).rejects.toThrow('Over quota after a restore.');
  });

  it('repair and teardown paths are still allowed', async () => {
    pve1(guestMarker('rowa'));
    await expect(requireOurGuest(row(), { allowError: true })).resolves.toBeDefined();
    // stopVm passes the gate (it then fails only for want of a configured cluster here).
    await expect(stopVm(row(), true)).rejects.not.toBeInstanceOf(GuestErroredError);
  });
});

describe('late create-task follower (audit MAJOR 1)', () => {
  it('does not claim the guest once its row has been deleted, and still runs its cleanup', async () => {
    const { c, state } = pve1(templateMarker('t1'), { status: 'running' });
    const afterTask = vi.fn(async () => undefined);
    const r = await settleFailedCreate(row({ status: 'creating' }), new Error('timed out'), false, {
      task: { node: 'pve1', upid: 'UPID:x', afterTask },
    });
    expect(r.following).toBe(true);
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(null); // the owner deleted the row
    state.task = { status: 'stopped', exitstatus: 'OK' };
    await vi.waitFor(() => expect(afterTask).toHaveBeenCalled(), { timeout: 5000 });
    expect(c.put.mock.calls.some((x) => bodyOf(x)['tags'] !== undefined)).toBe(false);
  });

  it('makes the late guest safe before tagging it, and never tags it when that fails (audit round 2)', async () => {
    const { c, state } = pve1(templateMarker('t1'), { status: 'running' });
    const order: string[] = [];
    const beforeTag = vi.fn(async () => {
      order.push('beforeTag');
      throw new Error('volume check failed');
    });
    const afterTask = vi.fn(async () => {
      order.push('afterTask');
    });
    await settleFailedCreate(row({ status: 'creating' }), new Error('timed out'), false, {
      task: { node: 'pve1', upid: 'UPID:x', beforeTag, afterTask },
    });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row());
    state.task = { status: 'stopped', exitstatus: 'OK' };
    await vi.waitFor(() => expect(afterTask).toHaveBeenCalled(), { timeout: 5000 });
    expect(order).toEqual(['beforeTag', 'afterTask']);
    expect(c.put.mock.calls.some((x) => bodyOf(x)['tags'] !== undefined)).toBe(false);
  });

  it('runs the safety step before tagging when the task had already finished', async () => {
    const { c } = pve1(templateMarker('t1'), { status: 'stopped', exitstatus: 'OK' });
    const beforeTag = vi.fn(async () => undefined);
    await settleFailedCreate(row({ status: 'creating' }), new Error('timed out'), false, {
      task: { node: 'pve1', upid: 'UPID:x', beforeTag },
    });
    const tagPut = c.put.mock.calls.findIndex((x) => bodyOf(x)['tags'] === guestMarker('rowa'));
    expect(beforeTag).toHaveBeenCalled();
    expect(beforeTag.mock.invocationCallOrder[0]!).toBeLessThan(c.put.mock.invocationCallOrder[tagPut]!);
  });

  it('tags the guest only while the row still points at that VMID', async () => {
    const { c, state } = pve1(templateMarker('t1'), { status: 'running' });
    await settleFailedCreate(row({ status: 'creating' }), new Error('timed out'), false, { task: { node: 'pve1', upid: 'UPID:x' } });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row());
    state.task = { status: 'stopped', exitstatus: 'OK' };
    await vi.waitFor(() => expect(c.put.mock.calls.some((x) => bodyOf(x)['tags'] === guestMarker('rowa'))).toBe(true), {
      timeout: 5000,
    });
    // The row stays in error: the tag only lets it be deleted together with its guest.
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: expect.objectContaining({ status: 'error', holdReason: expect.any(String) }) });
  });
});
