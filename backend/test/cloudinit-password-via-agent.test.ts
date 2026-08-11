import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMock = vi.fn();
const findUniqueMock = vi.fn();
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: {
      update: (...a: unknown[]) => updateMock(...a),
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
    },
  },
}));

vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn(async () => ({}) as never),
  guestAgentPing: vi.fn(async () => true),
  guestExecOutput: vi.fn(async () => ({ stdout: 'status: done', stderr: '', exitcode: 0 })),
  getVmConfig: vi.fn(async () => ({ ciuser: 'student' })),
  setGuestUserPassword: vi.fn(async () => undefined),
}));

// Real crypto — this test also proves the value we persist is not plaintext.
import { encrypt } from '../src/lib/crypto.js';
import * as pve from '../src/services/proxmox.service.js';
import { refreshDeployState } from '../src/services/deploy-lock.service.js';

const setPassword = vi.mocked(pve.setGuestUserPassword);
const guestExec = vi.mocked(pve.guestExecOutput);
const vmConfig = vi.mocked(pve.getVmConfig);

process.env['ENCRYPTION_KEY'] = 'a'.repeat(64);

const SECRET = 'TenantChosenPw123';

/**
 * Design A: the login password is NEVER handed to cloud-init, because doing so
 * writes its crypt hash to the cloud-init seed AND to /var/lib/cloud on the guest's
 * own disk — both tenant-readable for the life of the VM (verified live 2026-08-11;
 * the seed copy is the 2026-07-18 pentest finding). It is applied post-boot through
 * the guest agent, which writes only to /etc/shadow.
 */
function deployingVm(over: Record<string, unknown> = {}) {
  return {
    id: 'vm-1',
    type: 'qemu',
    proxmoxNode: 'pve-0',
    proxmoxVmId: 100,
    deployState: 'deploying',
    deployStateAt: new Date(),
    pendingCiPassword: encrypt(SECRET),
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
  findUniqueMock.mockResolvedValue({ pendingCiPassword: null, name: 'vm' });
  guestExec.mockResolvedValue({ stdout: 'status: done', stderr: '', exitcode: 0 } as never);
  vmConfig.mockResolvedValue({ ciuser: 'student' } as never);
  setPassword.mockResolvedValue(undefined as never);
});

describe('applying the login password via the guest agent', () => {
  it('sets it in-guest once cloud-init reports finished, and clears the stored copy', async () => {
    const state = await refreshDeployState(deployingVm());

    // The plaintext reaches the agent — and nowhere else.
    expect(setPassword).toHaveBeenCalledWith('pve-0', 100, 'student', SECRET);
    // And is destroyed immediately afterwards.
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pendingCiPassword: null }) }),
    );
    expect(state).toBe('ready');
  });

  it('does NOT set it while cloud-init is still running — the account may not exist yet', async () => {
    // cc_users_groups creates the user; setting a password before it runs fails.
    guestExec.mockResolvedValue({ stdout: 'status: running', stderr: '', exitcode: 0 } as never);

    const state = await refreshDeployState(deployingVm());

    expect(setPassword).not.toHaveBeenCalled();
    expect(state).toBe('deploying');
  });

  it('retries later rather than losing the password when the agent call fails', async () => {
    setPassword.mockRejectedValue(new Error('QEMU guest agent is not running'));

    const state = await refreshDeployState(deployingVm());

    // Still unlocks — a password failure must not hold the guest hostage...
    expect(state).toBe('ready');
    // ...but the encrypted value is kept so a later poll can retry.
    const cleared = updateMock.mock.calls.some(
      (c) => (c[0] as { data?: Record<string, unknown> })?.data?.['pendingCiPassword'] === null,
    );
    expect(cleared).toBe(false);
  });

  it('still tries on the timeout path, where the agent is usually simply absent', async () => {
    guestExec.mockRejectedValue(new Error('no agent'));
    const timedOut = deployingVm({ deployStateAt: new Date(Date.now() - 9 * 60 * 1000) });

    const state = await refreshDeployState(timedOut);

    expect(setPassword).toHaveBeenCalled();
    expect(state).toBe('ready');
  });

  it('does not keep a reversibly-encrypted password forever once the window closes', async () => {
    // The deploy window is the only chance to apply it. Holding the secret past
    // that point accumulates exactly the kind of stored credential this change
    // exists to remove — so it is dropped even though it was never applied.
    guestExec.mockRejectedValue(new Error('no agent'));
    setPassword.mockRejectedValue(new Error('QEMU guest agent is not running'));
    findUniqueMock.mockResolvedValue({ pendingCiPassword: encrypt(SECRET), name: 'student-a' });
    const timedOut = deployingVm({ deployStateAt: new Date(Date.now() - 9 * 60 * 1000) });

    await refreshDeployState(timedOut);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pendingCiPassword: null }) }),
    );
  });

  it('discards the secret rather than holding it when the guest has no cloud-init user', async () => {
    vmConfig.mockResolvedValue({} as never); // no ciuser

    await refreshDeployState(deployingVm());

    expect(setPassword).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pendingCiPassword: null }) }),
    );
  });

  it('is a no-op for an SSH-key-only deploy (no pending password)', async () => {
    await refreshDeployState(deployingVm({ pendingCiPassword: null }));

    expect(setPassword).not.toHaveBeenCalled();
    expect(vmConfig).not.toHaveBeenCalled();
  });

  it('does not attempt the agent path on an LXC container', async () => {
    await refreshDeployState(deployingVm({ type: 'lxc' }));

    expect(setPassword).not.toHaveBeenCalled();
  });

  it('never stores the password as plaintext', () => {
    // Guards the storage side of the design: what lands in the DB column must not
    // be the secret itself.
    const stored = encrypt(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(stored.split(':')).toHaveLength(3); // iv:tag:ciphertext
  });
});
