import { Router, type IRouter } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import {
  MODULE_API_VERSION,
  MODULE_MOUNT_ROOT,
  MODULE_NAME_RE,
  type ProxMateModule,
} from './types.js';

export { MODULE_API_VERSION, MODULE_MOUNT_ROOT, MODULE_NAME_RE, type ProxMateModule } from './types.js';

/**
 * The seam itself: one router, mounted once by `app.ts` at {@link MODULE_MOUNT_ROOT}.
 *
 * Modules attach INSIDE it at `/<name>`, which is what makes route shadowing
 * structurally impossible rather than merely discouraged — every module path begins
 * with a segment ProxMate has reserved, so no module can ever answer for `/api/vms`
 * however it is written. It also means `app.ts` never has to be re-read to know where
 * modules live, and CE adding an ordinary route can never collide with a module.
 *
 * Empty in a stock build: `app.use` on an empty router adds one layer that matches
 * nothing under a prefix nothing requests.
 */
export const moduleRouter: IRouter = Router();

/** Injectable for tests, so the loader can be exercised without a module on disk. */
export type ModuleImporter = (name: string) => Promise<unknown>;

const defaultImporter: ModuleImporter = (name) => import(`./${name}/index.js`);

/**
 * Validate an untrusted import result and narrow it to a {@link ProxMateModule}.
 *
 * Every failure throws with the module's name in the message, because the operator
 * reading it has a list of names in `PROXMATE_MODULES` and needs to know which one.
 */
export function assertProxMateModule(name: string, value: unknown): ProxMateModule {
  const mod = (value as { default?: unknown })?.default ?? value;
  if (typeof mod !== 'object' || mod === null) {
    throw new Error(`Module "${name}" did not export a module object (default export missing or not an object).`);
  }
  const m = mod as Partial<ProxMateModule>;
  if (m.name !== name) {
    throw new Error(
      `Module "${name}" declares its name as "${String(m.name)}"; the declared name must match the directory and the PROXMATE_MODULES entry.`,
    );
  }
  if (!MODULE_NAME_RE.test(m.name)) {
    throw new Error(`Module name "${m.name}" is not a usable URL segment — expected lowercase kebab-case matching ${MODULE_NAME_RE}.`);
  }
  if (m.apiVersion !== MODULE_API_VERSION) {
    throw new Error(
      `Module "${name}" targets module API version ${String(m.apiVersion)}, but this ProxMate build provides ${MODULE_API_VERSION}. Rebuild the module against this version.`,
    );
  }
  if (typeof m.router !== 'function') {
    throw new Error(`Module "${name}" did not supply an Express router.`);
  }
  if (m.auth !== undefined && m.auth !== 'session' && m.auth !== 'none') {
    throw new Error(`Module "${name}" set auth to "${String(m.auth)}"; expected 'session' or 'none'.`);
  }
  return m as ProxMateModule;
}

/**
 * Attach validated modules to a router. Separate from {@link loadModules} so tests can
 * mount fixtures into a throwaway `express()` without importing `app.ts` — which would
 * drag the http-proxy instance, the WebSocket server and the module-level rate limiters
 * into a test worker.
 *
 * @returns the mounted sub-paths, for logging.
 */
export function mountModules(target: IRouter, list: readonly ProxMateModule[]): string[] {
  const seen = new Set<string>();
  const mounted: string[] = [];
  for (const m of list) {
    if (seen.has(m.name)) throw new Error(`Two modules both call themselves "${m.name}"; module names must be unique.`);
    seen.add(m.name);

    if (m.auth === 'none') {
      // Never silent. An unauthenticated surface is exactly the thing an operator
      // should be able to find by reading their own startup log.
      logger.warn(
        { module: m.name, path: `${MODULE_MOUNT_ROOT}/${m.name}` },
        'module mounted WITHOUT authentication (auth: none) — every route it exposes is reachable by anyone who can reach the API',
      );
      target.use(`/${m.name}`, m.router);
    } else {
      // Default is fail-closed: forgetting the field cannot expose a module's routes.
      // requireAuth also carries CSRF enforcement for mutating cookie-authed requests.
      target.use(`/${m.name}`, requireAuth, m.router);
    }
    mounted.push(`${MODULE_MOUNT_ROOT}/${m.name}`);
  }
  return mounted;
}

/**
 * Load and mount every module named in `PROXMATE_MODULES`.
 *
 * **Unset or empty is the community-edition path and returns immediately** — no import
 * is attempted, no layer is added, and the request pipeline is exactly what it was
 * before this file existed. That is what makes "CE with no module behaves identically"
 * a structural fact rather than a hope.
 *
 * Deliberately fail-closed: a named module that cannot be imported or does not validate
 * throws, and `index.ts` turns that into a refusal to start. The alternative — boot
 * anyway and 404 — produces the worst state in the problem space, where the container
 * is green, the port is open, and a paid-for feature is simply missing. The escape
 * hatch is config-only: unset `PROXMATE_MODULES` and both this and the module migration
 * step become no-ops, with no image change.
 */
export async function loadModules(
  opts: { env?: string | undefined; importer?: ModuleImporter; target?: IRouter } = {},
): Promise<string[]> {
  const raw = opts.env ?? process.env['PROXMATE_MODULES'] ?? '';
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return [];

  const importer = opts.importer ?? defaultImporter;
  const target = opts.target ?? moduleRouter;

  const loaded: ProxMateModule[] = [];
  for (const name of names) {
    // Checked BEFORE the import: the name becomes a path, so a value like `../../etc`
    // must never reach the resolver.
    if (!MODULE_NAME_RE.test(name)) {
      throw new Error(`PROXMATE_MODULES entry "${name}" is not a valid module name — expected lowercase kebab-case matching ${MODULE_NAME_RE}.`);
    }
    let imported: unknown;
    try {
      imported = await importer(name);
    } catch (err) {
      throw new Error(`Module "${name}" is named in PROXMATE_MODULES but could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
    loaded.push(assertProxMateModule(name, imported));
  }

  const mounted = mountModules(target, loaded);
  logger.info({ modules: mounted }, `mounted ${mounted.length} module router(s)`);
  return mounted;
}
