import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { pveMessage } from '../services/proxmox.service.js';
import { deployFromTemplate, QuotaError } from '../services/vm.service.js';
import { listPublished, listAll, discover, register, unregister, updateTemplate } from '../services/template.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();
router.use(requireAuth);

// ─── GET /api/templates ───────────────────────────────────────
// Published templates for the Template Store (any authed user).

router.get('/', async (_req: Request, res: Response) => {
  const templates = await listPublished();
  res.json(templates);
});

// ─── POST /api/templates/deploy ───────────────────────────────
// Deploy a new VM from a template (clone + autoscale).

const DeploySchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/, 'Use letters, numbers and hyphens only'),
  cpu: z.number().int().positive().max(64),
  ram: z.number().int().positive(),
  storage: z.number().int().positive(),
});

router.post('/deploy', async (req: Request, res: Response) => {
  const parsed = DeploySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { id } = (req as AuthRequest).user;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const template = await prisma.template.findUnique({ where: { id: parsed.data.templateId } });
  if (!template || !template.published) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }

  try {
    const vm = await deployFromTemplate(user, template, parsed.data);
    res.status(201).json({ vm, status: vm.status });
  } catch (err) {
    if (err instanceof QuotaError) {
      res.status(403).json({ error: 'Quota exceeded', details: err.details });
      return;
    }
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── Admin: manage the store ──────────────────────────────────

router.get('/all', requireAdmin, async (_req: Request, res: Response) => {
  res.json(await listAll());
});

router.get('/discover', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await discover());
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

const RegisterSchema = z.object({
  proxmoxVmId: z.number().int().positive(),
  node: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  os: z.string().max(100).optional(),
  diskGb: z.number().int().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});

router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const template = await register(parsed.data);
    res.status(201).json(template);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

const UpdateSchema = z.object({
  notes: z.string().max(2000).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

router.patch('/:id', requireAdmin, async (req: Request, res: Response) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const template = await updateTemplate(req.params['id'] as string, parsed.data);
    res.json(template);
  } catch {
    res.status(404).json({ error: 'Template not found' });
  }
});

router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    await unregister(req.params['id'] as string);
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'Template not found' });
  }
});

export default router;
