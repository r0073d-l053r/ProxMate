import { describe, it, expect, vi, beforeEach } from 'vitest';

// Schedules stored before validation was strict never fire; at startup they are
// logged and reported to admins so someone re-saves them.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn() } },
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));

import { prisma } from '../src/lib/prisma.js';
import { notify } from '../src/services/notify.service.js';
import { reportInvalidStoredCrons } from '../src/services/power-schedule.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('reportInvalidStoredCrons', () => {
  it('reports each malformed stored schedule once and notifies admins', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([
      { id: 'v1', name: 'web', startCron: '0 1,,2 * * *', stopCron: '0 18 * * 1-5', backupCron: null },
      { id: 'v2', name: 'db', startCron: null, stopCron: null, backupCron: '0 3 * * 9' },
    ] as never);
    expect(await reportInvalidStoredCrons()).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(notify).mock.calls[0]![0].message;
    expect(msg).toContain('web (v1): startCron "0 1,,2 * * *"');
    expect(msg).toContain('db (v2): backupCron "0 3 * * 9"');
    expect(msg).not.toContain('stopCron');
  });

  it('stays quiet when every stored schedule is valid', async () => {
    vi.mocked(prisma.virtualMachine.findMany).mockResolvedValue([
      { id: 'v1', name: 'web', startCron: '0 8 * * 1-5', stopCron: null, backupCron: null },
    ] as never);
    expect(await reportInvalidStoredCrons()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
