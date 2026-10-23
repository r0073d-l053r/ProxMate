import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A user's own email preferences: announcement opt-out, activity-email opt-out and
// the weekly digest opt-in. Only the fields sent change, each audited on its own.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        broadcastOptOut: false,
        activityEmailOptOut: false,
        usageDigestOptIn: false,
        ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      })),
    },
  },
}));
// The caller's access window has ended: like the real middleware, requireAuth
// refuses with ACCESS_EXPIRED unless the route opted in with allowExpiredAccess.
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (
    req: { user?: unknown; allowExpiredAccess?: boolean },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (!req.allowExpiredAccess) {
      res.status(403).json({ code: 'ACCESS_EXPIRED' });
      return;
    }
    req.user = { id: 'u1', role: 'user', email: 'u1@example.com', displayName: 'U1' };
    next();
  },
  requireSession: (_req: unknown, _res: unknown, next: () => void) => next(),
  allowExpiredAccess: (req: { allowExpiredAccess?: boolean }, _res: unknown, next: () => void) => {
    req.allowExpiredAccess = true;
    next();
  },
}));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../src/services/twofactor.service.js', () => ({}));
vi.mock('../src/services/sso.service.js', () => ({}));
vi.mock('../src/services/passkey.service.js', () => ({}));
vi.mock('../src/services/kiosk.service.js', () => ({}));
vi.mock('../src/services/account-lockout.service.js', () => ({}));
vi.mock('../src/services/password-reset.service.js', () => ({}));
vi.mock('../src/middleware/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, publicTokenLimiter: pass, kioskExitLimiter: pass };
});

import authRoutes from '../src/routes/auth.routes.js';
import { prisma } from '../src/lib/prisma.js';
import { recordAudit } from '../src/services/audit.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => vi.clearAllMocks());

const put = (body: unknown) =>
  fetch(`${base}/auth/email-preferences`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PUT /api/auth/email-preferences', () => {
  it('is open to an account whose access has ended, so anyone can always opt out', async () => {
    expect((await put({ usageDigestOptIn: false })).status).toBe(200);
  });

  it('opts in to the weekly digest without touching the other preferences', async () => {
    const res = await put({ usageDigestOptIn: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      broadcastOptOut: false,
      activityEmailOptOut: false,
      usageDigestOptIn: true,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { broadcastOptOut: undefined, activityEmailOptOut: undefined, usageDigestOptIn: true },
    });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.usage_digest_optin' }));
  });

  it('opts out of activity emails, and still accepts the broadcast flag alone', async () => {
    await put({ activityEmailOptOut: true });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.activity_email_optout' }));
    vi.mocked(recordAudit).mockClear();
    expect((await put({ broadcastOptOut: true })).status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.broadcast_optout' }));
  });

  it('refuses an empty or malformed body', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ usageDigestOptIn: 'yes' })).status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
