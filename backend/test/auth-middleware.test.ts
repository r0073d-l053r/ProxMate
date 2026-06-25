import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/auth.service.js', () => ({ verifySession: vi.fn() }));

import { requireAuth } from '../src/middleware/auth.js';
import * as authService from '../src/services/auth.service.js';
import { SESSION_COOKIE } from '../src/lib/cookies.js';

const verifySession = vi.mocked(authService.verifySession);

const VALID = { user: { id: 'u1', email: 'a@b.c', role: 'user', displayName: 'A' }, csrfToken: 'good-csrf' };

function mockRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
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
  verifySession.mockResolvedValue(VALID as never);
});

describe('requireAuth (cookie + CSRF)', () => {
  it('401s when no session token is present', async () => {
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(mockReq({}) , res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s when the session is invalid', async () => {
    verifySession.mockResolvedValue(null);
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(mockReq({ cookieToken: 't' }), res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a cookie-authenticated GET (no CSRF needed) and attaches the user', async () => {
    const res = mockRes();
    const next = vi.fn();
    const req = mockReq({ cookieToken: 't', method: 'GET' });
    await requireAuth(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as unknown as { user: { id: string } }).user.id).toBe('u1');
  });

  it('403s a cookie-authenticated mutating request with no CSRF header', async () => {
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(mockReq({ cookieToken: 't', method: 'POST' }), res as never, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when the CSRF header does not match the session', async () => {
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(mockReq({ cookieToken: 't', method: 'POST', csrfHeader: 'wrong' }), res as never, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a cookie-authenticated mutating request with the matching CSRF header', async () => {
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(mockReq({ cookieToken: 't', method: 'POST', csrfHeader: 'good-csrf' }), res as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('exempts Bearer (API) clients from CSRF on mutating requests', async () => {
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(mockReq({ bearer: 't', method: 'POST' }), res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});
