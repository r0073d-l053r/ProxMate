import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getIdeCapability } from '../services/ide.service.js';
import { issueGatewayToken, listModelPickerEntries } from '../services/ide-gateway.service.js';
import {
  listLlmKeys,
  addLlmKey,
  deleteLlmKey,
  KNOWN_PROVIDERS,
  TooManyLlmKeysError,
  InvalidLlmKeyError,
} from '../services/tenant-llm-key.service.js';
import { recordAudit } from '../services/audit.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth);

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
  const publicApiBaseUrl = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
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

async function byoAllowed(user: { role: string }): Promise<boolean> {
  const cap = await getIdeCapability({ role: user.role });
  return cap.available && cap.allowByoKeys;
}

// GET /api/ide/keys — the caller's saved BYO keys (no secrets).
router.get('/keys', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (!(await byoAllowed(user))) {
    res.status(403).json({ error: 'Bring-your-own AI keys are not enabled.' });
    return;
  }
  res.json(await listLlmKeys(user.id));
});

// POST /api/ide/keys — save a new BYO key.
router.post('/keys', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (!(await byoAllowed(user))) {
    res.status(403).json({ error: 'Bring-your-own AI keys are not enabled.' });
    return;
  }
  const parsed = KeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const key = await addLlmKey(user.id, parsed.data);
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
