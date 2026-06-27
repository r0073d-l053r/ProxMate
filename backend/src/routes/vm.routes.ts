import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { recordAudit } from '../services/audit.service.js';
import { pveMessage, getVmConfig, hasSerialConsole } from '../services/proxmox.service.js';
import { requestVncProxy, requestTermProxy } from '../services/vnc-proxy.service.js';
import { convertVmToTemplate } from '../services/template.service.js';
import {
  listForVm,
  createMateState,
  restoreFromMateState,
  deleteMateState,
} from '../services/matestate.service.js';
import {
  QuotaError,
  createVm,
  listVms,
  refreshVmIps,
  getLiveUsage,
  getOwnedVm,
  getVmWithLiveStatus,
  destroyVm,
  startVm,
  stopVm,
  restartVm,
  syncVmNode,
} from '../services/vm.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth);
// Users whose admin required 2FA can't touch VMs until they've enrolled a method.
router.use(enforceMfaSetup);

// ─── GET /api/vms ─────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vms = await refreshVmIps(await listVms(user));
  res.json(vms);
});

// ─── GET /api/vms/live-usage ──────────────────────────────────
// Live aggregate usage of the caller's own running VMs (dashboard sparklines).
// Declared before `/:id` so it isn't matched as a VM id.

router.get('/live-usage', async (req: Request, res: Response) => {
  try {
    res.json(await getLiveUsage((req as AuthRequest).user));
  } catch {
    res.status(502).json({ error: 'Could not read live usage' });
  }
});

// ─── POST /api/vms ────────────────────────────────────────────

const CreateVmSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/, 'Use letters, numbers and hyphens only'),
  cpu: z.number().int().positive().max(64),
  ram: z.number().int().positive(),
  storage: z.number().int().positive(),
  // Restrict to a bare ISO filename so it can't inject extra Proxmox drive options
  // (the value is interpolated into `ide2: <storage>:iso/<os>,media=cdrom`).
  os: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(iso|img)$/i, 'Must be an ISO/IMG filename'),
  // Node name goes into the Proxmox API path — keep it to a safe charset.
  node: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid node name')
    .optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateVmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const { id } = (req as AuthRequest).user;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  try {
    const vm = await createVm(user, parsed.data);
    await recordAudit({
      action: 'vm.create',
      actor: user,
      targetType: 'vm',
      targetId: vm.id,
      detail: `${vm.name} (vmid ${vm.proxmoxVmId} on ${vm.proxmoxNode}, ${vm.cpu}c/${vm.ram}MB/${vm.storage}GB)`,
      req,
    });
    res.status(201).json({ vm, status: vm.status });
  } catch (err) {
    if (err instanceof QuotaError) {
      res.status(403).json({ error: 'Quota exceeded', details: err.details });
      return;
    }
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/vms/:id ─────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const withStatus = await getVmWithLiveStatus(vm);
  res.json(withStatus);
});

// ─── DELETE /api/vms/:id ──────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    await destroyVm(vm);
    await recordAudit({
      action: 'vm.delete', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `${vm.name} (vmid ${vm.proxmoxVmId})`, req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── Power actions ────────────────────────────────────────────

router.post('/:id/start', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    await startVm(vm);
    await recordAudit({ action: 'vm.start', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, status: 'running' });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/stop', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const force = req.query['force'] === 'true';
  try {
    await stopVm(vm, force);
    await recordAudit({
      action: force ? 'vm.stop_force' : 'vm.stop', actor: user, targetType: 'vm', targetId: vm.id,
      detail: vm.name, req,
    });
    res.json({ success: true, status: 'stopped', forced: force });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/restart', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    await restartVm(vm);
    await recordAudit({ action: 'vm.restart', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, status: 'running' });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/convert-template ───────────────────────
// Admin: turn a VM into a reusable, shareable template.

const ConvertSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  os: z.string().max(100).optional(),
});

router.post('/:id/convert-template', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (user.role !== 'admin') { res.status(403).json({ error: 'Admin only' }); return; }

  const parsed = ConvertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    const template = await convertVmToTemplate(vm, parsed.data);
    await recordAudit({
      action: 'template.create', actor: user, targetType: 'template', targetId: template.id,
      detail: `${parsed.data.name} (from vm ${vm.name})`, req,
    });
    res.status(201).json(template);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── MateStates (per-VM backups) ──────────────────────────────

router.get('/:id/matestates', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  res.json(await listForVm(vm.id));
});

router.post('/:id/matestates', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  try {
    const ms = await createMateState(vm, 'manual');
    await recordAudit({
      action: 'matestate.create', actor: user, targetType: 'matestate', targetId: ms.id,
      detail: `manual backup of ${vm.name}`, req,
    });
    res.status(201).json(ms);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/matestates/:msid/restore', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const ms = await prisma.mateState.findUnique({ where: { id: req.params['msid'] as string } });
  if (!ms || ms.vmId !== vm.id) { res.status(404).json({ error: 'MateState not found' }); return; }
  try {
    await restoreFromMateState(vm, ms);
    await recordAudit({
      action: 'matestate.restore', actor: user, targetType: 'matestate', targetId: ms.id,
      detail: `restored ${vm.name} from ${ms.createdAt.toISOString()}`, req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.delete('/:id/matestates/:msid', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const ms = await prisma.mateState.findUnique({ where: { id: req.params['msid'] as string } });
  if (!ms || ms.vmId !== vm.id) { res.status(404).json({ error: 'MateState not found' }); return; }
  try {
    await deleteMateState(ms);
    await recordAudit({
      action: 'matestate.delete', actor: user, targetType: 'matestate', targetId: ms.id,
      detail: `deleted a backup of ${vm.name}`, req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/console ────────────────────────────────
// Returns a one-time VNC ticket + port for the noVNC console.

router.post('/:id/console', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    vm = await syncVmNode(vm);
    const { ticket, port } = await requestVncProxy(vm.proxmoxNode, vm.proxmoxVmId);
    res.json({ ticket, port });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/serial ─────────────────────────────────
// Returns a one-time termproxy ticket + port + user for the xterm.js text
// console. 409 `no_serial` if the VM has no serial port (e.g. an ISO VM).

router.post('/:id/serial', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    vm = await syncVmNode(vm);
    const config = await getVmConfig(vm.proxmoxNode, vm.proxmoxVmId);
    if (!hasSerialConsole(config)) {
      res.status(409).json({ code: 'no_serial', error: 'This VM has no serial/text console.' });
      return;
    }
    const ticket = await requestTermProxy(vm.proxmoxNode, vm.proxmoxVmId);
    res.json(ticket);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

export default router;
