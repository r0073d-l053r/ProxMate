import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Load-bearing wiring in `app.ts` and `docker-entrypoint.sh` that nothing else tests.
 *
 * These are source-shape assertions, deliberately. The orderings below are invisible
 * at runtime until something specific breaks — an editor session mangled by a body
 * parser, a chat payload rejected by a 1 MB cap, every error response silently
 * becoming a stack trace. A unit test that boots the app would not catch a reordering
 * either, because the app still starts fine; it just misbehaves under particular
 * traffic. Reading the file is crude but it is the thing that actually fails when
 * someone moves a line.
 */

const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
const entrypoint = readFileSync(new URL('../docker-entrypoint.sh', import.meta.url), 'utf8');

/** Index of a literal in app.ts; -1 becomes an explicit failure rather than a silent pass. */
const at = (needle: string): number => {
  const i = app.indexOf(needle);
  expect(i, `expected to find ${JSON.stringify(needle)} in app.ts`).toBeGreaterThan(-1);
  return i;
};

describe('the error handler', () => {
  it('declares exactly four parameters', () => {
    // Express decides a handler belongs to the ERROR chain by its declared arity.
    // Deleting an unused `_next`, giving a parameter a default, or wrapping the
    // function silently demotes it to an ordinary middleware — at which point no
    // error is ever handled and every failure becomes an unformatted 500.
    expect(errorHandler.length).toBe(4);
  });

  it('is the last thing mounted', () => {
    const lastUse = app.lastIndexOf('app.use(');
    expect(app.slice(lastUse)).toMatch(/^app\.use\(errorHandler\);/);
  });
});

describe('module seam placement', () => {
  it('mounts after every core route and before the error handler', () => {
    const mount = at('app.use(MODULE_MOUNT_ROOT, moduleRouter)');
    // After the last core route: a module can never shadow a ProxMate endpoint,
    // because Express matches in registration order.
    expect(mount).toBeGreaterThan(at("app.use('/api/broadcast'"));
    // Before the error handler: module errors are rendered like core errors.
    expect(mount).toBeLessThan(at('app.use(errorHandler)'));
  });
});

describe('middleware order that is load-bearing', () => {
  it('mounts the IDE proxy before anything that would rewrite a request', () => {
    // It streams raw bodies to code-server and passes its response headers through.
    // Behind helmet/cors/json-parsing, an editor session is mangled.
    expect(at('mountIdeProxy(app);')).toBeLessThan(at('app.use(observability)'));
    expect(at('mountIdeProxy(app);')).toBeLessThan(at('app.use(helmet())'));
  });

  it('mounts the LLM gateway before the shared body cap and the write limiter', () => {
    // Chat payloads routinely exceed the 1 MB API cap, and streaming chat must not be
    // throttled as a "write".
    const gateway = at("app.use('/api/ide', ideGatewayRoutes)");
    expect(gateway).toBeLessThan(at("app.use(express.json({ limit: '1mb' }))"));
    expect(gateway).toBeLessThan(at("app.use('/api', apiWriteLimiter)"));
  });

  it('mounts the session-authed IDE routes after the gateway', () => {
    expect(at("app.use('/api/ide', ideGatewayRoutes)")).toBeLessThan(at("app.use('/api/ide', ideRoutes)"));
  });
});

describe('the container entrypoint', () => {
  it('applies module migrations after core migrations, never before', () => {
    const core = entrypoint.indexOf('npx prisma migrate deploy');
    const mods = entrypoint.indexOf('migrate-modules.js');
    expect(core).toBeGreaterThan(-1);
    expect(mods).toBeGreaterThan(core);
  });

  it('gates module migrations on PROXMATE_MODULES, so a stock install runs nothing new', () => {
    expect(entrypoint).toMatch(/if \[ -n "\$\{PROXMATE_MODULES:-\}" \]/);
  });

  it('does not defuse set -e on the module step', () => {
    // `|| true` here would let a failed module migration boot the app anyway and serve
    // module routes against missing tables — the worst state in the problem space.
    expect(entrypoint).toMatch(/^set -e/m);
    const line = entrypoint.split('\n').find((l) => l.includes('migrate-modules.js')) ?? '';
    expect(line).not.toMatch(/\|\||;\s*true/);
  });
});
