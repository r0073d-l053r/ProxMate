import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getIdeCapability } from '../services/ide.service.js';
import { issueGatewayToken, listModelPickerEntries } from '../services/ide-gateway.service.js';
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

export default router;
