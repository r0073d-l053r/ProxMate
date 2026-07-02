import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the seams (DB + Proxmox client factory); the real request builders and
// the real rescue/reset orchestration run against the fake axios below.
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
import {
  generateGuestPassword,
  resetGuestPassword,
  enterRescue,
  exitRescue,
} from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

const getClient = vi.mocked(pve.getClient);
const update = vi.mocked(prisma.virtualMachine.update);
const configFind = vi.mocked(prisma.systemConfig.findUnique);

const vm = (over: Record<string, unknown> = {}) =>
  ({ id: 'db-1', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 120, proxmoxNode: 'pve1', status: 'stopped', rescueBoot: null, ...over }) as never;

/** Fake Proxmox answering the reads rescue/reset orchestration makes. */
function fakePve(config: Record<string, string>, status = 'stopped') {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/resources') return ok([{ type: 'qemu', vmid: 120, node: 'pve1' }]);
    if (/\/qemu\/120\/config$/.test(url)) return ok(config);
    if (/\/qemu\/120\/status\/current$/.test(url)) return ok({ status });
    return ok(null);
  });
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ ...(vm() as object), ...args.data }) as never);
});

describe('generateGuestPassword', () => {
  it('produces 20 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i++) {
      const p = generateGuestPassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]+$/);
    }
  });

  it('draws from the alphabet without modulo bias (uniform-ish over a large sample)', () => {
    // crypto.randomInt is unbiased; `randomBytes % 56` would skew the first 32
    // chars ~14% high. Over 56k chars every symbol should be well within a
    // generous band of the ~1000 expected — a plain-modulo regression would
    // push the first bucket toward ~1140 and a late one toward ~875.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const counts = new Map<string, number>();
    const N = 1000;
    for (let i = 0; i < N; i++) for (const ch of generateGuestPassword()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = (N * 20) / alphabet.length; // ~357
    for (const ch of alphabet) {
      const c = counts.get(ch) ?? 0;
      expect(c).toBeGreaterThan(expected * 0.7);
      expect(c).toBeLessThan(expected * 1.3);
    }
  });
});

describe('resetGuestPassword', () => {
  it('POSTs username + a generated password to agent/set-user-password', async () => {
    const c = fakePve({});
    getClient.mockResolvedValue(asClient(c));

    const password = await resetGuestPassword(vm({ status: 'running' }), 'ubuntu');
    const call = c.post.mock.calls.find((x) => String(x[0]).includes('set-user-password'));
    expect(call![0]).toBe('/nodes/pve1/qemu/120/agent/set-user-password');
    const body = bodyOf(call!);
    expect(body['username']).toBe('ubuntu');
    expect(body['password']).toBe(password);
    expect(password).toHaveLength(20);
  });

  it('rejects containers without touching Proxmox', async () => {
    const c = fakeClient();
    getClient.mockResolvedValue(asClient(c));
    await expect(resetGuestPassword(vm({ type: 'lxc' }), 'root')).rejects.toThrow(/agent/i);
    expect(c.post).not.toHaveBeenCalled();
  });
});

describe('enterRescue', () => {
  it('snapshots boot config, attaches the ISO on ide3, pins boot, and starts', async () => {
    configFind.mockResolvedValue({ key: 'rescue_iso', value: 'local:iso/systemrescue.iso', sensitive: false } as never);
    const c = fakePve({ boot: 'order=scsi0;ide2', scsi0: 'ceph:vm-120-disk-0' });
    getClient.mockResolvedValue(asClient(c));

    await enterRescue(vm());

    // rescueBoot snapshot persisted with the prior boot line (no prior ide3).
    const data = update.mock.calls[0]![0].data as { rescueBoot: string };
    expect(JSON.parse(data.rescueBoot)).toEqual({ boot: 'order=scsi0;ide2', ide3: null });

    // Config pinned to the rescue ISO.
    const putCall = c.put.mock.calls.find((x) => /\/qemu\/120\/config$/.test(String(x[0])));
    const body = bodyOf(putCall!);
    expect(body['ide3']).toBe('local:iso/systemrescue.iso,media=cdrom');
    expect(body['boot']).toBe('order=ide3');

    // Started into the ISO (no stop needed - VM was stopped).
    expect(c.post.mock.calls.some((x) => String(x[0]).endsWith('/status/start'))).toBe(true);
    expect(c.post.mock.calls.some((x) => String(x[0]).endsWith('/status/stop'))).toBe(false);
  });

  it('refuses when no rescue ISO is configured', async () => {
    configFind.mockResolvedValue(null as never);
    const c = fakePve({});
    getClient.mockResolvedValue(asClient(c));
    await expect(enterRescue(vm())).rejects.toThrow(/no rescue iso/i);
    expect(c.put).not.toHaveBeenCalled();
  });

  it('refuses containers and double-entry', async () => {
    await expect(enterRescue(vm({ type: 'lxc' }))).rejects.toThrow(/containers/i);
    await expect(enterRescue(vm({ rescueBoot: '{}' }))).rejects.toThrow(/already/i);
  });
});

describe('exitRescue', () => {
  it('restores the snapshotted boot line, deletes the rescue ide3, and starts', async () => {
    const c = fakePve({ boot: 'order=ide3', ide3: 'local:iso/systemrescue.iso,media=cdrom' });
    getClient.mockResolvedValue(asClient(c));

    await exitRescue(vm({ rescueBoot: JSON.stringify({ boot: 'order=scsi0;ide2', ide3: null }) }));

    const putCall = c.put.mock.calls.find((x) => /\/qemu\/120\/config$/.test(String(x[0])));
    const body = bodyOf(putCall!);
    expect(body['boot']).toBe('order=scsi0;ide2');
    expect(body['delete']).toBe('ide3');

    const data = update.mock.calls[0]![0].data as { rescueBoot: null };
    expect(data.rescueBoot).toBeNull();
    expect(c.post.mock.calls.some((x) => String(x[0]).endsWith('/status/start'))).toBe(true);
  });

  it('refuses when not in rescue mode', async () => {
    await expect(exitRescue(vm())).rejects.toThrow(/not in rescue/i);
  });
});
