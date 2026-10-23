import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rows whose guest carries no ProxMate tag (created before tags existed and not
// matched by the backfill): deletes are refused rather than silently orphaning the
// guest, an admin can adopt the guest or remove just the row, the backfill keeps
// retrying until a clean pass, and status/IP/usage are never taken from a guest
// that isn't the row's own.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
    user: { findUnique: vi.fn(async () => null) },
    resourceSample: { createMany: vi.fn(async () => ({})) },
    template: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    ideGuestSecret: { deleteMany: vi.fn(async () => ({})) },
    ideGatewayToken: { deleteMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
// Isolation off and no default bridge: an adopt's make-safe step (covered in
// adopt-repair.test.ts) then only re-reads the guest's sizes.
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (key: string) => ({ isolation_enabled: 'false' })[key] ?? null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { beginInFlight, isInFlight } from '../src/lib/in-flight.js';
import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import {
  destroyVm,
  destroyBlocker,
  adoptGuest,
  AdoptError,
  listUnmatchedVms,
  runGuestMarkerBackfill,
  resetGuestMarkerBackfill,
  settleFailedCreate,
  getVmWithLiveStatus,
  refreshVmIps,
  getLiveUsage,
  guestMarker,
  GuestIdentityError,
  isHeld,
} from '../src/services/vm.service.js';
import { sampleResourceUsage } from '../src/services/resource-history.service.js';
import { notify } from '../src/services/notify.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const row = (over: Record<string, unknown> = {}) =>
  ({ id: 'rowa', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 100, proxmoxNode: 'pve1', status: 'running', ...over }) as never;

const ok = (data: unknown) => Promise.resolve({ data: { data } });

/** Guest 100 with `cfg` (null = no guest). Resource listings carry its tags. */
function pveWith(cfg: Record<string, string> | null, extra: Record<string, unknown> = {}) {
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/cluster/resources')) {
      return ok(cfg ? [{ type: 'qemu', vmid: 100, node: 'pve1', name: cfg['name'], tags: cfg['tags'], status: 'running', cpu: 0.5, maxcpu: 2, mem: 5, maxmem: 10, ...extra }] : []);
    }
    if (/\/qemu\/100\/config$/.test(url)) {
      return cfg ? ok(cfg) : Promise.reject(new Error("Configuration file 'nodes/pve1/qemu-server/100.conf' does not exist"));
    }
    if (/\/qemu\/100\/status\/current$/.test(url)) return ok({ status: 'stopped' });
    if (/agent\/network-get-interfaces$/.test(url)) {
      return ok({ result: [{ name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.9.9.9' }] }] });
    }
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetGuestMarkerBackfill();
  vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.virtualMachine.count).mockResolvedValue(0 as never);
});

describe('deleting a machine whose guest carries no ProxMate tag', () => {
  it('is refused (nothing destroyed, row kept) with an ask-an-admin message', async () => {
    const c = pveWith({ name: 'web' });
    await expect(destroyVm(row())).rejects.toBeInstanceOf(GuestIdentityError);
    await expect(destroyVm(row())).rejects.toThrow(/predates ProxMate's ownership tags — ask an admin/);
    expect(c.delete).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
  });

  it('an admin row-only delete removes just the row (and its IDE credentials), touching no guest', async () => {
    const c = pveWith({ name: 'web' });
    await destroyVm(row(), { rowOnly: true });
    expect(c.delete).not.toHaveBeenCalled();
    expect(c.post).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.delete).toHaveBeenCalledWith({ where: { id: 'rowa' } });
    expect(prisma.ideGuestSecret.deleteMany).toHaveBeenCalledWith({ where: { vmId: 'rowa' } });
    expect(prisma.ideGatewayToken.deleteMany).toHaveBeenCalledWith({ where: { vmId: 'rowa' } });
  });
});

describe('destroyBlocker (account deletion pre-check)', () => {
  it('names an untagged guest, and passes a tagged or foreign one', async () => {
    pveWith({ name: 'web' });
    expect(await destroyBlocker(row())).toMatch(/predates ProxMate's ownership tags/);
    pveWith({ name: 'web', tags: guestMarker('rowa') });
    expect(await destroyBlocker(row())).toBeNull();
    pveWith({ name: 'x', tags: guestMarker('rowb') });
    expect(await destroyBlocker(row())).toBeNull();
  });
});

describe('row-only delete', () => {
  it('is refused when the guest is confirmed as the row\'s own (a normal delete is the way)', async () => {
    pveWith({ name: 'web', tags: guestMarker('rowa') });
    await expect(destroyVm(row(), { rowOnly: true })).rejects.toThrow(/delete it normally/);
    expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
  });
});

describe('adoptGuest (admin)', () => {
  it('tags an untagged guest as this row\'s, keeping its other tags', async () => {
    const c = pveWith({ name: 'web', tags: 'prod' });
    await adoptGuest(row());
    const put = c.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve1/qemu/100/config');
    expect(bodyOf(put!)['tags']).toBe(`prod;${guestMarker('rowa')}`);
  });

  it('refuses a guest carrying another row\'s tag', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowb') });
    await expect(adoptGuest(row())).rejects.toBeInstanceOf(AdoptError);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses when another row references the same VMID', async () => {
    const c = pveWith({ name: 'web' });
    vi.mocked(prisma.virtualMachine.count).mockResolvedValue(1 as never);
    await expect(adoptGuest(row())).rejects.toThrow(/Another machine also references this VMID/);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses a VMID that belongs to a Template Store entry', async () => {
    const c = pveWith({ name: 'web' });
    vi.mocked(prisma.template.count).mockResolvedValueOnce(1 as never);
    await expect(adoptGuest(row())).rejects.toThrow(/Template Store/);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses a guest that is a Proxmox template', async () => {
    const c = pveWith({ name: 'web', template: '1' });
    await expect(adoptGuest(row())).rejects.toThrow(/Proxmox template/);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses when there is no guest at the VMID', async () => {
    pveWith(null);
    await expect(adoptGuest(row())).rejects.toThrow(/no Proxmox guest/);
  });

  it('keeps a hold while the guest still references another guest\'s volume (audit round 3)', async () => {
    pveWith({ name: 'web', tags: guestMarker('rowa'), scsi1: 'local-lvm:vm-200-disk-0,size=10G' });
    const held = row({ status: 'error', holdReason: 'The restored machine referenced disks that belong to another guest.' });
    await expect(adoptGuest(held)).rejects.toThrow(/aren't its own/);
    expect(prisma.virtualMachine.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ holdReason: null }) }));
  });

  it('refuses while the machine is still being worked on (a create, restore or follower in flight)', async () => {
    const c = pveWith({ name: 'web', tags: guestMarker('rowa'), scsi0: 'local-lvm:vm-100-disk-0,size=10G' });
    const done = beginInFlight('rowa');
    try {
      await expect(adoptGuest(row({ status: 'error', holdReason: 'x' }))).rejects.toThrow(/still being worked on/);
    } finally {
      done();
    }
    expect(c.put).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.update).not.toHaveBeenCalled();
  });

  it('holds the row in flight for the whole adopt, so nothing else can start on it meanwhile', async () => {
    const c = pveWith({ name: 'web', tags: 'prod', scsi0: 'local-lvm:vm-100-disk-0,size=10G' });
    const seen: boolean[] = [];
    const base = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string, opts?: unknown) => {
      seen.push(isInFlight('rowa'));
      return base(url, opts);
    });
    c.put.mockImplementation(() => {
      seen.push(isInFlight('rowa'));
      return ok('');
    });
    await adoptGuest(row({ status: 'error', holdReason: "This machine's provisioning didn't finish." }));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every(Boolean)).toBe(true);
    // Released once done, also when the adopt is refused part-way.
    expect(isInFlight('rowa')).toBe(false);
    pveWith({ name: 'web', tags: guestMarker('rowb') });
    await expect(adoptGuest(row())).rejects.toBeInstanceOf(AdoptError);
    expect(isInFlight('rowa')).toBe(false);
  });

  it('lifts a hold once the guest references only its own volumes', async () => {
    pveWith({ name: 'web', tags: guestMarker('rowa'), scsi0: 'local-lvm:vm-100-disk-0,size=10G' });
    const held = row({ status: 'error', holdReason: "This machine's provisioning didn't finish." });
    await adoptGuest(held);
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: { status: 'stopped', holdReason: null, opKind: null, opStartedAt: null, opUpid: null, opSourceId: null, opArchive: null } });
  });

  it('a 1.0.x error row whose untagged guest is adopted becomes startable in one step', async () => {
    const c = pveWith({ name: 'web', scsi0: 'local-lvm:vm-100-disk-0,size=10G' });
    const errored = row({ status: 'error', holdReason: null });
    vi.mocked(prisma.virtualMachine.update).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...(errored as object), ...data }) as never,
    );
    const adopted = await adoptGuest(errored);
    expect(c.put).toHaveBeenCalled(); // tagged first
    expect(prisma.virtualMachine.update).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: { status: 'stopped', holdReason: null, opKind: null, opStartedAt: null, opUpid: null, opSourceId: null, opArchive: null } });
    expect(isHeld(adopted)).toBe(false);
  });

  it('an untagged held row referencing another guest\'s volume is refused and stays held', async () => {
    const c = pveWith({ name: 'web', scsi1: 'local-lvm:vm-200-disk-0,size=10G' });
    await expect(adoptGuest(row({ status: 'error', holdReason: null }))).rejects.toThrow(/aren't its own/);
    expect(c.put).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.update).not.toHaveBeenCalled();
  });

  it('refuses to adopt an untagged guest that references another guest\'s volume', async () => {
    const c = pveWith({ name: 'web', scsi1: 'local-lvm:vm-200-disk-0,size=10G' });
    await expect(adoptGuest(row())).rejects.toThrow(/aren't its own/);
    expect(c.put).not.toHaveBeenCalled();
  });
});

describe('listUnmatchedVms (admin)', () => {
  it('lists only rows without a guest carrying their tag, with what is at the VMID', async () => {
    pveWith({ name: 'web' });
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([
      row(),
      row({ id: 'rowz', name: 'gone', proxmoxVmId: 555 }),
    ] as never);
    const list = await listUnmatchedVms();
    expect(list.map((r) => [r.id, r.guest.present, r.guest.name])).toEqual([
      ['rowa', true, 'web'],
      ['rowz', false, null],
    ]);
  });
});

describe('templates', () => {
  it('flags a row whose VMID holds a template or a Template Store entry', async () => {
    pveWith({ name: 'tpl' }, { template: 1 });
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([row()] as never);
    vi.mocked(prisma.template.findMany).mockResolvedValueOnce([{ proxmoxVmId: 100 }] as never);
    const [r] = await listUnmatchedVms();
    expect(r!.guest.isTemplate).toBe(true);
    expect(r!.templateRow).toBe(true);
  });

  it('the backfill tags a store template\'s guest and never offers it to a machine row', async () => {
    const c = pveWith({ name: 'web' }, { template: 1 });
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([row()] as never);
    vi.mocked(prisma.template.findMany).mockResolvedValueOnce([{ id: 'tplx', proxmoxVmId: 100, proxmoxNode: 'pve1' }] as never);
    const r = await runGuestMarkerBackfill();
    expect(r).toMatchObject({ tagged: 0, unmatched: 1, errors: 0 });
    const puts = c.put.mock.calls.map((x) => bodyOf(x)['tags']);
    expect(puts).toEqual(['proxmate-template-tplx']);
  });

  it('a template-tagged guest is another\'s to every machine row', async () => {
    pveWith({ name: 'web', tags: 'proxmate-template-tplx' });
    await expect(destroyVm(row())).resolves.toBeUndefined();
    expect(prisma.virtualMachine.delete).toHaveBeenCalled(); // row only — the template is left alone
  });
});

describe('runGuestMarkerBackfill keeps retrying until a clean pass', () => {
  it('re-runs after a pass with Proxmox errors, then stops once a pass is clean', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([row()] as never);
    const c = pveWith({ name: 'web' });
    const base = c.get.getMockImplementation()!;
    // First pass: the guest's config can't be read.
    c.get.mockImplementation((url: string) =>
      /\/config$/.test(url) ? Promise.reject(new Error('pveproxy timeout')) : base(url),
    );
    expect(await runGuestMarkerBackfill()).toMatchObject({ ran: true, errors: 1, tagged: 0 });
    // Second pass succeeds and tags it.
    c.get.mockImplementation(base);
    expect(await runGuestMarkerBackfill()).toMatchObject({ ran: true, errors: 0, tagged: 1 });
    // Done: later ticks are no-ops.
    expect(await runGuestMarkerBackfill()).toEqual({ ran: false });
  });

  it('tells the admins once, with the count, when a completed pass leaves rows unmatched', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([
      row(),
      row({ id: 'rowz', name: 'gone', proxmoxVmId: 555 }),
    ] as never);
    // 100 is another row's guest; 555 has no guest — neither can be matched.
    pveWith({ name: 'web', tags: guestMarker('rowb') });
    expect(await runGuestMarkerBackfill()).toMatchObject({ ran: true, errors: 0, unmatched: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/2 machine/) }));
    await runGuestMarkerBackfill();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('says nothing after a pass with errors (it will run again) or a pass that matched everything', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([row()] as never);
    const c = pveWith({ name: 'web' });
    const base = c.get.getMockImplementation()!;
    c.get.mockImplementation((url: string) =>
      /\/config$/.test(url) ? Promise.reject(new Error('pveproxy timeout')) : base(url),
    );
    await runGuestMarkerBackfill();
    expect(notify).not.toHaveBeenCalled();
    c.get.mockImplementation(base);
    expect(await runGuestMarkerBackfill()).toMatchObject({ errors: 0, unmatched: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('retries after the listing itself failed', async () => {
    const c = pveWith({ name: 'web' });
    c.get.mockRejectedValueOnce(new Error('cluster down'));
    await expect(runGuestMarkerBackfill()).rejects.toThrow('cluster down');
    expect(await runGuestMarkerBackfill()).toMatchObject({ ran: true });
  });
});

describe('failed-create cleanup', () => {
  it('drops the row together with its IDE credential rows', async () => {
    pveWith(null);
    await settleFailedCreate(row({ status: 'creating' }), new Error('boom'), false);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.ideGuestSecret.deleteMany).toHaveBeenCalledWith({ where: { vmId: 'rowa' } });
  });
});

describe('status, IP and usage are only taken from the row\'s own tagged guest', () => {
  it('detail status writes nothing for another guest', async () => {
    pveWith({ name: 'x', tags: guestMarker('rowb') });
    const r = await getVmWithLiveStatus(row({ status: 'stopped' }));
    expect(r.live).toBeNull();
    expect(prisma.virtualMachine.update).not.toHaveBeenCalled();
  });

  it('IP refresh skips another guest', async () => {
    const c = pveWith({ name: 'x', tags: guestMarker('rowb') });
    const [vm] = await refreshVmIps([row({ ipAddress: null })] as never[]);
    expect((vm as { ipAddress: unknown }).ipAddress).toBeNull();
    expect(c.get.mock.calls.some((x) => /agent/.test(String(x[0])))).toBe(false);
    expect(prisma.virtualMachine.update).not.toHaveBeenCalled();
  });

  it('IP refresh still works for the row\'s own guest', async () => {
    pveWith({ name: 'web', tags: guestMarker('rowa') });
    const [vm] = await refreshVmIps([row({ ipAddress: null })] as never[]);
    expect((vm as { ipAddress: unknown }).ipAddress).toBe('10.9.9.9');
  });

  it('live usage counts only tagged guests', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([{ id: 'rowa', proxmoxVmId: 100 }] as never);
    pveWith({ name: 'x', tags: guestMarker('rowb') });
    expect(await getLiveUsage({ id: 'u1' })).toEqual({ cpu: 0, mem: 0, maxMem: 0, running: 0 });
    pveWith({ name: 'web', tags: guestMarker('rowa') });
    expect((await getLiveUsage({ id: 'u1' })).running).toBe(1);
  });

  it('resource history samples only tagged guests', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([{ id: 'rowa', userId: 'u1', proxmoxVmId: 100 }] as never);
    pveWith({ name: 'x', tags: guestMarker('rowb') });
    expect(await sampleResourceUsage()).toEqual({ sampled: 0 });
    pveWith({ name: 'web', tags: guestMarker('rowa') });
    expect(await sampleResourceUsage()).toEqual({ sampled: 1 });
  });
});
