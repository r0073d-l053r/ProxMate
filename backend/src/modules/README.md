# ProxMate modules

A **module** is a self-contained directory that adds API routes — and optionally its own
database tables — to a ProxMate build, without patching `app.ts` and inheriting a merge
conflict on every upgrade.

A stock ProxMate ships no modules and mounts none. Everything here is inert until you
name a module in `PROXMATE_MODULES`.

## Writing one

`src/modules/<name>/index.ts`, default-exporting a `ProxMateModule`:

```ts
import { Router } from 'express';
import { MODULE_API_VERSION, type ProxMateModule } from '../types.js';

const router = Router();
router.get('/things', async (_req, res) => res.json({ things: [] }));

export default { name: 'mything', apiVersion: MODULE_API_VERSION, router } satisfies ProxMateModule;
```

Enable it with `PROXMATE_MODULES=mything`. It is served at `/api/ext/mything/things`.

Names are lowercase kebab-case. That is a security control, not a style rule: the name
becomes both a URL segment and a path on disk.

## What a module gets, and what it cannot do

You supply a **`Router`**, never the Express `app`. The seam owns the `app.use()` call,
which is what makes it structurally impossible for a module to add app-level middleware,
reorder helmet/CORS/body caps, or register a 4-argument function that Express would
silently promote to an error handler.

Every module router inherits, from the core app: helmet, CORS, `cookie-parser`, the 1 MB
JSON body cap, the mutating-request rate limiter, request-id + access logging + metrics,
and the shared error handler.

Two consequences worth knowing before you debug them:

- **Map your own status codes.** The core error handler flattens anything thrown into an
  opaque 500. If you want a 404 or a 409, set it in the handler — see
  `src/routes/quota-request.routes.ts` for the idiom.
- **Express 5 route syntax.** A bare `'*'` path throws at import, which the seam turns
  into a refused boot.

## Authentication

`auth` defaults to `'session'`: the seam puts `requireAuth` in front of your router,
which also enforces CSRF on mutating cookie-authenticated requests. Forgetting the field
cannot expose your routes.

`auth: 'none'` mounts the router unauthenticated — legitimate for a webhook receiver or
an emailed unsubscribe link, which is why ProxMate itself needs it. It is logged by name
at every boot, so an unauthenticated surface is never a quiet decision.

Add `requireAdmin` or per-route guards inside your own router as normal. You may add
guards; you cannot remove the default one.

## Owning database tables

A module that needs tables gets its own Prisma unit:

```
prisma/modules/<name>/schema.prisma
prisma/modules/<name>/migrations/<14-digit-timestamp>_<name>_<description>/migration.sql
```

The schema declares a `datasource` pointed at the same `DATABASE_URL` and **no
`generator` block**. That is deliberate: a generated client per module means a second
connection pool against a single-writer SQLite file. Read your tables through the core
singleton (`src/lib/prisma.ts`) with `$queryRaw` / `$executeRaw`.

**Migration directories must be named `<timestamp>_<module>_<description>`.** Core and
module migrations share one `_prisma_migrations` ledger, and Prisma keys it by directory
name alone — so a module migration whose name collides with a core one is treated as
already applied: "No pending migrations", exit 0, no error, and your table is never
created. `npm run db:migrate:modules` refuses to run rather than trust the convention.

Do not add a Prisma `@relation` to a core model. A one-sided relation fails validation,
and the back-relation would have to be added to the core schema. Reference core rows by
plain scalar id columns.

### Authoring a migration

```bash
DATABASE_URL="file:/absolute/path/to/scratch.db" \
  npx prisma migrate dev --name mything_init \
  --schema prisma/modules/mything/schema.prisma --skip-generate
```

Two rules, both learned the hard way:

- **Use a throwaway database, never the real one.** Core's own migrations look like
  foreign drift to a module schema, and `migrate dev` will offer to reset.
- **The URL must be absolute.** Prisma resolves a relative `file:` URL against the
  *schema file's* directory, so `file:./proxmate.db` silently creates an empty database
  inside `prisma/modules/mything/` and migrates that instead.

Then rename the generated directory to satisfy the namespace rule.

## How it runs

`npm run db:migrate:modules` locally; in the container the entrypoint runs the same
script, after core migrations, only when `PROXMATE_MODULES` is set.

A module named in `PROXMATE_MODULES` that cannot be loaded, fails validation, or whose
migrations fail **stops the boot**. The alternative — start anyway — gives you a green
container with an open port and a silently missing feature. To recover, unset
`PROXMATE_MODULES`: that disables the router mount and the migration step together, with
no image change.
