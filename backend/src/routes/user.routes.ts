import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { destroyVm } from '../services/vm.service.js';
import { pveMessage } from '../services/proxmox.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth, requireAdmin, enforceMfaSetup);

// ─── GET /api/users ───────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { vms: true } }, vms: true },
  });

  res.json(
    users.map((u) => {
      const usedCpu = u.vms.reduce((s, v) => s + v.cpu, 0);
      const usedRam = u.vms.reduce((s, v) => s + v.ram, 0);
      const usedStorage = u.vms.reduce((s, v) => s + v.storage, 0);
      return {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        vmCount: u._count.vms,
        quota: {
          cpu: { used: usedCpu, max: u.maxCpu },
          ram: { used: usedRam, max: u.maxRam },
          storage: { used: usedStorage, max: u.maxStorage },
        },
        createdAt: u.createdAt.toISOString(),
      };
    }),
  );
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
