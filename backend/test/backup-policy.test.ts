import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the DB is mocked; the real cronMatches (via power-schedule.service) runs.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn() } },
}));

import { prisma } from '../src/lib/prisma.js';
import { isBackupDue, runScheduledBackups, runDueBackups } from '../src/services/matestate.service.js';

const findMany = vi.mocked(prisma.virtualMachine.findMany);

// 2026-06-29 is a Monday; pin a concrete local minute for deterministic cron checks.
const MON_0300 = new Date(2026, 5, 29, 3, 0, 0);
const at = (backupCron: string | null) => ({ backupCron });

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([] as never);
});

describe('isBackupDue', () => {
  it('is false when the VM has no custom schedule', () => {
    expect(isBackupDue(at(null), MON_0300)).toBe(false);
  });

  it('is true when the VM cron fires this minute', () => {
    expect(isBackupDue(at('0 3 * * *'), MON_0300)).toBe(true); // daily 03:00
    expect(isBackupDue(at('0 3 * * 1'), MON_0300)).toBe(true); // Mondays 03:00
  });

  it('is false when the VM cron does not fire this minute', () => {
    expect(isBackupDue(at('0 4 * * *'), MON_0300)).toBe(false); // wrong hour
    expect(isBackupDue(at('0 3 * * 2'), MON_0300)).toBe(false); // Tuesdays only
    expect(isBackupDue(at('0 3 2 * *'), MON_0300)).toBe(false); // 2nd of the month
  });
});

describe('backup scheduler queries (no double-backup)', () => {
  it('the cluster-wide run targets only VMs WITHOUT a custom schedule', async () => {
    await runScheduledBackups();
    expect(findMany).toHaveBeenCalledWith({ where: { status: { not: 'creating' }, backupCron: null } });
  });

  it('the per-VM tick considers only VMs WITH a custom schedule', async () => {
    await runDueBackups(MON_0300);
    expect(findMany).toHaveBeenCalledWith({ where: { status: { not: 'creating' }, backupCron: { not: null } } });
  });

  it('the per-VM tick backs up nothing when none are due (no Proxmox work)', async () => {
    findMany.mockResolvedValue([
      { id: 'a', proxmoxVmId: 1, backupCron: '0 4 * * *' }, // 04:00, not due at 03:00
    ] as never);
    const r = await runDueBackups(MON_0300);
    expect(r).toEqual({ ran: 0, failed: 0 });
  });
});
