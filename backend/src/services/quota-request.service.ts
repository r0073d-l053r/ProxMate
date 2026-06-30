import { prisma } from '../lib/prisma.js';

/** A quota-request error carrying an HTTP status the route can surface. */
export class QuotaRequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface PendingQuotaRequest {
  id: string;
  cpu: number;
  ram: number;
  storage: number;
  reason: string | null;
  createdAt: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    quota: { cpu: number; ram: number; storage: number };
  };
}

/** Create a pending request (absolute target caps). One pending per user at a time. */
export async function createQuotaRequest(
  userId: string,
  data: { cpu: number; ram: number; storage: number; reason?: string },
): Promise<void> {
  const existing = await prisma.quotaRequest.findFirst({ where: { userId, status: 'pending' } });
  if (existing) throw new QuotaRequestError('You already have a pending quota request.', 409);
  await prisma.quotaRequest.create({
    data: { userId, cpu: data.cpu, ram: data.ram, storage: data.storage, reason: data.reason?.trim() || null },
  });
}

/** The caller's own requests, newest first. */
export function listMyQuotaRequests(userId: string) {
  return prisma.quotaRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

/** Pending requests + each requester's current quota (admin review queue). */
export async function listPendingQuotaRequests(): Promise<PendingQuotaRequest[]> {
  const rows = await prisma.quotaRequest.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    include: {
      user: { select: { id: true, email: true, displayName: true, maxCpu: true, maxRam: true, maxStorage: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    cpu: r.cpu,
    ram: r.ram,
    storage: r.storage,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    user: {
      id: r.user.id,
      email: r.user.email,
      displayName: r.user.displayName,
      quota: { cpu: r.user.maxCpu, ram: r.user.maxRam, storage: r.user.maxStorage },
    },
  }));
}

/** Approve: apply the requested caps to the user and mark the request resolved. */
export async function approveQuotaRequest(
  id: string,
  adminId: string,
): Promise<{ email: string; cpu: number; ram: number; storage: number }> {
  const row = await prisma.quotaRequest.findUnique({ where: { id }, include: { user: true } });
  if (!row) throw new QuotaRequestError('Request not found', 404);
  if (row.status !== 'pending') throw new QuotaRequestError('This request was already resolved.', 409);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { maxCpu: row.cpu, maxRam: row.ram, maxStorage: row.storage },
    }),
    prisma.quotaRequest.update({
      where: { id },
      data: { status: 'approved', resolvedAt: new Date(), resolvedById: adminId },
    }),
  ]);
  return { email: row.user.email, cpu: row.cpu, ram: row.ram, storage: row.storage };
}

/** Deny: mark resolved without touching the quota. */
export async function denyQuotaRequest(id: string, adminId: string): Promise<{ email: string }> {
  const row = await prisma.quotaRequest.findUnique({ where: { id }, include: { user: true } });
  if (!row) throw new QuotaRequestError('Request not found', 404);
  if (row.status !== 'pending') throw new QuotaRequestError('This request was already resolved.', 409);
  await prisma.quotaRequest.update({
    where: { id },
    data: { status: 'denied', resolvedAt: new Date(), resolvedById: adminId },
  });
  return { email: row.user.email };
}
