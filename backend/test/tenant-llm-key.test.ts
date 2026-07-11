import { describe, it, expect, beforeEach, vi } from 'vitest';

// encrypt is identity in tests so we can assert the stored keyEnc without a real key.
vi.mock('../src/lib/crypto.js', () => ({ encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    tenantLlmKey: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  listLlmKeys,
  addLlmKey,
  deleteLlmKey,
  getLlmKeyEndpoint,
  MAX_LLM_KEYS_PER_USER,
  TooManyLlmKeysError,
  InvalidLlmKeyError,
} from '../src/services/tenant-llm-key.service.js';

const count = vi.mocked(prisma.tenantLlmKey.count);
const create = vi.mocked(prisma.tenantLlmKey.create);
const findUnique = vi.mocked(prisma.tenantLlmKey.findUnique);
const findFirst = vi.mocked(prisma.tenantLlmKey.findFirst);
const del = vi.mocked(prisma.tenantLlmKey.delete);

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(0 as never);
  create.mockImplementation((async (args: { data: Record<string, unknown> }) => ({
    id: 'k1',
    label: args.data['label'],
    provider: args.data['provider'],
    model: args.data['model'],
    baseUrl: args.data['baseUrl'],
    createdAt: new Date(),
    lastUsedAt: null,
  })) as never);
});

describe('addLlmKey', () => {
  it('encrypts the secret and never returns it', async () => {
    const view = await addLlmKey('u1', { label: 'mine', provider: 'openai', model: 'gpt-4o', key: 'sk-123' });
    expect(view).not.toHaveProperty('keyEnc');
    expect(view).not.toHaveProperty('key');
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data['keyEnc']).toBe('enc(sk-123)'); // stored encrypted
    expect(arg.data['baseUrl']).toBeNull(); // openai uses its fixed endpoint
  });

  it('keeps a custom baseUrl for openai-compatible', async () => {
    await addLlmKey('u1', {
      label: 'router',
      provider: 'openai-compatible',
      model: 'x',
      baseUrl: 'https://openrouter.ai/api/v1',
      key: 'or-1',
    });
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data['baseUrl']).toBe('https://openrouter.ai/api/v1');
  });

  it('rejects an openai-compatible provider without a valid base URL', async () => {
    await expect(
      addLlmKey('u1', { label: 'x', provider: 'openai-compatible', model: 'm', key: 'k' }),
    ).rejects.toBeInstanceOf(InvalidLlmKeyError);
    await expect(
      addLlmKey('u1', { label: 'x', provider: 'openai-compatible', model: 'm', baseUrl: 'not-a-url', key: 'k' }),
    ).rejects.toBeInstanceOf(InvalidLlmKeyError);
  });

  it('rejects an unknown provider and missing fields', async () => {
    await expect(
      addLlmKey('u1', { label: 'x', provider: 'anthropic', model: 'm', key: 'k' }),
    ).rejects.toBeInstanceOf(InvalidLlmKeyError);
    await expect(
      addLlmKey('u1', { label: '', provider: 'openai', model: 'm', key: 'k' }),
    ).rejects.toBeInstanceOf(InvalidLlmKeyError);
  });

  it('enforces the per-user cap', async () => {
    count.mockResolvedValue(MAX_LLM_KEYS_PER_USER as never);
    await expect(
      addLlmKey('u1', { label: 'x', provider: 'openai', model: 'm', key: 'k' }),
    ).rejects.toBeInstanceOf(TooManyLlmKeysError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('tenant custom-base restriction (owner decision 2026-07-11)', () => {
  const custom = { label: 'x', provider: 'openai-compatible', model: 'm', key: 'k' };

  it('rejects a tenant free-form base URL (custom endpoints are admin-only)', async () => {
    await expect(
      addLlmKey('u1', { ...custom, baseUrl: 'https://my-vllm.example.com/v1' }),
    ).rejects.toThrow(/admin-only/);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts the fixed tenant presets, tolerant of case and trailing slashes', async () => {
    await addLlmKey('u1', { ...custom, baseUrl: 'https://OpenRouter.ai/api/v1/' });
    await addLlmKey('u1', { ...custom, baseUrl: 'https://api.groq.com/openai/v1' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('allows an admin (allowCustomBase) to save a free-form base URL', async () => {
    await addLlmKey('admin1', { ...custom, baseUrl: 'https://my-vllm.example.com/v1' }, { allowCustomBase: true, allowPrivate: true });
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data['baseUrl']).toBe('https://my-vllm.example.com/v1');
  });
});

describe('deleteLlmKey', () => {
  it('deletes only the caller-owned key', async () => {
    findUnique.mockResolvedValue({ id: 'k1', userId: 'u1' } as never);
    expect(await deleteLlmKey('u1', 'k1')).toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: 'k1' } });
  });

  it("refuses to delete another user's key", async () => {
    findUnique.mockResolvedValue({ id: 'k1', userId: 'someone-else' } as never);
    expect(await deleteLlmKey('u1', 'k1')).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it('returns false for a missing key', async () => {
    findUnique.mockResolvedValue(null as never);
    expect(await deleteLlmKey('u1', 'nope')).toBe(false);
  });
});

describe('getLlmKeyEndpoint', () => {
  it('resolves an owned openai-compatible key to its endpoint + decrypted secret', async () => {
    findFirst.mockResolvedValue({
      id: 'k1', userId: 'u1', provider: 'openai-compatible', baseUrl: 'https://h/v1', model: 'm', label: 'L', keyEnc: 'sk-x',
    } as never);
    expect(await getLlmKeyEndpoint('u1', 'k1')).toMatchObject({ baseUrl: 'https://h/v1', apiKey: 'sk-x', model: 'm', label: 'L' });
  });

  it('uses the fixed OpenAI base for an openai-preset key', async () => {
    findFirst.mockResolvedValue({ id: 'k1', userId: 'u1', provider: 'openai', baseUrl: null, model: 'gpt', label: 'L', keyEnc: 'sk' } as never);
    expect((await getLlmKeyEndpoint('u1', 'k1'))?.baseUrl).toBe('https://api.openai.com/v1');
  });

  it("returns null when the key isn't the caller's", async () => {
    findFirst.mockResolvedValue(null as never);
    expect(await getLlmKeyEndpoint('u1', 'nope')).toBeNull();
  });
});

describe('listLlmKeys', () => {
  it('selects only the safe view (no keyEnc)', async () => {
    vi.mocked(prisma.tenantLlmKey.findMany).mockResolvedValue([] as never);
    await listLlmKeys('u1');
    const arg = vi.mocked(prisma.tenantLlmKey.findMany).mock.calls[0]![0] as { select: Record<string, boolean> };
    expect(arg.select).not.toHaveProperty('keyEnc');
    expect(arg.select).toMatchObject({ id: true, label: true, provider: true, model: true, baseUrl: true });
  });
});
