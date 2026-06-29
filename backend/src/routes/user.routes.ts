import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { destroyVm } from '../services/vm.service.js';
import { recordAudit } from '../services/audit.service.js';
import { pveMessage } from '../services/proxmox.service.js';
import type { AuthRequest } from '../types/index.js';

/** Shape one user row the way GET /api/users returns it (quota + live usage). */
function toManagedUser(u: {
  id: string; email: string; displayName: string; role: string;
  maxCpu: number; maxRam: number; maxStorage: number; createdAt: Date;
  vms: { cpu: number; ram: number; storage: number }[];
  _count: { vms: number };
}) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    vmCount: u._count.vms,
    quota: {
      cpu: { used: u.vms.reduce((s, v) => s + v.cpu, 0), max: u.maxCpu },
      ram: { used: u.vms.reduce((s, v) => s + v.ram, 0), max: u.maxRam },
      storage: { used: u.vms.reduce((s, v) => s + v.storage, 0), max: u.maxStorage },
    },
    createdAt: u.createdAt.toISOString(),
  };
}

const router = Router();

router.use(requireAuth, requireAdmin, enforceMfaSetup);

// ─── GET /api/users ───────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { vms: true } }, vms: true },
  });

  res.json(users.map(toManagedUser));
});

// ─── PATCH /api/users/:id — update a user's resource quota ─────
// Admin-only (router is requireAdmin). Lets an admin re-provision how much of the
// cluster a given user may consume. Existing VMs are untouched; quotas are enforced
// at create/resize time, so lowering below current usage just blocks new spend.

const UpdateQuotaSchema = z.object({
  maxCpu: z.number().int().min(0).max(1024),
  maxRam: z.number().int().min(0), // MB
  maxStorage: z.number().int().min(0), // GB
});

router.patch('/:id', async (req: Request, res: Response) => {
  const parsed = UpdateQuotaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const targetId = req.params['id'] as string;
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const { maxCpu, maxRam, maxStorage } = parsed.data;
  const updated = await prisma.user.update({
    where: { id: targetId },
    data: { maxCpu, maxRam, maxStorage },
    include: { _count: { select: { vms: true } }, vms: true },
  });
  await recordAudit({
    action: 'admin.update_quota',
    actor: (req as AuthRequest).user,
    targetType: 'user',
    targetId,
    detail: `${target.email}: ${maxCpu} vCPU / ${maxRam} MB / ${maxStorage} GB`,
    req,
  });
  res.json(toManagedUser(updated));
});

// ─── DELETE /api/users/:id ────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  const targetId = req.params['id'] as string;
  const me = (req as AuthRequest).user;

  if (targetId === me.id) {
    res.status(400).json({ error: 'You cannot delete your own account' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: targetId }, include: { vms: true } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Best-effort: destroy the user's VMs on Proxmox before removing the account.
  for (const vm of user.vms) {
    try {
      await destroyVm(vm);
    } catch (err) {
      console.warn(`Failed to destroy VM ${vm.proxmoxVmId} for deleted user: ${pveMessage(err)}`);
    }
  }

  // Cascade removes any remaining VM rows, sessions, and frees their invite.
  await prisma.user.delete({ where: { id: targetId } });
  res.json({ success: true });
});

export default router;
