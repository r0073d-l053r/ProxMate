import type { Router } from 'express';

/**
 * The module seam.
 *
 * ProxMate's community edition ships no modules and mounts none. This file exists so
 * that a build which DOES carry one — an internal integration, a site-specific
 * dashboard, a commercial add-on — has exactly one supported way to attach itself,
 * instead of patching `app.ts` and inheriting a merge conflict on every upgrade.
 *
 * The seam is deliberately narrow. A module contributes **routes and tables**. It does
 * not get to configure the application.
 */

/** Bumped when a change here would break an existing module. */
export const MODULE_API_VERSION = 1;

/** Every module's routes live under this prefix. */
export const MODULE_MOUNT_ROOT = '/api/ext';

/**
 * Module names: lowercase kebab.
 *
 * This is a security control, not a style rule. The name is used both as a URL segment
 * and to resolve a path on disk, so anything permitting `.`, `/` or `..` would turn
 * `PROXMATE_MODULES` into a path-traversal primitive.
 */
export const MODULE_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

export interface ProxMateModule {
  /** Mounted at `/api/ext/<name>`. Must match {@link MODULE_NAME_RE}. */
  readonly name: string;

  /**
   * The seam version this module was written against. Checked at boot: a module built
   * for an older seam fails loudly at startup rather than misbehaving at request time.
   */
  readonly apiVersion: number;

  /**
   * The module's routes.
   *
   * This is a `Router`, not a `registerRoutes(app)` hook, and that is the single most
   * important decision in the seam. A hook handed the `app` could re-mount at `/`,
   * insert a body parser ahead of the IDE proxy, replace helmet's configuration, or
   * register a 4-argument function that Express silently promotes to an error handler.
   * A router property makes every one of those structurally impossible, because the
   * seam — not the module — owns the `app.use(path, router)` call.
   */
  readonly router: Router;

  /**
   * Whether the seam wraps this module's routes in `requireAuth`.
   *
   * Defaults to `'session'`: fail closed, so forgetting the field cannot expose a
   * module's routes. `'none'` exists because ProxMate itself needs it — the broadcast
   * unsubscribe link and the download endpoints are deliberately session-less — and a
   * seam that made public routes impossible would just push authors back to patching
   * `app.ts`. Choosing `'none'` is logged by name at boot, so an unauthenticated module
   * is never a quiet decision.
   */
  readonly auth?: 'session' | 'none';
}
