import { describe, it, expect, beforeEach, vi } from 'vitest';

// Unit-test the cloud-init deploy-lock state machine against a mocked guest agent
// and prisma — the same seam-mocking strategy as the other service tests.
vi.mock('../src/lib/prisma.js', () => ({
  // findUnique backs the end-of-window check that drops an unapplied login password
  // instead of storing it indefinitely — see abandonPendingCiPassword.
  prisma: { virtualMachine: { update: vi.fn(), findUnique: vi.fn(async () => null) } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({})),
  guestAgentPing: vi.fn(),
  guestExecOutput: vi.fn(),
  getVmConfig: vi.fn(async () => ({})),
  setGuestUserPassword: vi.fn(async () => undefined),
}));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn(async () => undefined) }));

import { prisma } from '../src/lib/prisma.js';
import { notify } from '../src/services/notify.service.js';
import { guestAgentPing, guestExecOutput } from '../src/services/proxmox.service.js';
import { deployStateOf, isDeploying, refreshDeployState } from '../src/services/deploy-lock.service.js';
import type { VirtualMachine } from '@prisma/client';

const update = vi.mocked(prisma.virtualMachine.update);
const findUnique = vi.mocked(prisma.virtualMachine.findUnique);
const notified = vi.mocked(notify);
const ping = vi.mocked(guestAgentPing);
const exec = vi.mocked(guestExecOutput);

function vm(over: Partial<VirtualMachine> = {}): VirtualMachine {
  return {
    id: 'vm-1',
    proxmoxNode: 'pve-x',
    proxmoxVmId: 110,
    deployState: 'deploying',
    deployStateAt: new Date(),
    ...over,
  } as VirtualMachine;
}

function cloudInitStatus(status: string) {
  exec.mockResolvedValue({ exitcode: 0, stdout: `status: ${status}`, stderr: '' });
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({} as never);
});

describe('deployStateOf / isDeploying', () => {
  it('normalises the raw column', () => {
    expect(deployStateOf({ deployState: 'deploying' })).toBe('deploying');
    expect(deployStateOf({ deployState: 'ready' })).toBe('ready');
    expect(deployStateOf({ deployState: null })).toBe('none');
    expect(deployStateOf({ deployState: 'garbage' })).toBe('none');
  });

  it('isDeploying is true only for the deploying state', () => {
    expect(isDeploying({ deployState: 'deploying' })).toBe(true);
    expect(isDeploying({ deployState: 'ready' })).toBe(false);
    expect(isDeploying({ deployState: null })).toBe(false);
  });
});

describe('refreshDeployState', () => {
  it('is a no-op when the VM is not mid-deploy', async () => {
    expect(await refreshDeployState(vm({ deployState: 'ready' }))).toBe('ready');
    expect(await refreshDeployState(vm({ deployState: null }))).toBe('none');
    expect(ping).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('stays locked while the guest agent is unreachable', async () => {
    ping.mockResolvedValue(false);
    expect(await refreshDeployState(vm())).toBe('deploying');
    expect(exec).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('stays locked while cloud-init is still running', async () => {
    ping.mockResolvedValue(true);
    cloudInitStatus('running');
    expect(await refreshDeployState(vm())).toBe('deploying');
    expect(update).not.toHaveBeenCalled();
  });

  it('treats "not run" (not started yet) as still deploying', async () => {
    ping.mockResolvedValue(true);
    exec.mockResolvedValue({ exitcode: 0, stdout: 'status: not run', stderr: '' });
    expect(await refreshDeployState(vm())).toBe('deploying');
    expect(update).not.toHaveBeenCalled();
  });

  it('unlocks once cloud-init reports done', async () => {
    ping.mockResolvedValue(true);
    cloudInitStatus('done');
    expect(await refreshDeployState(vm())).toBe('ready');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'vm-1' }, data: expect.objectContaining({ deployState: 'ready' }) }),
    );
  });

  it('unlocks on a terminal error/disabled status too', async () => {
    ping.mockResolvedValue(true);
    cloudInitStatus('error');
    expect(await refreshDeployState(vm())).toBe('ready');
    expect(update).toHaveBeenCalledOnce();
  });

  it('unlocks when there is no cloud-init to wait on (empty output)', async () => {
    ping.mockResolvedValue(true);
    exec.mockResolvedValue({ exitcode: 0, stdout: '', stderr: '' });
    expect(await refreshDeployState(vm())).toBe('ready');
    expect(update).toHaveBeenCalledOnce();
  });

  it('stays locked when the probe throws (agent glitch) — retried next poll', async () => {
    ping.mockResolvedValue(true);
    exec.mockRejectedValue(new Error('exec timed out'));
    expect(await refreshDeployState(vm())).toBe('deploying');
    expect(update).not.toHaveBeenCalled();
  });

  it('unlocks after the timeout even with no agent, so it never locks forever', async () => {
    ping.mockResolvedValue(false);
    const stale = new Date(Date.now() - 9 * 60 * 1000); // > 8-min ceiling
    expect(await refreshDeployState(vm({ deployStateAt: stale }))).toBe('ready');
    // Timeout path unlocks without ever probing the agent.
    expect(ping).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deployState: 'ready' }) }),
    );
  });
});


/**
 * B-39. A deploy whose guest agent never responds must reach an ADMIN.
 *
 * The failure mode is quiet and asymmetric: Proxmox reports the VM running, the
 * deploy lock clears, nothing errors — and the tenant simply cannot log in, because
 * the password is applied in-guest through the agent (never on the cloud-init seed,
 * where a tenant could read it back). Before this, the only signals were a server-side
 * log line nobody watches and a support ticket from the tenant.
 *
 * It is really a TEMPLATE fault, not a VM fault: a template without qemu-guest-agent
 * breaks every password-only deploy made from it, so the notification has to name the
 * source or an admin cannot act on it.
 */
describe('the deploy window closing with the password unapplied', () => {
  const stale = () => vm({ deployStateAt: new Date(Date.now() - 9 * 60 * 1000) });

  it('notifies an admin, names the template, and destroys the stored secret', async () => {
    findUnique.mockResolvedValue({
      pendingCiPassword: 'enc:whatever',
      name: 'app-01',
      description: 'From template: debian-13-trixie',
      os: 'Debian 13',
      proxmoxVmId: 110,
    } as never);

    await refreshDeployState(stale());

    expect(notified).toHaveBeenCalledTimes(1);
    const payload = notified.mock.calls[0]![0]!;
    expect(payload.event).toBe('deploy.agent_missing');
    expect(payload.title).toContain('app-01');
    expect(payload.title).toContain('110');
    // Names the template to fix, and says the fix is the template rather than the VM.
    expect(payload.message).toContain('debian-13-trixie');
    expect(payload.message).toContain('qemu-guest-agent');

    // The secret is dropped, not carried indefinitely.
    expect(update.mock.calls.some((c) => (c[0] as { data: Record<string, unknown> }).data['pendingCiPassword'] === null)).toBe(true);
  });

  it('falls back to the OS label when the description is missing', async () => {
    findUnique.mockResolvedValue({
      pendingCiPassword: 'enc:whatever', name: 'app-01', description: null, os: 'Debian 13', proxmoxVmId: 110,
    } as never);

    await refreshDeployState(stale());

    expect(notified.mock.calls[0]![0]!.message).toContain('Debian 13');
  });

  it('stays silent when there was no pending password at all', async () => {
    findUnique.mockResolvedValue({ pendingCiPassword: null, name: 'app-01', description: null, os: 'x', proxmoxVmId: 110 } as never);

    await refreshDeployState(stale());

    expect(notified).not.toHaveBeenCalled();
  });

  it('never lets a failing notification hold the deploy lock', async () => {
    findUnique.mockResolvedValue({
      pendingCiPassword: 'enc:whatever', name: 'app-01', description: null, os: 'x', proxmoxVmId: 110,
    } as never);
    notified.mockRejectedValueOnce(new Error('webhook exploded'));

    // The guest is otherwise usable; a broken notification channel must not strand it.
    await expect(refreshDeployState(stale())).resolves.toBe('ready');
  });
});
