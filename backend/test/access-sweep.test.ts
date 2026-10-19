import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access-expiry sweep: warn tenants before their compute-access window closes,
// then power off a lapsed tenant's guests — gracefully on the first pass, forcibly on
// later passes — latch the suspension once and tell the admins once.

const NOW = new Date('2026-10-19T12:00:00Z');
const DAY = 86_400_000;

type Row = Record<string, unknown>;
let warnRows: Row[] = [];
let lapsedRows: Row[] = [];

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      // The warning query bounds the deadline from below (gt: now); the lapsed one doesn't.
      findMany: vi.fn(async (args: { where: { accessExpiresAt: { gt?: Date } } }) =>
        args.where.accessExpiresAt.gt ? warnRows : lapsedRows,
      ),
      update: vi.fn(async () => ({})),
    },
  },
}));
vi.mock('../src/services/mail.service.js', () => ({
  isMailConfigured: vi.fn(async () => true),
  sendMail: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/email-templates.js', () => ({
  accessExpiringEmail: vi.fn((o: { daysLeft: number }) => ({ subject: `${o.daysLeft} days`, html: '', text: '' })),
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => 'https://pm.example') }));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/vm.service.js', () => ({
  stopVm: vi.fn(async () => undefined),
  kindOf: () => 'qemu',
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getVmStatus: vi.fn(async () => ({ status: 'running' })),
  pveMessage: (e: unknown) => String((e as Error)?.message ?? e),
}));

import { runAccessExpiryTick } from '../src/services/access-sweep.service.js';
import { prisma } from '../src/lib/prisma.js';
import { isMailConfigured, sendMail } from '../src/services/mail.service.js';
import { recordAudit } from '../src/services/audit.service.js';
import { notify } from '../src/services/notify.service.js';
import { stopVm } from '../src/services/vm.service.js';
import { getVmStatus } from '../src/services/proxmox.service.js';

const update = vi.mocked(prisma.user.update);

const vm = (id: string, vmid: number) => ({ id, name: id, proxmoxNode: 'pve1', proxmoxVmId: vmid });
const tenant = (over: Row = {}): Row => ({
  id: 'u1', email: 't@example.com', displayName: 'T', role: 'user',
  accessExpiresAt: new Date(NOW.getTime() - 60_000), accessSuspendedAt: null,
  accessWarned7For: null, accessWarned1For: null, vms: [], _count: { vms: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  warnRows = [];
  lapsedRows = [];
  vi.mocked(isMailConfigured).mockResolvedValue(true);
  vi.mocked(getVmStatus).mockResolvedValue({ status: 'running' } as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('runAccessExpiryTick — lapsed tenants', () => {
  it('first pass: shuts running guests down gracefully, skips stopped ones, latches and notifies once', async () => {
    lapsedRows = [tenant({ vms: [vm('a', 101), vm('b', 102)] })];
    vi.mocked(getVmStatus).mockImplementation((async (_n: string, vmid: number) =>
      ({ status: vmid === 101 ? 'running' : 'stopped' })) as never);

    const r = await runAccessExpiryTick(NOW);

    expect(r).toEqual({ warned: 0, suspended: 1, stopped: 1 });
    expect(stopVm).toHaveBeenCalledTimes(1);
    expect(stopVm).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), false); // graceful
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { accessSuspendedAt: NOW } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'access.expired' }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.access_suspended', targetId: 'u1' }));
  });

  it('later pass: forces a guest that ignored the shutdown, without re-latching or re-notifying', async () => {
    lapsedRows = [tenant({ accessSuspendedAt: new Date(NOW.getTime() - DAY), vms: [vm('a', 101)] })];

    const r = await runAccessExpiryTick(NOW);

    expect(r).toEqual({ warned: 0, suspended: 0, stopped: 1 });
    expect(stopVm).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), true); // forced
    expect(update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'vm.stop', detail: expect.stringContaining('forced') }),
    );
  });

  it('leaves an already-down suspended tenant alone', async () => {
    lapsedRows = [tenant({ accessSuspendedAt: new Date(NOW.getTime() - DAY), vms: [vm('a', 101)] })];
    vi.mocked(getVmStatus).mockResolvedValue({ status: 'stopped' } as never);

    expect(await runAccessExpiryTick(NOW)).toEqual({ warned: 0, suspended: 0, stopped: 0 });
    expect(stopVm).not.toHaveBeenCalled();
  });

  it('a guest whose status cannot be read or whose stop fails is left for the next pass, and the rest still stop', async () => {
    lapsedRows = [tenant({ vms: [vm('unreadable', 101), vm('stubborn', 102), vm('ok', 103)] })];
    vi.mocked(getVmStatus).mockImplementation((async (_n: string, vmid: number) => {
      if (vmid === 101) throw new Error('node unreachable');
      return { status: 'running' };
    }) as never);
    vi.mocked(stopVm).mockImplementation((async (v: { id: string }) => {
      if (v.id === 'stubborn') throw new Error('The guest has not shut down yet');
    }) as never);

    const r = await runAccessExpiryTick(NOW);

    expect(r).toEqual({ warned: 0, suspended: 1, stopped: 1 });
    expect(stopVm).toHaveBeenCalledTimes(2); // never for the unreadable one
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { accessSuspendedAt: NOW } });
  });

  it('never selects admins for suspension', async () => {
    await runAccessExpiryTick(NOW);
    const lapsedQuery = vi.mocked(prisma.user.findMany).mock.calls
      .map((c) => c[0] as { where: { role: unknown; accessExpiresAt: { gt?: Date; lte: Date } } })
      .find((a) => !a.where.accessExpiresAt.gt)!;
    expect(lapsedQuery.where.role).toEqual({ not: 'admin' });
    expect(lapsedQuery.where.accessExpiresAt).toEqual({ lte: NOW });
  });
});

describe('runAccessExpiryTick — warnings', () => {
  it('does nothing, and stamps nothing, while mail is not configured', async () => {
    vi.mocked(isMailConfigured).mockResolvedValue(false);
    warnRows = [tenant({ accessExpiresAt: new Date(NOW.getTime() + 3 * DAY) })];

    expect((await runAccessExpiryTick(NOW)).warned).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('sends the 7-day warning once per deadline', async () => {
    const deadline = new Date(NOW.getTime() + 3 * DAY);
    warnRows = [tenant({ accessExpiresAt: deadline })];

    expect((await runAccessExpiryTick(NOW)).warned).toBe(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { accessWarned7For: deadline } });

    vi.clearAllMocks();
    warnRows = [tenant({ accessExpiresAt: deadline, accessWarned7For: deadline })];
    expect((await runAccessExpiryTick(NOW)).warned).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('inside the last day sends only the 1-day warning and stamps both levels', async () => {
    const deadline = new Date(NOW.getTime() + 6 * 3_600_000);
    warnRows = [tenant({ accessExpiresAt: deadline })];

    expect((await runAccessExpiryTick(NOW)).warned).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { accessWarned1For: deadline, accessWarned7For: deadline },
    });
  });

  it('an extended window re-arms the warning', async () => {
    const oldDeadline = new Date(NOW.getTime() + 2 * DAY);
    const newDeadline = new Date(NOW.getTime() + 5 * DAY);
    warnRows = [tenant({ accessExpiresAt: newDeadline, accessWarned7For: oldDeadline })];

    expect((await runAccessExpiryTick(NOW)).warned).toBe(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { accessWarned7For: newDeadline } });
  });

  it('a failed send is stamped anyway so a bad address is not retried every tick', async () => {
    const deadline = new Date(NOW.getTime() + 3 * DAY);
    warnRows = [tenant({ accessExpiresAt: deadline })];
    vi.mocked(sendMail).mockRejectedValueOnce(new Error('550 mailbox unavailable'));

    expect((await runAccessExpiryTick(NOW)).warned).toBe(0);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { accessWarned7For: deadline } });
  });
});
