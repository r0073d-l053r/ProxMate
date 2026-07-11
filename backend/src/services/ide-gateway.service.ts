import { randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../lib/crypto.js';
import { getConfig } from './config.service.js';
import { getOwnedVm } from './vm.service.js';
import { getIdeCapability, getIdeConfig } from './ide.service.js';
import { getLlmKeyEndpointById } from './tenant-llm-key.service.js';
import { assertPublicHttpUrl } from '../lib/ssrf.js';

/**
 * ProxMate LLM gateway (Phase 4) — the policy + routing brain behind the
 * OpenAI-compatible endpoint the in-guest AI agent (OpenCode) talks to.
 *
 * Why it exists: OpenCode runs INSIDE the tenant's VM and has no ProxMate session
 * cookie, and we never want the tenant to see the admin's local-model endpoint or
 * any upstream key. So OpenCode points at `…/api/ide/:id/llm/v1` bearing a per-VM
 * gateway token; the gateway resolves that token to (user, vm), re-checks live
 * ownership + the admin IDE policy, enforces the shared-model allow-list, and
 * forwards to the real upstream — the single controlled egress for all IDE LLM
 * traffic (shared local models AND tenant bring-your-own keys).
 *
 * This module is transport-free (no req/res) so it stays unit-testable without a
 * network: the route layer does the actual fetch/stream using `resolveModelRoute`.
 *
 * Model-id namespaces (opaque ids the tenant's picker sends back verbatim):
 *   shared:<SharedModel.id>  → admin gateway  (`ide_gateway_url` + `ide_gateway_key`)
 *   byo:<TenantLlmKey.id>    → the tenant's own provider key (decrypted in-memory)
 * A bare id that matches a shared model's id is also accepted (curl / convenience).
 */

const PREFIX = 'pmide_';
const DISPLAY_PREFIX_LEN = 12; // 'pmide_' + 6 chars
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Strip a trailing slash so we can append `/chat/completions` cleanly. */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// ─── Per-VM gateway token ─────────────────────────────────────

export interface IssuedGatewayToken {
  /** The raw secret — shown to the caller exactly once, then only its hash is kept. */
  token: string;
  /** The OpenAI-compatible base URL OpenCode should point at (includes the vm id). */
  baseUrl: string;
}

/**
 * Mint (or rotate) the per-VM gateway token for a user+VM. Returns the raw token
 * once. Re-provisioning a VM's IDE calls this again and rotates the secret
 * (the `@@unique([userId, vmId])` row is upserted). Returns null if the user may
 * not use the IDE on this VM (ownership or admin policy).
 */
export async function issueGatewayToken(
  user: { id: string; role: string },
  vmId: string,
  publicApiBaseUrl: string,
): Promise<IssuedGatewayToken | null> {
  const vm = await getOwnedVm(vmId, user);
  if (!vm) return null;
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) return null;

  const raw = PREFIX + randomBytes(24).toString('base64url');
  const data = {
    tokenHash: sha256(raw),
    prefix: raw.slice(0, DISPLAY_PREFIX_LEN),
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
  };
  await prisma.ideGatewayToken.upsert({
    where: { userId_vmId: { userId: user.id, vmId } },
    update: data,
    create: { userId: user.id, vmId, ...data },
  });

  const baseUrl = `${normalizeBase(publicApiBaseUrl)}/api/ide/${vmId}/llm/v1`;
  return { token: raw, baseUrl };
}

/** Revoke the gateway token for a user+VM (e.g. IDE turned off, share removed). */
export async function revokeGatewayToken(userId: string, vmId: string): Promise<void> {
  await prisma.ideGatewayToken
    .updateMany({ where: { userId, vmId, revokedAt: null }, data: { revokedAt: new Date() } })
    .catch(() => {});
}

export interface GatewayContext {
  user: { id: string; role: string };
  vmId: string;
}

/**
 * Resolve a raw gateway token that must be bound to `pathVmId`, re-checking every
 * gate live (ownership + admin policy can change after a token is minted). Returns
 * null on any failure — unknown/revoked/expired token, VM mismatch, lost access.
 */
export async function verifyGatewayToken(raw: string | undefined, pathVmId: string): Promise<GatewayContext | null> {
  if (!raw || !raw.startsWith(PREFIX)) return null;
  const row = await prisma.ideGatewayToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!row) return null;
  if (row.vmId !== pathVmId) return null; // token is scoped to exactly one VM
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, role: true } });
  if (!user) return null;

  // Live re-authorization: the mint-time checks are not enough on their own.
  const vm = await getOwnedVm(row.vmId, user);
  if (!vm) return null;
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) return null;

  // Best-effort last-used stamp; never block or throw the request on it.
  void prisma.ideGatewayToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return { user: { id: user.id, role: user.role }, vmId: row.vmId };
}

// ─── Model listing (/v1/models) ───────────────────────────────

export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/**
 * The models this user may use, in OpenAI `/v1/models` shape. Shared models are
 * always `shared:<id>`; the tenant's BYO keys appear as `byo:<id>` only when the
 * admin allows BYO. Upstream endpoints/keys/real model names are never exposed.
 */
export async function listGatewayModels(user: { id: string; role: string }): Promise<OpenAiModel[]> {
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) return [];
  const created = Math.floor(Date.now() / 1000);
  const models: OpenAiModel[] = cap.models.map((m) => ({ id: m.id, object: 'model', created, owned_by: 'proxmate' }));
  if (cap.allowByoKeys) {
    const keys = await prisma.tenantLlmKey.findMany({ where: { userId: user.id }, select: { id: true } });
    for (const k of keys) models.push({ id: `byo:${k.id}`, object: 'model', created, owned_by: 'byo' });
  }
  return models;
}

export interface ModelPickerEntry {
  /** Namespaced id the tenant's picker sends back (shared:* / byo:*). */
  id: string;
  /** Display label for the model. */
  name: string;
}

/**
 * The same models as {@link listGatewayModels} but with display labels — used to
 * build the guest's `opencode.json` model map at provision/mint time.
 */
export async function listModelPickerEntries(user: { id: string; role: string }): Promise<ModelPickerEntry[]> {
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) return [];
  const entries: ModelPickerEntry[] = cap.models.map((m) => ({ id: m.id, name: m.label }));
  if (cap.allowByoKeys) {
    const keys = await prisma.tenantLlmKey.findMany({ where: { userId: user.id }, select: { id: true, label: true } });
    for (const k of keys) entries.push({ id: `byo:${k.id}`, name: k.label });
  }
  return entries;
}

// ─── Connection test (list an endpoint's models) ─────────────

export interface ProbeResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/**
 * Probe an OpenAI-compatible endpoint's `/models` — the shared "Test connection"
 * primitive behind both the tenant BYO-key test and the admin source test. Returns
 * the available model ids, or a short error. Never throws.
 */
export async function probeModels(baseUrl: string, apiKey?: string): Promise<ProbeResult> {
  const base = normalizeBase(baseUrl);
  if (!base) return { ok: false, models: [], error: 'No base URL' };
  try {
    const r = await fetch(`${base}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, models: [], error: `HTTP ${r.status}` };
    const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(j.data)
      ? j.data.map((m) => String(m.id ?? '')).filter(Boolean).sort()
      : [];
    return { ok: true, models };
  } catch (e) {
    const msg = (e as Error)?.name === 'TimeoutError' ? 'Timed out' : (e as Error)?.message || 'Unreachable';
    return { ok: false, models: [], error: msg };
  }
}

// ─── Upstream routing (allow-list enforcement) ────────────────

export interface UpstreamRoute {
  /** OpenAI-compatible base URL, e.g. http://host:11434/v1 — `/chat/completions` is appended. */
  url: string;
  /** Bearer key for the upstream (admin gateway key, or the tenant's decrypted BYO key). */
  apiKey?: string;
  /** The REAL upstream model name to send (the tenant never sees this). */
  model: string;
  /** Human label for logs/audit (never a secret). */
  label: string;
  /** 'shared' | 'byo' — which egress this resolved to. */
  kind: 'shared' | 'byo';
}

/**
 * Map a tenant-supplied model id to a concrete upstream, enforcing the admin
 * allow-list. Returns null if the model isn't permitted for this user — the
 * single choke point that stops a token from reaching an un-shared model or a
 * BYO key when BYO is disabled.
 */
export async function resolveModelRoute(
  user: { id: string; role: string },
  modelId: string,
): Promise<UpstreamRoute | null> {
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) return null;

  // Local models sourced from an admin's saved endpoint, gated by visibility.
  if (modelId.startsWith('local:')) {
    const id = modelId.slice('local:'.length);
    const cfg = await getIdeConfig();
    const lm = cfg.localModels.find((m) => m.id === id);
    if (!lm) return null;
    const visible = lm.visibility === 'shared' || (lm.visibility === 'admin' && user.role === 'admin');
    if (!visible) return null;
    const ep = await getLlmKeyEndpointById(lm.sourceKeyId);
    if (!ep) return null;
    return {
      url: normalizeBase(ep.baseUrl),
      apiKey: ep.apiKey || undefined,
      model: lm.model,
      label: lm.nickname || lm.model,
      kind: 'shared',
    };
  }

  // Shared local models via the admin gateway (legacy).
  const sharedId = modelId.startsWith('shared:') ? modelId.slice('shared:'.length) : modelId;
  const shared = cap.sharedModels.find((m) => m.id === sharedId);
  if (shared && (modelId.startsWith('shared:') || !modelId.includes(':'))) {
    const gatewayUrl = await getConfig('ide_gateway_url');
    if (!gatewayUrl || !gatewayUrl.trim()) return null;
    const gatewayKey = await getConfig('ide_gateway_key'); // decrypted by config.service
    return {
      url: normalizeBase(gatewayUrl),
      apiKey: gatewayKey ?? undefined,
      model: shared.model,
      label: shared.label,
      kind: 'shared',
    };
  }

  // Tenant bring-your-own key (only if the admin permits BYO).
  if (modelId.startsWith('byo:')) {
    if (!cap.allowByoKeys) return null;
    const id = modelId.slice('byo:'.length);
    const key = await prisma.tenantLlmKey.findFirst({ where: { id, userId: user.id } });
    if (!key) return null;
    const base =
      key.provider === 'openai'
        ? 'https://api.openai.com/v1'
        : (key.baseUrl && key.baseUrl.trim() ? key.baseUrl : '');
    if (!base) return null;
    // SSRF re-check at forward time (blocks a key whose host now resolves private,
    // e.g. DNS rebinding, or a key saved before the save-time guard existed).
    if (key.provider !== 'openai') {
      try {
        await assertPublicHttpUrl(base);
      } catch {
        return null;
      }
    }
    void prisma.tenantLlmKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return {
      url: normalizeBase(base),
      apiKey: decrypt(key.keyEnc),
      model: key.model,
      label: key.label,
      kind: 'byo',
    };
  }

  return null;
}
