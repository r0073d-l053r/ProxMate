import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Provisioning orchestrates proxmox + gateway calls — mock them and inspect the
// bootstrap it ships and the guest secret it records.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn().mockResolvedValue({}),
  guestAgentPing: vi.fn().mockResolvedValue(true),
  guestFileWrite: vi.fn(),
  guestExec: vi.fn(),
  guestExecOutput: vi.fn().mockResolvedValue({ exitcode: 0, stdout: 'yes', stderr: '' }),
  ensureIdePinhole: vi.fn(),
  ensureHostCpu: vi.fn().mockResolvedValue(false),
  getNodeAvxMap: vi.fn(),
  migratableTargets: vi.fn(),
  getNodesHealth: vi.fn(),
  pickBestNode: vi.fn(),
  shutdownVm: vi.fn(),
  waitForTask: vi.fn(),
}));
vi.mock('../src/services/vm.service.js', () => ({
  migrateVmToNode: vi.fn(),
  startVm: vi.fn(),
  getVmWithLiveStatus: vi.fn(),
  // The guest at the VMID is the row's own.
  requireOurGuest: vi.fn(async (v: unknown) => v),
}));
vi.mock('../src/services/ide-gateway.service.js', () => ({
  issueGatewayToken: vi.fn().mockResolvedValue({ token: 'pmide_tok', baseUrl: 'https://x/api/ide/vm-1/llm/v1' }),
  listModelPickerEntries: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/services/ide-assets.generated.js', () => ({
  IDE_SETTINGS_JSON: '{}',
  IDE_AUTOSTART_PACKAGE_JSON: '{}',
  IDE_AUTOSTART_EXTENSION_JS: '',
}));
vi.mock('../src/services/ide-guest-auth.service.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/ide-guest-auth.service.js')>()),
  saveIdeGuestSecret: vi.fn().mockResolvedValue(undefined),
  loadIdeGuestSecret: vi.fn(),
  proveIdeGuestTarget: vi.fn(),
}));

import type { VirtualMachine } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { guestFileWrite, guestExec } from '../src/services/proxmox.service.js';
import {
  saveIdeGuestSecret,
  loadIdeGuestSecret,
  proveIdeGuestTarget,
} from '../src/services/ide-guest-auth.service.js';
import { startIdeProvision, refreshIdeState, advanceIdeState, resetIdeProbes } from '../src/services/ide-provision.service.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function vm(overrides: Partial<VirtualMachine> = {}): VirtualMachine {
  return {
    id: 'vm-1',
    userId: 'u1',
    type: 'qemu',
    status: 'running',
    cpu: 2,
    ram: 8192,
    proxmoxNode: 'pve',
    proxmoxVmId: 101,
    ipAddress: '10.0.0.5',
    ideState: null,
    ideStateAt: null,
    ...overrides,
  } as VirtualMachine;
}

async function provisionAndReadBootstrap(): Promise<{ script: string; secret: string }> {
  await startIdeProvision(vm(), { id: 'u1', role: 'user' }, 'https://x');
  const b64 = vi.mocked(guestFileWrite).mock.calls.at(-1)![3] as string;
  const secret = vi.mocked(saveIdeGuestSecret).mock.calls.at(-1)![1];
  return { script: Buffer.from(b64, 'base64').toString('utf8'), secret };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startIdeProvision — per-VM guest credential', () => {
  it('runs code-server with password auth keyed to a fresh per-VM secret', async () => {
    const { script, secret } = await provisionAndReadBootstrap();
    expect(vi.mocked(saveIdeGuestSecret)).toHaveBeenCalledWith('vm-1', expect.any(String));
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(script).toContain('--auth password');
    expect(script).not.toContain('--auth none');
    // The guest only ever receives the hash, never the secret itself.
    expect(script).toContain('HASHED_PASSWORD=%s');
    expect(script).toContain(`'${sha(secret)}' > /etc/proxmate-ide.env`);
    expect(script).not.toContain(secret);
  });

  it('rotates the secret on every (re)provision', async () => {
    const a = await provisionAndReadBootstrap();
    const b = await provisionAndReadBootstrap();
    expect(a.secret).not.toBe(b.secret);
  });

  it('restarts the service so a reinstall replaces an already-running code-server', async () => {
    const { script } = await provisionAndReadBootstrap();
    expect(script).toMatch(/systemctl restart proxmate-ide\.service/);
  });
});

describe('startIdeProvision — bootstrap files in /tmp', () => {
  it('decodes under umask 077 and removes both temp files once started', async () => {
    const { script } = await provisionAndReadBootstrap();
    const cmd = (vi.mocked(guestExec).mock.calls.at(-1)![2] as string[]).join(' ');
    expect(cmd.indexOf('umask 077')).toBeGreaterThanOrEqual(0);
    expect(cmd.indexOf('umask 077')).toBeLessThan(cmd.indexOf('base64 -d'));
    expect(cmd).toMatch(/rm -f \/tmp\/pmide-bootstrap\.b64/);
    // The script deletes itself first thing (sh keeps reading the open file).
    expect(script.split('\n').slice(0, 6).join('\n')).toMatch(/rm -f \/tmp\/pmide-bootstrap\.sh/);
  });
});

describe('startIdeProvision — one install at a time', () => {
  it('refuses while an install is still running, without touching the guest or the secret', async () => {
    const err = await startIdeProvision(
      vm({ ideState: 'installing', ideStateAt: new Date() }),
      { id: 'u1', role: 'user' },
      'https://x',
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('install_in_progress');
    expect(vi.mocked(guestFileWrite)).not.toHaveBeenCalled();
    expect(vi.mocked(saveIdeGuestSecret)).not.toHaveBeenCalled();
  });

  it('allows a retry once a stuck install has timed out', async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await expect(
      startIdeProvision(vm({ ideState: 'installing', ideStateAt: old }), { id: 'u1', role: 'user' }, 'https://x'),
    ).resolves.toBe('installing');
  });
});

describe('startIdeProvision — owner only', () => {
  it('refuses to install (and mint a gateway token) for anyone but the VM owner', async () => {
    await expect(startIdeProvision(vm({ userId: 'owner1' }), { id: 'admin1', role: 'admin' }, 'https://x')).rejects.toThrow(
      /owner/i,
    );
    expect(vi.mocked(guestFileWrite)).not.toHaveBeenCalled();
    expect(vi.mocked(saveIdeGuestSecret)).not.toHaveBeenCalled();
  });
});

describe('refreshIdeState — ready only once the guest proves the secret', () => {
  const installing = () => vm({ ideState: 'installing', ideStateAt: new Date() });

  it('stays installing while the guest cannot prove the secret (e.g. an old install still answering)', async () => {
    vi.mocked(loadIdeGuestSecret).mockResolvedValue('s');
    vi.mocked(proveIdeGuestTarget).mockResolvedValue(null);
    expect(await refreshIdeState(installing())).toBe('installing');
    expect(vi.mocked(prisma.virtualMachine.update)).not.toHaveBeenCalled();
  });

  it('flips to ready when the guest proves the secret', async () => {
    vi.mocked(loadIdeGuestSecret).mockResolvedValue('s');
    vi.mocked(proveIdeGuestTarget).mockResolvedValue('http://10.0.0.5:8080');
    expect(await refreshIdeState(installing())).toBe('ready');
    expect(vi.mocked(proveIdeGuestTarget)).toHaveBeenCalledWith(expect.objectContaining({ id: 'vm-1' }), 's');
  });
});

describe('advanceIdeState — the VM-detail fetch advances the install', () => {
  beforeEach(() => resetIdeProbes());
  const installing = () => vm({ ideState: 'installing', ideStateAt: new Date() });

  it('marks a finished install ready, probing the guest at most once per interval', async () => {
    vi.mocked(loadIdeGuestSecret).mockResolvedValue('s');
    vi.mocked(proveIdeGuestTarget).mockResolvedValue(null);
    expect(await advanceIdeState(installing())).toBe('installing');
    vi.mocked(proveIdeGuestTarget).mockResolvedValue('http://10.0.0.5:8080');
    // Inside the interval the last answer stands, without dialling the guest again.
    expect(await advanceIdeState(installing())).toBe('installing');
    expect(vi.mocked(proveIdeGuestTarget)).toHaveBeenCalledTimes(1);
  });

  it('records ready when the guest proves the secret', async () => {
    vi.mocked(loadIdeGuestSecret).mockResolvedValue('s');
    vi.mocked(proveIdeGuestTarget).mockResolvedValue('http://10.0.0.5:8080');
    expect(await advanceIdeState(installing())).toBe('ready');
    expect(vi.mocked(prisma.virtualMachine.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ideState: 'ready' }) }),
    );
  });

  it('never probes a VM that is not installing', async () => {
    expect(await advanceIdeState(vm({ ideState: 'ready' }))).toBe('ready');
    expect(vi.mocked(proveIdeGuestTarget)).not.toHaveBeenCalled();
  });
});

describe('startIdeProvision — IDE_GUEST_PORT', () => {
  it('binds code-server to the configured guest port (the one the pinhole, probe and proxy use)', async () => {
    vi.stubEnv('IDE_GUEST_PORT', '9000');
    vi.resetModules();
    try {
      const prov = await import('../src/services/ide-provision.service.js');
      const pmx = await import('../src/services/proxmox.service.js');
      await prov.startIdeProvision(vm(), { id: 'u1', role: 'user' }, 'https://x');
      const b64 = vi.mocked(pmx.guestFileWrite).mock.calls.at(-1)![3] as string;
      const script = Buffer.from(b64, 'base64').toString('utf8');
      expect(script).toContain('--bind-addr 0.0.0.0:9000');
      expect(script).not.toContain('0.0.0.0:8080');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
