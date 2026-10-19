import { describe, it, expect, vi, beforeEach } from 'vitest';

// A stop now waits for the guest to actually go down. The per-minute tick must not
// wait on each due guest in turn: one slow shutdown would hold the tick past the
// next minute, and a schedule due in a skipped minute would never fire.

const vms = [
  { id: 'a', name: 'a', proxmoxVmId: 101, proxmoxNode: 'pve1', startCron: null, stopCron: '0 18 * * *' },
  { id: 'b', name: 'b', proxmoxVmId: 102, proxmoxNode: 'pve1', startCron: null, stopCron: '0 18 * * *' },
];
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { findMany: vi.fn(async () => vms) } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({
    get: vi.fn(async () => ({
      data: { data: vms.map((v) => ({ type: 'qemu', vmid: v.proxmoxVmId, status: 'running' })) },
    })),
  })),
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));

let inFlight = 0;
let maxInFlight = 0;
vi.mock('../src/services/vm.service.js', () => ({
  startVm: vi.fn(async () => undefined),
  stopVm: vi.fn(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
  }),
}));

import { runDuePowerActions } from '../src/services/power-schedule.service.js';
import { stopVm } from '../src/services/vm.service.js';

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
  vi.mocked(stopVm).mockClear();
});

describe('runDuePowerActions', () => {
  it('stops every due guest side by side rather than one after another', async () => {
    const r = await runDuePowerActions(new Date(2026, 5, 29, 18, 0));
    expect(r).toEqual({ started: 0, stopped: 2 });
    expect(stopVm).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(2);
  });

  it('a failed stop is isolated and the others still count', async () => {
    vi.mocked(stopVm).mockRejectedValueOnce(new Error('guest ignored shutdown'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await runDuePowerActions(new Date(2026, 5, 29, 18, 0));
    expect(r.stopped).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
