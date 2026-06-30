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
  setBackupPolicy,
} from '../services/matestate.service.js';
import { listShares, addShare, removeShare, SHARE_ROLES, ShareError } from '../services/vm-share.service.js';
import { listDisks, addDataDisk, resizeDataDisk, removeDataDisk } from '../services/disk.service.js';
import {
  QuotaError,
  ResizeError,
  createVm,
  resizeVm,
  rebuildVm,
  normalizeTags,
  listVms,
  refreshVmIps,
  getLiveUsage,
  getOwnedVm,
  getViewableVm,
  getWritableVm,
  resolveVmAccess,
  annotateAccess,
  migrateVmToNode,
  getVmWithLiveStatus,
  updateVm,
  setPowerSchedule,
  destroyVm,
  startVm,
  stopVm,
  restartVm,
  syncVmNode,
} from '../services/vm.service.js';
import type { RebuildSource } from '../services/vm.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth);
// Users whose admin required 2FA can't touch VMs until they've enrolled a method.
router.use(enforceMfaSetup);

// ─── GET /api/vms ─────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  // Tag each VM with the caller's access (owner/admin/co-owner/read-only) so the
  // UI can badge shared VMs and gate write actions; the API enforces it regardless.
  const vms = await annotateAccess(await refreshVmIps(await listVms(user)), user);
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

// ─── POST /api/vms/bulk ───────────────────────────────────────
// Apply one power action to several owned VMs at once. Per-VM errors are
// isolated and reported; declared before `/:id` so "bulk" isn't read as an id.
// Bulk *delete* is supported, but the UI gates it behind a typed confirmation
// (the user must type the selected-VM count) so several VMs can't be destroyed
// by an accidental click.

const BulkSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'delete']),
  ids: z.array(z.string()).min(1).max(50),
});

router.post('/bulk', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = BulkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { action, ids } = parsed.data;
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    const vm = await getOwnedVm(id, user);
    if (!vm) { results.push({ id, ok: false, error: 'not found' }); continue; }
    try {
      if (action === 'start') await startVm(vm);
      else if (action === 'stop') await stopVm(vm, false);
      else if (action === 'restart') await restartVm(vm);
      else await destroyVm(vm);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: pveMessage(err) });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  await recordAudit({
    action: `vm.bulk_${action}`, actor: user, targetType: 'vm',
    detail: `${ok}/${ids.length} ${action}`, req,
  });
  res.json({ results });
});

// ─── GET /api/vms/:id ─────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const resolved = await resolveVmAccess(req.params['id'] as string, user);
  if (!resolved) { res.status(404).json({ error: 'VM not found' }); return; }

  const withStatus = await getVmWithLiveStatus(resolved.vm);
  res.json({ ...withStatus, access: resolved.access });
});

// ─── GET /api/vms/:id/metrics ─────────────────────────────────
// Historical CPU/memory/network for this VM from Proxmox's RRD store, so the
// owner can see resource trends (?timeframe=hour|day|week|month|year).

const RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'] as const;

router.get('/:id/metrics', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getViewableVm(req.params['id'] as string, user);
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
  const vm = await getViewableVm(req.params['id'] as string, user);
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
// Update a VM: free-text notes, its name (also pushed to Proxmox), and/or an
// in-place resize of CPU/RAM/disk (quota-checked; disk is grow-only).

const UpdateVmSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-zA-Z0-9-]+$/, 'Use letters, numbers and hyphens only')
    .optional(),
  // In-place resize. Each is optional; disk can only grow (enforced server-side).
  cpu: z.number().int().positive().max(64).optional(),
  ram: z.number().int().positive().optional(),
  storage: z.number().int().positive().optional(),
  // Optional labels for grouping/filtering. Pass [] to clear.
  tags: z
    .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,30}$/, 'Letters, numbers, space, _ and - only'))
    .max(20)
    .optional(),
});

router.patch('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getWritableVm(req.params['id'] as string, user);
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
  // undefined = not provided; empty CSV → null (clear all tags).
  const tags = parsed.data.tags === undefined ? undefined : normalizeTags(parsed.data.tags) || null;
  const metaChanged = renaming || description !== undefined || tags !== undefined;

  const resizeInput = {
    ...(parsed.data.cpu !== undefined ? { cpu: parsed.data.cpu } : {}),
    ...(parsed.data.ram !== undefined ? { ram: parsed.data.ram } : {}),
    ...(parsed.data.storage !== undefined ? { storage: parsed.data.storage } : {}),
  };
  const resizing = Object.keys(resizeInput).length > 0;

  if (!metaChanged && !resizing) { res.json(vm); return; }

  try {
    // Notes / rename first. A rename hits Proxmox first (so a PVE failure
    // doesn't desync our DB).
    if (metaChanged) {
      if (renaming) {
        vm = await syncVmNode(vm);
        await setVmName(vm.proxmoxNode, vm.proxmoxVmId, newName!);
      }
      vm = await updateVm(vm, {
        description,
        ...(renaming ? { name: newName } : {}),
        ...(tags !== undefined ? { tags } : {}),
      });
      await recordAudit({
        action: 'vm.update', actor: user, targetType: 'vm', targetId: vm.id,
        detail: renaming ? `renamed ${vm.name} → ${newName}` : `${vm.name} updated`, req,
      });
    }

    if (resizing) {
      // resizeVm needs the full user record (quota caps + role).
      const fullUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!fullUser) { res.status(404).json({ error: 'User not found' }); return; }
      const before = `${vm.cpu}c/${vm.ram}MB/${vm.storage}GB`;
      vm = await resizeVm(fullUser, vm, resizeInput);
      await recordAudit({
        action: 'vm.resize', actor: user, targetType: 'vm', targetId: vm.id,
        detail: `${vm.name}: ${before} → ${vm.cpu}c/${vm.ram}MB/${vm.storage}GB`, req,
      });
    }

    res.json(vm);
  } catch (err) {
    if (err instanceof QuotaError) {
      res.status(403).json({ error: 'Quota exceeded', details: err.details });
      return;
    }
    if (err instanceof ResizeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── Power schedule (auto start/stop) ─────────────────────────

router.get('/:id/schedule', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  res.json({ startCron: vm.startCron, stopCron: vm.stopCron });
});

const ScheduleSchema = z.object({
  startCron: z.string().max(120).nullable(),
  stopCron: z.string().max(120).nullable(),
});

router.put('/:id/schedule', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getWritableVm(req.params['id'] as string, user);
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

// ─── Per-VM backup policy (schedule + retention) ──────────────

router.get('/:id/backup-policy', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  res.json({ backupCron: vm.backupCron, backupKeep: vm.backupKeep });
});

const BackupPolicySchema = z.object({
  // null = fall back to the cluster-wide weekly default.
  backupCron: z.string().max(120).nullable(),
  // null = default rolling retention; otherwise keep between 1 and 14.
  backupKeep: z.number().int().min(1).max(14).nullable(),
});

router.put('/:id/backup-policy', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getWritableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const parsed = BackupPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { backupCron } = parsed.data;
  if (backupCron !== null && !isValidCron(backupCron)) {
    res.status(400).json({ error: 'Invalid backup schedule.' });
    return;
  }

  // Backup *redundancy* (how many MateStates to keep) is an admin-only setting.
  // Regular users always fall back to the cluster default (MATESTATE_RETENTION = 2),
  // so a tenant can never keep more than two redundant backups of a VM.
  const backupKeep = user.role === 'admin' ? parsed.data.backupKeep : null;

  const updated = await setBackupPolicy(vm, { backupCron, backupKeep });
  await recordAudit({
    action: 'vm.backup_policy', actor: user, targetType: 'vm', targetId: vm.id,
    detail: `${vm.name}: backup=${backupCron ?? 'default'} keep=${backupKeep ?? 'default'}`, req,
  });
  res.json({ backupCron: updated.backupCron, backupKeep: updated.backupKeep });
});

// ─── Data disks (extra volumes) ───────────────────────────────
// View for any access level; mutate requires write access (co-owner+). The VM's
// `storage` (total provisioned GB) and the owner's quota are kept in step.

router.get('/:id/disks', async (req: Request, res: Response) => {
  const vm = await getViewableVm(req.params['id'] as string, (req as AuthRequest).user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  try {
    res.json(await listDisks(vm));
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

const DiskSizeSchema = z.object({ sizeGb: z.number().int().min(1).max(4096) });
const DISK_SLOT_RE = /^(scsi|virtio|sata|ide)\d+$/;

router.post('/:id/disks', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getWritableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const parsed = DiskSizeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a disk size in GB.' }); return; }
  try {
    const disk = await addDataDisk(vm, parsed.data.sizeGb);
    await recordAudit({ action: 'vm.disk_add', actor: user, targetType: 'vm', targetId: vm.id, detail: `${disk.slot} +${disk.sizeGb}GB`, req });
    res.status(201).json(disk);
  } catch (err) {
    if (err instanceof QuotaError) { res.status(403).json({ error: 'Quota exceeded', details: err.details }); return; }
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.patch('/:id/disks/:slot', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getWritableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const slot = req.params['slot'] as string;
  if (!DISK_SLOT_RE.test(slot)) { res.status(400).json({ error: 'Invalid disk.' }); return; }
  const parsed = DiskSizeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a new size in GB.' }); return; }
  try {
    await resizeDataDisk(vm, slot, parsed.data.sizeGb);
    await recordAudit({ action: 'vm.disk_resize', actor: user, targetType: 'vm', targetId: vm.id, detail: `${slot} → ${parsed.data.sizeGb}GB`, req });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof QuotaError) { res.status(403).json({ error: 'Quota exceeded', details: err.details }); return; }
    const msg = err instanceof Error ? err.message : pveMessage(err);
    res.status(/grow|root|not found/i.test(msg) ? 400 : 502).json({ error: msg });
  }
});

router.delete('/:id/disks/:slot', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getWritableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const slot = req.params['slot'] as string;
  if (!DISK_SLOT_RE.test(slot)) { res.status(400).json({ error: 'Invalid disk.' }); return; }
  try {
    await removeDataDisk(vm, slot);
    await recordAudit({ action: 'vm.disk_remove', actor: user, targetType: 'vm', targetId: vm.id, detail: slot, req });
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : pveMessage(err);
    res.status(/root|not found/i.test(msg) ? 400 : 502).json({ error: msg });
  }
});

// ─── POST /api/vms/:id/migrate (admin only) ───────────────────
// Move a VM to another cluster node (live if running, offline otherwise).

const MigrateSchema = z.object({
  targetNode: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid node name'),
});

router.post('/:id/migrate', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Only an admin can migrate VMs between nodes.' });
    return;
  }
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const parsed = MigrateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Choose a target node.' }); return; }
  try {
    const updated = await migrateVmToNode(vm, parsed.data.targetNode);
    await recordAudit({
      action: 'vm.migrate', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `${vm.proxmoxNode} → ${parsed.data.targetNode}`, req,
    });
    res.json({ success: true, proxmoxNode: updated.proxmoxNode });
  } catch (err) {
    const msg = err instanceof Error ? err.message : pveMessage(err);
    res.status(/already on|No such node|mismatch/i.test(msg) ? 400 : 502).json({ error: msg });
  }
});

// ─── VM sharing (owner/admin only) ────────────────────────────
// Grant another tenant co-owner (operate) or read-only (view) access to a VM.

router.get('/:id/shares', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  res.json(await listShares(vm.id));
});

const AddShareSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(SHARE_ROLES),
});

router.post('/:id/shares', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const parsed = AddShareSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a valid email and role.' }); return; }
  try {
    const share = await addShare(vm, parsed.data.email, parsed.data.role);
    await recordAudit({
      action: 'vm.share', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `${parsed.data.email} as ${parsed.data.role}`, req,
    });
    res.status(201).json(share);
  } catch (err) {
    if (err instanceof ShareError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(500).json({ error: 'Failed to share the VM' });
  }
});

router.delete('/:id/shares/:shareId', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const ok = await removeShare(vm.id, req.params['shareId'] as string);
  if (!ok) { res.status(404).json({ error: 'Share not found' }); return; }
  await recordAudit({ action: 'vm.unshare', actor: user, targetType: 'vm', targetId: vm.id, req });
  res.json({ success: true });
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
  const vm = await getWritableVm(req.params['id'] as string, user);
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
  const vm = await getWritableVm(req.params['id'] as string, user);
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
  const vm = await getWritableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    await restartVm(vm);
    await recordAudit({ action: 'vm.restart', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, status: 'running' });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/rebuild ────────────────────────────────
// Re-image a VM in place from a fresh ISO or a template/cloud image. Destructive:
// the current disk is wiped, but the VM keeps its id/VMID/name/owner and resources.

const RebuildSchema = z
  .object({
    // Provide exactly one source — an ISO/IMG filename, or a published template id.
    os: z
      .string()
      .max(255)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(iso|img)$/i, 'Must be an ISO/IMG filename')
      .optional(),
    templateId: z.string().min(1).optional(),
    // Cloud-init templates only (re-supplied each rebuild — never stored):
    sshKey: z
      .string()
      .max(4000)
      .optional()
      .refine(
        (v) => !v || /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/m.test(v.trim()),
        'Must be an OpenSSH public key',
      ),
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'Lowercase letters, digits, _ and - only').optional(),
    password: z.string().min(1).max(128).optional(),
    installDocker: z.boolean().optional(),
    installTailscale: z.boolean().optional(),
    installGuestAgent: z.boolean().optional(),
  })
  .refine((d) => !!d.os !== !!d.templateId, {
    message: 'Provide either an ISO (os) or a templateId, not both.',
  });

router.post('/:id/rebuild', async (req: Request, res: Response) => {
  const authUser = (req as AuthRequest).user;
  const vm = await getWritableVm(req.params['id'] as string, authUser);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  const parsed = RebuildSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  try {
    let source: RebuildSource;
    let sourceLabel: string;
    if (parsed.data.templateId) {
      const template = await prisma.template.findUnique({ where: { id: parsed.data.templateId } });
      if (!template || !template.published) { res.status(404).json({ error: 'Template not found' }); return; }
      if (template.cloudInit && !parsed.data.sshKey && !parsed.data.password) {
        res.status(400).json({ error: 'This cloud image needs an SSH public key or a password to log in.' });
        return;
      }
      source = { kind: 'template', template, cloud: parsed.data };
      sourceLabel = template.name;
    } else {
      source = { kind: 'iso', os: parsed.data.os! };
      sourceLabel = parsed.data.os!;
    }

    const rebuilt = await rebuildVm(user, vm, source);
    await recordAudit({
      action: 'vm.rebuild', actor: authUser, targetType: 'vm', targetId: vm.id,
      detail: `${vm.name} rebuilt from ${sourceLabel}`, req,
    });
    res.json(rebuilt);
  } catch (err) {
    if (err instanceof QuotaError) {
      res.status(403).json({ error: 'Quota exceeded', details: err.details });
      return;
    }
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
  const vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  res.json(await listForVm(vm.id));
});

router.post('/:id/matestates', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getWritableVm(req.params['id'] as string, user);
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
  const vm = await getWritableVm(req.params['id'] as string, user);
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
  const vm = await getWritableVm(req.params['id'] as string, user);
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
  let vm = await getViewableVm(req.params['id'] as string, user);
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
  let vm = await getWritableVm(req.params['id'] as string, user);
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
  let vm = await getWritableVm(req.params['id'] as string, user);
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
  let vm = await getWritableVm(req.params['id'] as string, user);
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
  let vm = await getWritableVm(req.params['id'] as string, user);
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
  let vm = await getWritableVm(req.params['id'] as string, user);
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
