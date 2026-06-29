import { randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import type { AuthUser } from '../types/index.js';

const PREFIX = 'pm_';
const DISPLAY_PREFIX_LEN = 11; // `pm_` + 8 chars

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** True if a bearer value looks like a ProxMate API token (vs a session JWT). */
export function isApiToken(bearer: string | undefined | null): boolean {
  return !!bearer && bearer.startsWith(PREFIX);
}

export interface CreatedApiToken {
  id: string;
  name: string;
  token: string; // the raw secret — shown to the caller exactly once
  createdAt: Date;
}

/** Mint a new token for a user. Returns the raw secret (never stored in clear). */
export async function createApiToken(userId: string, name: string): Promise<CreatedApiToken> {
  const raw = PREFIX + randomBytes(24).toString('base64url');
  const row = await prisma.apiToken.create({
    data: { userId, name, tokenHash: hashToken(raw), prefix: raw.slice(0, DISPLAY_PREFIX_LEN) },
  });
  return { id: row.id, name: row.name, token: raw, createdAt: row.createdAt };
}

/** A token's non-secret metadata (for listing in the UI). */
export function listApiTokens(userId: string) {
  return prisma.apiToken.findMany({
    where: { userId },
    select: { id: true, name: true, prefix: true, lastUsedAt: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** Revoke one of the user's tokens. Returns false if it wasn't theirs / didn't exist. */
export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  const r = await prisma.apiToken.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

/**
 * Resolve a raw API token to the user it authenticates, or null if it's unknown or
 * expired. Best-effort updates `lastUsedAt` without blocking the request.
 */
export async function verifyApiToken(raw: string): Promise<AuthUser | null> {
  if (!isApiToken(raw)) return null;
  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: { select: { id: true, email: true, role: true, displayName: true } } },
  });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return row.user;
}
