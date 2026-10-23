import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import { getMailConfig, sendMail } from './mail.service.js';
import { usageDigestEmail, type DigestVmRow, type RenderedEmail } from '../lib/email-templates.js';
import { SAMPLE_INTERVAL_MINUTES } from './resource-history.service.js';
import { hasAccessEnded } from './access.service.js';

/**
 * Weekly per-tenant usage digest. Each user who opted in (`usageDigestOptIn`,
 * off by default) gets one email covering the past 7 days: their machines, the
 * running time and average CPU/RAM from `ResourceSample`, and their quota in use.
 * The admin can turn the whole digest off (`usage_digest_enabled`, on unless set
 * to 'false' — the per-user opt-in is what decides who gets one).
 *
 * Every query is scoped to the recipient's own user id, and samples are filtered
 * by owner again after they are read, so a digest can only ever describe the
 * recipient's machines. Samples outlive their VM (they are not tied to the row),
 * so a machine deleted during the week still shows its usage, as "Deleted machine".
 */

const DAY_MS = 86_400_000;
export const DIGEST_DAYS = 7;
/** Default schedule: Mondays at 08:00 server time. Override with USAGE_DIGEST_CRON. */
export const DEFAULT_USAGE_DIGEST_CRON = '0 8 * * 1';

export async function isUsageDigestEnabled(): Promise<boolean> {
  return (await getConfig('usage_digest_enabled')) !== 'false';
}

export async function setUsageDigestEnabled(enabled: boolean): Promise<void> {
  await setConfig('usage_digest_enabled', String(enabled));
}

type VmRef = { id: string; name: string };
type Sample = { userId: string; vmId: string; cpu: number; mem: number };

/**
 * Pure: fold one user's samples into per-machine rows. `vms` are the user's
 * current machines; a sample whose VM is no longer among them is a deleted
 * machine. Samples belonging to anyone else are dropped. Current machines come
 * first (by name), then deleted ones; machines with no samples show 0 h.
 */
export function digestRows(userId: string, vms: VmRef[], samples: Sample[]): DigestVmRow[] {
  const agg = new Map<string, { n: number; cpu: number; mem: number }>();
  for (const s of samples) {
    if (s.userId !== userId) continue;
    const a = agg.get(s.vmId) ?? { n: 0, cpu: 0, mem: 0 };
    a.n += 1;
    a.cpu += s.cpu;
    a.mem += s.mem;
    agg.set(s.vmId, a);
  }
  const row = (name: string, exists: boolean, a?: { n: number; cpu: number; mem: number }): DigestVmRow => ({
    name,
    exists,
    runningHours: a ? (a.n * SAMPLE_INTERVAL_MINUTES) / 60 : 0,
    avgCpuPct: a ? (a.cpu / a.n) * 100 : null,
    avgMemMb: a ? a.mem / a.n / (1024 * 1024) : null,
  });
  const known = new Set(vms.map((v) => v.id));
  const current = [...vms].sort((x, y) => x.name.localeCompare(y.name)).map((v) => row(v.name, true, agg.get(v.id)));
  const deleted = [...agg.entries()].filter(([vmId]) => !known.has(vmId)).map(([, a]) => row('', false, a));
  return [...current, ...deleted];
}

/** Build one user's digest for the 7 days before `now`, or null if the user is gone. */
export async function buildUsageDigest(
  userId: string,
  now: Date = new Date(),
): Promise<{ to: string; mail: RenderedEmail } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, maxCpu: true, maxRam: true, maxStorage: true },
  });
  if (!user) return null;
  const since = new Date(now.getTime() - DIGEST_DAYS * DAY_MS);
  const [vms, samples] = await Promise.all([
    prisma.virtualMachine.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, cpu: true, ram: true, storage: true, quotaExempt: true },
    }),
    prisma.resourceSample.findMany({
      where: { userId: user.id, createdAt: { gte: since, lt: now } },
      select: { userId: true, vmId: true, cpu: true, mem: true },
    }),
  ]);
  // Quota use counts what the quota checks count: exempt grants are left out.
  const counted = vms.filter((v) => !v.quotaExempt);
  const sum = (k: 'cpu' | 'ram' | 'storage') => counted.reduce((s, v) => s + v[k], 0);
  const base = ((await getConfig('frontend_url')) ?? process.env['FRONTEND_URL'] ?? '').replace(/\/+$/, '');
  const mail = usageDigestEmail({
    displayName: user.displayName,
    periodStart: since,
    periodEnd: now,
    vms: digestRows(user.id, vms, samples),
    quota: {
      cpu: [sum('cpu'), user.maxCpu],
      ram: [sum('ram'), user.maxRam],
      storage: [sum('storage'), user.maxStorage],
    },
    dashboardUrl: base || undefined,
  });
  return { to: user.email, mail };
}

export interface DigestRunResult {
  ran: boolean;
  reason?: string;
  sent: number;
  failed: number;
}

/**
 * Send every opted-in user their digest. The scheduler's weekly tick. Users whose
 * access window has ended are skipped: they can't sign in, and the digest would
 * keep arriving for an account they can no longer use.
 */
export async function runUsageDigest(now: Date = new Date()): Promise<DigestRunResult> {
  if (!(await isUsageDigestEnabled())) return { ran: false, reason: 'disabled by the admin', sent: 0, failed: 0 };
  if (!(await getMailConfig())) return { ran: false, reason: 'SMTP is not configured', sent: 0, failed: 0 };
  const users = await prisma.user.findMany({
    where: { usageDigestOptIn: true },
    select: { id: true, role: true, accessExpiresAt: true, accessSuspendedAt: true },
  });
  let sent = 0;
  let failed = 0;
  for (const u of users) {
    if (hasAccessEnded(u, now)) continue;
    try {
      const digest = await buildUsageDigest(u.id, now);
      if (!digest) continue;
      await sendMail({ to: digest.to, ...digest.mail });
      sent++;
    } catch (err) {
      // One bad address or a hiccup must not stop everyone else's digest.
      failed++;
      console.warn(`[usage-digest] digest for user ${u.id} failed:`, err);
    }
  }
  return { ran: true, sent, failed };
}
