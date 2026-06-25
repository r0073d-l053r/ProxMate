import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { getConfig, setConfig } from '../services/config.service.js';
import { testProxmoxConnection, saveDefaults } from '../services/setup.service.js';
import {
  isClusterFirewallEnabled,
  getClusterStats,
  getBridgeNetwork,
  ipv4NetworkCidr,
  setClusterFirewall,
  getDefaultNode,
  getClient,
  pveMessage,
} from '../services/proxmox.service.js';
import { listAudit, recordAudit } from '../services/audit.service.js';
import { getMailConfig, saveMailConfig, verifyMailConfig } from '../services/mail.service.js';
import * as sso from '../services/sso.service.js';
import { listResetRequests, adminResetPassword } from '../services/password-reset.service.js';
import type { AuthRequest } from '../types/index.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

router.use(requireAuth, requireAdmin);

// ─── GET /api/admin/audit ─────────────────────────────────────
// Append-only activity trail (who did what, when). Newest first, paginated.

router.get('/audit', async (req: Request, res: Response) => {
  const limit = Number(req.query['limit']) || 100;
  const offset = Number(req.query['offset']) || 0;
  res.json(await listAudit({ limit, offset }));
});

// ─── GET /api/admin/settings ──────────────────────────────────
// Returns current config (never the Proxmox token secret).

router.get('/settings', async (_req: Request, res: Response) => {
  const [host, tokenId, verifySsl, storage, bridge, isoStorage] = await Promise.all([
    getConfig('proxmox_host'),
    getConfig('proxmox_token_id'),
    getConfig('proxmox_verify_ssl'),
    getConfig('default_storage'),
    getConfig('default_bridge'),
    getConfig('iso_storage'),
  ]);

  const mail = await getMailConfig();
  const ssoCfg = await sso.getSsoConfig();
  res.json({
    proxmox: { host, tokenId, verifySsl: verifySsl === 'true', hasSecret: !!(await getConfig('proxmox_token_secret')) },
    defaults: { storage, bridge, isoStorage },
    smtp: mail
      ? { configured: true, host: mail.host, port: mail.port, secure: mail.secure, user: mail.user ?? '', from: mail.from, hasPass: !!mail.pass }
      : { configured: false },
    sso: ssoCfg
      ? {
          configured: true,
          enabled: ssoCfg.enabled,
          issuer: ssoCfg.issuer,
          clientId: ssoCfg.clientId,
          scopes: ssoCfg.scopes,
          groupsClaim: ssoCfg.groupsClaim,
          adminGroup: ssoCfg.adminGroup,
          allowSignup: ssoCfg.allowSignup,
          buttonLabel: ssoCfg.buttonLabel,
          hasSecret: await sso.hasClientSecret(),
          callbackUrl: sso.callbackUrl(),
        }
      : { configured: false, callbackUrl: sso.callbackUrl() },
  });
});

// ─── SMTP (email) settings ────────────────────────────────────

const SmtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  secure: z.boolean().default(false),
  user: z.string().optional(),
  pass: z.string().optional(), // kept if blank
  from: z.string().optional(),
});

router.put('/settings/smtp', async (req: Request, res: Response) => {
  const parsed = SmtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  await saveMailConfig(parsed.data);
  res.json({ success: true });
});

router.post('/settings/smtp/test', async (_req: Request, res: Response) => {
  try {
    res.json(await verifyMailConfig());
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'SMTP test failed' });
  }
});

// ─── SSO (OIDC) settings ──────────────────────────────────────

const SsoSchema = z.object({
  enabled: z.boolean().default(false),
  issuer: z.string().url('Issuer must be a valid URL'),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(), // kept if blank
  scopes: z.string().optional(),
  groupsClaim: z.string().optional(),
  adminGroup: z.string().optional(),
  allowSignup: z.boolean().optional(),
  buttonLabel: z.string().optional(),
});

router.put('/settings/sso', async (req: Request, res: Response) => {
  const parsed = SsoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  await sso.saveSsoConfig(parsed.data);
  await recordAudit({ action: 'admin.sso_config', actor: (req as AuthRequest).user, req });
  res.json({ success: true });
});

router.post('/settings/sso/test', async (_req: Request, res: Response) => {
  try {
    res.json(await sso.verifyDiscovery());
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'SSO discovery failed' });
  }
});

// ─── Password reset (no-SMTP fallback) ────────────────────────

router.get('/password-requests', async (_req: Request, res: Response) => {
  res.json(await listResetRequests());
});

const AdminResetSchema = z.object({ password: z.string().min(8, 'Password must be at least 8 characters') });

router.post('/users/:id/reset-password', async (req: Request, res: Response) => {
  const parsed = AdminResetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const userId = req.params['id'] as string;
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }

  await adminResetPassword(userId, parsed.data.password);
  await recordAudit({
    action: 'admin.reset_password', actor: (req as AuthRequest).user,
    targetType: 'user', targetId: userId, detail: target.email, req,
  });
  res.json({ success: true });
});

// ─── PUT /api/admin/settings/proxmox ──────────────────────────
// tokenSecret is optional — when omitted/blank, the existing secret is kept.

const ProxmoxUpdateSchema = z.object({
  host: z.string().url(),
  tokenId: z.string().min(1),
  tokenSecret: z.string().optional(),
  verifySsl: z.boolean().default(true),
});

router.put('/settings/proxmox', async (req: Request, res: Response) => {
  const parsed = ProxmoxUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { host, tokenId, tokenSecret, verifySsl } = parsed.data;

  await setConfig('proxmox_host', host);
  await setConfig('proxmox_token_id', tokenId);
  await setConfig('proxmox_verify_ssl', String(verifySsl));
  if (tokenSecret && tokenSecret.trim().length > 0) {
    await setConfig('proxmox_token_secret', tokenSecret, true);
  }

  res.json({ success: true });
});

// ─── POST /api/admin/settings/proxmox/test ────────────────────

router.post('/settings/proxmox/test', async (_req: Request, res: Response) => {
  try {
    const result = await testProxmoxConnection();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed';
    res.status(502).json({ connected: false, error: msg });
  }
});

// ─── PUT /api/admin/settings/defaults ─────────────────────────

const DefaultsSchema = z.object({
  storage: z.string().min(1),
  bridge: z.string().min(1),
  isoStorage: z.string().min(1),
});

router.put('/settings/defaults', async (req: Request, res: Response) => {
  const parsed = DefaultsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  await saveDefaults(parsed.data);
  res.json({ success: true });
});

// ─── GET /api/admin/cluster-stats ─────────────────────────────
// Live cluster-wide capacity + usage for the admin/owner dashboard.

router.get('/cluster-stats', async (_req: Request, res: Response) => {
  try {
    const diskPool = (await getConfig('default_storage')) ?? undefined;
    const stats = await getClusterStats(diskPool);
    res.json(stats);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── Helper: derive the management subnet from the default bridge ──

async function suggestMgmtCidr(): Promise<string | null> {
  try {
    const bridge = await getConfig('default_bridge');
    if (!bridge) return null;
    const node = await getDefaultNode();
    const { cidr } = await getBridgeNetwork(bridge, node);
    return cidr ? (ipv4NetworkCidr(cidr) ?? null) : null;
  } catch {
    return null;
  }
}

// ─── GET /api/admin/isolation ─────────────────────────────────
// Tenant network-isolation status. `enforced` is only true when BOTH ProxMate
// applies per-VM firewall rules AND the Proxmox cluster firewall is enabled.

router.get('/isolation', async (_req: Request, res: Response) => {
  const isolationEnabled = (await getConfig('isolation_enabled')) !== 'false';
  let clusterFirewallEnabled = false;
  let reachable = true;
  try {
    clusterFirewallEnabled = await isClusterFirewallEnabled();
  } catch {
    reachable = false;
  }
  res.json({
    isolationEnabled,
    clusterFirewallEnabled,
    enforced: isolationEnabled && clusterFirewallEnabled,
    reachable,
    suggestedMgmtCidr: reachable ? await suggestMgmtCidr() : null,
  });
});

// ─── PUT /api/admin/isolation ─────────────────────────────────

const IsolationSchema = z.object({ enabled: z.boolean() });

router.put('/isolation', async (req: Request, res: Response) => {
  const parsed = IsolationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  await setConfig('isolation_enabled', String(parsed.data.enabled));
  res.json({ success: true });
});

// ─── POST /api/admin/isolation/enforce ────────────────────────
// Safely enable the Proxmox cluster firewall (adds management allow-rules first
// so the admin isn't locked out). This is what actually *enforces* per-VM isolation.

const EnforceSchema = z.object({ managementCidr: z.string().min(1) });

router.post('/isolation/enforce', async (req: Request, res: Response) => {
  const parsed = EnforceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    await setClusterFirewall(true, [parsed.data.managementCidr]);
    res.json({ success: true, enforced: true });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── DELETE /api/admin/isolation/enforce ──────────────────────
// Disable the cluster firewall (stops enforcing; management allow-rules are left in place).

router.delete('/isolation/enforce', async (_req: Request, res: Response) => {
  try {
    await setClusterFirewall(false);
    res.json({ success: true, enforced: false });
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/admin/all-vms ───────────────────────────────────
// Every VM on the cluster, grouped by owner (admin first, then users by
// signup order). Used by the admin monitor dashboard.

router.get('/all-vms', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    include: { vms: { orderBy: { createdAt: 'desc' } } },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
  res.json(
    users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      quota: { cpu: u.maxCpu, ram: u.maxRam, storage: u.maxStorage },
      vms: u.vms,
    })),
  );
});

// ─── GET /api/admin/live-stats ────────────────────────────────
// Live metrics for ALL guests on the cluster in a single Proxmox call.
// Returned as a map keyed by proxmoxVmId so the frontend can do O(1) lookups.

interface PveResource {
  type: string;
  vmid?: number;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  netin?: number;
  netout?: number;
}

router.get('/live-stats', async (_req: Request, res: Response) => {
  try {
    const client = await getClient();
    const r = await client.get<{ data: PveResource[] }>('/cluster/resources');
    const stats: Record<number, {
      status: string;
      cpu: number; maxcpu: number;
      mem: number; maxmem: number;
      disk: number; maxdisk: number;
      uptime: number;
      netin: number; netout: number;
    }> = {};
    for (const item of r.data.data) {
      if ((item.type === 'qemu' || item.type === 'lxc') && item.vmid !== undefined) {
        stats[item.vmid] = {
          status: item.status ?? 'unknown',
          cpu: item.cpu ?? 0,
          maxcpu: item.maxcpu ?? 0,
          mem: item.mem ?? 0,
          maxmem: item.maxmem ?? 0,
          disk: item.disk ?? 0,
          maxdisk: item.maxdisk ?? 0,
          uptime: item.uptime ?? 0,
          netin: item.netin ?? 0,
          netout: item.netout ?? 0,
        };
      }
    }
    res.json(stats);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

export default router;
