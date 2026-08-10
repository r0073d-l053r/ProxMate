import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the cloud-init credential scrub.
 *
 * An authorized pentest (2026-07-18) pulled a username and a crypt hash off a tenant
 * VM's cloud-init seed drive: `cipassword` is written into the VM config, Proxmox
 * bakes its hash into the seed ISO, and that ISO stays attached and root-readable in
 * the guest forever. Where one password is reused across a fleet cloned from a shared
 * template, a single compromised guest yields the credential for all of them.
 *
 * The password cannot simply not be set — on a password-only deploy it is the sole
 * credential, and the first boot is what applies it. So it is removed immediately
 * after: config key deleted, seed regenerated, while the guest keeps running.
 *
 * The hazard these tests exist to prevent is the opposite failure — scrubbing a
 * password that cloud-init has NOT yet applied, which would leave a password-only
 * tenant permanently locked out of their own VM.
 */

const { update, findUnique } = vi.hoisted(() => ({ update: vi.fn(async () => ({})), findUnique: vi.fn() }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { update, findUnique } },
}));

vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({}) as never),
    guestAgentPing: vi.fn(async () => true),
    guestExecOutput: vi.fn(async () => ({ stdout: 'status: done', stderr: '', exitcode: 0 })),
    scrubCloudInitPassword: vi.fn(async () => true),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import { refreshDeployState } from '../src/services/deploy-lock.service.js';

const scrub = vi.mocked(pve.scrubCloudInitPassword);
const guestExec = vi.mocked(pve.guestExecOutput);

const DEPLOYING = {
  id: 'vm1',
  type: 'qemu',
  proxmoxNode: 'pve-0',
  proxmoxVmId: 100,
  deployState: 'deploying',
  deployStateAt: new Date(),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  guestExec.mockResolvedValue({ stdout: 'status: done', stderr: '', exitcode: 0 } as never);
  scrub.mockResolvedValue(true);
});

describe('scrubbing the cloud-init password when the deploy lock clears', () => {
  it('scrubs once cloud-init reports it finished, then unlocks', async () => {
    const state = await refreshDeployState(DEPLOYING);

    expect(scrub).toHaveBeenCalledWith('pve-0', 100);
    expect(state).toBe('ready');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'vm1' }, data: expect.objectContaining({ deployState: 'ready' }) }),
    );
  });

  it('does NOT scrub while cloud-init is still running — the password may not be applied yet', async () => {
    guestExec.mockResolvedValue({ stdout: 'status: running', stderr: '', exitcode: 0 } as never);

    const state = await refreshDeployState(DEPLOYING);

    expect(scrub).not.toHaveBeenCalled();
    expect(state).toBe('deploying');
  });

  it('does NOT scrub when the lock is released by TIMEOUT — cloud-init was never confirmed', async () => {
    // The lock-out hazard: the timeout fires precisely when we could not confirm the
    // run finished (no agent, stuck guest). Removing the password here could delete a
    // credential that was never applied, leaving a password-only tenant with no way in.
    const timedOut = { ...(DEPLOYING as object), deployStateAt: new Date(Date.now() - 9 * 60 * 1000) } as never;

    const state = await refreshDeployState(timedOut);

    expect(scrub).not.toHaveBeenCalled();
    expect(state).toBe('ready');
  });

  it('keeps the lock and retries when the scrub fails, rather than losing the cleanup', async () => {
    scrub.mockRejectedValue(new Error('proxmox 500'));

    const state = await refreshDeployState(DEPLOYING);

    expect(scrub).toHaveBeenCalled();
    // Still 'deploying', so the next poll runs the scrub again. The timeout branch is
    // the backstop that guarantees this can never wedge the guest permanently.
    expect(state).toBe('deploying');
    expect(update).not.toHaveBeenCalled();
  });

  it('skips the scrub for LXC — containers carry no cloud-init seed drive', async () => {
    const lxc = { ...(DEPLOYING as object), type: 'lxc' } as never;

    const state = await refreshDeployState(lxc);

    expect(scrub).not.toHaveBeenCalled();
    expect(state).toBe('ready');
  });

  it('leaves a guest that is not mid-deploy completely alone', async () => {
    const ready = { ...(DEPLOYING as object), deployState: 'ready' } as never;

    await refreshDeployState(ready);

    expect(scrub).not.toHaveBeenCalled();
    expect(guestExec).not.toHaveBeenCalled();
  });
});
