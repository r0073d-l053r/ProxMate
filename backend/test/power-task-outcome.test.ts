import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

// Keep the real module (other services import named things from it at load time)
// and replace only the calls this path makes.
vi.mock('../src/services/proxmox.service.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/services/proxmox.service.js')>(
      '../src/services/proxmox.service.js',
    );
  return {
    ...actual,
    getClient: vi.fn(),
    getVmConfig: vi.fn(),
    stopVm: vi.fn(),
    shutdownVm: vi.fn(),
    startVm: vi.fn(),
    rebootVm: vi.fn(),
    waitForTask: vi.fn(),
  };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { stopVm, startVm, restartVm } from '../src/services/vm.service.js';

const ROW_ID = 'cmtest00000000000000000a';
const row = () =>
  ({
    id: ROW_ID,
    proxmoxVmId: 106,
    proxmoxNode: 'pve-3',
    name: 'labtest-vm',
    type: 'qemu',
    status: 'running',
    holdReason: null,
  }) as never;

const update = vi.mocked(prisma.virtualMachine.update);

beforeEach(() => {
  vi.clearAllMocks();
  // requireOurGuest: re-resolve the node, then confirm the guest carries our marker.
  vi.mocked(pve.getClient).mockResolvedValue({
    get: vi.fn(async (path: string) => {
      if (path === '/cluster/resources') {
        return { data: { data: [{ type: 'qemu', vmid: 106, node: 'pve-3' }] } };
      }
      throw new Error(`unexpected GET ${path}`);
    }),
  } as never);
  vi.mocked(pve.getVmConfig).mockResolvedValue({ tags: `proxmate-${ROW_ID}` } as never);
  update.mockImplementation((async (args: { data: unknown }) => ({
    ...(row() as object),
    ...(args.data as object),
  })) as never);
});

/**
 * Regression: Proxmox runs stop/shutdown asynchronously and the POST only returns a
 * task UPID. The old code discarded it and wrote `status: 'stopped'` unconditionally,
 * so a graceful shutdown the guest ignored ("VM quit/powerdown failed - got timeout")
 * was reported as a successful stop — and the next action (destroy, restore) then
 * failed with "VM is running" for reasons the user could not see.
 */
describe('stopVm — the task outcome decides, not the request', () => {
  it('waits for the shutdown task before reporting the guest stopped', async () => {
    vi.mocked(pve.shutdownVm).mockResolvedValue('UPID:pve-3:shutdown');
    vi.mocked(pve.waitForTask).mockResolvedValue(undefined);

    await expect(stopVm(row(), false)).resolves.toBeUndefined();

    expect(pve.shutdownVm).toHaveBeenCalledOnce();
    expect(pve.waitForTask).toHaveBeenCalledWith(
      'pve-3',
      'UPID:pve-3:shutdown',
      undefined,
      expect.any(Number),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ROW_ID }, data: { status: 'stopped' } }),
    );
  });

  it('does NOT mark the row stopped when the graceful shutdown times out', async () => {
    vi.mocked(pve.shutdownVm).mockResolvedValue('UPID:pve-3:shutdown');
    vi.mocked(pve.waitForTask).mockRejectedValue(
      new Error('Proxmox task failed: VM quit/powerdown failed - got timeout'),
    );

    await expect(stopVm(row(), false)).rejects.toThrow(/quit\/powerdown failed/);

    // The whole point: no write claiming the guest is off.
    for (const call of update.mock.calls) {
      expect((call[0] as { data?: { status?: string } }).data?.status).not.toBe('stopped');
    }
  });

  it('waits for the force-stop task too', async () => {
    vi.mocked(pve.stopVm).mockResolvedValue('UPID:pve-3:stop');
    vi.mocked(pve.waitForTask).mockResolvedValue(undefined);

    await stopVm(row(), true);

    expect(pve.stopVm).toHaveBeenCalledOnce();
    expect(pve.shutdownVm).not.toHaveBeenCalled();
    expect(pve.waitForTask).toHaveBeenCalledWith(
      'pve-3',
      'UPID:pve-3:stop',
      undefined,
      expect.any(Number),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'stopped' } }),
    );
  });

  it('turns our own bounded deadline into advice, and still writes nothing', async () => {
    vi.mocked(pve.shutdownVm).mockResolvedValue('UPID:pve-3:shutdown');
    // waitForTask's own message when it gives up at the deadline — the task may yet
    // finish, so this is not "Proxmox refused" and must not read like it.
    vi.mocked(pve.waitForTask).mockRejectedValue(new Error('Proxmox task timed out'));

    await expect(stopVm(row(), false)).rejects.toThrow(/has not shut down yet/i);

    for (const call of update.mock.calls) {
      expect((call[0] as { data?: { status?: string } }).data?.status).not.toBe('stopped');
    }
  });

  it('keeps a forced stop timing out as the raw failure (no shutdown advice)', async () => {
    vi.mocked(pve.stopVm).mockResolvedValue('UPID:pve-3:stop');
    vi.mocked(pve.waitForTask).mockRejectedValue(new Error('Proxmox task timed out'));

    // A hard stop that times out is a real problem, not a guest ignoring ACPI.
    await expect(stopVm(row(), true)).rejects.toThrow(/Proxmox task timed out/);
  });

  it('propagates a hard-stop failure instead of reporting success', async () => {
    vi.mocked(pve.stopVm).mockResolvedValue('UPID:pve-3:stop');
    vi.mocked(pve.waitForTask).mockRejectedValue(new Error('Proxmox task failed: got lock timeout'));

    await expect(stopVm(row(), true)).rejects.toThrow(/lock timeout/);
    for (const call of update.mock.calls) {
      expect((call[0] as { data?: { status?: string } }).data?.status).not.toBe('stopped');
    }
  });
});

describe('startVm and restartVm — the task outcome decides too', () => {
  const statuses = () => update.mock.calls.map((c) => (c[0] as { data?: { status?: string } }).data?.status);

  it('marks the guest running only after the start task finished', async () => {
    vi.mocked(pve.startVm).mockResolvedValue('UPID:pve-3:start');
    vi.mocked(pve.waitForTask).mockResolvedValue(undefined);

    await expect(startVm(row())).resolves.toBeUndefined();

    expect(pve.waitForTask).toHaveBeenCalledWith('pve-3', 'UPID:pve-3:start', undefined, expect.any(Number));
    expect(statuses()).toContain('running');
  });

  it('reports a failed start and writes nothing', async () => {
    vi.mocked(pve.startVm).mockResolvedValue('UPID:pve-3:start');
    vi.mocked(pve.waitForTask).mockRejectedValue(new Error('Proxmox task failed: storage not available'));

    await expect(startVm(row())).rejects.toThrow(/storage not available/);
    expect(statuses()).not.toContain('running');
  });

  it('turns a restart that outlives our deadline into advice, and writes nothing', async () => {
    vi.mocked(pve.rebootVm).mockResolvedValue('UPID:pve-3:reboot');
    vi.mocked(pve.waitForTask).mockRejectedValue(new Error('Proxmox task timed out'));

    await expect(restartVm(row())).rejects.toThrow(/has not restarted yet.*stop it forcibly/);
    expect(update).not.toHaveBeenCalled();
  });

  it('reports a failed reboot instead of claiming the guest restarted', async () => {
    vi.mocked(pve.rebootVm).mockResolvedValue('UPID:pve-3:reboot');
    vi.mocked(pve.waitForTask).mockRejectedValue(new Error('Proxmox task failed: VM quit/powerdown failed - got timeout'));

    await expect(restartVm(row())).rejects.toThrow(/powerdown failed/);
    expect(update).not.toHaveBeenCalled();
  });
});
