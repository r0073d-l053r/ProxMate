import { describe, it, expect, beforeEach, vi } from 'vitest';

// Unit-test the cloud-init deploy-lock state machine against a mocked guest agent
// and prisma — the same seam-mocking strategy as the other service tests.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { update: vi.fn() } },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({})),
  guestAgentPing: vi.fn(),
  guestExecOutput: vi.fn(),
}));

import { prisma } from '../src/lib/prisma.js';
import { guestAgentPing, guestExecOutput } from '../src/services/proxmox.service.js';
import { deployStateOf, isDeploying, refreshDeployState } from '../src/services/deploy-lock.service.js';
import type { VirtualMachine } from '@prisma/client';

const update = vi.mocked(prisma.virtualMachine.update);
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
