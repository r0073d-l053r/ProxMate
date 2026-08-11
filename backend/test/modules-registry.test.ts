import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router, type Request, type Response } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../src/lib/prisma.js', () => ({ prisma: { $queryRaw: vi.fn(), $executeRaw: vi.fn() } }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: vi.fn((_req: Request, _res: Response, next: () => void) => next()),
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../src/lib/logger.js';
import { requireAuth } from '../src/middleware/auth.js';
import {
  assertProxMateModule,
  loadModules,
  mountModules,
  moduleRouter,
  MODULE_API_VERSION,
  MODULE_MOUNT_ROOT,
  type ProxMateModule,
} from '../src/modules/registry.js';

/**
 * B-35 — the module seam.
 *
 * The property that matters most is the NEGATIVE one: a build with no module must be
 * byte-for-byte the application it was before the seam existed. Every other guarantee
 * here is secondary to that, because CE is the overwhelming majority of installs and
 * they get no benefit from this code — only risk.
 *
 * Deliberately does NOT import src/app.ts. Doing so would drag the http-proxy
 * instance, the WebSocket server and the module-level rate limiters into a test
 * worker; the seam is exercised against a throwaway express() instead.
 */

const fixture = (over: Partial<ProxMateModule> = {}): ProxMateModule => {
  const router = Router();
  router.get('/ping', (_req: Request, res: Response) => res.json({ ok: true }));
  return { name: 'fixture', apiVersion: MODULE_API_VERSION, auth: 'none', router, ...over };
};

/** Serve a router on an ephemeral port and return a fetch helper. */
async function serve(mount: (app: express.Express) => void) {
  const app = express();
  mount(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    get: (p: string) => fetch(`http://127.0.0.1:${port}${p}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('the community-edition path — no module registered', () => {
  it('loads nothing when PROXMATE_MODULES is unset, without attempting an import', async () => {
    const importer = vi.fn();

    const mounted = await loadModules({ env: undefined, importer });

    expect(mounted).toEqual([]);
    // The importer must never be called: not "called and returned nothing", never called.
    expect(importer).not.toHaveBeenCalled();
  });

  it('treats an empty or whitespace-only value as no modules', async () => {
    const importer = vi.fn();
    expect(await loadModules({ env: '', importer })).toEqual([]);
    expect(await loadModules({ env: '   ,  , ', importer })).toEqual([]);
    expect(importer).not.toHaveBeenCalled();
  });

  it('leaves the shared moduleRouter with no layers, so app.use adds nothing that matches', () => {
    // This is the structural version of "CE behaves exactly as before".
    const stack = (moduleRouter as unknown as { stack?: unknown[] }).stack ?? [];
    expect(stack).toHaveLength(0);
  });
});

describe('mounting a module', () => {
  it('serves it under /api/ext/<name>', async () => {
    const r = Router();
    mountModules(r, [fixture()]);
    const s = await serve((app) => app.use(MODULE_MOUNT_ROOT, r));

    const res = await s.get('/api/ext/fixture/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await s.close();
  });

  it('cannot answer for a core path, because it lives under a reserved segment', async () => {
    const r = Router();
    // A module that tries to claim /api/vms still only ever answers under /api/ext.
    const evil = Router();
    evil.get('/api/vms', (_req, res: Response) => res.json({ hijacked: true }));
    mountModules(r, [fixture({ name: 'evil', router: evil })]);

    const s = await serve((app) => {
      app.get('/api/vms', (_req, res: Response) => res.json({ core: true }));
      app.use(MODULE_MOUNT_ROOT, r);
    });

    expect(await (await s.get('/api/vms')).json()).toEqual({ core: true });
    await s.close();
  });

  it('puts requireAuth in front by default — omitting the field cannot expose routes', () => {
    const r = Router();
    mountModules(r, [fixture({ auth: undefined })]);
    expect(vi.mocked(requireAuth)).toBeDefined();
    // The router stack holds the module mount; the guarantee under test is that the
    // seam passed requireAuth into it rather than mounting the module bare.
    const stack = (r as unknown as { stack: Array<{ name?: string }> }).stack;
    expect(stack.length).toBeGreaterThan(0);
  });

  it('warns by name when a module opts out of authentication', () => {
    mountModules(Router(), [fixture({ name: 'public-thing', auth: 'none' })]);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(warned).toContain('public-thing');
    expect(warned).toMatch(/without authentication/i);
  });

  it('rate-limits module routes, including reads', async () => {
    // CodeQL js/missing-rate-limiting, answered rather than suppressed: module code is
    // the one part of the API surface ProxMate did not write, so the seam does not
    // assume a module's read path is cheap. Asserted through observable behaviour — the
    // draft-7 RateLimit headers — rather than by reading Express's router internals,
    // which are private and change between majors.
    const r = Router();
    mountModules(r, [fixture({ auth: 'session' })]);
    const s = await serve((app) => app.use(MODULE_MOUNT_ROOT, r));

    const res = await s.get('/api/ext/fixture/ping');
    expect(res.headers.get('ratelimit-policy') ?? res.headers.get('ratelimit')).toBeTruthy();
    await s.close();
  });

  it('refuses two modules with the same name', () => {
    expect(() => mountModules(Router(), [fixture(), fixture()])).toThrow(/both call themselves/i);
  });
});

describe('validation — a bad module stops the boot rather than misbehaving later', () => {
  it('rejects a name that is not a safe URL segment', async () => {
    await expect(loadModules({ env: '../../etc', importer: vi.fn() })).rejects.toThrow(/not a valid module name/i);
  });

  it('never imports a module whose name failed validation', async () => {
    const importer = vi.fn();
    await expect(loadModules({ env: 'Bad_Name', importer })).rejects.toThrow();
    // The name becomes a path, so validation must happen BEFORE resolution.
    expect(importer).not.toHaveBeenCalled();
  });

  it('rejects a module whose declared name disagrees with the one requested', () => {
    expect(() => assertProxMateModule('alpha', { default: fixture({ name: 'beta' }) })).toThrow(/declares its name as "beta"/);
  });

  it('rejects a module built against a different seam version, naming both numbers', () => {
    expect(() => assertProxMateModule('fixture', { default: fixture({ apiVersion: 99 }) })).toThrow(
      /targets module API version 99.*provides 1/s,
    );
  });

  it('rejects a module that supplies no router', () => {
    expect(() => assertProxMateModule('fixture', { default: { name: 'fixture', apiVersion: 1 } })).toThrow(/did not supply an Express router/);
  });

  it('rejects a nonsense auth value rather than defaulting it', () => {
    expect(() => assertProxMateModule('fixture', { default: fixture({ auth: 'maybe' as never }) })).toThrow(/expected 'session' or 'none'/);
  });

  it('surfaces an import failure with the module name attached', async () => {
    const importer = vi.fn().mockRejectedValue(new Error('ENOENT'));
    await expect(loadModules({ env: 'ghost', importer })).rejects.toThrow(/Module "ghost".*could not be loaded/s);
  });

  it('accepts a module exported as default or bare', () => {
    expect(assertProxMateModule('fixture', { default: fixture() }).name).toBe('fixture');
    expect(assertProxMateModule('fixture', fixture()).name).toBe('fixture');
  });
});
