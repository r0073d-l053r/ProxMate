import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getNodes, getIsos, getStorages, pveMessage } from '../services/proxmox.service.js';
import { getProxmoxResources } from '../services/setup.service.js';

const router = Router();

router.use(requireAuth);

// ─── GET /api/proxmox/resources ───────────────────────────────
// Storages, bridges, and ISO-capable storages (for VM create + settings).

router.get('/resources', async (_req: Request, res: Response) => {
  try {
    const resources = await getProxmoxResources();
    res.json(resources);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/proxmox/nodes ───────────────────────────────────

router.get('/nodes', async (_req: Request, res: Response) => {
  try {
    const nodes = await getNodes();
    res.json(
      nodes.map((n) => ({
        node: n.node,
        status: n.status,
        maxcpu: n.maxcpu,
        maxmem: n.maxmem,
        cpu: n.cpu,
        mem: n.mem,
      })),
    );
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/proxmox/isos ────────────────────────────────────

router.get('/isos', async (_req: Request, res: Response) => {
  try {
    const isos = await getIsos();
    res.json(isos);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/proxmox/storage ─────────────────────────────────

router.get('/storage', async (_req: Request, res: Response) => {
  try {
    const storages = await getStorages();
    res.json(storages.map((s) => ({ name: s.storage, type: s.type, content: s.content })));
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

export default router;
