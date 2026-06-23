import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { generateToken, parseExpiry } from '../services/invite.service.js';

const router = Router();

router.use(requireAuth, requireAdmin);

// ─── POST /api/invites ────────────────────────────────────────

const CreateInviteSchema = z.object({
  maxCpu: z.number().int().positive(),
  maxRam: z.number().int().positive(),
  maxStorage: z.number().int().positive(),
  label: z.string().max(200).optional(),
  expiresIn: z.string().default('7d'),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  let expiresAt: Date;
  try {
    expiresAt = parseExpiry(parsed.data.expiresIn);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid expiresIn' });
    return;
  }

  const token = generateToken();
  const invite = await prisma.inviteToken.create({
    data: {
      token,
      createdById: (req as any).user.id,
      label: parsed.data.label,
      maxCpu: parsed.data.maxCpu,
      maxRam: parsed.data.maxRam,
      maxStorage: parsed.data.maxStorage,
      expiresAt,
    },
  });

  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  res.status(201).json({
    id: invite.id,
    token: invite.token,
    inviteUrl: `${frontendUrl}/register/${invite.token}`,
    label: invite.label,
    maxCpu: invite.maxCpu,
    maxRam: invite.maxRam,
    maxStorage: invite.maxStorage,
    expiresAt: invite.expiresAt.toISOString(),
  });
});

// ─── GET /api/invites ─────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  const invites = await prisma.inviteToken.findMany({
    orderBy: { createdAt: 'desc' },
    include: { usedBy: { select: { email: true, displayName: true } } },
  });

  res.json(
    invites.map((inv) => ({
      id: inv.id,
      token: inv.token,
      label: inv.label,
      maxCpu: inv.maxCpu,
      maxRam: inv.maxRam,
      maxStorage: inv.maxStorage,
      used: !!inv.usedById,
      usedBy: inv.usedBy ? { email: inv.usedBy.email, displayName: inv.usedBy.displayName } : null,
      expired: inv.expiresAt < new Date(),
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
    })),
  );
});

// ─── DELETE /api/invites/:id ──────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  const invite = await prisma.inviteToken.findUnique({ where: { id: req.params['id'] as string } });

  if (!invite) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  if (invite.usedById) {
    res.status(409).json({ error: 'Cannot revoke an already-used invite' });
    return;
  }

  await prisma.inviteToken.delete({ where: { id: invite.id } });
  res.json({ success: true });
});

export default router;
