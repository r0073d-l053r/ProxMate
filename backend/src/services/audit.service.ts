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

/** Best-effort client IP (honors `trust proxy` set in app.ts). */
function clientIp(req?: Request): string | null {
  if (!req) return null;
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
