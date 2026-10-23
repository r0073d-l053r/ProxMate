import { describe, it, expect, vi, beforeEach } from 'vitest';

// The restart reconciler settles rows an interrupted create, clone, upload
// restore, rebuild, import, backup or in-place restore left behind. It must never
// touch an operation still running (here or in Proxmox), never claim a guest on a
// task result alone (the VMID may have gone to someone else since), only write to
// a row still as it read it, and never delete a guest.

type Row = Record<string, unknown>;
const rows: Row[] = [];
const states: Row[] = [];
let backupsOf: Record<string, number> = {};

const matches = (r: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'not' in (v as object)) return r[k] !== (v as { not: unknown }).not;
    if (v instanceof Date) return r[k] instanceof Date && (r[k] as Date).getTime() === v.getTime();
    return r[k] === v;
  });

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      findMany: vi.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r['id'] === where.id) ?? null),
      count: vi.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where)).length),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = rows.find((x) => x['id'] === where.id);
        if (!r) throw new Error('not found');
        return Object.assign(r, data);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, where)) rows.splice(i, 1);
        return { count: before - rows.length };
      }),
    },
    mateState: {
      findMany: vi.fn(async () => states),
      count: vi.fn(async ({ where }: { where: { vmId: string } }) => backupsOf[where.vmId] ?? 0),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = states.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    user: { findUnique: vi.fn(async () => null) },
    ideGuestSecret: { deleteMany: vi.fn(async () => ({})) },
    ideGatewayToken: { deleteMany: vi.fn(async () => ({})) },
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
    deleteBackup: vi.fn(async () => 'UPID:del'),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import { notify } from '../src/services/notify.service.js';
import { beginInFlight, resetInFlight } from '../src/lib/in-flight.js';
import {
  reconcileCreatingVm,
  reconcileRestoringMateState,
  reconcileCreatingMateState,
  reconcileStuckOperations,
  resetReconcileNotices,
  upidNode,
  STUCK_AFTER_MS,
  LOCK_NOTICE_AFTER_MS,
} from '../src/services/task-reconcile.service.js';
import { guestMarker, templateMarker, PROVISION_FAILED_MESSAGE, RESTORE_FAILED_MESSAGE } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf, type FakeClient } from './helpers.js';

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const NOW = new Date('2026-10-23T12:00:00Z');
const OLD = new Date(NOW.getTime() - STUCK_AFTER_MS - 60_000);
const UPID = 'UPID:pve1:0001:0002:6718F000:qmcreate:100:root@pam:';

function row(over: Row = {}): Row {
  const r: Row = {
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
    opSourceId: null,
    opArchive: null,
    updatedAt: OLD,
    ...over,
  };
  rows.push(r);
  return r;
}

/**
 * Fake PVE. `guest`: the config at VMID 100 (null = no guest). `task`: the status of
 * the recorded UPID (null = unreadable). `listed`: whether /cluster/resources answers.
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
    if (/\/tasks\/.*\/status$/.test(url)) return opts.task ? ok(opts.task) : Promise.reject(new Error('node offline'));
    return ok(null);
  });
  vi.mocked(pve.getClient).mockResolvedValue(asClient(c));
  return c;
}

const TASK_OK = { status: 'stopped', exitstatus: 'OK' };
const tagPut = (c: FakeClient) =>
  c.put.mock.calls.find((x) => String(x[0]) === '/nodes/pve1/qemu/100/config' && bodyOf(x)['tags'] !== undefined);
const held = (r: Row, message = PROVISION_FAILED_MESSAGE) =>
  expect(r).toMatchObject({ status: 'error', holdReason: message, opKind: null, opUpid: null });
const untouched = (c: FakeClient) => {
  expect(c.put).not.toHaveBeenCalled();
  expect(c.post).not.toHaveBeenCalled();
  expect(c.delete).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  resetInFlight();
  resetReconcileNotices();
  rows.length = 0;
  states.length = 0;
  backupsOf = {};
});

describe('upidNode', () => {
  it('reads the node out of a UPID and rejects anything else', () => {
    expect(upidNode(UPID)).toBe('pve1');
    expect(upidNode('nope')).toBeNull();
    expect(upidNode(null)).toBeNull();
  });
});

describe('operations still going are never touched', () => {
  it('leaves a row whose operation is in flight in this process, however old it is', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: TASK_OK });
    const r = row({ opStartedAt: new Date(0) });
    const done = beginInFlight('rowa');
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('in-flight');
    expect(c.get).not.toHaveBeenCalled();
    expect(r['status']).toBe('creating');
    done();
  });

  it('leaves a row younger than the threshold', async () => {
    const c = pveWith({ guest: null });
    const r = row({ opStartedAt: new Date(NOW.getTime() - 60_000) });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('recent');
    expect(rows).toHaveLength(1);
  });

  it('leaves a row whose Proxmox task is still running', async () => {
    const c = pveWith({ guest: { tags: templateMarker('t1') }, task: { status: 'running' } });
    const r = row({ opKind: 'clone' });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('busy');
    untouched(c);
    expect(r['status']).toBe('creating');
  });

  it('leaves a row whose recorded task can\'t be read right now (not a guess at failure)', async () => {
    const c = pveWith({ guest: null, task: null });
    const r = row({ opKind: 'clone' });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('unreachable');
    expect(rows).toHaveLength(1);
  });

  it('leaves a locked guest, telling an admin once when the lock outlives a day', async () => {
    const c = pveWith({ guest: { tags: '', lock: 'clone' } });
    const r = row({ opKind: 'clone', opUpid: null });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('busy');
    expect(notify).not.toHaveBeenCalled();
    const later = new Date(OLD.getTime() + LOCK_NOTICE_AFTER_MS + 60_000);
    expect(await reconcileCreatingVm(r as never, asClient(c), later)).toBe('busy');
    expect(await reconcileCreatingVm(r as never, asClient(c), later)).toBe('busy');
    expect(notify).toHaveBeenCalledTimes(1);
    untouched(c);
  });

  it('leaves the row when the cluster cannot be asked where the guest is', async () => {
    const c = pveWith({ guest: null, listed: false });
    const r = row();
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('unreachable');
    expect(rows).toHaveLength(1);
  });

  it('writes nothing when the row is picked up between the read and the write', async () => {
    const c = pveWith({ guest: null, task: { status: 'stopped', exitstatus: 'clone failed' } });
    const stale = { ...row({ opKind: 'clone' }) };
    // Another create re-used the row's slot meanwhile: same id, new operation.
    rows[0]!['opStartedAt'] = new Date(NOW.getTime() - 1000);
    expect(await reconcileCreatingVm(stale as never, asClient(c), NOW)).toBe('in-flight');
    expect(rows).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('writes nothing when the operation becomes in flight after the checks', async () => {
    let done: (() => void) | undefined;
    const c = pveWith({
      guest: null,
      task: { status: 'stopped', exitstatus: 'clone failed' },
      extra: (url) => {
        if (/\/qemu\/100\/config$/.test(url)) done = beginInFlight('rowa');
        return undefined;
      },
    });
    const r = row({ opKind: 'clone' });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('in-flight');
    expect(rows).toHaveLength(1);
    done?.();
  });
});

describe('settling an interrupted create', () => {
  it('finishes an ISO create whose task completed: firewall, then stopped (never started)', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa'), name: 'web' }, task: TASK_OK });
    const r = row();
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('completed');
    expect(pve.configureVmIsolation).toHaveBeenCalledWith('pve1', 100, { dnsServers: [] }, expect.anything(), 'qemu');
    expect(r).toMatchObject({ status: 'stopped', opKind: null, opStartedAt: null, opUpid: null });
    expect(c.post).not.toHaveBeenCalled();
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('drops an ISO create whose VMID holds an untagged guest — it is not this row\'s', async () => {
    const c = pveWith({ guest: { tags: '', name: 'web' }, task: TASK_OK });
    row();
    expect(await reconcileCreatingVm(rows[0] as never, asClient(c), NOW)).toBe('dropped');
    expect(rows).toHaveLength(0);
    untouched(c);
  });

  it('drops the row of a create that never produced a guest', async () => {
    const c = pveWith({ guest: null, task: { status: 'stopped', exitstatus: 'clone failed' } });
    row({ opKind: 'clone' });
    expect(await reconcileCreatingVm(rows[0] as never, asClient(c), NOW)).toBe('dropped');
    expect(rows).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'vm.error' }));
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('tags and holds a template clone that finished before it was tagged, when nothing else could claim it', async () => {
    const c = pveWith({ guest: { tags: templateMarker('t1'), name: 'web' }, task: TASK_OK });
    const r = row({ opKind: 'clone', opSourceId: 't1' });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('held');
    held(r);
    expect(bodyOf(tagPut(c)!)['tags']).toBe(guestMarker('rowa'));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'vm.error' }));
  });

  it('never tags a reused VMID: another row has it now', async () => {
    // The half-built clone was deleted and another tenant's create took VMID 100.
    const c = pveWith({ guest: { tags: guestMarker('rowb'), name: 'web' }, task: TASK_OK });
    row({ opKind: 'clone', opSourceId: 't1' });
    row({ id: 'rowb', userId: 'u2', status: 'running', opKind: null, opStartedAt: null });
    expect(await reconcileCreatingVm(rows[0] as never, asClient(c), NOW)).toBe('dropped');
    expect(tagPut(c)).toBeUndefined();
    expect(rows.map((r) => r['id'])).toEqual(['rowb']);
    expect(rows[0]).toMatchObject({ status: 'running' });
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('never tags a reused VMID: no row, but the guest carries another template\'s tag or another name', async () => {
    const c = pveWith({ guest: { tags: templateMarker('other'), name: 'web' }, task: TASK_OK });
    row({ opKind: 'clone', opSourceId: 't1' });
    expect(await reconcileCreatingVm(rows[0] as never, asClient(c), NOW)).toBe('dropped');
    expect(tagPut(c)).toBeUndefined();

    const c2 = pveWith({ guest: { tags: '', name: 'somebody-elses' }, task: TASK_OK });
    const r2 = row({ opKind: 'clone', opSourceId: 't1' });
    expect(await reconcileCreatingVm(r2 as never, asClient(c2), NOW)).toBe('held');
    expect(tagPut(c2)).toBeUndefined();
    held(r2);
  });

  it('never tags on a failed or unrecorded task', async () => {
    const c = pveWith({ guest: { tags: templateMarker('t1'), name: 'web' } });
    const r = row({ opKind: 'clone', opSourceId: 't1', opUpid: null });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('held');
    expect(tagPut(c)).toBeUndefined();
  });

  it('keeps a duplicate whose copy still carries its source\'s tag (not someone else\'s guest)', async () => {
    const c = pveWith({ guest: { tags: guestMarker('source'), name: 'web' }, task: TASK_OK });
    const r = row({ opKind: 'duplicate', opSourceId: 'source' });
    row({ id: 'source', status: 'stopped', proxmoxVmId: 90, opKind: null, opStartedAt: null });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('held');
    expect(bodyOf(tagPut(c)!)['tags']).toBe(guestMarker('rowa'));
  });

  it('tags and holds a template rebuild whose clone finished, rather than orphaning it', async () => {
    const c = pveWith({ guest: { tags: templateMarker('t1'), name: 'web' }, task: TASK_OK });
    const r = row({ opKind: 'rebuild-template', opSourceId: 't1' });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('held');
    expect(bodyOf(tagPut(c)!)['tags']).toBe(guestMarker('rowa'));
    held(r);
  });

  it('keeps (holds) a rebuild with backups even when its VMID is empty', async () => {
    const c = pveWith({ guest: null, task: null });
    const r = row({ opKind: 'rebuild-template', opUpid: null });
    backupsOf = { rowa: 2 };
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('held');
    held(r);
  });

  it('keeps an older row with no operation record when it has backups', async () => {
    const c = pveWith({ guest: null });
    const r = row({ opKind: null, opUpid: null, opStartedAt: null });
    backupsOf = { rowa: 1 };
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('held');
  });
});

describe('settling an interrupted upload restore', () => {
  const archive = 'backups:backup/vzdump-qemu-555-2026_10_01-00_00_00.vma.zst';

  it('holds a landed restore untagged, keeps it from booting, and removes the archive', async () => {
    const c = pveWith({
      guest: { tags: guestMarker('some-old-row'), name: 'old', onboot: '1', protection: '1', net0: 'virtio=AA:BB,bridge=vmbr9' },
      task: TASK_OK,
    });
    const r = row({ opKind: 'restore-upload', opArchive: archive });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('held');
    held(r);
    expect(tagPut(c)).toBeUndefined();
    const puts = c.put.mock.calls.map((x) => bodyOf(x));
    expect(puts.some((b) => (b['delete'] ?? '').includes('onboot') && b['delete']!.includes('protection'))).toBe(true);
    expect(puts.some((b) => b['net0'] === 'virtio=AA:BB,bridge=vmbr9,link_down=1')).toBe(true);
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve1', 'backups', archive);
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('drops a restore that never landed, removing its archive', async () => {
    const c = pveWith({ guest: null, task: { status: 'stopped', exitstatus: 'restore failed' } });
    row({ opKind: 'restore-upload', opArchive: archive });
    expect(await reconcileCreatingVm(rows[0] as never, asClient(c), NOW)).toBe('dropped');
    expect(pve.deleteBackup).toHaveBeenCalledWith('pve1', 'backups', archive);
  });

  it('touches nothing when the VMID is another row\'s', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowb'), onboot: '1' }, task: TASK_OK });
    row({ opKind: 'restore-upload', opArchive: archive });
    row({ id: 'rowb', status: 'running', opKind: null, opStartedAt: null });
    expect(await reconcileCreatingVm(rows[0] as never, asClient(c), NOW)).toBe('dropped');
    expect(c.put).not.toHaveBeenCalled();
  });
});

describe('settling an interrupted import', () => {
  it('completes an import whose tag (the last step) was written', async () => {
    const c = pveWith({ guest: { tags: `prod;${guestMarker('rowa')}`, name: 'legacy' }, running: true });
    const r = row({ opKind: 'import', opUpid: null, name: 'legacy' });
    expect(await reconcileCreatingVm(r as never, asClient(c), NOW)).toBe('completed');
    expect(r).toMatchObject({ status: 'running', opKind: null });
    untouched(c);
  });

  it('drops an import that never tagged its guest, leaving the guest alone', async () => {
    const c = pveWith({ guest: { tags: 'prod', name: 'legacy' } });
    row({ opKind: 'import', opUpid: null });
    expect(await reconcileCreatingVm(rows[0] as never, asClient(c), NOW)).toBe('dropped');
    expect(rows).toHaveLength(0);
    untouched(c);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('reconcileRestoringMateState', () => {
  const ms = (over: Row = {}): Row => {
    const s: Row = { id: 'ms1', vmId: 'rowa', status: 'restoring', upid: UPID, updatedAt: OLD, createdAt: OLD, storage: 'backups', proxmoxVmId: 100, ...over };
    states.push(s);
    return s;
  };

  it('never touches a restore whose VM has an operation in flight here', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') } });
    const s = ms();
    const done = beginInFlight('rowa');
    expect(await reconcileRestoringMateState(s as never, asClient(c), NOW)).toBe('in-flight');
    expect(s['status']).toBe('restoring');
    done();
  });

  it('leaves a restore whose task is running, or can\'t be read', async () => {
    row({ status: 'stopped', opKind: null });
    const s = ms();
    expect(await reconcileRestoringMateState(s as never, asClient(pveWith({ guest: { tags: guestMarker('rowa') }, task: { status: 'running' } })), NOW)).toBe('busy');
    expect(await reconcileRestoringMateState(s as never, asClient(pveWith({ guest: { tags: guestMarker('rowa') }, task: null })), NOW)).toBe('unreachable');
    expect(s['status']).toBe('restoring');
  });

  it('frees the backup, stops its own running guest and holds the row', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: TASK_OK, running: true });
    const r = row({ status: 'running', opKind: null });
    const s = ms();
    expect(await reconcileRestoringMateState(s as never, asClient(c), NOW)).toBe('held');
    expect(s).toMatchObject({ status: 'ready', upid: null });
    expect(c.post).toHaveBeenCalledWith('/nodes/pve1/qemu/100/status/stop');
    expect(r).toMatchObject({ status: 'error', holdReason: RESTORE_FAILED_MESSAGE });
  });

  it('never stops a guest that is not the row\'s own, but still holds the row', async () => {
    const c = pveWith({ guest: { tags: guestMarker('someone-else') }, running: true });
    const r = row({ status: 'running', opKind: null });
    const s = ms({ upid: null });
    expect(await reconcileRestoringMateState(s as never, asClient(c), NOW)).toBe('held');
    expect(c.post).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'error', holdReason: RESTORE_FAILED_MESSAGE });
  });

  it('keeps a more specific hold the row already has', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') } });
    const r = row({ status: 'error', holdReason: 'Over quota', opKind: null });
    expect(await reconcileRestoringMateState(ms({ upid: null }) as never, asClient(c), NOW)).toBe('held');
    expect(r['holdReason']).toBe('Over quota');
  });
});

describe('reconcileCreatingMateState (an interrupted backup)', () => {
  const ms = (over: Row = {}): Row => {
    const s: Row = { id: 'ms1', vmId: 'rowa', status: 'creating', upid: UPID, createdAt: OLD, updatedAt: OLD, storage: 'backups', proxmoxVmId: 100, ...over };
    states.push(s);
    return s;
  };
  const archive = 'backups:backup/vzdump-qemu-100-2026_10_23-11_00_00.vma.zst';

  it('records the archive a finished task wrote, as its log names it', async () => {
    const c = pveWith({
      guest: { tags: guestMarker('rowa') },
      task: TASK_OK,
      extra: (url) => {
        if (/\/tasks\/.*\/log/.test(url)) return ok([{ t: `INFO: creating vzdump archive '/mnt/backups/dump/vzdump-qemu-100-2026_10_23-11_00_00.vma.zst'` }]);
        if (url === '/nodes') return ok([{ node: 'pve1', status: 'online' }]);
        if (/\/storage\/backups\/content/.test(url)) return ok([{ volid: archive, size: 1234, ctime: 1, vmid: 100 }]);
        return undefined;
      },
    });
    const s = ms();
    expect(await reconcileCreatingMateState(s as never, asClient(c), NOW)).toBe('completed');
    expect(s).toMatchObject({ volid: archive, size: BigInt(1234), status: 'ready', upid: null });
  });

  it('does not mark a backup failed while its task can\'t be read', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: null });
    const s = ms();
    expect(await reconcileCreatingMateState(s as never, asClient(c), NOW)).toBe('unreachable');
    expect(s['status']).toBe('creating');
  });

  it('leaves a backup whose vzdump still holds the guest lock', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa'), lock: 'backup' } });
    row({ status: 'running', opKind: null });
    const s = ms({ upid: null });
    expect(await reconcileCreatingMateState(s as never, asClient(c), NOW)).toBe('busy');
    expect(s['status']).toBe('creating');
  });

  it('marks a backup that failed as failed, deleting nothing', async () => {
    const c = pveWith({ guest: { tags: guestMarker('rowa') }, task: { status: 'stopped', exitstatus: 'job errors' } });
    const s = ms();
    expect(await reconcileCreatingMateState(s as never, asClient(c), NOW)).toBe('failed');
    expect(s).toMatchObject({ status: 'error', upid: null });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'backup.failed' }));
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('never touches a backup in flight here', async () => {
    const c = pveWith({});
    const s = ms({ createdAt: new Date(0) });
    const done = beginInFlight('ms1');
    expect(await reconcileCreatingMateState(s as never, asClient(c), NOW)).toBe('in-flight');
    expect(s['status']).toBe('creating');
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
    row();
    vi.mocked(pve.getClient).mockRejectedValueOnce(new Error('down'));
    const r = await reconcileStuckOperations(NOW);
    expect(r.deferred).toBe(1);
    expect(rows[0]!['status']).toBe('creating');
  });

  it('settles each row, counting in-flight ones as deferred', async () => {
    pveWith({ guest: { tags: guestMarker('rowa'), name: 'web' }, task: TASK_OK });
    row();
    row({ id: 'rowb', proxmoxVmId: 101 });
    const done = beginInFlight('rowb');
    const r = await reconcileStuckOperations(NOW);
    expect(r).toMatchObject({ checked: 2, completed: 1, deferred: 1 });
    done();
  });
});
