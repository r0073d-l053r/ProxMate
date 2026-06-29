import { describe, it, expect, vi } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { normalizeArch, getNodeArchMap, pickBestNode } from '../src/services/proxmox.service.js';
import { fakeClient, asClient } from './helpers.js';

const GiB = 1024 ** 3;

/** A /cluster/resources node entry with capacity to spare. */
function node(name: string) {
  return { type: 'node', status: 'online', node: name, maxcpu: 8, cpu: 0.1, maxmem: 16 * GiB, mem: 2 * GiB };
}

describe('normalizeArch', () => {
  it('maps uname machine strings to coarse buckets', () => {
    expect(normalizeArch('x86_64')).toBe('amd64');
    expect(normalizeArch('amd64')).toBe('amd64');
    expect(normalizeArch('aarch64')).toBe('arm64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(normalizeArch('riscv64')).toBe('unknown');
    expect(normalizeArch(undefined)).toBe('unknown');
  });
});

describe('getNodeArchMap', () => {
  it('reads each node’s current-kernel.machine; detection failure → unknown', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/resources') {
        return Promise.resolve({ data: { data: [node('pve-0'), node('pve-1'), node('pve-2')] } });
      }
      if (url === '/nodes/pve-0/status') return Promise.resolve({ data: { data: { 'current-kernel': { machine: 'x86_64' } } } });
      if (url === '/nodes/pve-1/status') return Promise.resolve({ data: { data: { 'current-kernel': { machine: 'aarch64' } } } });
      return Promise.reject(new Error('node down')); // pve-2 → unknown
    });

    const map = await getNodeArchMap(asClient(c));
    expect(map.get('pve-0')).toBe('amd64');
    expect(map.get('pve-1')).toBe('arm64');
    expect(map.get('pve-2')).toBe('unknown');
  });
});

describe('pickBestNode — architecture guardrail', () => {
  // A mixed cluster: one amd64 node, one arm64 node.
  function mixedClient() {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/resources') {
        return Promise.resolve({ data: { data: [node('pve-x86'), node('pve-arm')] } });
      }
      if (url === '/nodes/pve-x86/status') return Promise.resolve({ data: { data: { 'current-kernel': { machine: 'x86_64' } } } });
      if (url === '/nodes/pve-arm/status') return Promise.resolve({ data: { data: { 'current-kernel': { machine: 'aarch64' } } } });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    return c;
  }

  const want = { cpu: 1, ramMb: 512, storageGb: 8 };

  it('places an arm64 image on the arm64 node', async () => {
    const n = await pickBestNode(want, undefined, asClient(mixedClient()), undefined, 'arm64');
    expect(n).toBe('pve-arm');
  });

  it('places an amd64 image on the amd64 node', async () => {
    const n = await pickBestNode(want, undefined, asClient(mixedClient()), undefined, 'amd64');
    expect(n).toBe('pve-x86');
  });

  it('throws when no node matches the required arch (never mis-places)', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/resources') return Promise.resolve({ data: { data: [node('pve-x86')] } });
      if (url === '/nodes/pve-x86/status') return Promise.resolve({ data: { data: { 'current-kernel': { machine: 'x86_64' } } } });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    await expect(pickBestNode(want, undefined, asClient(c), undefined, 'arm64')).rejects.toThrow(/No arm64 node/);
  });

  it('does not filter when no arch is requested (back-compat)', async () => {
    const n = await pickBestNode(want, undefined, asClient(mixedClient()));
    expect(['pve-x86', 'pve-arm']).toContain(n);
  });
});
