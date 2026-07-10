import { randomUUID } from 'node:crypto';
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

/** Who may pick a local model: admins only, all tenants, or nobody (staged/off). */
export type ModelVisibility = 'admin' | 'shared' | 'none';

/**
 * A local model the admin exposes through the gateway, sourced from one of the
 * admin's OWN saved endpoints (a `TenantLlmKey` on the admin account — the same
 * "AI keys" they manage on the Security page). The tenant never sees the source
 * endpoint/key; the gateway resolves `sourceKeyId` at request time.
 */
export interface LocalModel {
  /** Internal stable id for routing (`local:<id>`) — not shown to the admin. */
  id: string;
  /** Optional admin nickname; falls back to the model name for display. */
  nickname?: string;
  /** The real upstream model name (chosen from the source endpoint's model list). */
  model: string;
  /** The admin `TenantLlmKey` id this model is served from. */
  sourceKeyId: string;
  /** admin-only / shared-with-tenants / none. */
  visibility: ModelVisibility;
}

/** A model entry for the picker — namespaced id + display label, no secrets. */
export interface PickerModel {
  id: string;
  label: string;
}

export interface IdeConfig {
  enabled: IdeTier;
  allowByoKeys: boolean;
  /** Local models sourced from the admin's saved endpoints (the new model). */
  localModels: LocalModel[];
  /** Legacy shared models (gateway-sourced) — kept for back-compat. */
  sharedModels: SharedModel[];
  /** Legacy admin local-model endpoint base URL — never returned to tenants. */
  gatewayUrl: string;
  /** Whether a legacy upstream gateway key is stored (the secret is never returned). */
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

const VISIBILITIES: readonly ModelVisibility[] = ['admin', 'shared', 'none'];

/** Tolerant parse of the stored local-models JSON; bad/legacy data → []. */
function parseLocalModels(v: string | null): LocalModel[] {
  if (!v) return [];
  try {
    const arr: unknown = JSON.parse(v);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (m): m is Record<string, unknown> =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as { model?: unknown }).model === 'string' &&
          typeof (m as { sourceKeyId?: unknown }).sourceKeyId === 'string',
      )
      .map((m) => {
        const nickname = typeof m['nickname'] === 'string' ? m['nickname'].trim() : '';
        const vis = m['visibility'];
        return {
          id: typeof m['id'] === 'string' && m['id'] ? String(m['id']) : randomUUID(),
          ...(nickname ? { nickname } : {}),
          model: String(m['model']),
          sourceKeyId: String(m['sourceKeyId']),
          visibility: (VISIBILITIES as readonly string[]).includes(String(vis)) ? (vis as ModelVisibility) : 'none',
        };
      });
  } catch {
    return [];
  }
}

/** Full IDE policy for the admin settings view (upstream secret masked to a boolean). */
export async function getIdeConfig(): Promise<IdeConfig> {
  const [enabled, byo, local, models, gatewayUrl, gatewayKey] = await Promise.all([
    getConfig('ide_enabled'),
    getConfig('ide_allow_byo_keys'),
    getConfig('ide_local_models'),
    getConfig('ide_shared_models'),
    getConfig('ide_gateway_url'),
    getConfig('ide_gateway_key'),
  ]);
  return {
    enabled: parseTier(enabled),
    allowByoKeys: byo === 'true',
    localModels: parseLocalModels(local),
    sharedModels: parseSharedModels(models),
    gatewayUrl: gatewayUrl ?? '',
    hasGatewayKey: !!gatewayKey,
  };
}

/** A local model as it arrives from the admin form (id assigned on save). */
export type LocalModelInput = Omit<LocalModel, 'id'> & { id?: string };

/** Persist IDE policy. Local models are stored verbatim (each gets a stable id). */
export async function saveIdeConfig(data: {
  enabled: IdeTier;
  allowByoKeys: boolean;
  localModels?: LocalModelInput[];
  sharedModels?: SharedModel[];
  gatewayUrl?: string;
  gatewayKey?: string; // blank = keep existing
}): Promise<void> {
  await setConfig('ide_enabled', data.enabled);
  await setConfig('ide_allow_byo_keys', String(data.allowByoKeys));
  if (data.localModels !== undefined) {
    const withIds = data.localModels.map((m) => ({ ...m, id: m.id || randomUUID() }));
    await setConfig('ide_local_models', JSON.stringify(withIds));
  }
  if (data.sharedModels !== undefined) {
    await setConfig('ide_shared_models', JSON.stringify(data.sharedModels));
  }
  if (data.gatewayUrl !== undefined) {
    await setConfig('ide_gateway_url', data.gatewayUrl.trim());
  }
  if (data.gatewayKey && data.gatewayKey.trim().length > 0) {
    await setConfig('ide_gateway_key', data.gatewayKey.trim(), true);
  }
}

/** What a given user may do with the IDE — no secrets, safe to hand the client. */
export interface IdeCapability {
  available: boolean;
  allowByoKeys: boolean;
  /** Namespaced, visibility-filtered picker models (legacy `shared:*` + new `local:*`). */
  models: PickerModel[];
  /** Legacy shared models (kept for back-compat; unused by the current client). */
  sharedModels: SharedModel[];
}

/**
 * Resolve a user's IDE availability + the models they may pick, applying each
 * local model's visibility (admins get `admin`+`shared`, tenants only `shared`,
 * `none` is hidden from everyone). Legacy gateway-sourced shared models remain
 * visible to all as `shared:*`.
 */
export async function getIdeCapability(user: { role: string }): Promise<IdeCapability> {
  const cfg = await getIdeConfig();
  const available = cfg.enabled === 'tenants' ? true : cfg.enabled === 'admin' ? user.role === 'admin' : false;
  if (!available) return { available: false, allowByoKeys: false, models: [], sharedModels: [] };

  const isAdmin = user.role === 'admin';
  const models: PickerModel[] = cfg.sharedModels.map((m) => ({ id: `shared:${m.id}`, label: m.label }));
  for (const lm of cfg.localModels) {
    const visible = lm.visibility === 'shared' || (lm.visibility === 'admin' && isAdmin);
    if (visible) models.push({ id: `local:${lm.id}`, label: lm.nickname || lm.model });
  }
  return { available: true, allowByoKeys: cfg.allowByoKeys, models, sharedModels: cfg.sharedModels };
}
