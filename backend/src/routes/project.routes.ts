import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { recordAudit } from '../services/audit.service.js';
import {
  assignProject,
  getProjectsView,
  normalizeProjectName,
  DEFAULT_USAGE_DAYS,
} from '../services/project.service.js';
import type { AuthRequest } from '../types/index.js';

// Projects: VMs grouped by their `project:<name>` tag (see project.service.ts).
// Power actions on a project go through POST /api/vms/bulk, so they keep every
// lock and ownership check that route applies.

const router = Router();
router.use(requireAuth);
router.use(enforceMfaSetup);

// ─── GET /api/projects ────────────────────────────────────────
// The caller's VMs grouped by project with allocation and usage rollups
// (?days=1..90, default 7). Admins get every owner's VMs, owner by owner.

router.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const days = Number(req.query['days'] ?? DEFAULT_USAGE_DAYS);
  res.json(await getProjectsView(user, Number.isFinite(days) ? days : DEFAULT_USAGE_DAYS));
});

// ─── POST /api/projects/assign ────────────────────────────────
// Move VMs into a project, or out of one with `project: null`. Owner-or-admin
// per VM; anything else is reported per item as "not found".

const AssignSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(50),
  project: z.string().max(64).nullable(),
});

router.post('/assign', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  let name: string | null = null;
  if (parsed.data.project !== null && parsed.data.project.trim() !== '') {
    name = normalizeProjectName(parsed.data.project);
    if (!name) {
      res.status(400).json({ error: 'Project names use letters, numbers, _ and - (up to 32), starting with a letter or number.' });
      return;
    }
  }
  const results = await assignProject(user, parsed.data.ids, name);
  // One entry per VM moved, so each VM's activity feed shows the change.
  const detail = name ? `moved to project ${name}` : 'removed from its project';
  for (const r of results.filter((x) => x.ok)) {
    await recordAudit({ action: 'vm.project', actor: user, targetType: 'vm', targetId: r.id, detail, req });
  }
  res.json({ project: name, results });
});

export default router;
