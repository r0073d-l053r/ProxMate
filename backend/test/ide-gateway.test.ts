import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// In-memory SystemConfig so the REAL ide.service policy (allow-list, BYO gate)
// runs unmodified while we exercise the gateway logic layered on top of it.
const store = new Map<string, string>();
vi.mock('../src/services/config.service.js', () => ({
  getConfig: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
  setConfig: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
}));

// Ownership is resolved elsewhere; here we drive it directly per-test.
vi.mock('../src/services/vm.service.js', () => ({ getVmWithCap: vi.fn() }));

// Decrypt is identity in tests so a stored BYO key round-trips to itself.
vi.mock('../src/lib/crypto.js', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    ideGatewayToken: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    tenantLlmKey: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import { getVmWithCap } from '../src/services/vm.service.js';
import { saveIdeConfig } from '../src/services/ide.service.js';
import {
  issueGatewayToken,
  verifyGatewayToken,
  listGatewayModels,
  listModelPickerEntries,
  resolveModelRoute,
  probeModels,
} from '../src/services/ide-gateway.service.js';

const ownedVm = vi.mocked(getVmWithCap);
const tokenFindUnique = vi.mocked(prisma.ideGatewayToken.findUnique);
const tokenUpsert = vi.mocked(prisma.ideGatewayToken.upsert);
const keyFindFirst = vi.mocked(prisma.tenantLlmKey.findFirst);
const keyFindMany = vi.mocked(prisma.tenantLlmKey.findMany);
const userFindUnique = vi.mocked(prisma.user.findUnique);

const USER = { id: 'u1', role: 'user' };
const SHARED = { id: 'llama', label: 'Llama 3.1', provider: 'ollama', model: 'llama3.1:8b' };

/** Policy: IDE on for tenants, one shared model, a gateway endpoint + key. */
async function setupSharedPolicy(opts: { byo?: boolean } = {}): Promise<void> {
  await saveIdeConfig({
    enabled: 'tenants',
    allowByoKeys: opts.byo ?? false,
    sharedModels: [SHARED],
    gatewayUrl: 'http://127.0.0.1:11434/v1',
    gatewayKey: 'admin-upstream-key',
  });
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  // sensible defaults; individual tests override
  ownedVm.mockResolvedValue({ id: 'vm1', userId: 'u1' } as never);
  userFindUnique.mockResolvedValue({ id: 'u1', role: 'user' } as never);
  keyFindMany.mockResolvedValue([] as never);
});

describe('resolveModelRoute — allow-list enforcement (shared)', () => {
  it('resolves a shared model to the admin gateway + upstream model name', async () => {
    await setupSharedPolicy();
    const route = await resolveModelRoute(USER, 'shared:llama');
    expect(route).not.toBeNull();
    expect(route).toMatchObject({
      url: 'http://127.0.0.1:11434/v1',
      apiKey: 'admin-upstream-key',
      model: 'llama3.1:8b', // the REAL model — tenant only ever sends "shared:llama"
      kind: 'shared',
    });
  });

  it('accepts a bare id that matches a shared model', async () => {
    await setupSharedPolicy();
    expect(await resolveModelRoute(USER, 'llama')).toMatchObject({ model: 'llama3.1:8b', kind: 'shared' });
  });

  it('rejects a model that is not on the allow-list', async () => {
    await setupSharedPolicy();
    expect(await resolveModelRoute(USER, 'shared:gpt-4o')).toBeNull();
    expect(await resolveModelRoute(USER, 'shared:nope')).toBeNull();
  });

  it('rejects when the IDE is off for the user', async () => {
    await saveIdeConfig({ enabled: 'off', allowByoKeys: false, sharedModels: [SHARED] });
    expect(await resolveModelRoute(USER, 'shared:llama')).toBeNull();
  });

  it('rejects a shared model when no gateway endpoint is configured', async () => {
    await saveIdeConfig({ enabled: 'tenants', allowByoKeys: false, sharedModels: [SHARED], gatewayUrl: '' });
    expect(await resolveModelRoute(USER, 'shared:llama')).toBeNull();
  });
});

describe('resolveModelRoute — local models (admin-sourced, visibility-gated)', () => {
  const keyUnique = () => vi.mocked(prisma.tenantLlmKey.findUnique);

  beforeEach(() => {
    store.set('ide_enabled', 'tenants');
    keyUnique().mockResolvedValue({
      id: 'srck',
      provider: 'openai-compatible',
      baseUrl: 'http://ollama:11434/v1',
      keyEnc: 'admin-key',
    } as never);
  });

  it('routes a shared local model to its admin source key', async () => {
    store.set('ide_local_models', JSON.stringify([{ id: 'lm1', model: 'gemma4:26b', sourceKeyId: 'srck', visibility: 'shared' }]));
    const route = await resolveModelRoute(USER, 'local:lm1');
    expect(route).toMatchObject({ url: 'http://ollama:11434/v1', apiKey: 'admin-key', model: 'gemma4:26b', kind: 'shared' });
  });

  it('hides an admin-only local model from tenants but serves admins', async () => {
    store.set('ide_local_models', JSON.stringify([{ id: 'lm2', model: 'gpt-oss:120b', sourceKeyId: 'srck', visibility: 'admin' }]));
    expect(await resolveModelRoute(USER, 'local:lm2')).toBeNull();
    expect(await resolveModelRoute({ id: 'a', role: 'admin' }, 'local:lm2')).not.toBeNull();
  });

  it("never serves a 'none' local model", async () => {
    store.set('ide_local_models', JSON.stringify([{ id: 'lm3', model: 'x', sourceKeyId: 'srck', visibility: 'none' }]));
    expect(await resolveModelRoute({ id: 'a', role: 'admin' }, 'local:lm3')).toBeNull();
  });

  it('returns null for an unknown local id', async () => {
    store.set('ide_local_models', JSON.stringify([]));
    expect(await resolveModelRoute(USER, 'local:nope')).toBeNull();
  });
});

describe('resolveModelRoute — BYO gating', () => {
  it('rejects byo:* when the admin has BYO disabled', async () => {
    await setupSharedPolicy({ byo: false });
    keyFindFirst.mockResolvedValue({ id: 'k1', userId: 'u1', provider: 'openai', model: 'gpt-4o', keyEnc: 'sk-x' } as never);
    expect(await resolveModelRoute(USER, 'byo:k1')).toBeNull();
  });

  it('routes byo:* to the provider with the tenant-decrypted key when BYO is on', async () => {
    await setupSharedPolicy({ byo: true });
    keyFindFirst.mockResolvedValue({
      id: 'k1',
      userId: 'u1',
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: null,
      keyEnc: 'sk-tenant-123',
    } as never);
    const route = await resolveModelRoute(USER, 'byo:k1');
    expect(route).toMatchObject({
      url: 'https://api.openai.com/v1',
      apiKey: 'sk-tenant-123',
      model: 'gpt-4o',
      kind: 'byo',
    });
  });

  it('honors a custom baseUrl for an openai-compatible BYO key', async () => {
    await setupSharedPolicy({ byo: true });
    keyFindFirst.mockResolvedValue({
      id: 'k2',
      userId: 'u1',
      provider: 'openai-compatible',
      model: 'mixtral',
      baseUrl: 'https://openrouter.ai/api/v1/',
      keyEnc: 'or-key',
    } as never);
    expect(await resolveModelRoute(USER, 'byo:k2')).toMatchObject({
      url: 'https://openrouter.ai/api/v1', // trailing slash normalized off
      apiKey: 'or-key',
      kind: 'byo',
    });
  });

  it("rejects a BYO id that isn't the caller's", async () => {
    await setupSharedPolicy({ byo: true });
    keyFindFirst.mockResolvedValue(null as never); // scoped query found nothing for this user
    expect(await resolveModelRoute(USER, 'byo:someone-else')).toBeNull();
  });
});

describe('listGatewayModels / listModelPickerEntries', () => {
  it('lists shared models only when BYO is off', async () => {
    await setupSharedPolicy({ byo: false });
    const models = await listGatewayModels(USER);
    expect(models.map((m) => m.id)).toEqual(['shared:llama']);
  });

  it('adds byo:* entries when BYO is on', async () => {
    await setupSharedPolicy({ byo: true });
    keyFindMany.mockResolvedValue([{ id: 'k1', label: 'my openai' }] as never);
    const models = await listGatewayModels(USER);
    expect(models.map((m) => m.id).sort()).toEqual(['byo:k1', 'shared:llama']);
    const entries = await listModelPickerEntries(USER);
    expect(entries).toContainEqual({ id: 'shared:llama', name: 'Llama 3.1' });
    expect(entries).toContainEqual({ id: 'byo:k1', name: 'my openai' });
  });

  it('returns nothing when the IDE is unavailable', async () => {
    await saveIdeConfig({ enabled: 'off', allowByoKeys: true, sharedModels: [SHARED] });
    expect(await listGatewayModels(USER)).toEqual([]);
  });
});

describe('issueGatewayToken', () => {
  it('mints a pmide_ token + a vm-scoped baseUrl for an owned VM', async () => {
    await setupSharedPolicy();
    const issued = await issueGatewayToken(USER, 'vm1', 'https://proxmate.example.com/');
    expect(issued).not.toBeNull();
    expect(issued?.token.startsWith('pmide_')).toBe(true);
    expect(issued?.baseUrl).toBe('https://proxmate.example.com/api/ide/vm1/llm/v1');
    expect(tokenUpsert).toHaveBeenCalledOnce();
  });

  it('refuses when the user does not own the VM', async () => {
    await setupSharedPolicy();
    ownedVm.mockResolvedValue(null as never);
    expect(await issueGatewayToken(USER, 'vm1', 'https://x')).toBeNull();
    expect(tokenUpsert).not.toHaveBeenCalled();
  });

  it('refuses when the IDE is off', async () => {
    await saveIdeConfig({ enabled: 'off', allowByoKeys: false, sharedModels: [] });
    expect(await issueGatewayToken(USER, 'vm1', 'https://x')).toBeNull();
  });
});

describe('probeModels (connection test)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the endpoint models (sorted) on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'm2' }, { id: 'm1' }] }) }));
    const r = await probeModels('http://ollama:11434/v1/', 'k');
    expect(r).toEqual({ ok: true, models: ['m1', 'm2'] });
  });

  it('reports a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const r = await probeModels('http://x/v1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
  });

  it('reports an unreachable endpoint without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await probeModels('http://x/v1');
    expect(r).toMatchObject({ ok: false, models: [] });
  });
});

describe('verifyGatewayToken', () => {
  const row = {
    id: 't1',
    userId: 'u1',
    vmId: 'vm1',
    tokenHash: 'hash',
    revokedAt: null as Date | null,
    expiresAt: null as Date | null,
  };

  beforeEach(async () => {
    await setupSharedPolicy();
  });

  it('rejects a malformed / non-prefixed token without a DB hit', async () => {
    expect(await verifyGatewayToken('not-a-token', 'vm1')).toBeNull();
    expect(await verifyGatewayToken(undefined, 'vm1')).toBeNull();
    expect(tokenFindUnique).not.toHaveBeenCalled();
  });

  it('accepts a valid token bound to its VM and re-checks ownership + policy', async () => {
    tokenFindUnique.mockResolvedValue({ ...row } as never);
    const ctx = await verifyGatewayToken('pmide_abc', 'vm1');
    expect(ctx).toMatchObject({ user: { id: 'u1', role: 'user' }, vmId: 'vm1' });
  });

  it('rejects when the token is for a different VM than the path', async () => {
    tokenFindUnique.mockResolvedValue({ ...row, vmId: 'other' } as never);
    expect(await verifyGatewayToken('pmide_abc', 'vm1')).toBeNull();
  });

  it('rejects a revoked token', async () => {
    tokenFindUnique.mockResolvedValue({ ...row, revokedAt: new Date() } as never);
    expect(await verifyGatewayToken('pmide_abc', 'vm1')).toBeNull();
  });

  it('rejects an expired token', async () => {
    tokenFindUnique.mockResolvedValue({ ...row, expiresAt: new Date(Date.now() - 1000) } as never);
    expect(await verifyGatewayToken('pmide_abc', 'vm1')).toBeNull();
  });

  it('rejects an unknown token', async () => {
    tokenFindUnique.mockResolvedValue(null as never);
    expect(await verifyGatewayToken('pmide_abc', 'vm1')).toBeNull();
  });

  it('rejects when the user has since lost access to the VM', async () => {
    tokenFindUnique.mockResolvedValue({ ...row } as never);
    ownedVm.mockResolvedValue(null as never);
    expect(await verifyGatewayToken('pmide_abc', 'vm1')).toBeNull();
  });

  it('rejects when the admin has since turned the IDE off', async () => {
    tokenFindUnique.mockResolvedValue({ ...row } as never);
    await saveIdeConfig({ enabled: 'off', allowByoKeys: false, sharedModels: [] });
    expect(await verifyGatewayToken('pmide_abc', 'vm1')).toBeNull();
  });
});
