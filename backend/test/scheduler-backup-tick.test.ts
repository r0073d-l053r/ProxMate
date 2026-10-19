import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-VM scheduled backups run one after another under one lock. A schedule that
// fires while an earlier VM's backup is still running must be caught up by the
// next tick that runs, not dropped.

vi.mock('../src/lib/prisma.js', () => ({ prisma: { virtualMachine: { findMany: vi.fn() } } }));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock('../src/services/matestate.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/matestate.service.js')>();
  return { ...actual, runDueBackups: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as matestate from '../src/services/matestate.service.js';
import { perVmBackupTick } from '../src/services/scheduler.service.js';

const runDue = vi.mocked(matestate.runDueBackups);
const at = (h: number, m: number) => new Date(2026, 5, 29, h, m, 0);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('per-VM backup tick (BUG-029)', () => {
  it('a tick after a long-running one covers every minute since the last tick that ran', async () => {
    let finish!: () => void;
    runDue.mockImplementationOnce(() => new Promise((r) => (finish = () => r({ ran: 1, failed: 0 }))));
    runDue.mockResolvedValue({ ran: 0, failed: 0 });

    const first = perVmBackupTick(at(2, 0)); // VM A's 20-minute backup
    await vi.waitFor(() => expect(runDue).toHaveBeenCalledTimes(1));
    await perVmBackupTick(at(2, 10)); // skipped: still busy
    finish();
    await first;
    await perVmBackupTick(at(2, 21));

    expect(runDue).toHaveBeenCalledTimes(2);
    expect(runDue).toHaveBeenLastCalledWith(at(2, 21), at(2, 0));
  });
});

describe('per-VM backup tick marker across restarts (audit minor)', () => {
  it('the first tick after a restart covers the minutes since the stored marker, and stores its own', async () => {
    vi.resetModules();
    const config = await import('../src/services/config.service.js');
    const ms = await import('../src/services/matestate.service.js');
    const { perVmBackupTick: freshTick } = await import('../src/services/scheduler.service.js');
    vi.mocked(config.getConfig).mockResolvedValue(at(1, 50).toISOString() as never);
    vi.mocked(ms.runDueBackups).mockResolvedValue({ ran: 0, failed: 0 });

    await freshTick(at(2, 21));
    expect(ms.runDueBackups).toHaveBeenCalledWith(at(2, 21), at(1, 50));
    expect(config.setConfig).toHaveBeenCalledWith('matestate_vm_tick_last', at(2, 21).toISOString());
  });
});

describe('isBackupDueSince / runDueBackups with a catch-up window (BUG-029)', () => {
  it('finds a schedule that fired inside the window, and only inside it', () => {
    const vm = { backupCron: '10 2 * * *' };
    expect(matestate.isBackupDueSince(vm, at(2, 21), at(2, 0))).toBe(true);
    expect(matestate.isBackupDueSince(vm, at(2, 21), at(2, 10))).toBe(false); // 02:10 was already covered
    expect(matestate.isBackupDueSince(vm, at(2, 9), at(2, 0))).toBe(false);
    expect(matestate.isBackupDueSince(vm, at(2, 10))).toBe(true); // no window: this minute only
  });

  it('the real runDueBackups selects VMs whose schedule fired in the window', async () => {
    const actual = await vi.importActual<typeof import('../src/services/matestate.service.js')>(
      '../src/services/matestate.service.js',
    );
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([
      { id: 'b', proxmoxVmId: 2, backupCron: '30 4 * * *' }, // not due in the window
    ] as never);
    expect(await actual.runDueBackups(at(2, 21), at(2, 0))).toEqual({ ran: 0, failed: 0 });
  });
});
