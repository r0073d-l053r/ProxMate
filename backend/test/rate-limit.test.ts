import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRateLimiter } from '../src/middleware/rate-limit.js';

let server: http.Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** Spin a throwaway express app with the limiter on /limited; return its base URL. */
async function startApp(max: number): Promise<string> {
  const app = express();
  app.use('/limited', createRateLimiter({ max, windowMs: 60_000 }));
  app.get('/limited', (_req, res) => {
    res.json({ ok: true });
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('rate limiter (brute-force protection)', () => {
  it('allows requests up to the limit, then returns 429', async () => {
    const base = await startApp(3);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await fetch(`${base}/limited`)).status);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
  });

  it('returns a JSON error body when throttled', async () => {
    const base = await startApp(1);
    await fetch(`${base}/limited`);
    const blocked = await fetch(`${base}/limited`);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toHaveProperty('error');
  });

  it('emits standard RateLimit headers', async () => {
    const base = await startApp(5);
    const res = await fetch(`${base}/limited`);
    expect(res.headers.get('ratelimit')).toBeTruthy();
  });
});
