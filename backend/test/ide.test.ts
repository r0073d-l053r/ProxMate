import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory SystemConfig so we exercise the real ide.service logic without prisma.
const store = new Map<string, string>();
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
  setConfig: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
}));

import { getIdeConfig, saveIdeConfig, getIdeCapability, isValidIngressCidr } from '../src/services/ide.service.js';

beforeEach(() => store.clear());

describe('ide_ingress_cidr (admin-visible pinhole source)', () => {
  it('defaults to empty and round-trips through save/get (trimmed)', async () => {
    expect((await getIdeConfig()).ingressCidr).toBe('');
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, ingressCidr: ' 192.168.50.228/32 ' });
    expect((await getIdeConfig()).ingressCidr).toBe('192.168.50.228/32');
  });

  it('an empty string clears it; undefined leaves it untouched', async () => {
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, ingressCidr: '10.0.0.1/32' });
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false }); // untouched
    expect((await getIdeConfig()).ingressCidr).toBe('10.0.0.1/32');
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, ingressCidr: '' }); // cleared
    expect((await getIdeConfig()).ingressCidr).toBe('');
  });

  it('never leaks into the tenant-facing capability', async () => {
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, ingressCidr: '10.9.9.9/32' });
    expect(await getIdeCapability({ role: 'user' })).not.toHaveProperty('ingressCidr');
  });

  it('isValidIngressCidr accepts real IPv4 CIDRs and the empty clear-value', () => {
    for (const ok of ['', '  ', '192.168.50.228/32', '10.0.0.0/8', '0.0.0.0/0', '172.16.4.1/26']) {
      expect(isValidIngressCidr(ok), ok).toBe(true);
    }
  });

  it('isValidIngressCidr rejects malformed values', () => {
    for (const bad of [
      '192.168.50.228', // no prefix
      '192.168.50.228/33', // prefix out of range
      '256.1.1.1/24', // octet out of range
      '192.168.1/24', // short
      'fe80::1/64', // v6 (the pinhole builder is IPv4)
      'not-a-cidr',
      '10.0.0.1/32; DROP TABLE', // junk suffix
    ]) {
      expect(isValidIngressCidr(bad), bad).toBe(false);
    }
  });
});

describe('ide.service policy + gating', () => {
  it('defaults to off, and nobody has access', async () => {
    const cfg = await getIdeConfig();
    expect(cfg.enabled).toBe('off');
    expect(cfg.allowByoKeys).toBe(false);
    expect(cfg.sharedModels).toEqual([]);
    expect(cfg.hasGatewayKey).toBe(false);
    expect((await getIdeCapability({ role: 'admin' })).available).toBe(false);
    expect((await getIdeCapability({ role: 'user' })).available).toBe(false);
  });

  it("admin tier: admins get it, tenants don't", async () => {
    await saveIdeConfig({ enabled: 'admin', allowByoKeys: true, sharedModels: [] });
    expect((await getIdeCapability({ role: 'admin' })).available).toBe(true);
    expect((await getIdeCapability({ role: 'user' })).available).toBe(false);
  });

  it('tenants tier: everyone gets it', async () => {
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, sharedModels: [] });
    expect((await getIdeCapability({ role: 'user' })).available).toBe(true);
    expect((await getIdeCapability({ role: 'admin' })).available).toBe(true);
  });

  it('round-trips shared models and masks the gateway secret', async () => {
    await saveIdeConfig({
      enabled: 'tenants',
      allowByoKeys: true,
      sharedModels: [{ id: 'llama', label: 'Llama 3.1', provider: 'ollama', model: 'llama3.1:8b' }],
      gatewayUrl: 'http://127.0.0.1:11434/v1',
      gatewayKey: 'secret-key',
    });
    const cfg = await getIdeConfig();
    expect(cfg.gatewayUrl).toBe('http://127.0.0.1:11434/v1');
    expect(cfg.hasGatewayKey).toBe(true);
    expect(cfg.sharedModels[0]).toMatchObject({ id: 'llama', provider: 'ollama', model: 'llama3.1:8b' });

    // The tenant-facing capability never leaks the endpoint or key.
    const cap = await getIdeCapability({ role: 'user' });
    expect(cap).not.toHaveProperty('gatewayUrl');
    expect(cap).not.toHaveProperty('hasGatewayKey');
    expect(cap.allowByoKeys).toBe(true);
    expect(cap.sharedModels).toHaveLength(1);
  });

  it('a blank gatewayKey keeps the previously stored secret', async () => {
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, sharedModels: [], gatewayKey: 'first' });
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, sharedModels: [] });
    expect((await getIdeConfig()).hasGatewayKey).toBe(true);
  });

  it('tolerates corrupt or non-array shared-models JSON', async () => {
    store.set('ide_enabled', 'tenants');
    store.set('ide_shared_models', 'not json at all');
    expect((await getIdeConfig()).sharedModels).toEqual([]);
    store.set('ide_shared_models', '{"not":"array"}');
    expect((await getIdeConfig()).sharedModels).toEqual([]);
  });

  it('applies per-model visibility to local models by role', async () => {
    await saveIdeConfig({
      enabled: 'tenants',
      allowByoKeys: false,
      localModels: [
        { model: 'gemma4:26b', sourceKeyId: 'k1', visibility: 'shared' },
        { nickname: 'Big', model: 'gpt-oss:120b', sourceKeyId: 'k1', visibility: 'admin' },
        { model: 'staged', sourceKeyId: 'k1', visibility: 'none' },
      ],
    });
    const labels = (c: { models: { label: string }[] }) => c.models.map((m) => m.label).sort();
    // tenant sees only the shared one
    expect(labels(await getIdeCapability({ role: 'user' }))).toEqual(['gemma4:26b']);
    // admin sees shared + admin-only (by nickname), never the 'none' one
    expect(labels(await getIdeCapability({ role: 'admin' }))).toEqual(['Big', 'gemma4:26b']);
  });

  it('round-trips local models with server-assigned ids', async () => {
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, localModels: [{ model: 'm', sourceKeyId: 's', visibility: 'shared' }] });
    const cfg = await getIdeConfig();
    expect(cfg.localModels).toHaveLength(1);
    expect(cfg.localModels[0]!.id).toBeTruthy(); // an id was assigned
    expect(cfg.localModels[0]).toMatchObject({ model: 'm', sourceKeyId: 's', visibility: 'shared' });
  });

  it('an unknown enabled tier falls back to off', async () => {
    store.set('ide_enabled', 'bogus');
    expect((await getIdeConfig()).enabled).toBe('off');
    expect((await getIdeCapability({ role: 'admin' })).available).toBe(false);
  });
});
