import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { assertPublicHttpUrlShape } from '../lib/url-safety.js';

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

// The openai-compatible bases TENANTS may use — the fixed, well-known preset
// services the UI offers (OpenRouter, Groq). A free-form "custom" base URL is
// admin-only (owner decision 2026-07-11): tenants must not point the gateway at
// arbitrary endpoints. Keep in sync with the PRESETS list in
// frontend/src/components/ide/ai-keys-card.tsx.
export const TENANT_ALLOWED_COMPAT_BASES = [
  'https://openrouter.ai/api/v1',
  'https://api.groq.com/openai/v1',
] as const;

/** Normalize a base URL for allow-list comparison: lowercase, no trailing slashes. */
function normalizeBase(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

const TENANT_ALLOWED_NORMALIZED = new Set(TENANT_ALLOWED_COMPAT_BASES.map(normalizeBase));

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

/**
 * Save a new BYO key for a user (secret encrypted at rest). Returns the safe view.
 * `allowPrivate` exempts the SSRF host-shape check — set it for ADMINS, who
 * legitimately point shared-model sources at a LAN endpoint (e.g. a local Ollama).
 * `allowCustomBase` (also admin-only) permits openai-compatible base URLs beyond
 * the fixed tenant presets in {@link TENANT_ALLOWED_COMPAT_BASES}.
 */
export async function addLlmKey(
  userId: string,
  input: AddLlmKeyInput,
  opts: { allowPrivate?: boolean; allowCustomBase?: boolean } = {},
): Promise<LlmKeyView> {
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
  // Tenants may only use the fixed preset services; a free-form base URL is
  // admin-only (arbitrary endpoints are the risky surface — the gateway would
  // forward chats and the key wherever this points).
  if (provider !== 'openai' && baseUrl && !opts.allowCustomBase && !TENANT_ALLOWED_NORMALIZED.has(normalizeBase(baseUrl))) {
    throw new InvalidLlmKeyError(
      'Custom AI endpoints are admin-only — pick one of the offered providers, or ask your admin to share the model instead.',
    );
  }
  // SSRF guard: a tenant's own key must reach only the public internet, never the
  // ProxMate host's internal network / metadata endpoint. Admins are exempt (they
  // configure LAN model sources), as is the ALLOW_PRIVATE_OUTBOUND_URLS escape hatch.
  if (provider !== 'openai' && baseUrl && !opts.allowPrivate) {
    try {
      assertPublicHttpUrlShape(baseUrl, 'base URL');
    } catch (e) {
      throw new InvalidLlmKeyError((e as Error).message);
    }
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

/**
 * Resolve a key to its endpoint WITHOUT owner scoping — used only by the gateway
 * to serve an admin-configured local model to a tenant (the caller has already
 * checked the model's visibility). The secret is decrypted in-memory to forward.
 */
export async function getLlmKeyEndpointById(
  id: string,
): Promise<{ baseUrl: string; apiKey: string } | null> {
  const row = await prisma.tenantLlmKey.findUnique({ where: { id } });
  if (!row) return null;
  const baseUrl = row.provider === 'openai' ? 'https://api.openai.com/v1' : (row.baseUrl ?? '');
  if (!baseUrl) return null;
  return { baseUrl, apiKey: decrypt(row.keyEnc) };
}

/** Delete a key, but only if it belongs to the requesting user (else false → 404). */
export async function deleteLlmKey(userId: string, id: string): Promise<boolean> {
  const row = await prisma.tenantLlmKey.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return false;
  await prisma.tenantLlmKey.delete({ where: { id } });
  return true;
}
