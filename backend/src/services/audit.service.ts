import type { Request } from 'express';
import type { AuditLog } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export interface AuditActor {
  id: string;
  email?: string | null;
}

export interface AuditInput {
  action: string; // dotted verb, e.g. "vm.create", "auth.login"
  actor?: AuditActor | null; // null for anonymous / failed login
  targetType?: string;
  targetId?: string;
  detail?: string;
  req?: Request; // used to capture client IP
}

/**
 * Best-effort client IP. Behind a reverse proxy / tunnel (Cloudflare, nginx),
 * the TCP peer (`req.socket`) is the proxy, so `req.ip` is the *same* address for
 * every request unless `TRUST_PROXY` is configured — which is why the audit log
 * showed one IP for everyone. We therefore prefer the real-client header the edge
 * stamps on each request: Cloudflare's `CF-Connecting-IP` by default (override via
 * `REAL_IP_HEADER`, or set it empty to disable and fall back to `req.ip`). In a
 * tunnel deploy that header is only reachable through the edge, so it isn't
 * client-spoofable; for direct/dev connections it's absent and we use `req.ip`.
 */
function clientIp(req?: Request): string | null {
  if (!req) return null;
  const headerName = (process.env['REAL_IP_HEADER'] ?? 'cf-connecting-ip').toLowerCase();
  if (headerName) {
    const raw = req.headers?.[headerName];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const ip = value?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/**
 * Record one audit entry. **Never throws** — auditing must not break the action
 * it's recording, so failures are logged and swallowed.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.actor?.id ?? null,
        actorEmail: input.actor?.email ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        detail: input.detail ?? null,
        ip: clientIp(input.req),
      },
    });
  } catch (err) {
    console.error(`[audit] failed to record "${input.action}":`, err);
  }
}

export interface ListAuditResult {
  items: AuditLog[];
  total: number;
  limit: number;
  offset: number;
}

/** List audit entries, newest first, with bounded pagination. */
export async function listAudit(opts: { limit?: number; offset?: number } = {}): Promise<ListAuditResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
    prisma.auditLog.count(),
  ]);
  return { items, total, limit, offset };
}

/**
 * The recent audit entries for one target (e.g. a single VM), newest first.
 * Powers the per-VM activity feed — scoped to `targetType`/`targetId` so a tenant
 * only ever sees events for a VM they own (the caller checks ownership first).
 *
 * `hideActionsByAdminsExcept` (owner decision 2026-07-11): a tenant's feed shows
 * what THEY and their shared users did — admin interventions stay off it and live
 * only in the admin-side log. Pass the VM owner's id: rows are kept when the
 * actor is null (system/scheduled), a non-admin, or an admin who IS that owner.
 * Read-time filtering — retroactive by construction, and the append-only,
 * best-effort recording path is untouched.
 */
export async function listAuditForTarget(
  targetType: string,
  targetId: string,
  limit = 20,
  opts: { hideActionsByAdminsExcept?: string } = {},
): Promise<AuditLog[]> {
  let where: Record<string, unknown> = { targetType, targetId };
  if (opts.hideActionsByAdminsExcept !== undefined) {
    const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
    const hiddenIds = admins.map((a) => a.id).filter((id) => id !== opts.hideActionsByAdminsExcept);
    if (hiddenIds.length > 0) {
      where = { ...where, OR: [{ userId: null }, { userId: { notIn: hiddenIds } }] };
    }
  }
  return prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
}
