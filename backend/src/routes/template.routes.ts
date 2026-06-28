import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { pveMessage } from '../services/proxmox.service.js';
import { deployFromTemplate, QuotaError } from '../services/vm.service.js';
import {
  listPublished,
  listAll,
  discover,
  register,
  unregister,
  updateTemplate,
  addCloudImage,
  CURATED_IMAGES,
  getCloudInitExtras,
  enableCloudInitSnippets,
  cloudInitStatus,
} from '../services/template.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();
router.use(requireAuth);
// A user whose admin required 2FA can't browse or deploy templates until they
// enrol a method — same gate as /api/vms (notably covers POST /templates/deploy).
router.use(enforceMfaSetup);

// ─── GET /api/templates ───────────────────────────────────────
// Published templates for the Template Store (any authed user).

router.get('/', async (_req: Request, res: Response) => {
  const templates = await listPublished();
  res.json(templates);
});

// Which ProxMate "extras" snippets are present on each node (for the wizard).
router.get('/cloud-init-status', async (_req: Request, res: Response) => {
  try {
    res.json(await cloudInitStatus());
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/templates/deploy ───────────────────────────────
// Deploy a new VM from a template (clone + autoscale).

const DeploySchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/, 'Use letters, numbers and hyphens only'),
  cpu: z.number().int().positive().max(64),
  ram: z.number().int().positive(),
  storage: z.number().int().positive(),
  // Cloud-init templates only:
  sshKey: z
    .string()
    .max(4000)
    .optional()
    .refine((v) => !v || /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/m.test(v.trim()), 'Must be an OpenSSH public key'),
  username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'Lowercase letters, digits, _ and - only').optional(),
  password: z.string().min(1).max(128).optional(),
  installDocker: z.boolean().optional(),
  installTailscale: z.boolean().optional(),
  installGuestAgent: z.boolean().optional(),
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

  // A cloud image needs a way in, or the box is unreachable on first boot.
  if (template.cloudInit && !parsed.data.sshKey && !parsed.data.password) {
    res.status(400).json({ error: 'This cloud image needs an SSH public key or a password to log in.' });
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

// Curated cloud images the admin can one-click add.
router.get('/cloud-images', requireAdmin, (_req: Request, res: Response) => {
  res.json(CURATED_IMAGES);
});

// Cloud-init "extras" (Docker / Tailscale) setup: status + snippet bundles to place.
router.get('/cloud-init-extras', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await getCloudInitExtras());
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// Enable the `snippets` content type on the snippet storage (the API-doable half).
router.post('/cloud-init-extras/enable', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await enableCloudInitSnippets());
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// Build a cloud-init template from a cloud image (download → import → convert).
// Long-running: the image download is hundreds of MB.
const CloudImageSchema = z.object({
  name: z.string().min(1).max(100),
  imageUrl: z
    .string()
    .url()
    // Only http(s) — block ftp:/file:/data: and other schemes Proxmox's
    // download-url might otherwise follow from the host's network position.
    .refine((u) => /^https?:\/\//i.test(u), 'URL must start with http:// or https://')
    .refine((u) => /\.(qcow2|img|raw)(\?.*)?$/i.test(u), 'URL must point to a .qcow2/.img/.raw image'),
  os: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  node: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid node name').optional(),
});

router.post('/cloud-image', requireAdmin, async (req: Request, res: Response) => {
  const parsed = CloudImageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const template = await addCloudImage(parsed.data);
    res.status(201).json(template);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
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
  // Custom icon as a small RASTER image data-URI (admin upload). Cap ~300 KB
  // encoded. SVG is intentionally excluded: an inline-rendered SVG can carry
  // script, so we only accept raster formats that can't execute.
  icon: z
    .string()
    .max(400_000)
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/, 'Must be a PNG/JPEG/WebP/GIF data URI')
    .nullable()
    .optional(),
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
  } catch (err) {
    const msg = pveMessage(err);
    // Linked clones still depend on this template's base disk — Proxmox refuses.
    if (/clone/i.test(msg)) {
      res.status(409).json({
        error: 'Cannot delete this template while VMs are still cloned from it. Delete those VMs first.',
      });
      return;
    }
    res.status(502).json({ error: msg });
  }
});

export default router;
