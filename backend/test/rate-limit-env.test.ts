import { describe, it, expect, vi, afterEach } from 'vitest';
import express, { type RequestHandler } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A non-numeric rate-limit setting keeps the default limit. (A NaN limit would
 * switch the limiter off altogether.) The same applies to the other numeric
 * tunables that are read once at start-up.
 */

let server: http.Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function statuses(limiter: RequestHandler, n: number): Promise<number[]> {
  const app = express();
  app.use('/x', limiter);
  app.get('/x', (_req, res) => {
    res.json({ ok: true });
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/x`;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fetch(url)).status);
  return out;
}

describe('non-numeric rate-limit settings fall back to the defaults', () => {
  it('auth limiter: AUTH_RATE_LIMIT_MAX=abc still allows 20 then refuses', async () => {
    vi.stubEnv('AUTH_RATE_LIMIT_MAX', 'abc');
    vi.stubEnv('AUTH_RATE_LIMIT_WINDOW_MS', 'soon');
    const { authLimiter } = await import('../src/middleware/rate-limit.js');
    const codes = await statuses(authLimiter, 21);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('kiosk exit limiter: KIOSK_EXIT_RATE_LIMIT_MAX=abc still allows 10 then refuses', async () => {
    vi.stubEnv('KIOSK_EXIT_RATE_LIMIT_MAX', 'abc');
    const { kioskExitLimiter } = await import('../src/middleware/rate-limit.js');
    const codes = await statuses(kioskExitLimiter, 11);
    expect(codes[9]).toBe(200);
    expect(codes[10]).toBe(429);
  });

  it('share limiter: SHARE_RATE_LIMIT_MAX=abc still allows 30 then refuses', async () => {
    vi.stubEnv('SHARE_RATE_LIMIT_MAX', 'abc');
    vi.stubEnv('SHARE_RATE_LIMIT_WINDOW_MS', 'soon');
    const { shareLimiter } = await import('../src/middleware/rate-limit.js');
    const codes = await statuses(shareLimiter, 31);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it('gateway limiter: IDE_GATEWAY_RATE_LIMIT_MAX=abc still limits', async () => {
    vi.stubEnv('IDE_GATEWAY_RATE_LIMIT_MAX', 'abc');
    const { gatewayAuthLimiter } = await import('../src/middleware/rate-limit.js');
    const codes = await statuses(gatewayAuthLimiter, 601);
    expect(codes[600]).toBe(429);
  });
});

describe('IDE guest port', () => {
  it('a non-numeric IDE_GUEST_PORT keeps the proxy target on 8080', async () => {
    const { resolveIdeTargetUrl } = await import('../src/services/ide-guest-auth.service.js');
    expect(resolveIdeTargetUrl({ ipAddress: '10.0.0.5' }, { IDE_GUEST_PORT: 'abc' } as NodeJS.ProcessEnv)).toBe(
      'http://10.0.0.5:8080',
    );
    expect(resolveIdeTargetUrl({ ipAddress: '10.0.0.5' }, { IDE_GUEST_PORT: '9000' } as NodeJS.ProcessEnv)).toBe(
      'http://10.0.0.5:9000',
    );
  });
});
