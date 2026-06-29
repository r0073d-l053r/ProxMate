import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.service.js';
import { createApiToken, listApiTokens, revokeApiToken, isApiToken } from '../services/api-token.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();
router.use(requireAuth);

// Defense in depth: a token must not be able to mint or revoke tokens — managing
// them requires a real (browser) session, so a leaked token can't bootstrap more.
router.use((req: Request, res: Response, next) => {
  if (isApiToken((req as AuthRequest).sessionToken)) {
    res.status(403).json({ error: 'API tokens cannot manage API tokens — use the web app.' });
    return;
  }
  next();
});

router.get('/', async (req: Request, res: Response) => {
  res.json(await listApiTokens((req as AuthRequest).user.id));
});

const CreateSchema = z.object({ name: z.string().min(1).max(60) });

router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const user = (req as AuthRequest).user;
  const name = parsed.data.name.trim();
  const token = await createApiToken(user.id, name);
  await recordAudit({ action: 'apitoken.create', actor: user, targetType: 'apitoken', targetId: token.id, detail: name, req });
  res.status(201).json(token); // includes the raw token — shown to the caller once
});

router.delete('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = req.params['id'] as string;
  const ok = await revokeApiToken(user.id, id);
  if (!ok) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  await recordAudit({ action: 'apitoken.revoke', actor: user, targetType: 'apitoken', targetId: id, req });
  res.json({ success: true });
});

export default router;
