import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.service.js';
import { createQuotaRequest, listMyQuotaRequests, QuotaRequestError } from '../services/quota-request.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();
router.use(requireAuth);

const CreateSchema = z.object({
  cpu: z.number().int().positive().max(1024),
  ram: z.number().int().positive(), // MB
  storage: z.number().int().positive(), // GB
  reason: z.string().max(1000).optional(),
});

// ─── POST /api/quota-requests — ask an admin to raise your quota ──
router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const user = (req as AuthRequest).user;
  try {
    await createQuotaRequest(user.id, parsed.data);
    await recordAudit({
      action: 'quota.request',
      actor: user,
      targetType: 'user',
      targetId: user.id,
      detail: `${parsed.data.cpu} vCPU / ${parsed.data.ram} MB / ${parsed.data.storage} GB`,
      req,
    });
    res.status(201).json({ success: true });
  } catch (err) {
    if (err instanceof QuotaRequestError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ─── GET /api/quota-requests/mine — my requests (for the "pending" badge) ──
router.get('/mine', async (req: Request, res: Response) => {
  const rows = await listMyQuotaRequests((req as AuthRequest).user.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      cpu: r.cpu,
      ram: r.ram,
      storage: r.storage,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  );
});

export default router;
