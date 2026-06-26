import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/auth.service.js', () => ({ verifySession: vi.fn(), verifyEnrollment: vi.fn() }));
vi.mock('../src/services/mfa.service.js', () => ({ isMfaSetupRequired: vi.fn() }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: { user: { findUnique: vi.fn() } } }));

import { requireAuthOrEnrollment } from '../src/middleware/enrollment.js';
import * as authService from '../src/services/auth.service.js';
import * as mfaService from '../src/services/mfa.service.js';
import { prisma } from '../src/lib/prisma.js';
import { SESSION_COOKIE } from '../src/lib/cookies.js';

const verifySession = vi.mocked(authService.verifySession);
const verifyEnrollment = vi.mocked(authService.verifyEnrollment);
const isMfaSetupRequired = vi.mocked(mfaService.isMfaSetupRequired);
const findUser = vi.mocked(prisma.user.findUnique);

const SESSION = { user: { id: 'u1', email: 'a@b.c', role: 'user', displayName: 'A' }, csrfToken: 'good-csrf' };
const ENROLLEE = { id: 'u2', email: 'e@b.c', role: 'user', displayName: 'E' };

function mockRes() {
  return {
    statusCode: 0,
    body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

function mockReq(opts: { cookieToken?: string; bearer?: string; method?: string; csrfHeader?: string }) {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return {
    cookies: opts.cookieToken ? { [SESSION_COOKIE]: opts.cookieToken } : {},
    method: opts.method ?? 'GET',
    headers,
    header(name: string) {
      return name.toLowerCase() === 'x-csrf-token' ? opts.csrfHeader : headers[name.toLowerCase()];
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue(null); // default: no real session
});

describe('requireAuthOrEnrollment', () => {
  it('allows a valid session (a logged-in /security user) and attaches the user', async () => {
    verifySession.mockResolvedValue(SESSION as never);
    const res = mockRes();
    const next = vi.fn();
    const req = mockReq({ cookieToken: 't', method: 'GET' });
    await requireAuthOrEnrollment(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as unknown as { user: { id: string } }).user.id).toBe('u1');
    expect(verifyEnrollment).not.toHaveBeenCalled();
  });

  it('accepts a valid enrollment Bearer token while setup is still required', async () => {
    verifyEnrollment.mockResolvedValue('u2' as never);
    isMfaSetupRequired.mockResolvedValue(true as never);
    findUser.mockResolvedValue(ENROLLEE as never);
    const res = mockRes();
    const next = vi.fn();
    const req = mockReq({ bearer: 'enroll-token', method: 'POST' });
    await requireAuthOrEnrollment(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as unknown as { user: { id: string } }).user.id).toBe('u2');
  });

  it('rejects the enrollment token once a factor exists (token goes inert)', async () => {
    verifyEnrollment.mockResolvedValue('u2' as never);
    isMfaSetupRequired.mockResolvedValue(false as never);
    const res = mockRes();
    const next = vi.fn();
    await requireAuthOrEnrollment(mockReq({ bearer: 'enroll-token', method: 'POST' }), res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s with neither a session nor an enrollment token', async () => {
    const res = mockRes();
    const next = vi.fn();
    await requireAuthOrEnrollment(mockReq({}), res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('still enforces CSRF on a cookie-authenticated mutating request', async () => {
    verifySession.mockResolvedValue(SESSION as never);
    const res = mockRes();
    const next = vi.fn();
    await requireAuthOrEnrollment(
      mockReq({ cookieToken: 't', method: 'POST', csrfHeader: 'wrong' }),
      res as never,
      next,
    );
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
