import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { recordAudit } from '../services/audit.service.js';
import { getWritableVm } from '../services/vm.service.js';
import {
  createPassthroughRequest,
  listMyPassthroughRequests,
  PassthroughRequestError,
} from '../services/passthrough-request.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();
router.use(requireAuth);
router.use(enforceMfaSetup);

const CreateSchema = z.object({
  vmId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

// ─── POST /api/passthrough-requests — ask an admin to attach GPU/PCI to a VM ──
router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const user = (req as AuthRequest).user;
  // Authorize: the caller must be able to operate this VM (owner / admin / co-owner).
  const vm = await getWritableVm(parsed.data.vmId, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    await createPassthroughRequest(user.id, vm, parsed.data.reason);
    await recordAudit({
      action: 'passthrough.request',
      actor: user,
      targetType: 'vm',
      targetId: vm.id,
      detail: `${vm.name}${parsed.data.reason ? `: ${parsed.data.reason.trim()}` : ''}`,
      req,
    });
    res.status(201).json({ success: true });
  } catch (err) {
    if (err instanceof PassthroughRequestError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ─── GET /api/passthrough-requests/mine — my requests (for the pending badge) ──
router.get('/mine', async (req: Request, res: Response) => {
  const rows = await listMyPassthroughRequests((req as AuthRequest).user.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      vmId: r.vmId,
      vmName: r.vm.name,
      reason: r.reason,
      status: r.status,
      mapping: r.mapping,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  );
});

export default router;
