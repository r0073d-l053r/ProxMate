import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the seams (DB + Proxmox client factory); the real injectGuestSshKey and
// addGuestSshKey orchestration run against the fake axios below — same pattern
// as rescue-reset.test.ts.
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), update: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { addGuestSshKey } from '../src/services/vm.service.js';
import { fakeClient, asClient } from './helpers.js';

const getClient = vi.mocked(pve.getClient);
const update = vi.mocked(prisma.virtualMachine.update);

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHfXm3PpXcVSyCTXlq2WCyDPeeVGrLYU2VgYPBYcqvlj dev@laptop';
const OLD_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAA old@box';

const vm = (over: Record<string, unknown> = {}) =>
  ({ id: 'db-1', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 120, proxmoxNode: 'pve1', status: 'running', ...over }) as never;

/** Fake Proxmox answering everything addGuestSshKey touches. */
function fakePve(opts: { config?: Record<string, string>; execStatus?: object[] } = {}) {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  const statuses = opts.execStatus ?? [{ exited: 1, exitcode: 0 }];
  let statusIdx = 0;
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/resources') return ok([{ type: 'qemu', vmid: 120, node: 'pve1' }]);
    if (/agent\/exec-status\?pid=77$/.test(url)) return ok(statuses[Math.min(statusIdx++, statuses.length - 1)]);
    if (/\/qemu\/120\/config$/.test(url)) return ok(opts.config ?? {});
    return ok(null);
  });
  c.post.mockImplementation((url: string) => {
    if (/agent\/exec$/.test(url)) return ok({ pid: 77 });
    return ok('UPID:fake');
  });
  return c;
}

/** The recorded agent/exec call's `command` argv (repeated form params). */
function execArgv(c: ReturnType<typeof fakeClient>): string[] {
  const call = c.post.mock.calls.find(([url]) => /agent\/exec$/.test(url as string));
  expect(call).toBeDefined();
  return (call![1] as URLSearchParams).getAll('command');
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockImplementation(
    (args: { data: Record<string, unknown> }) => Promise.resolve({ ...(vm() as object), ...args.data }) as never,
  );
});

describe('addGuestSshKey — guards', () => {
  it('rejects containers (no guest agent) before touching Proxmox', async () => {
    await expect(addGuestSshKey(vm({ type: 'lxc' }), 'root', KEY)).rejects.toThrow(/containers are not supported/);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('rejects a multi-line paste (authorized_keys injection guard) before touching Proxmox', async () => {
    await expect(addGuestSshKey(vm(), 'ubuntu', `${KEY}\nssh-rsa AAAA smuggled@evil`)).rejects.toThrow(/OpenSSH public key/);
    await expect(addGuestSshKey(vm(), 'ubuntu', 'not a key at all')).rejects.toThrow(/OpenSSH public key/);
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('addGuestSshKey — agent exec (argv-safe)', () => {
  it('passes the username and key as argv positionals, never interpolated into the script', async () => {
    const c = fakePve();
    getClient.mockResolvedValue(asClient(c));

    await addGuestSshKey(vm(), 'ubuntu', KEY);

    const argv = execArgv(c);
    expect(argv).toHaveLength(6);
    expect(argv[0]).toBe('/bin/sh');
    expect(argv[1]).toBe('-c');
    // The fixed script: mkdir/append/perm-fix — and free of both user inputs.
    expect(argv[2]).toContain('authorized_keys');
    expect(argv[2]).toContain('chmod 700');
    expect(argv[2]).not.toContain(KEY);
    expect(argv[2]).not.toContain('ubuntu');
    expect(argv[3]).toBe('sh'); // $0
    expect(argv[4]).toBe('ubuntu'); // $1
    expect(argv[5]).toBe(KEY); // $2
  });

  it('polls exec-status until the script exits 0', async () => {
    const c = fakePve({ execStatus: [{ exited: 0 }, { exited: 1, exitcode: 0 }] });
    getClient.mockResolvedValue(asClient(c));

    await addGuestSshKey(vm(), 'ubuntu', KEY);
    const polls = c.get.mock.calls.filter(([url]) => /exec-status/.test(url as string));
    expect(polls.length).toBe(2);
  });

  it('maps exit 3 to a clear "user does not exist" error', async () => {
    const c = fakePve({ execStatus: [{ exited: 1, exitcode: 3 }] });
    getClient.mockResolvedValue(asClient(c));

    await expect(addGuestSshKey(vm(), 'ghost', KEY)).rejects.toThrow(/"ghost" does not exist/);
  });

  it('surfaces the guest stderr on a non-zero exit', async () => {
    const c = fakePve({ execStatus: [{ exited: 1, exitcode: 1, 'err-data': 'mkdir: read-only file system' }] });
    getClient.mockResolvedValue(asClient(c));

    await expect(addGuestSshKey(vm(), 'ubuntu', KEY)).rejects.toThrow(/read-only file system/);
  });
});

describe('addGuestSshKey — best-effort cloud-init config sync', () => {
  const cloudCfg = (sshkeys?: string): Record<string, string> => ({
    ide2: 'local-lvm:vm-120-cloudinit,media=cdrom',
    ipconfig0: 'ip=192.168.50.10/24,gw=192.168.50.1',
    ...(sshkeys ? { sshkeys } : {}),
  });

  it('appends the key to the cloud-init sshkeys config, preserving the static ipconfig0', async () => {
    const c = fakePve({ config: cloudCfg(encodeURIComponent(OLD_KEY)) });
    getClient.mockResolvedValue(asClient(c));

    await addGuestSshKey(vm(), 'ubuntu', KEY);

    const put = c.put.mock.calls.find(([url]) => /\/qemu\/120\/config$/.test(url as string));
    expect(put).toBeDefined();
    const body = put![1] as URLSearchParams;
    expect(decodeURIComponent(body.get('sshkeys')!)).toBe(`${OLD_KEY}\n${KEY}`);
    // The key add must never flip a static-IP VM back to DHCP.
    expect(body.get('ipconfig0')).toBe('ip=192.168.50.10/24,gw=192.168.50.1');
  });

  it('skips the config write when the key is already in sshkeys', async () => {
    const c = fakePve({ config: cloudCfg(encodeURIComponent(`${OLD_KEY}\n${KEY}`)) });
    getClient.mockResolvedValue(asClient(c));

    await addGuestSshKey(vm(), 'ubuntu', KEY);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('skips the config write for a VM without a cloud-init drive', async () => {
    const c = fakePve({ config: { scsi0: 'local-lvm:vm-120-disk-0,size=20G' } });
    getClient.mockResolvedValue(asClient(c));

    await addGuestSshKey(vm(), 'ubuntu', KEY);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('still succeeds when the config sync fails — the key is already live in the guest', async () => {
    const c = fakePve({ config: cloudCfg() });
    c.put.mockRejectedValue(new Error('VM is locked (backup)'));
    getClient.mockResolvedValue(asClient(c));

    await expect(addGuestSshKey(vm(), 'ubuntu', KEY)).resolves.toBeUndefined();
  });
});
