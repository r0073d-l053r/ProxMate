import { getConfig, setConfig } from './config.service.js';

/**
 * ProxMate IDE — an in-guest code-server (with OpenCode baked in) that ProxMate
 * reverse-proxies, letting a tenant edit/build inside their own VM with an AI
 * assistant. This module owns the ADMIN POLICY for that feature (the transport +
 * provisioning live in later phases). Everything here is config-only, so it's
 * unit-testable without a live cluster.
 *
 * Availability tiers:
 *   - 'off'     : disabled for everyone
 *   - 'admin'   : admins only (the admin can keep the IDE to themselves)
 *   - 'tenants' : admins + tenants
 *
 * Model access is two independent switches:
 *   - allowByoKeys : tenants may plug in their OWN LLM API keys
 *   - sharedModels : models the admin exposes via the ProxMate LLM gateway
 *                    (tenants use them WITHOUT ever seeing the upstream endpoint
 *                    or credentials — see `ide_gateway_url` / `ide_gateway_key`).
 */

export type IdeTier = 'off' | 'admin' | 'tenants';

export interface SharedModel {
  /** Stable id the gateway routes on (opaque to tenants). */
  id: string;
  /** Human label shown in the IDE model picker. */
  label: string;
  /** Upstream kind, e.g. 'openai-compatible' | 'ollama'. */
  provider: string;
  /** Upstream model name passed to the provider. */
  model: string;
}

export interface IdeConfig {
  enabled: IdeTier;
  allowByoKeys: boolean;
  sharedModels: SharedModel[];
  /** Admin's local-model endpoint base URL — never returned to tenants. */
  gatewayUrl: string;
  /** Whether an upstream gateway key is stored (the secret itself is never returned). */
  hasGatewayKey: boolean;
}

const TIERS: readonly IdeTier[] = ['off', 'admin', 'tenants'];

function parseTier(v: string | null): IdeTier {
  return v && (TIERS as readonly string[]).includes(v) ? (v as IdeTier) : 'off';
}

/** Tolerant parse of the stored shared-models JSON; bad/legacy data → []. */
function parseSharedModels(v: string | null): SharedModel[] {
  if (!v) return [];
  try {
    const arr: unknown = JSON.parse(v);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string')
      .map((m) => ({
        id: String(m['id']),
        label: String(m['label'] ?? m['id']),
        provider: String(m['provider'] ?? 'openai-compatible'),
        model: String(m['model'] ?? m['id']),
      }));
  } catch {
    return [];
  }
}

/** Full IDE policy for the admin settings view (upstream secret masked to a boolean). */
export async function getIdeConfig(): Promise<IdeConfig> {
  const [enabled, byo, models, gatewayUrl, gatewayKey] = await Promise.all([
    getConfig('ide_enabled'),
    getConfig('ide_allow_byo_keys'),
    getConfig('ide_shared_models'),
    getConfig('ide_gateway_url'),
    getConfig('ide_gateway_key'),
  ]);
  return {
    enabled: parseTier(enabled),
    allowByoKeys: byo === 'true',
    sharedModels: parseSharedModels(models),
    gatewayUrl: gatewayUrl ?? '',
    hasGatewayKey: !!gatewayKey,
  };
}

/** Persist IDE policy. The gateway key is stored encrypted and only replaced when supplied. */
export async function saveIdeConfig(data: {
  enabled: IdeTier;
  allowByoKeys: boolean;
  sharedModels: SharedModel[];
  gatewayUrl?: string;
  gatewayKey?: string; // blank = keep existing
}): Promise<void> {
  await setConfig('ide_enabled', data.enabled);
  await setConfig('ide_allow_byo_keys', String(data.allowByoKeys));
  await setConfig('ide_shared_models', JSON.stringify(data.sharedModels ?? []));
  await setConfig('ide_gateway_url', (data.gatewayUrl ?? '').trim());
  if (data.gatewayKey && data.gatewayKey.trim().length > 0) {
    await setConfig('ide_gateway_key', data.gatewayKey.trim(), true);
  }
}

/** What a given user may do with the IDE — no secrets, safe to hand the client. */
export interface IdeCapability {
  available: boolean;
  allowByoKeys: boolean;
  sharedModels: SharedModel[];
}

/** Resolve a user's IDE availability + permitted model sources from the admin policy. */
export async function getIdeCapability(user: { role: string }): Promise<IdeCapability> {
  const cfg = await getIdeConfig();
  const available = cfg.enabled === 'tenants' ? true : cfg.enabled === 'admin' ? user.role === 'admin' : false;
  if (!available) return { available: false, allowByoKeys: false, sharedModels: [] };
  return { available: true, allowByoKeys: cfg.allowByoKeys, sharedModels: cfg.sharedModels };
}
