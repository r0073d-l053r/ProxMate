import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getIdeCapability } from '../services/ide.service.js';
import { issueGatewayToken, listModelPickerEntries, probeModels } from '../services/ide-gateway.service.js';
import { getVmWithCap, getViewableVm } from '../services/vm.service.js';
import {
  startIdeProvision,
  refreshIdeState,
  IdeProvisionError,
  startIdeRelocate,
  getIdeRelocateStatus,
} from '../services/ide-provision.service.js';
import {
  listLlmKeys,
  addLlmKey,
  deleteLlmKey,
  getLlmKeyEndpoint,
  KNOWN_PROVIDERS,
  TooManyLlmKeysError,
  InvalidLlmKeyError,
} from '../services/tenant-llm-key.service.js';
import { recordAudit } from '../services/audit.service.js';
import { assertSafeOutboundUrl } from '../lib/url-safety.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth);

/**
 * The public base URL for this ProxMate, as the in-guest AI agent must reach it.
 * MUST be https in production: OpenCode POSTs to `<base>/llm/v1/chat/completions`,
 * and if the base is http the edge (Cloudflare/Caddy) 301-redirects to https —
 * which downgrades the POST to a GET, dropping the body + Bearer token, so the
 * request misses the POST-only gateway route and 401s as "missing session".
 *
 * Header sniffing is NOT reliable for this: an intermediate proxy that isn't
 * configured to trust upstream `X-Forwarded-*` REPLACES `x-forwarded-proto`
 * with its own (http) view — live-confirmed on the cloudflared→Caddy chain,
 * which minted `http://` gateway URLs into guests. So the operator-configured
 * `BACKEND_PUBLIC_URL` (the deployment runbook sets it) wins outright; the
 * header/protocol derivation is only the fallback for bare dev setups.
 */
export function publicBaseUrl(req: Request): string {
  const configured = (process.env['BACKEND_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  const proto = fwd || req.protocol;
  return `${proto}://${req.get('host') ?? 'localhost'}`;
}

// ─── GET /api/ide/config ──────────────────────────────────────
// What the current user may do with ProxMate IDE: whether it's available to them,
// whether they can bring their own LLM keys, and which admin-shared models they
// may use. Never exposes the gateway endpoint or any secret.
router.get('/config', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  res.json(await getIdeCapability({ role: user.role }));
});

// ─── POST /api/ide/:id/gateway-token ──────────────────────────
// Mint (or rotate) the per-VM LLM-gateway token that the in-guest AI agent
// (OpenCode) uses to reach `/api/ide/:id/llm/v1`. The raw token is returned ONCE;
// provisioning writes it (plus baseUrl + the model list) into the guest's
// opencode.json. Owner/admin only (issueGatewayToken re-checks ownership + the
// admin IDE policy). Session-authed, so it carries CSRF via requireAuth.
router.post('/:id/gateway-token', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vmId = req.params['id'] as string;
  const publicApiBaseUrl = publicBaseUrl(req);
  const issued = await issueGatewayToken({ id: user.id, role: user.role }, vmId, publicApiBaseUrl);
  if (!issued) {
    res.status(403).json({ error: 'ProxMate IDE is not available for this VM' });
    return;
  }
  const models = await listModelPickerEntries({ id: user.id, role: user.role });
  void recordAudit({
    actor: user,
    action: 'ide.gateway_token_mint',
    targetType: 'vm',
    targetId: vmId,
    detail: `minted IDE gateway token (${models.length} model(s))`,
    req,
  });
  res.json({ token: issued.token, baseUrl: issued.baseUrl, models });
});

// ─── In-guest install (lazy provisioning on first "Open IDE") ──
// POST /:id/provision installs code-server + OpenCode natively into the VM via the
// guest agent (owner/admin/co-owner). GET /:id/status polls the install state so
// the UI can show a loading screen and only open the IDE once it's ready.
router.post('/:id/provision', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'ide');
  if (!vm) {
    res.status(404).json({ error: 'VM not found' });
    return;
  }
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) {
    res.status(403).json({ error: 'ProxMate IDE is not available.' });
    return;
  }
  const publicApiBaseUrl = publicBaseUrl(req);
  try {
    const state = await startIdeProvision(vm, { id: user.id, role: user.role }, publicApiBaseUrl);
    void recordAudit({ actor: user, action: 'ide.provision', targetType: 'vm', targetId: vm.id, req });
    res.json({ state });
  } catch (err) {
    if (err instanceof IdeProvisionError) {
      // `code` lets the UI offer the right remedy (reboot vs relocate) instead
      // of parsing message text.
      res.status(400).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      return;
    }
    throw err;
  }
});

router.get('/:id/status', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) {
    res.status(404).json({ error: 'VM not found' });
    return;
  }
  res.json({ state: await refreshIdeState(vm) });
});

// ─── Relocate to an AVX-capable node ('node_no_avx' escape hatch) ─────────────
// POST kicks off the background stop → offline-migrate → start (202; long disk
// copies outlast any HTTP request) and GET polls it. The SERVER picks the target
// node — tenants never choose nodes (recorded design decision).
router.post('/:id/relocate', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'ide');
  if (!vm) {
    res.status(404).json({ error: 'VM not found' });
    return;
  }
  const cap = await getIdeCapability({ role: user.role });
  if (!cap.available) {
    res.status(403).json({ error: 'ProxMate IDE is not available.' });
    return;
  }
  try {
    const target = await startIdeRelocate(vm, user.id);
    void recordAudit({
      actor: user,
      action: 'vm.ide_relocate',
      targetType: 'vm',
      targetId: vm.id,
      detail: `moving to AVX-capable node ${target} for the IDE`,
      req,
    });
    res.status(202).json({ started: true, target });
  } catch (err) {
    if (err instanceof IdeProvisionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.get('/:id/relocate-status', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) {
    res.status(404).json({ error: 'VM not found' });
    return;
  }
  res.json(getIdeRelocateStatus(vm.id) ?? { state: 'none' });
});

// ─── Bring-your-own AI keys (used only through the gateway) ────
// Per-user LLM provider keys. Gated by the admin's allowByoKeys switch; the secret
// is encrypted at rest and never returned. Session-authed (CSRF via requireAuth).

const KeySchema = z.object({
  label: z.string().min(1).max(60),
  provider: z.enum(KNOWN_PROVIDERS),
  model: z.string().min(1).max(120),
  baseUrl: z.string().url().max(300).optional().or(z.literal('')),
  key: z.string().min(1).max(400),
});

// Tenants may manage AI keys only when the admin allows BYO; admins may always
// manage their own (they use saved endpoints as shared-model sources).
async function canManageKeys(user: { role: string }): Promise<boolean> {
  const cap = await getIdeCapability({ role: user.role });
  return cap.available && (cap.allowByoKeys || user.role === 'admin');
}

// GET /api/ide/keys — the caller's saved BYO keys (no secrets).
router.get('/keys', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (!(await canManageKeys(user))) {
    res.status(403).json({ error: 'Bring-your-own AI keys are not enabled.' });
    return;
  }
  res.json(await listLlmKeys(user.id));
});

// POST /api/ide/keys — save a new BYO key.
router.post('/keys', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (!(await canManageKeys(user))) {
    res.status(403).json({ error: 'Bring-your-own AI keys are not enabled.' });
    return;
  }
  const parsed = KeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    // Admins configure LAN model sources and free-form endpoints; tenants are held
    // to public endpoints AND the fixed preset services (no custom base URLs).
    const isAdmin = user.role === 'admin';
    const key = await addLlmKey(user.id, parsed.data, { allowPrivate: isAdmin, allowCustomBase: isAdmin });
    void recordAudit({
      actor: user,
      action: 'ide.llm_key_add',
      targetType: 'llm_key',
      targetId: key.id,
      detail: `added AI key "${key.label}" (${key.provider})`,
      req,
    });
    res.status(201).json(key);
  } catch (err) {
    if (err instanceof TooManyLlmKeysError || err instanceof InvalidLlmKeyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// POST /api/ide/keys/:keyId/test — check that the saved key can reach its endpoint
// (lists the endpoint's models). Decrypts the key server-side only to probe.
router.post('/keys/:keyId/test', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (!(await canManageKeys(user))) {
    res.status(403).json({ error: 'Bring-your-own AI keys are not enabled.' });
    return;
  }
  const ep = await getLlmKeyEndpoint(user.id, req.params['keyId'] as string);
  if (!ep) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  // Tenants may only probe public endpoints (SSRF guard); admins configure LAN
  // model sources (e.g. a private Ollama) and are trusted, so they're exempt.
  if (user.role !== 'admin') {
    try {
      await assertSafeOutboundUrl(ep.baseUrl, 'endpoint');
    } catch {
      res.status(400).json({ ok: false, error: 'That endpoint address is not allowed.' });
      return;
    }
  }
  const probe = await probeModels(ep.baseUrl, ep.apiKey);
  res.json({ ok: probe.ok, modelCount: probe.models.length, models: probe.models.slice(0, 100), error: probe.error });
});

// DELETE /api/ide/keys/:keyId — remove a BYO key (allowed even if BYO was since
// disabled, so users can always clean up). Ownership-checked.
router.delete('/keys/:keyId', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const keyId = req.params['keyId'] as string;
  const ok = await deleteLlmKey(user.id, keyId);
  if (!ok) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  void recordAudit({ actor: user, action: 'ide.llm_key_delete', targetType: 'llm_key', targetId: keyId, req });
  res.status(204).end();
});

export default router;
