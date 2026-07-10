import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../lib/crypto.js';

/**
 * Tenant bring-your-own LLM keys. Used ONLY through the ProxMate gateway (single
 * controlled egress + audit) — see ide-gateway.service.ts. The provider API key is
 * AES-256-GCM encrypted at rest (keyEnc) and never returned to any client; this
 * module only ever hands back the safe view (label/provider/model/baseUrl), the
 * secret stays server-side and is decrypted in-memory only to forward a request.
 */

// Cap per user — unbounded rows are a cheap DB-bloat vector on a multi-tenant box.
export const MAX_LLM_KEYS_PER_USER = 20;

// Providers we can route. 'openai' has a fixed base; 'openai-compatible' (OpenRouter,
// Groq, vLLM, LM Studio, …) needs an explicit base URL. Anthropic isn't OpenAI-wire
// compatible, so it's intentionally not offered here.
export const KNOWN_PROVIDERS = ['openai', 'openai-compatible'] as const;
export type LlmProvider = (typeof KNOWN_PROVIDERS)[number];

export interface LlmKeyView {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const SAFE_SELECT = {
  id: true,
  label: true,
  provider: true,
  model: true,
  baseUrl: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

export class TooManyLlmKeysError extends Error {
  constructor() {
    super(`You can save at most ${MAX_LLM_KEYS_PER_USER} AI keys. Remove one first.`);
    this.name = 'TooManyLlmKeysError';
  }
}

export class InvalidLlmKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLlmKeyError';
  }
}

/** A user's saved BYO keys, newest first — never includes the secret. */
export async function listLlmKeys(userId: string): Promise<LlmKeyView[]> {
  return prisma.tenantLlmKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: SAFE_SELECT });
}

export interface AddLlmKeyInput {
  label: string;
  provider: string;
  model: string;
  baseUrl?: string;
  key: string;
}

/** Save a new BYO key for a user (secret encrypted at rest). Returns the safe view. */
export async function addLlmKey(userId: string, input: AddLlmKeyInput): Promise<LlmKeyView> {
  const label = input.label?.trim();
  const provider = input.provider?.trim();
  const model = input.model?.trim();
  const baseUrl = input.baseUrl?.trim() || null;
  const key = input.key?.trim();

  if (!label || !model || !key) throw new InvalidLlmKeyError('label, model, and key are required');
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    throw new InvalidLlmKeyError('unknown provider');
  }
  // 'openai' uses its fixed endpoint; everything else must supply an http(s) base URL.
  if (provider !== 'openai' && (!baseUrl || !/^https?:\/\//i.test(baseUrl))) {
    throw new InvalidLlmKeyError('a valid http(s) base URL is required for an openai-compatible provider');
  }

  const count = await prisma.tenantLlmKey.count({ where: { userId } });
  if (count >= MAX_LLM_KEYS_PER_USER) throw new TooManyLlmKeysError();

  return prisma.tenantLlmKey.create({
    data: { userId, label, provider, model, baseUrl: provider === 'openai' ? null : baseUrl, keyEnc: encrypt(key) },
    select: SAFE_SELECT,
  });
}

/**
 * Resolve a user-owned key to its concrete upstream endpoint + decrypted secret,
 * for a connection test or (admin) sourcing shared models. Returns null if the key
 * isn't the user's or has no usable base URL. The plaintext key never leaves the
 * server — callers use it only to probe/forward.
 */
export async function getLlmKeyEndpoint(
  userId: string,
  id: string,
): Promise<{ baseUrl: string; apiKey: string; model: string; label: string } | null> {
  const row = await prisma.tenantLlmKey.findFirst({ where: { id, userId } });
  if (!row) return null;
  const baseUrl = row.provider === 'openai' ? 'https://api.openai.com/v1' : (row.baseUrl ?? '');
  if (!baseUrl) return null;
  return { baseUrl, apiKey: decrypt(row.keyEnc), model: row.model, label: row.label };
}

/** Delete a key, but only if it belongs to the requesting user (else false → 404). */
export async function deleteLlmKey(userId: string, id: string): Promise<boolean> {
  const row = await prisma.tenantLlmKey.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return false;
  await prisma.tenantLlmKey.delete({ where: { id } });
  return true;
}
