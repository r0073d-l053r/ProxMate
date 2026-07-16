import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request } from 'express';

// ide.routes pulls in many services; stub prisma so importing the module (for
// the pure URL helper) doesn't drag in a real DB.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { publicBaseUrl } from '../src/routes/ide.routes.js';

function fakeReq(over: { fwdProto?: string; host?: string; protocol?: string } = {}): Request {
  return {
    headers: over.fwdProto !== undefined ? { 'x-forwarded-proto': over.fwdProto } : {},
    protocol: over.protocol ?? 'http',
    get: (h: string) => (h.toLowerCase() === 'host' ? (over.host ?? 'proxmate.example.com') : undefined),
  } as unknown as Request;
}

const ENV_KEY = 'BACKEND_PUBLIC_URL';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe('publicBaseUrl — the base the in-guest AI agent is told to call', () => {
  it('the operator-configured BACKEND_PUBLIC_URL wins outright (headers ignored)', () => {
    process.env[ENV_KEY] = 'https://proxmate.myhomelab.pro';
    // Even with an edge chain that (wrongly) reports http, the configured URL rules —
    // this is the live failure: Caddy replaced x-forwarded-proto with its own http view,
    // minting http:// gateway URLs whose POSTs got 301-downgraded to GETs.
    expect(publicBaseUrl(fakeReq({ fwdProto: 'http', host: 'wrong-host' }))).toBe(
      'https://proxmate.myhomelab.pro',
    );
  });

  it('trailing slashes on the configured URL are trimmed (clean path joins)', () => {
    process.env[ENV_KEY] = 'https://proxmate.myhomelab.pro///';
    expect(publicBaseUrl(fakeReq())).toBe('https://proxmate.myhomelab.pro');
  });

  it('a blank configured value falls back to header derivation', () => {
    process.env[ENV_KEY] = '   ';
    expect(publicBaseUrl(fakeReq({ fwdProto: 'https', host: 'pm.example.com' }))).toBe(
      'https://pm.example.com',
    );
  });

  it('unset: uses x-forwarded-proto (first hop) + host', () => {
    expect(publicBaseUrl(fakeReq({ fwdProto: 'https, http', host: 'pm.example.com' }))).toBe(
      'https://pm.example.com',
    );
  });

  it('unset + no forwarded header: falls back to req.protocol', () => {
    expect(publicBaseUrl(fakeReq({ protocol: 'http', host: 'localhost:4000' }))).toBe(
      'http://localhost:4000',
    );
  });
});
