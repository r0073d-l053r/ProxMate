import { describe, it, expect, vi, beforeEach } from 'vitest';

// The restart reconciler settles rows an interrupted create, clone, upload
// restore, rebuild, backup or in-place restore left behind — and must never touch
// an operation that is still running, here or in Proxmox, nor delete a guest.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    mateState: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
    ideGuestSecret: { deleteMany: vi.fn(async () => ({})) },
    ideGatewayToken: { deleteMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => null) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/mail.service.js', () => ({
  isMailConfigured: vi.fn(async () => false),
  sendMail: vi.fn(async () => undefined),
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(),
    configureVmIsolation: vi.fn(async () => undefined),
    readIsolationOptions: vi.fn(async () => ({ dnsServers: [] })),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { notify } from '../src/services/notify.service.js';
import { beginInFlight, resetInFlight } from '../src/lib/in-flight.js';
import {
  reconcileCreatingVm,
  reconcileRestoringMateState,
  reconcileCreatingMateState,
  reconcileStuckOperations,
  upidNode,
  STUCK_AFTER_MS,
} from '../src/services/task-reconcile.service.js';
import { guestMarker, templateMarker, PROVISION_FAILED_MESSAGE, RESTORE_FAILED_MESSAGE } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf, type FakeClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const NOW = new Date('2026-10-23T12:00:00Z');
const OLD = new Date(NOW.getTime() - STUCK_AFTER_MS - 60_000);
const UPID = 'UPID:pve1:0001:0002:6718F000:qmcreate:100:root@pam:';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'rowa',
    userId: 'u1',
    name: 'web',
    type: 'qemu',
    proxmoxVmId: 100,
    proxmoxNode: 'pve1',
    status: 'creating',
    holdReason: null,
    opKind: 'create',
    opStartedAt: OLD,
    opUpid: UPID,
    updatedAt: OLD,
    ...over,
  } as never;
}

/**
 * Fake PVE. `guest`: the config at VMID 100 (null = no guest). `task`: the status
 * of the recorded UPID (null = unknown task). `listed`: whether /cluster/resources
 * can be read at all.
 */
function pveWith(opts: {
  guest?: Record<string, string> | null;
  task?: { status: string; exitstatus?: string } | null;
  listed?: boolean;
  running?: boolean;
  extra?: (url: string) => Promise<unknown> | undefined;
}): FakeClient {
  const c = fakeClient();
  const guest = opts.guest === undefined ? null : opts.guest;
  c.get.mockImplementation((url: string) => {
    const more = opts.extra?.(url);
    if (more) return more;
    if (url === '/cluster/resources') {
      if (opts.listed === false) return Promise.reject(new Error('connect ECONNREFUSED'));
      return ok(guest ? [{ type: 'qemu', vmid: 100, node: 'pve1' }] : []);
    }
    if (/\/qemu\/100\/config$/.test(url)) {
      return guest === null
        ? Promise.reject(new Error("Configuration file 'qemu-server/100.conf' does not exist"))
        : ok(guest);
    }
    if (/\/qemu\/100\/status\/current$/.test(url)) return ok({ status: opts.running ? 'running' : 'stopped' });
    if (/\/tasks\/.*\/status$/.test(url)) return opts.task ? ok(opts.task) : Promise.reject(new Error('no such task'));
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

const vmUpdate = () => vi.mocked(prisma.virtualMachine.update);
const untouched = (c: FakeClient) => {
  expect(prisma.virtualMachine.update).not.toHaveBeenCalled();
  expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
  expect(c.put).not.toHaveBeenCalled();
  expect(c.post).not.toHaveBeenCalled();
  expect(c.delete).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  resetInFlight();
  vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue({ id: 'rowa' } as never);
});

describe('upidNode', () => {
  it('reads the node out of a UPID and rejects anything else', () => {
    expect(upidNode(UPID)).toBe('pve1');
    expect(upidNode('UPID:fake')).toBe('fake');
    expect(upidNode('nope')).toBeNull();
    expect(upidNode(null)).toBeNull();
  });
});

describe('reconcileCreatingVm — operations still going are never touched', () => {
  it('leaves a row whose operation is in flight in this process, however old it is', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: { status: 'stopped', exitstatus: 'OK' } });
    const done = beginInFlight('rowa');
    expect(await reconcileCreatingVm(row({ opStartedAt: new Date(0) }), asClient(c), NOW)).toBe('in-flight');
    expect(c.get).not.toHaveBeenCalled();
    untouched(c);
    done();
  });

  it('leaves a row younger than the threshold', async () => {
    const c = pveWith({ guest: null });
    const fresh = new Date(NOW.getTime() - 60_000);
    expect(await reconcileCreatingVm(row({ opStartedAt: fresh }), asClient(c), NOW)).toBe('recent');
    untouched(c);
  });

  it('leaves a row whose Proxmox task is still running', async () => {
    const c = pveWith({ guest: { tags: templateMarker('t1') }, task: { status: 'running' } });
    expect(await reconcileCreatingVm(row({ opKind: 'clone' }), asClient(c), NOW)).toBe('busy');
    untouched(c);
  });

  it('leaves a row whose guest holds a Proxmox lock', async () => {
    const c = pveWith({ guest: { tags: '', lock: 'clone' }, task: null });
    expect(await reconcileCreatingVm(row({ opKind: 'clone', opUpid: null }), asClient(c), NOW)).toBe('busy');
    untouched(c);
  });

  it('leaves the row when the cluster cannot be asked where the guest is', async () => {
    const c = pveWith({ guest: null, listed: false });
    expect(await reconcileCreatingVm(row(), asClient(c), NOW)).toBe('unreachable');
    untouched(c);
  });
});

describe('reconcileCreatingVm — settling', () => {
  it('finishes an ISO create whose task completed: firewall, then stopped (never started)', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa'), name: 'web' }, task: { status: 'stopped', exitstatus: 'OK' } });
    expect(await reconcileCreatingVm(row(), asClient(c), NOW)).toBe('completed');
    expect(pve.configureVmIsolation).toHaveBeenCalledWith('pve1', 100, { dnsServers: [] }, expect.anything(), 'qemu');
    expect(vmUpdate()).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: { status: 'stopped', opKind: null, opStartedAt: null, opUpid: null },
    });
    expect(c.post).not.toHaveBeenCalled(); // not started
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('holds (does not complete) an ISO create whose guest carries no tag of this row', async () => {
    const c = pveWith({ guest: { tags: '' }, task: { status: 'stopped', exitstatus: 'OK' } });
    expect(await reconcileCreatingVm(row(), asClient(c), NOW)).toBe('held');
    expect(pve.configureVmIsolation).not.toHaveBeenCalled();
    expect(vmUpdate()).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ status: 'error', holdReason: PROVISION_FAILED_MESSAGE }),
    });
  });

  it('holds a template clone that finished (cloud-init was never configured) and tags it as the row\'s', async () => {
    const c = pveWith({ guest: { tags: templateMarker('t1') }, task: { status: 'stopped', exitstatus: 'OK' } });
    expect(await reconcileCreatingVm(row({ opKind: 'clone' }), asClient(c), NOW)).toBe('held');
    expect(vmUpdate()).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ status: 'error', holdReason: PROVISION_FAILED_MESSAGE }),
    });
    const tag = c.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve1/qemu/100/config');
    expect(bodyOf(tag!)['tags']).toBe(guestMarker('rowa'));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'vm.error' }));
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('holds an upload restore that landed, without tagging the unchecked guest', async () => {
    const c = pveWith({ guest: { tags: guestMarker('some-old-row') }, task: { status: 'stopped', exitstatus: 'OK' } });
    expect(await reconcileCreatingVm(row({ opKind: 'restore-upload' }), asClient(c), NOW)).toBe('held');
    expect(c.put).not.toHaveBeenCalled();
    expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
    expect(vmUpdate()).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ status: 'error', holdReason: PROVISION_FAILED_MESSAGE }),
    });
  });

  it('drops the row of a create that never produced a guest (as a failed create does)', async () => {
    const c = pveWith({ guest: null, task: { status: 'stopped', exitstatus: 'clone failed' } });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(null);
    expect(await reconcileCreatingVm(row({ opKind: 'clone' }), asClient(c), NOW)).toBe('dropped');
    expect(prisma.virtualMachine.delete).toHaveBeenCalledWith({ where: { id: 'rowa' } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'vm.error' }));
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('keeps (holds) a rebuild with backups even when its VMID is empty', async () => {
    const c = pveWith({ guest: null, task: null });
    vi.mocked(prisma.mateState.count).mockResolvedValue(2);
    expect(await reconcileCreatingVm(row({ opKind: 'rebuild-template' }), asClient(c), NOW)).toBe('held');
    expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
    expect(vmUpdate()).toHaveBeenCalledWith({
      where: { id: 'rowa' },
      data: expect.objectContaining({ status: 'error', holdReason: PROVISION_FAILED_MESSAGE }),
    });
  });

  it('keeps an older row with no operation record when it has backups', async () => {
    const c = pveWith({ guest: null, task: null });
    vi.mocked(prisma.mateState.count).mockResolvedValue(1);
    expect(await reconcileCreatingVm(row({ opKind: null, opUpid: null, opStartedAt: null }), asClient(c), NOW)).toBe('held');
    expect(prisma.virtualMachine.delete).not.toHaveBeenCalled();
  });
});

describe('reconcileRestoringMateState', () => {
  const ms = (over: Record<string, unknown> = {}) =>
    ({ id: 'ms1', vmId: 'rowa', status: 'restoring', upid: UPID, updatedAt: OLD, createdAt: OLD, storage: 'backups', proxmoxVmId: 100, ...over }) as never;

  it('never touches a restore whose VM has an operation in flight here', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') } });
    const done = beginInFlight('rowa');
    expect(await reconcileRestoringMateState(ms(), asClient(c), NOW)).toBe('in-flight');
    expect(prisma.mateState.update).not.toHaveBeenCalled();
    untouched(c);
    done();
  });

  it('leaves a restore whose task is still running', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: { status: 'running' } });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ status: 'stopped', opKind: null }));
    expect(await reconcileRestoringMateState(ms(), asClient(c), NOW)).toBe('busy');
    expect(prisma.mateState.update).not.toHaveBeenCalled();
  });

  it('frees the backup, stops its own running guest and holds the row', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: { status: 'stopped', exitstatus: 'OK' }, running: true });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ status: 'running', opKind: null }));
    expect(await reconcileRestoringMateState(ms(), asClient(c), NOW)).toBe('held');
    expect(prisma.mateState.update).toHaveBeenCalledWith({ where: { id: 'ms1' }, data: { status: 'ready', upid: null } });
    expect(c.post).toHaveBeenCalledWith('/nodes/pve1/qemu/100/status/stop');
    expect(vmUpdate()).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: { status: 'error', holdReason: RESTORE_FAILED_MESSAGE } });
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('never stops a guest that is not the row\'s own, but still holds the row', async () => {
    const c = pveWith({ guest: { tags: guestMarker('someone-else') }, task: null, running: true });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ status: 'running', opKind: null }));
    expect(await reconcileRestoringMateState(ms({ upid: null }), asClient(c), NOW)).toBe('held');
    expect(c.post).not.toHaveBeenCalled();
    expect(vmUpdate()).toHaveBeenCalledWith({ where: { id: 'rowa' }, data: { status: 'error', holdReason: RESTORE_FAILED_MESSAGE } });
  });

  it('keeps a more specific hold the row already has', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: null });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ status: 'error', holdReason: 'Over quota', opKind: null }));
    expect(await reconcileRestoringMateState(ms({ upid: null }), asClient(c), NOW)).toBe('held');
    expect(vmUpdate()).not.toHaveBeenCalled();
  });
});

describe('reconcileCreatingMateState (an interrupted backup)', () => {
  const ms = (over: Record<string, unknown> = {}) =>
    ({ id: 'ms1', vmId: 'rowa', status: 'creating', upid: UPID, createdAt: OLD, updatedAt: OLD, storage: 'backups', proxmoxVmId: 100, ...over }) as never;
  const archive = 'backups:backup/vzdump-qemu-100-2026_10_23-11_00_00.vma.zst';

  it('records the archive a finished task wrote, as its log names it', async () => {
    const c = pveWith({
      guest: { tags: guestMarker('rowa') },
      task: { status: 'stopped', exitstatus: 'OK' },
      extra: (url) => {
        if (/\/tasks\/.*\/log/.test(url)) return ok([{ t: `INFO: creating vzdump archive '/mnt/backups/dump/vzdump-qemu-100-2026_10_23-11_00_00.vma.zst'` }]);
        if (url === '/nodes') return ok([{ node: 'pve1', status: 'online' }]);
        if (/\/storage\/backups\/content/.test(url)) return ok([{ volid: archive, size: 1234, ctime: 1, vmid: 100 }]);
        return undefined;
      },
    });
    expect(await reconcileCreatingMateState(ms(), asClient(c), NOW)).toBe('completed');
    expect(prisma.mateState.update).toHaveBeenCalledWith({
      where: { id: 'ms1' },
      data: { volid: archive, size: BigInt(1234), status: 'ready', upid: null },
    });
  });

  it('leaves a backup whose vzdump still holds the guest lock', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa'), lock: 'backup' } });
    vi.mocked(prisma.virtualMachine.findUnique).mockResolvedValue(row({ status: 'running', opKind: null }));
    expect(await reconcileCreatingMateState(ms({ upid: null }), asClient(c), NOW)).toBe('busy');
    expect(prisma.mateState.update).not.toHaveBeenCalled();
  });

  it('marks a backup that cannot be accounted for as failed, deleting nothing', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: { status: 'stopped', exitstatus: 'job errors' } });
    expect(await reconcileCreatingMateState(ms(), asClient(c), NOW)).toBe('failed');
    expect(prisma.mateState.update).toHaveBeenCalledWith({ where: { id: 'ms1' }, data: { status: 'error', upid: null } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'backup.failed' }));
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('never touches a backup in flight here', async () => {
    const c = pveWith({});
    const done = beginInFlight('ms1');
    expect(await reconcileCreatingMateState(ms({ createdAt: new Date(0) }), asClient(c), NOW)).toBe('in-flight');
    expect(prisma.mateState.update).not.toHaveBeenCalled();
    done();
  });
});

describe('reconcileStuckOperations', () => {
  it('is a no-op (no Proxmox call) when nothing is stuck', async () => {
    const r = await reconcileStuckOperations(NOW);
    expect(r).toEqual({ checked: 0, completed: 0, held: 0, dropped: 0, failed: 0, deferred: 0 });
    expect(pve.getClient).not.toHaveBeenCalled();
  });

  it('defers everything while Proxmox is unreachable', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValueOnce([row()] as never);
    vi.mocked(pve.getClient).mockRejectedValueOnce(new Error('down'));
    const r = await reconcileStuckOperations(NOW);
    expect(r.deferred).toBe(1);
    expect(prisma.virtualMachine.update).not.toHaveBeenCalled();
  });

  it('settles each row, counting in-flight ones as deferred', async () => {
    pveWith({ guest: { tags: guestMarker('rowa') }, task: { status: 'stopped', exitstatus: 'OK' } });
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValueOnce([row(), row({ id: 'rowb' })] as never);
    const done = beginInFlight('rowb');
    const r = await reconcileStuckOperations(NOW);
    expect(r).toMatchObject({ checked: 2, completed: 1, deferred: 1 });
    done();
  });
});
