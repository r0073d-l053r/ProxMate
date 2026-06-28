import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';
import { setAuthCookies, clearAuthCookies, SESSION_COOKIE, CSRF_COOKIE } from '../src/lib/cookies.js';

function mockRes() {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
}

/** The options object (3rd arg) of the `res.cookie(name, value, options)` call for `name`. */
function optsFor(res: ReturnType<typeof mockRes>, name: string): Record<string, unknown> {
  const call = res.cookie.mock.calls.find((c) => c[0] === name);
  return (call?.[2] ?? {}) as Record<string, unknown>;
}

const future = () => new Date(Date.now() + 60_000);

describe('auth cookies', () => {
  let savedSecure: string | undefined;
  let savedNodeEnv: string | undefined;
  beforeEach(() => {
    savedSecure = process.env['COOKIE_SECURE'];
    savedNodeEnv = process.env['NODE_ENV'];
  });
  afterEach(() => {
    if (savedSecure === undefined) delete process.env['COOKIE_SECURE'];
    else process.env['COOKIE_SECURE'] = savedSecure;
    process.env['NODE_ENV'] = savedNodeEnv;
  });

  it('session cookie is httpOnly + SameSite=Lax (XSS/CSRF posture)', () => {
    const res = mockRes();
    setAuthCookies(res, 'jwt', 'csrf', future());
    expect(optsFor(res, SESSION_COOKIE)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('CSRF cookie is readable by JS (httpOnly:false) for the double-submit header', () => {
    const res = mockRes();
    setAuthCookies(res, 'jwt', 'csrf', future());
    expect(optsFor(res, CSRF_COOKIE)).toMatchObject({ httpOnly: false, sameSite: 'lax' });
  });

  it('honors COOKIE_SECURE=true', () => {
    process.env['COOKIE_SECURE'] = 'true';
    const res = mockRes();
    setAuthCookies(res, 'jwt', 'csrf', future());
    expect(optsFor(res, SESSION_COOKIE)['secure']).toBe(true);
  });

  it('defaults Secure off outside production when COOKIE_SECURE is unset', () => {
    delete process.env['COOKIE_SECURE'];
    process.env['NODE_ENV'] = 'test';
    const res = mockRes();
    setAuthCookies(res, 'jwt', 'csrf', future());
    expect(optsFor(res, SESSION_COOKIE)['secure']).toBe(false);
  });

  it('clamps a past expiry to maxAge 0 (never negative)', () => {
    const res = mockRes();
    setAuthCookies(res, 'jwt', 'csrf', new Date(Date.now() - 5000));
    expect(optsFor(res, SESSION_COOKIE)['maxAge']).toBe(0);
  });

  it('clears both auth cookies on logout', () => {
    const res = mockRes();
    clearAuthCookies(res);
    const cleared = res.clearCookie.mock.calls.map((c) => c[0]);
    expect(cleared).toContain(SESSION_COOKIE);
    expect(cleared).toContain(CSRF_COOKIE);
  });
});
