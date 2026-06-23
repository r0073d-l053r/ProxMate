import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPasswordSafe, signToken } from '../services/auth.service.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

// ─── POST /api/auth/register ──────────────────────────────────

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(100),
  inviteToken: z.string().min(1),
});

router.post('/register', async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { email, password, displayName, inviteToken } = parsed.data;

  const invite = await prisma.inviteToken.findUnique({ where: { token: inviteToken } });
  if (!invite || invite.usedById || invite.expiresAt < new Date()) {
    res.status(400).json({ error: 'Invalid or expired invite token' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      passwordHash,
      displayName: displayName.trim(),
      maxCpu: invite.maxCpu,
      maxRam: invite.maxRam,
      maxStorage: invite.maxStorage,
    },
  });

  // Atomically claim the invite — only succeeds if still unused. Guards against
  // two concurrent registrations redeeming the same token (quota duplication).
  const claimed = await prisma.inviteToken.updateMany({
    where: { id: invite.id, usedById: null },
    data: { usedById: user.id },
  });
  if (claimed.count === 0) {
    await prisma.user.delete({ where: { id: user.id } });
    res.status(400).json({ error: 'Invite token already used' });
    return;
  }

  const { token, expiresAt } = await signToken(user.id);
  await prisma.session.create({ data: { userId: user.id, token, expiresAt } });

  res.status(201).json({
    user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
    token,
    expiresAt: expiresAt.toISOString(),
  });
});

// ─── POST /api/auth/login ─────────────────────────────────────

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  // Always runs bcrypt (dummy hash when no user) so timing can't enumerate accounts.
  const valid = await verifyPasswordSafe(password, user?.passwordHash);

  if (!user || !valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const { token, expiresAt } = await signToken(user.id);
  await prisma.session.create({ data: { userId: user.id, token, expiresAt } });

  res.json({
    user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
    token,
    expiresAt: expiresAt.toISOString(),
  });
});

// ─── POST /api/auth/logout ────────────────────────────────────

router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const header = req.headers.authorization!;
  const token = header.slice(7);
  await prisma.session.deleteMany({ where: { token } });
  res.json({ success: true });
});

// ─── GET /api/auth/me ─────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { id } = (req as AuthRequest).user;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const vms = await prisma.virtualMachine.findMany({ where: { userId: id } });
  const usedCpu = vms.reduce((s, v) => s + v.cpu, 0);
  const usedRam = vms.reduce((s, v) => s + v.ram, 0);
  const usedStorage = vms.reduce((s, v) => s + v.storage, 0);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      createdAt: user.createdAt,
      quota: {
        cpu: { used: usedCpu, max: user.maxCpu },
        ram: { used: usedRam, max: user.maxRam },
        storage: { used: usedStorage, max: user.maxStorage },
      },
    },
  });
});

// ─── GET /api/auth/invite/:token ──────────────────────────────

router.get('/invite/:token', async (req: Request, res: Response) => {
  const invite = await prisma.inviteToken.findUnique({
    where: { token: req.params['token'] as string },
  });

  if (!invite || invite.usedById || invite.expiresAt < new Date()) {
    res.status(404).json({ error: 'Invite token not found or already used' });
    return;
  }

  res.json({
    valid: true,
    quotas: { maxCpu: invite.maxCpu, maxRam: invite.maxRam, maxStorage: invite.maxStorage },
    expiresAt: invite.expiresAt.toISOString(),
    label: invite.label,
  });
});

export default router;
