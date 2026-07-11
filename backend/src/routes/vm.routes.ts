import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fsp, existsSync } from 'node:fs';
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
  listLxcTemplates,
  getPassthroughDevices,
  getNodesHealth,
  migratableTargets,
} from '../services/proxmox.service.js';
import type { RrdTimeframe } from '../services/proxmox.service.js';
import { requestVncProxy, requestTermProxy } from '../services/vnc-proxy.service.js';
import { convertVmToTemplate } from '../services/template.service.js';
import { isValidCron } from '../services/power-schedule.service.js';
import {
  listForVm,
  serializeMateState,
  createMateState,
  restoreFromMateState,
  deleteMateState,
  setBackupPolicy,
} from '../services/matestate.service.js';
import { listShares, addShare, removeShare, SHARE_ROLES, normalizeShareRole, ShareError } from '../services/vm-share.service.js';
import { listDisks, addDataDisk, resizeDataDisk, removeDataDisk } from '../services/disk.service.js';
import {
  QuotaError,
  ResizeError,
  CreateOptionError,
  resolveCreateTarget,
  createVm,
  createContainer,
  kindOf,
  resizeVm,
  rebuildVm,
  normalizeTags,
  listVms,
  refreshVmIps,
  getLiveUsage,
  getOwnedVm,
  getViewableVm,
  getVmWithCap,
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
  pauseVm,
  resumeVm,
  resetGuestPassword,
  addGuestSshKey,
  enterRescue,
  exitRescue,
  duplicateVm,
  syncVmNode,
} from '../services/vm.service.js';
import { isValidPublicKey } from '../services/ssh-key.service.js';
import { isIdeInstalling } from '../services/ide-provision.service.js';
import { isDeploying, refreshDeployState } from '../services/deploy-lock.service.js';
import { getLiveStats } from '../services/live-stats.service.js';
import { getConfig } from '../services/config.service.js';
import { ALERT_METRICS } from '../services/alert.service.js';
import { downloadsEnabled, requestBackupDownload, DownloadError } from '../services/download.service.js';
import {
  restoreUploadsEnabled,
  restoreFromUpload,
  resolveUnderUploadDir,
  uploadDir,
  VZDUMP_UPLOAD_RE,
  TEMP_UPLOAD_RE,
  RestoreUploadError,
} from '../services/restore-upload.service.js';
import type { RebuildSource } from '../services/vm.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth);
// Users whose admin required 2FA can't touch VMs until they've enrolled a method.
router.use(enforceMfaSetup);

/**
 * Destructive per-VM actions (stop/restart/pause/delete/migrate) are refused with
 * a 409 while the guest is locked — either the ProxMate IDE is installing or
 * cloud-init is still provisioning a freshly-deployed VM. Returns true (and sends
 * the response) when locked, so callers just `if (rejectIfLocked(vm, res)) return;`.
 */
function rejectIfLocked(vm: { ideState: string | null; deployState: string | null }, res: Response): boolean {
  if (isIdeInstalling(vm)) {
    res.status(409).json({ error: 'The ProxMate IDE is installing on this VM — wait until it finishes.' });
    return true;
  }
  if (isDeploying(vm)) {
    res.status(409).json({ error: "This VM is still finishing its cloud-init setup — wait until it's ready." });
    return true;
  }
  return false;
}

/**
 * Resize lock: an admin-managed VM (deploy-for-tenant) may be RESIZED only by an
 * admin — the owning tenant operates it as-is. This also closes a quota bypass:
 * a tenant who could grow a quota-exempt grant would sidestep quota entirely
 * (quotaExempt implies adminManaged, but we check both defensively). Returns true
 * (and sends 403) when the non-admin caller may not change this VM's size.
 */
export function rejectIfSizeLocked(
  vm: { adminManaged: boolean; quotaExempt: boolean },
  user: { role: string },
  res: Response,
): boolean {
  if ((vm.adminManaged || vm.quotaExempt) && user.role !== 'admin') {
    res.status(403).json({ error: 'This VM was set up by an admin — only an admin can resize it.' });
    return true;
  }
  return false;
}

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
  // ADMIN-ONLY (enforced in the route): tenants never pin nodes.
  node: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid node name')
    .optional(),
  // Admin-only: deploy INTO this user's account…
  forUserId: z.string().min(1).max(64).optional(),
  // …optionally as a grant that doesn't count toward their quota.
  quotaExempt: z.boolean().optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateVmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const actor = (req as AuthRequest).user;
  try {
    // The guest's OWNER (the acting user, or the admin's chosen tenant) — quota
    // applies to them; node/forUserId/quotaExempt are admin-only options.
    const owner = await resolveCreateTarget(actor, parsed.data);
    const vm = await createVm(owner, { ...parsed.data, adminManaged: owner.id !== actor.id });
    const forNote = owner.id !== actor.id ? ` for ${owner.email}` : '';
    const exemptNote = vm.quotaExempt ? ', quota-exempt' : '';
    await recordAudit({
      action: 'vm.create',
      actor,
      targetType: 'vm',
      targetId: vm.id,
      detail: `${vm.name}${forNote} (vmid ${vm.proxmoxVmId} on ${vm.proxmoxNode}, ${vm.cpu}c/${vm.ram}MB/${vm.storage}GB${exemptNote})`,
      req,
    });
    res.status(201).json({ vm, status: vm.status });
  } catch (err) {
    if (err instanceof CreateOptionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof QuotaError) {
      res.status(403).json({ error: 'Quota exceeded', details: err.details });
      return;
    }
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/vms/lxc-templates ───────────────────────────────
// LXC OS templates (vztmpl) available on the cluster, for the create wizard.
// Declared before `/:id` so "lxc-templates" isn't read as a VM id.

router.get('/lxc-templates', async (_req: Request, res: Response) => {
  try {
    res.json(await listLxcTemplates());
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── Restore from an uploaded MateState backup ────────────────
// The migration path between clusters / ProxMate instances: upload the vzdump
// archive from a MateState download email → restore it as a new guest.
// Declared before `/:id` so "restore-capability"/"restore-upload" aren't VM ids.

router.get('/restore-capability', async (_req: Request, res: Response) => {
  // Tells the create wizard whether to show "Restore from old build" (needs the
  // backup share mounted read-write).
  res.json({ enabled: await restoreUploadsEnabled() });
});

// Uploads can be tens of GB; cap is env-tunable (0 disables the cap).
const RESTORE_UPLOAD_MAX_GB = Math.max(0, parseInt(process.env['RESTORE_UPLOAD_MAX_GB'] || '50', 10) || 0);

const restoreUploadMulter = multer({
  storage: multer.diskStorage({
    // Stream straight onto the mounted backup share (container tmp may be tiny),
    // under a dot-name Proxmox's vzdump content scan ignores until we rename.
    destination: (_req, _file, cb) => {
      const dir = uploadDir();
      if (dir) cb(null, dir);
      else cb(new RestoreUploadError('Backup uploads are not enabled on this server.'), '');
    },
    filename: (_req, _file, cb) => cb(null, `.proxmate-upload-${randomBytes(8).toString('hex')}.part`),
  }),
  limits: RESTORE_UPLOAD_MAX_GB > 0 ? { fileSize: RESTORE_UPLOAD_MAX_GB * 1024 ** 3 } : undefined,
  fileFilter: (_req, file, cb) => {
    const name = path.basename(file.originalname);
    if (name !== file.originalname || !VZDUMP_UPLOAD_RE.test(name)) {
      cb(new RestoreUploadError('That file is not a vzdump backup archive (expected a downloaded MateState like vzdump-qemu-….vma.zst).'));
      return;
    }
    cb(null, true);
  },
});

const RestoreUploadSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/, 'Use letters, numbers and hyphens only'),
});

router.post('/restore-upload', async (req: Request, res: Response) => {
  if (!(await restoreUploadsEnabled())) {
    res.status(409).json({ error: 'Backup uploads are not enabled on this server (the backup share must be mounted read-write).' });
    return;
  }
  const { id } = (req as AuthRequest).user;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // Run multer explicitly so its errors map to proper HTTP responses.
  const uploadErr = await new Promise<unknown>((resolve) =>
    restoreUploadMulter.single('file')(req, res, resolve),
  );
  const file = (req as Request & { file?: Express.Multer.File }).file;
  // Never touch the filesystem with request-derived strings directly: re-derive
  // both paths from their basenames under the upload root (strict-pattern +
  // containment sanitizer in restore-upload.service).
  const tempPath = file ? resolveUnderUploadDir(file.path, TEMP_UPLOAD_RE) : null;
  const dropTemp = async () => { if (tempPath) await fsp.unlink(tempPath).catch(() => undefined); };

  if (uploadErr) {
    await dropTemp();
    if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `That file is larger than the server's ${RESTORE_UPLOAD_MAX_GB} GB upload limit (RESTORE_UPLOAD_MAX_GB).` });
      return;
    }
    const msg = uploadErr instanceof Error ? uploadErr.message : 'Upload failed';
    res.status(uploadErr instanceof RestoreUploadError ? 400 : 502).json({ error: msg });
    return;
  }
  if (!file) { res.status(400).json({ error: 'No backup file was uploaded.' }); return; }

  const parsed = RestoreUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    await dropTemp();
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  // Promote the finished temp file to its real vzdump name (making it visible
  // to Proxmox's storage scan). Refuse to clobber an existing backup.
  const finalPath = resolveUnderUploadDir(file.originalname, VZDUMP_UPLOAD_RE);
  if (!tempPath || !finalPath) {
    await dropTemp();
    res.status(400).json({ error: 'That file is not a vzdump backup archive.' });
    return;
  }
  const filename = path.basename(finalPath);
  if (existsSync(finalPath)) {
    await dropTemp();
    res.status(409).json({ error: 'A backup file with this exact name already exists on the server. Rename your file (keep the vzdump-… pattern) and retry.' });
    return;
  }

  try {
    await fsp.rename(tempPath, finalPath);
    const vm = await restoreFromUpload(user, { filename, name: parsed.data.name });
    await recordAudit({
      action: 'vm.restore_upload',
      actor: user,
      targetType: 'vm',
      targetId: vm.id,
      detail: `${vm.name} restored from uploaded ${filename} (vmid ${vm.proxmoxVmId} on ${vm.proxmoxNode})`,
      req,
    });
    res.status(201).json({ vm, status: vm.status });
  } catch (err) {
    await dropTemp();
    if (err instanceof QuotaError) {
      res.status(403).json({ error: 'Quota exceeded', details: err.details });
      return;
    }
    if (err instanceof RestoreUploadError) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/containers ─────────────────────────────────
// Create an LXC container from an OS template. Mirrors POST /api/vms (QEMU) but
// takes a template volid instead of an ISO, plus optional password / SSH key.

const CreateContainerSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/, 'Use letters, numbers and hyphens only'),
  cpu: z.number().int().positive().max(64),
  ram: z.number().int().positive(),
  storage: z.number().int().positive(),
  // Full Proxmox template volid, e.g. "local:vztmpl/debian-12-standard_….tar.zst".
  // Constrained charset since it's interpolated into the create call's ostemplate.
  template: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*:vztmpl\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid template'),
  password: z.string().min(5).max(128).optional(),
  sshKey: z
    .string()
    .max(4000)
    .optional()
    .refine((v) => !v || /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/m.test(v.trim()), 'Must be an OpenSSH public key'),
  node: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid node name')
    .optional(),
  // Admin-only options — see CreateVmSchema.
  forUserId: z.string().min(1).max(64).optional(),
  quotaExempt: z.boolean().optional(),
});

router.post('/containers', async (req: Request, res: Response) => {
  const parsed = CreateContainerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  if (!parsed.data.password && !parsed.data.sshKey) {
    res.status(400).json({ error: 'A container needs a root password or an SSH public key to log in.' });
    return;
  }

  const actor = (req as AuthRequest).user;
  try {
    const owner = await resolveCreateTarget(actor, parsed.data);
    const vm = await createContainer(owner, { ...parsed.data, adminManaged: owner.id !== actor.id });
    const forNote = owner.id !== actor.id ? ` for ${owner.email}` : '';
    const exemptNote = vm.quotaExempt ? ', quota-exempt' : '';
    await recordAudit({
      action: 'vm.create',
      actor,
      targetType: 'vm',
      targetId: vm.id,
      detail: `${vm.name}${forNote} (LXC, vmid ${vm.proxmoxVmId} on ${vm.proxmoxNode}, ${vm.cpu}c/${vm.ram}MB/${vm.storage}GB${exemptNote})`,
      req,
    });
    res.status(201).json({ vm, status: vm.status });
  } catch (err) {
    if (err instanceof CreateOptionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
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
  // Advance the cloud-init deploy lock: probes `cloud-init status` via the guest
  // agent and flips 'deploying' → 'ready' once it settles (or the timeout lapses),
  // so the lock clears on its own as the tenant watches the VM come up. No-op
  // unless the VM is mid-deploy. Reflect the fresh value in this response.
  const deployState = await refreshDeployState(resolved.vm);
  // Whether the admin has designated a rescue ISO — lets the UI explain the
  // Rescue card's disabled state instead of failing on click.
  const rescueAvailable = kindOf(resolved.vm) !== 'lxc' && !!(await getConfig('rescue_iso'));
  // `caps` is what the UI gates on (per-capability buttons/tabs); `access` is the
  // display badge. Owner/admin get every capability.
  res.json({ ...withStatus, deployState, access: resolved.access, caps: [...resolved.caps], rescueAvailable });
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
    const data = await getVmRrdData(vm.proxmoxNode, vm.proxmoxVmId, timeframe, undefined, kindOf(vm));
    res.json({ timeframe, points: data });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/vms/:id/passthrough ─────────────────────────────
// Attached PCI/GPU devices (parsed `hostpciN`), for the detail page's badge +
// admin detach. QEMU-only; containers return an empty list.

router.get('/:id/passthrough', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') { res.json({ devices: [] }); return; }
  try {
    vm = await syncVmNode(vm);
    const cfg = await getVmConfig(vm.proxmoxNode, vm.proxmoxVmId);
    res.json({ devices: getPassthroughDevices(cfg) });
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
  // Tenants (owner + shared users) see their own trail; admin interventions are
  // logged admin-side only (/admin/audit). Admin callers keep the unfiltered
  // view — it's their log to begin with.
  const entries = await listAuditForTarget(
    'vm',
    vm.id,
    20,
    user.role === 'admin' ? {} : { hideActionsByAdminsExcept: vm.userId },
  );
  // Project to a safe subset for the owner-facing feed — never expose the actor's
  // IP or internal user id.
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
  let vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
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
  // Resizing an admin-managed VM is admin-only (rename/tags stay open to the owner).
  if (resizing && rejectIfSizeLocked(vm, user, res)) return;

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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'backups');
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
  // Containers have a single rootfs (resized via the VM resize controls), not the
  // QEMU multi-disk model — surface none here.
  if (kindOf(vm) === 'lxc') { res.json([]); return; }
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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (rejectIfSizeLocked(vm, user, res)) return;
  if (kindOf(vm) === 'lxc') { res.status(400).json({ error: 'Data disks aren’t supported for containers.' }); return; }
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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (rejectIfSizeLocked(vm, user, res)) return;
  if (kindOf(vm) === 'lxc') { res.status(400).json({ error: 'Data disks aren’t supported for containers.' }); return; }
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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (rejectIfSizeLocked(vm, user, res)) return;
  if (kindOf(vm) === 'lxc') { res.status(400).json({ error: 'Data disks aren’t supported for containers.' }); return; }
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

// ─── GET /api/vms/:id/migrate-targets (admin only) ────────────
// The nodes this specific VM may actually be migrated to, per Proxmox's own
// preflight (`allowed_nodes`) — so the picker never offers a node the guest can't
// reach (e.g. its disks live on node-local storage no other node has). An empty
// list means it can't be migrated at all. LXC / passthrough guests are pinned.
router.get('/:id/migrate-targets', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (user.role !== 'admin') { res.status(403).json({ error: 'Only an admin can migrate VMs between nodes.' }); return; }
  const vm = await getOwnedVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc' || vm.hasPassthrough) {
    res.json({ current: vm.proxmoxNode, targets: [] });
    return;
  }
  try {
    const current = await syncVmNode(vm);
    const [allowed, health] = await Promise.all([
      migratableTargets(current.proxmoxNode, current.proxmoxVmId),
      getNodesHealth(),
    ]);
    const onlineOthers = health.nodes.filter((n) => n.online && n.name !== current.proxmoxNode).map((n) => n.name);
    // Fail open when the preflight can't be read (null): offer the online nodes and
    // let the migrate route re-validate, rather than blocking migration entirely.
    const base = allowed ?? onlineOthers;
    const onlineSet = new Set(onlineOthers);
    const targets = base.filter((n) => onlineSet.has(n));
    res.json({ current: current.proxmoxNode, targets });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
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
    const updated = await migrateVmToNode(vm, parsed.data.targetNode, { notifyOwner: true, actorId: user.id });
    await recordAudit({
      action: 'vm.migrate', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `${vm.proxmoxNode} → ${parsed.data.targetNode}`, req,
    });
    res.json({ success: true, proxmoxNode: updated.proxmoxNode });
  } catch (err) {
    // pveMessage extracts Proxmox's real reason from an axios error (an AxiosError
    // is an Error, so `err.message` would just be "Request failed with status 500").
    const msg = pveMessage(err);
    res.status(/already on|No such node|mismatch|containers|passthrough/i.test(msg) ? 400 : 502).json({ error: msg });
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
  // Accept the legacy names for one release (a stale browser bundle mid-deploy
  // must not 400) — normalized to the current presets.
  role: z.enum([...SHARE_ROLES, 'co-owner', 'read-only']).transform(normalizeShareRole),
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
  if (rejectIfLocked(vm, res)) return;

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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'power');
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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'power');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  if (rejectIfLocked(vm, res)) return;
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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'power');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (rejectIfLocked(vm, res)) return;

  try {
    await restartVm(vm);
    await recordAudit({ action: 'vm.restart', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, status: 'running' });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/pause + /resume ────────────────────────
// QEMU suspend/resume: freeze a running VM with its RAM resident (instant to
// resume). Containers (LXC) can't be paused — Proxmox's LXC suspend is
// experimental — so they get a clean 409 instead of a Proxmox error.

router.post('/:id/pause', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'power');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') {
    res.status(409).json({ error: 'Containers (LXC) cannot be paused' });
    return;
  }

  if (rejectIfLocked(vm, res)) return;
  try {
    await pauseVm(vm);
    await recordAudit({ action: 'vm.pause', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, status: 'paused' });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/resume', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'power');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') {
    res.status(409).json({ error: 'Containers (LXC) cannot be paused' });
    return;
  }

  try {
    await resumeVm(vm);
    await recordAudit({ action: 'vm.resume', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, status: 'running' });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/duplicate ──────────────────────────────
// Self-service full clone of a stopped VM. Quota-checked against the owner's
// caps, isolation firewall re-applied before boot. QEMU-only. Runs in the
// background (clone can take a while) and returns 202 with the new VM id.

const DuplicateSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/, 'Letters, numbers and hyphens only'),
});

router.post('/:id/duplicate', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') {
    res.status(409).json({ error: 'Containers (LXC) can\'t be duplicated' });
    return;
  }
  const parsed = DuplicateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  try {
    const copy = await duplicateVm(vm, parsed.data.name);
    await recordAudit({
      action: 'vm.duplicate', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `${vm.name} → ${copy.name}`, req,
    });
    res.status(201).json(copy);
  } catch (err) {
    if (err instanceof QuotaError) { res.status(403).json({ error: 'Quota exceeded', details: err.details }); return; }
    const msg = pveMessage(err);
    res.status(/Stop the machine|can't be duplicated/.test(msg) ? 409 : 502).json({ error: msg });
  }
});

// ─── POST /api/vms/:id/reset-password ─────────────────────────
// Set a guest user's password via the QEMU guest agent (dedicated call, no
// shell). The CSPRNG password is returned exactly once and never stored; the
// audit entry records the username only.

const ResetPasswordSchema = z.object({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._][a-zA-Z0-9._-]*$/, 'Invalid username'),
});

router.post('/:id/reset-password', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') {
    res.status(409).json({ error: 'Password reset needs the QEMU guest agent — containers are not supported' });
    return;
  }
  const parsed = ResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  try {
    const password = await resetGuestPassword(vm, parsed.data.username);
    await recordAudit({
      action: 'vm.reset_password', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `${vm.name} · user ${parsed.data.username}`, req,
    });
    res.json({ password });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/ssh-keys ───────────────────────────────
// Add an SSH public key to a guest user's authorized_keys after creation. The
// wizard's key rides cloud-init (first boot only); this one rides the QEMU
// guest agent, so it works on a running machine. Key + username are validated
// here and passed argv-safe into a fixed script — never interpolated.

const AddVmSshKeySchema = z.object({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._][a-zA-Z0-9._-]*$/, 'Invalid username'),
  publicKey: z
    .string()
    .min(1)
    .max(4096)
    .refine((k) => isValidPublicKey(k.trim()), "That doesn't look like an OpenSSH public key"),
});

router.post('/:id/ssh-keys', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') {
    res.status(409).json({ error: 'Adding SSH keys needs the QEMU guest agent — containers are not supported' });
    return;
  }
  const parsed = AddVmSshKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  try {
    await addGuestSshKey(vm, parsed.data.username, parsed.data.publicKey);
    await recordAudit({
      action: 'vm.ssh_key_add', actor: user, targetType: 'vm', targetId: vm.id,
      detail: `${vm.name} · user ${parsed.data.username}`, req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── POST /api/vms/:id/rescue + /rescue/exit ──────────────────
// Boot from the admin-designated rescue ISO (force-stopping first if needed),
// or restore the snapshotted boot config and boot from disk again.

router.post('/:id/rescue', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') {
    res.status(409).json({ error: 'Rescue mode is for VMs — containers share the host kernel' });
    return;
  }

  try {
    await enterRescue(vm);
    await recordAudit({ action: 'vm.rescue_enter', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, rescue: true });
  } catch (err) {
    const msg = pveMessage(err);
    res.status(/configured|Already in rescue/.test(msg) ? 409 : 502).json({ error: msg });
  }
});

router.post('/:id/rescue/exit', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    await exitRescue(vm);
    await recordAudit({ action: 'vm.rescue_exit', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
    res.json({ success: true, rescue: false });
  } catch (err) {
    const msg = pveMessage(err);
    res.status(/Not in rescue/.test(msg) ? 409 : 502).json({ error: msg });
  }
});

// ─── Per-VM alert rules ───────────────────────────────────────
// Tenant-owned thresholds on a VM (CPU/memory/disk %, or an unexpected stop).
// Evaluated on the resource-history scheduler tick; delivery emails the owner.

const AlertSchema = z.object({
  metric: z.enum(ALERT_METRICS),
  // Percent threshold (ignored server-side for "down").
  threshold: z.number().int().min(1).max(100).optional(),
  sustainedMin: z.number().int().min(1).max(1440).default(5),
});

router.get('/:id/alerts', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const rules = await prisma.alertRule.findMany({
    where: { vmId: vm.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, metric: true, threshold: true, sustainedMin: true, enabled: true, lastFiredAt: true },
  });
  res.json(rules);
});

router.post('/:id/alerts', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const parsed = AlertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { metric, sustainedMin } = parsed.data;
  // "down" has no threshold; the others require one.
  const threshold = metric === 'down' ? 0 : parsed.data.threshold;
  if (metric !== 'down' && threshold === undefined) {
    res.status(400).json({ error: 'A threshold percentage is required for this metric.' });
    return;
  }
  const rule = await prisma.alertRule.create({
    data: { vmId: vm.id, userId: vm.userId, metric, threshold: threshold ?? 0, sustainedMin },
    select: { id: true, metric: true, threshold: true, sustainedMin: true, enabled: true, lastFiredAt: true },
  });
  await recordAudit({ action: 'vm.alert_add', actor: user, targetType: 'vm', targetId: vm.id, detail: `${vm.name} · ${metric}`, req });
  res.status(201).json(rule);
});

router.delete('/:id/alerts/:alertId', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'configure');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  // Scope the delete to this VM so a rule id from another VM can't be removed.
  const { count } = await prisma.alertRule.deleteMany({ where: { id: req.params['alertId'] as string, vmId: vm.id } });
  if (count === 0) { res.status(404).json({ error: 'Alert not found' }); return; }
  await recordAudit({ action: 'vm.alert_remove', actor: user, targetType: 'vm', targetId: vm.id, detail: vm.name, req });
  res.json({ success: true });
});

// ─── GET /api/vms/:id/live-stats ──────────────────────────────
// Lightweight per-VM live sample for the Insights "Live" chart's 1 s ticks.
// Served from the same cached /cluster/resources call the admin monitor uses
// (750 ms TTL, request-coalesced), so per-second polling adds no Proxmox load.
// Viewable by read-only shares too — it's the same data the detail page shows.

router.get('/:id/live-stats', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getViewableVm(req.params['id'] as string, user);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    const all = await getLiveStats();
    const s = all[vm.proxmoxVmId];
    if (!s) { res.json({ status: vm.status, cpu: 0, maxcpu: vm.cpu, mem: 0, maxmem: 0 }); return; }
    res.json({ status: s.status, cpu: s.cpu, maxcpu: s.maxcpu, mem: s.mem, maxmem: s.maxmem, uptime: s.uptime });
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
    installSuperfile: z.boolean().optional(),
    features: z.array(z.string().max(64)).max(20).optional(),
  })
  .refine((d) => !!d.os !== !!d.templateId, {
    message: 'Provide either an ISO (os) or a templateId, not both.',
  });

router.post('/:id/rebuild', async (req: Request, res: Response) => {
  const authUser = (req as AuthRequest).user;
  const vm = await getOwnedVm(req.params['id'] as string, authUser);
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') {
    res.status(400).json({ error: 'Rebuild isn’t available for containers. Delete and recreate it instead.' });
    return;
  }

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
  if (kindOf(vm) === 'lxc') {
    res.status(400).json({ error: 'Converting to a template isn’t supported for containers.' });
    return;
  }

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
  // `downloadable` tells the panel whether to show a Download button (needs the
  // admin-mounted backup share + SMTP). Cheap boolean, computed once.
  const items = (await listForVm(vm.id)).map(serializeMateState);
  res.json({ downloadable: await downloadsEnabled(), items });
});

// Request a one-time emailed download link for a specific MateState. Requires
// the backup share mounted (BACKUP_DOWNLOAD_DIR) + SMTP; the link is sent to the
// requesting user's own email.
router.post('/:id/matestates/:msid/download', async (req: Request, res: Response) => {
  const authUser = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, authUser, 'backups');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { id: true, email: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  try {
    const appUrl = (await getConfig('frontend_url')) ?? process.env['BACKEND_PUBLIC_URL'] ?? process.env['FRONTEND_URL'] ?? '';
    const { emailedTo } = await requestBackupDownload(req.params['msid'] as string, vm.id, user, appUrl);
    await recordAudit({
      action: 'matestate.download', actor: authUser, targetType: 'matestate', targetId: req.params['msid'] as string,
      detail: `download link for ${vm.name}`, req,
    });
    res.json({ emailed: true, to: emailedTo });
  } catch (err) {
    if (err instanceof DownloadError) { res.status(409).json({ error: err.message }); return; }
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/matestates', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'backups');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  try {
    const ms = await createMateState(vm, 'manual');
    await recordAudit({
      action: 'matestate.create', actor: user, targetType: 'matestate', targetId: ms.id,
      detail: `manual backup of ${vm.name}`, req,
    });
    res.status(201).json(serializeMateState(ms));
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/matestates/:msid/restore', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const vm = await getVmWithCap(req.params['id'] as string, user, 'backups');
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
  const vm = await getVmWithCap(req.params['id'] as string, user, 'backups');
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
  if (kindOf(vm) === 'lxc') { res.json([]); return; }
  try {
    vm = await syncVmNode(vm);
    res.json(await listSnapshots(vm.proxmoxNode, vm.proxmoxVmId));
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

router.post('/:id/snapshots', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let vm = await getVmWithCap(req.params['id'] as string, user, 'backups');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  if (kindOf(vm) === 'lxc') { res.status(400).json({ error: 'Snapshots aren’t available for containers yet.' }); return; }
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
  let vm = await getVmWithCap(req.params['id'] as string, user, 'backups');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') { res.status(400).json({ error: 'Snapshots aren’t available for containers yet.' }); return; }
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
  let vm = await getVmWithCap(req.params['id'] as string, user, 'backups');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (kindOf(vm) === 'lxc') { res.status(400).json({ error: 'Snapshots aren’t available for containers yet.' }); return; }
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
  let vm = await getVmWithCap(req.params['id'] as string, user, 'console');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }
  if (rejectIfLocked(vm, res)) return;

  try {
    vm = await syncVmNode(vm);
    const { ticket, port } = await requestVncProxy(vm.proxmoxNode, vm.proxmoxVmId, kindOf(vm));
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
  let vm = await getVmWithCap(req.params['id'] as string, user, 'console');
  if (!vm) { res.status(404).json({ error: 'VM not found' }); return; }

  try {
    vm = await syncVmNode(vm);
    const kind = kindOf(vm);
    // LXC containers always expose a text console (their native console is the
    // termproxy); QEMU VMs need a serial port in their config.
    if (kind === 'qemu') {
      const config = await getVmConfig(vm.proxmoxNode, vm.proxmoxVmId);
      if (!hasSerialConsole(config)) {
        res.status(409).json({ code: 'no_serial', error: 'This VM has no serial/text console.' });
        return;
      }
    }
    const ticket = await requestTermProxy(vm.proxmoxNode, vm.proxmoxVmId, undefined, kind);
    res.json(ticket);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

export default router;
