import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { InviteToken } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { generateToken, parseExpiry } from '../services/invite.service.js';
import { isMailConfigured, sendMail } from '../services/mail.service.js';
import { inviteEmail } from '../lib/email-templates.js';

const router = Router();

router.use(requireAuth, requireAdmin);

/** Public registration URL for an invite token. */
function inviteUrlFor(token: string): string {
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  return `${frontendUrl.replace(/\/+$/, '')}/register/${token}`;
}

/**
 * Email a branded invite link to `to`. The invite already exists regardless, so
 * this never throws — it returns `null` on success or a human-readable error the
 * caller can surface (the admin can still copy the link by hand).
 */
async function emailInvite(to: string, invite: InviteToken, inviterName?: string | null): Promise<string | null> {
  if (!(await isMailConfigured())) {
    return 'SMTP is not configured — set up email in Settings to send invites.';
  }
  try {
    const mail = inviteEmail({
      inviteUrl: inviteUrlFor(invite.token),
      label: invite.label,
      maxCpu: invite.maxCpu,
      maxRam: invite.maxRam,
      maxStorage: invite.maxStorage,
      require2fa: invite.require2fa,
      expiresAt: invite.expiresAt,
      inviterName,
    });
    await sendMail({ to, ...mail });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Failed to send the invite email.';
  }
}

// ─── POST /api/invites ────────────────────────────────────────

const CreateInviteSchema = z.object({
  maxCpu: z.number().int().positive(),
  maxRam: z.number().int().positive(),
  maxStorage: z.number().int().positive(),
  label: z.string().max(200).optional(),
  email: z.string().trim().email().max(254).optional(),
  expiresIn: z.string().default('7d'),
  require2fa: z.boolean().default(false),
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
      email: parsed.data.email ?? null,
      maxCpu: parsed.data.maxCpu,
      maxRam: parsed.data.maxRam,
      maxStorage: parsed.data.maxStorage,
      require2fa: parsed.data.require2fa,
      expiresAt,
    },
  });

  // If an address was given, try to email the link. A send failure does NOT fail
  // the request — the invite is created and the link returned either way.
  let emailError: string | null = null;
  if (parsed.data.email) {
    emailError = await emailInvite(parsed.data.email, invite, (req as any).user.displayName);
  }

  res.status(201).json({
    id: invite.id,
    token: invite.token,
    inviteUrl: inviteUrlFor(invite.token),
    label: invite.label,
    email: invite.email,
    maxCpu: invite.maxCpu,
    maxRam: invite.maxRam,
    maxStorage: invite.maxStorage,
    require2fa: invite.require2fa,
    expiresAt: invite.expiresAt.toISOString(),
    emailed: !!parsed.data.email && !emailError,
    emailError: emailError ?? undefined,
  });
});

// ─── POST /api/invites/:id/send ───────────────────────────────
// (Re)send an existing, still-valid invite link to an email address.

const SendInviteSchema = z.object({ email: z.string().trim().email().max(254) });

router.post('/:id/send', async (req: Request, res: Response) => {
  const parsed = SendInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }

  const invite = await prisma.inviteToken.findUnique({ where: { id: req.params['id'] as string } });
  if (!invite) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  if (invite.usedById) {
    res.status(409).json({ error: 'This invite has already been used.' });
    return;
  }
  if (invite.expiresAt < new Date()) {
    res.status(409).json({ error: 'This invite has expired.' });
    return;
  }

  const emailError = await emailInvite(parsed.data.email, invite, (req as any).user.displayName);
  if (!emailError) {
    await prisma.inviteToken.update({ where: { id: invite.id }, data: { email: parsed.data.email } });
  }

  // Return 200 with a structured result rather than a 5xx an upstream proxy might
  // replace with its own opaque error page, so the admin sees the real reason.
  res.json({ ok: !emailError, email: parsed.data.email, error: emailError ?? undefined });
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
      email: inv.email,
      maxCpu: inv.maxCpu,
      maxRam: inv.maxRam,
      maxStorage: inv.maxStorage,
      require2fa: inv.require2fa,
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
