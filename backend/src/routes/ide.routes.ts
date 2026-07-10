import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getIdeCapability } from '../services/ide.service.js';
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

export default router;
