import { randomBytes } from 'node:crypto';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function parseExpiry(expiry: string): Date {
  const match = expiry.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error('Invalid expiresIn format — use e.g. "7d", "24h", "60m"');
  const amount = parseInt(match[1]!, 10);
  const multipliers: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
  return new Date(Date.now() + amount * multipliers[match[2]!]!);
}
