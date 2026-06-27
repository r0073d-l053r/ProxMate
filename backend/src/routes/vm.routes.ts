import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { recordAudit, listAuditForTarget } from '../services/audit.service.js';
import {
  pveMessage,
  getVmConfig,
  hasSerialConsole,
  getVmRrdData,
  setVmName,
  listSnapshots,
  createSnapshot,
  deleteSnapshot,
  rollbackSnapshot,
  waitForTask,
} from '../services/proxmox.service.js';
import type { RrdTimeframe } from '../services/proxmox.service.js';
import { requestVncProxy, requestTermProxy } from '../services/vnc-proxy.service.js';
import { convertVmToTemplate } from '../services/template.service.js';
import { isValidCron } from '../services/power-schedule.service.js';
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
  updateVm,
  setPowerSchedule,
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

// ─── GET /api/vms/:id/metrics ─────────────────────────────────
// Historical CPU/memory/network for this VM from Proxmox's RRD store, so the
// owner can see resource trends (?timeframe=hour|day|week|month|year).

const RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'] as const;

router.get('/:id/metrics', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const tfParam = req.query['timeframe'];
  const timeframe = (RRD_TIMEFRAMES as readonly string[]).includes(tfParam as string)
    ? (tfParam as RrdTimeframe)
    : 'hour';

  try {
    vm = await syncVmNode(vm);
    const data = await getVmRrdData(vm.proxmoxNode, vm.proxmoxVmId, timeframe);
    res.json({ timeframe, points: data });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/vms/:id/activity ────────────────────────────────
// Recent audit-log events for this VM (create/start/stop/restart/notes), so the
// owner can see its history without admin access. Scoped to the VM's own id.

router.get('/:id/activity', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const entries = await listAuditForTarget('vm', vm.id, 20);
  // Project to a safe subset for the owner-facing feed — never expose the actor's
  // IP or internal user id (an admin could have acted on this tenant's VM).
  res.json(
    entries.map((e) => ({
      id: e.id,
      action: e.action,
      actorEmail: e.actorEmail,
      detail: e.detail,
      createdAt: e.createdAt,
    })),
  );
});

// ─── PATCH /api/vms/:id ───────────────────────────────────────
// Update a VM's user-editable metadata: free-text notes and/or its name (the
// latter is also pushed to Proxmox).

const UpdateVmSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-zA-Z0-9-]+$/, 'Use letters, numbers and hyphens only')
    .optional(),
});

router.patch('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const parsed = UpdateVmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  // Normalize "" → null so an emptied note clears the field rather than storing blank.
  const description =
    parsed.data.description === undefined
      ? undefined
      : (parsed.data.description?.trim() || null);
  const newName = parsed.data.name?.trim();
  const renaming = !!newName && newName !== vm.name;

  try {
    // A rename hits Proxmox first (so a PVE failure doesn't desync our DB).
    if (renaming) {
      vm = await syncVmNode(vm);
      await setVmName(vm.proxmoxNode, vm.proxmoxVmId, newName);
    }
    const updated = await updateVm(vm, { description, ...(renaming ? { name: newName } : {}) });
    await recordAudit({
      action: 'vm.update', actor: user, targetType: 'vm', targetId: vm.id,
      detail: renaming ? `renamed ${vm.name} → ${newName}` : `${vm.name} notes updated`, req,
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── Power schedule (auto start/stop) ─────────────────────────

router.get('/:id/schedule', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  res.json({ startCron: vm.startCron, stopCron: vm.stopCron });
});

const ScheduleSchema = z.object({
  startCron: z.string().max(120).nullable(),
  stopCron: z.string().max(120).nullable(),
});

router.put('/:id/schedule', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const parsed = ScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { startCron, stopCron } = parsed.data;
  if (startCron !== null && !isValidCron(startCron)) {
    res.status(400).json({ error: 'Invalid start schedule.' });
    return;
  }
  if (stopCron !== null && !isValidCron(stopCron)) {
    res.status(400).json({ error: 'Invalid stop schedule.' });
    return;
  }

  const updated = await setPowerSchedule(vm, { startCron, stopCron });
  await recordAudit({
    action: 'vm.schedule', actor: user, targetType: 'vm', targetId: vm.id,
    detail: `${vm.name}: start=${startCron ?? 'off'} stop=${stopCron ?? 'off'}`, req,
  });
  res.json({ startCron: updated.startCron, stopCron: updated.stopCron });
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

// ─── Snapshots (per-VM live, in-place point-in-time) ──────────
// Distinct from MateStates: these are instant Proxmox snapshots for quick
// "before I change something" rollbacks, not durable off-host backups.

const SNAP_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
// Cap snapshots per VM: they consume host storage and aren't quota-counted, so an
// unbounded count is a storage-exhaustion vector on a shared cluster.
const MAX_SNAPSHOTS_PER_VM = 12;

const CreateSnapshotSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(SNAP_NAME_RE, 'Start with a letter; use letters, numbers, _ and - only'),
  description: z.string().max(200).optional(),
  includeRam: z.boolean().optional(),
});

router.get('/:id/snapshots', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  try {
    vm = await syncVmNode(vm);
    res.json(await listSnapshots(vm.proxmoxNode, vm.proxmoxVmId));
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/snapshots', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const parsed = CreateSnapshotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    vm = await syncVmNode(vm);
    const existing = await listSnapshots(vm.proxmoxNode, vm.proxmoxVmId);
    if (existing.length >= MAX_SNAPSHOTS_PER_VM) {
      res.status(409).json({
        error: `Snapshot limit reached (${MAX_SNAPSHOTS_PER_VM}). Delete an old snapshot first.`,
      });
      return;
    }
    const upid = await createSnapshot(
      vm.proxmoxNode,
      vm.proxmoxVmId,
      parsed.data.name,
      { description: parsed.data.description, vmstate: parsed.data.includeRam },
    );
    await waitForTask(vm.proxmoxNode, upid);
    await recordAudit({
      action: 'snapshot.create', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `snapshot "${parsed.data.name}" of ${vm.name}`, req,
    });
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/snapshots/:name/rollback', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const name = req.params['name'] as string;
  if (!SNAP_NAME_RE.test(name)) { res.status(400).json({ error: 'Invalid snapshot name' }); return; }
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  try {
    vm = await syncVmNode(vm);
    const upid = await rollbackSnapshot(vm.proxmoxNode, vm.proxmoxVmId, name);
    await waitForTask(vm.proxmoxNode, upid, undefined, 300_000);
    await recordAudit({
      action: 'snapshot.rollback', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `rolled ${vm.name} back to "${name}"`, req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.delete('/:id/snapshots/:name', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const name = req.params['name'] as string;
  if (!SNAP_NAME_RE.test(name)) { res.status(400).json({ error: 'Invalid snapshot name' }); return; }
  let vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  try {
    vm = await syncVmNode(vm);
    const upid = await deleteSnapshot(vm.proxmoxNode, vm.proxmoxVmId, name);
    await waitForTask(vm.proxmoxNode, upid);
    await recordAudit({
      action: 'snapshot.delete', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `deleted snapshot "${name}" of ${vm.name}`, req,
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
