import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A personal API token whose owner's compute-access window has lapsed answers the
// same 403 access_expired the session path gives, so a script can tell "access
// ended" apart from "bad token" (401).

const ENDED = new Date('2026-01-01T00:00:00Z');
vi.mock('../src/services/api-token.service.js', () => ({
  isApiToken: (t: unknown) => typeof t === 'string' && t.startsWith('pm_'),
  verifyApiToken: vi.fn(async (t: string) => {
    if (t === 'pm_lapsed') return { accessExpired: true, accessExpiresAt: ENDED };
    if (t === 'pm_ok') return { id: 'u1', email: 'a@b.c', role: 'user', displayName: null };
    return null;
  }),
}));
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { requireAuth, allowExpiredAccess } from '../src/middleware/auth.js';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.get('/x', requireAuth, (_req, res) => { res.json({ ok: true }); });
  app.get('/lenient', allowExpiredAccess, requireAuth, (_req, res) => { res.json({ ok: true }); });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = (path: string, token: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

describe('requireAuth with a personal API token', () => {
  it('answers 403 access_expired when the owner\'s access window has lapsed', async () => {
    const res = await get('/x', 'pm_lapsed');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('access_expired');
    expect(body.error).toContain(ENDED.toUTCString());
  });

  it('refuses a lapsed token even on routes that let a lapsed session through', async () => {
    expect((await get('/lenient', 'pm_lapsed')).status).toBe(403);
  });

  it('still answers 401 for an unknown token and passes a valid one', async () => {
    expect((await get('/x', 'pm_unknown')).status).toBe(401);
    expect((await get('/x', 'pm_ok')).status).toBe(200);
  });
});
