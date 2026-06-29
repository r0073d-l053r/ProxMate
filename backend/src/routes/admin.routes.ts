import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { getConfig, setConfig } from '../services/config.service.js';
import { testProxmoxConnection, saveDefaults } from '../services/setup.service.js';
import {
  isClusterFirewallEnabled,
  getClusterStats,
  getNodesHealth,
  getBridgeNetwork,
  ipv4NetworkCidr,
  setClusterFirewall,
  getDefaultNode,
  getClient,
  pveMessage,
} from '../services/proxmox.service.js';
import { listAudit, recordAudit } from '../services/audit.service.js';
import {
  checkForUpdate,
  getUpdateStatus,
  requestUpdate,
  selfUpdateEnabled,
  currentVersion,
  isValidTag,
} from '../services/update.service.js';
import { getMailConfig, saveMailConfig, verifyMailConfig } from '../services/mail.service.js';
import { getNotifyConfig, saveNotifyConfig, sendTestNotification, NOTIFY_EVENTS } from '../services/notify.service.js';
import * as sso from '../services/sso.service.js';
import { listResetRequests, adminResetPassword } from '../services/password-reset.service.js';
import { refreshVmIps } from '../services/vm.service.js';
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
    notify: await getNotifyConfig(),
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

// ─── Event notifications (webhook + email) ────────────────────

const NotifySchema = z.object({
  webhookUrl: z.string().max(2000).optional(), // blank = webhook disabled
  emailEnabled: z.boolean().default(false),
  emailTo: z.string().max(200).optional(), // blank = all admins
  events: z.array(z.enum(NOTIFY_EVENTS)).default([]),
});

router.put('/settings/notifications', async (req: Request, res: Response) => {
  const parsed = NotifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const url = (parsed.data.webhookUrl ?? '').trim();
  if (url && !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'Webhook URL must start with http:// or https://' });
    return;
  }
  await saveNotifyConfig({
    webhookUrl: url,
    emailEnabled: parsed.data.emailEnabled,
    emailTo: parsed.data.emailTo,
    events: parsed.data.events,
  });
  await recordAudit({ action: 'admin.notify_config', actor: (req as AuthRequest).user, req });
  res.json({ success: true });
});

router.post('/settings/notifications/test', async (_req: Request, res: Response) => {
  try {
    // The test reports per-channel success/failure in the body (200) — a failing
    // webhook/email is data, not a server error. Returning 5xx here would let the
    // edge proxy (e.g. Cloudflare) swap the body for its own error page, hiding the
    // real reason. Only a config error (no channel enabled) is a 400.
    res.json(await sendTestNotification());
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Test failed' });
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

// ─── GET /api/admin/nodes ─────────────────────────────────────
// Per-node health + cluster quorum (the kiosk command center).

router.get('/nodes', async (_req: Request, res: Response) => {
  try {
    res.json(await getNodesHealth());
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
    dnsServers: (await getConfig('isolation_dns_servers')) ?? '',
  });
});

// ─── PUT /api/admin/isolation ─────────────────────────────────

const IsolationSchema = z.object({ enabled: z.boolean(), dnsServers: z.string().optional() });

router.put('/isolation', async (req: Request, res: Response) => {
  const parsed = IsolationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  await setConfig('isolation_enabled', String(parsed.data.enabled));
  // Optional DNS allow-list for the isolation rule-builder. Empty = allow DNS to
  // any resolver (so tenant VMs always resolve names); set = restrict to these IPs.
  if (parsed.data.dnsServers !== undefined) {
    await setConfig('isolation_dns_servers', parsed.data.dnsServers.trim());
  }
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
  // Refresh guest IPs (running VMs) so the owner-grouped list shows live addresses.
  await refreshVmIps(users.flatMap((u) => u.vms));
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

// ─── Updates ──────────────────────────────────────────────────
// Check GitHub Releases for a newer version, surface what's new, and (opt-in)
// hand a one-click apply off to the host-side updater. See update.service.ts.

router.get('/updates/check', async (req: Request, res: Response) => {
  const force = req.query['force'] === 'true';
  try {
    res.json(await checkForUpdate(force));
  } catch {
    res.status(502).json({ error: 'Could not reach GitHub to check for updates. Try again shortly.' });
  }
});

router.get('/updates/status', async (_req: Request, res: Response) => {
  res.json({ enabled: selfUpdateEnabled(), current: currentVersion(), ...(await getUpdateStatus()) });
});

const ApplyUpdateSchema = z.object({ tag: z.string().min(1).max(64) });

router.post('/updates/apply', async (req: Request, res: Response) => {
  if (!selfUpdateEnabled()) {
    res.status(409).json({
      code: 'not_enabled',
      error:
        'One-click updates are not enabled on this server. Set up the host updater (deploy/update.sh) ' +
        'and set SELF_UPDATE_ENABLED=true, or update manually.',
    });
    return;
  }
  const parsed = ApplyUpdateSchema.safeParse(req.body);
  if (!parsed.success || !isValidTag(parsed.data.tag)) {
    res.status(400).json({ error: 'Invalid release tag.' });
    return;
  }
  const user = (req as AuthRequest).user;
  try {
    await requestUpdate(parsed.data.tag, user.email);
    await recordAudit({
      action: 'admin.update_requested', actor: user, targetType: 'system', targetId: parsed.data.tag,
      detail: `requested update to ${parsed.data.tag}`, req,
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Could not queue the update — the control directory may be unwritable.' });
  }
});

export default router;
