import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory SystemConfig so we exercise the real ide.service logic without prisma.
const store = new Map<string, string>();
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
  setConfig: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
}));

import { getIdeConfig, saveIdeConfig, getIdeCapability } from '../src/services/ide.service.js';

beforeEach(() => store.clear());

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

  it('an unknown enabled tier falls back to off', async () => {
    store.set('ide_enabled', 'bogus');
    expect((await getIdeConfig()).enabled).toBe('off');
    expect((await getIdeCapability({ role: 'admin' })).available).toBe(false);
  });
});
