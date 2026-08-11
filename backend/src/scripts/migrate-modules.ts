import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Apply the Prisma migrations owned by each module named in `PROXMATE_MODULES`.
 *
 * Runs after core migrations, against the same database. Lives under `src/` so `tsc`
 * compiles it to `dist/scripts/migrate-modules.js`, which the Dockerfile's existing
 * `COPY --from=build /app/dist ./dist` already carries — no Dockerfile change, and one
 * implementation of this policy rather than a duplicated shell loop.
 *
 * ── The reason the name guard exists ──────────────────────────────────────────────
 * Core and module migrations share ONE `_prisma_migrations` ledger in the database,
 * and Prisma keys that ledger by **directory name alone**. So a module migration whose
 * directory name happens to match an already-applied core one is treated as already
 * applied: `migrate deploy` prints "No pending migrations to apply", exits 0, raises no
 * checksum error — and the module's table is never created. The failure surfaces later
 * as a missing table at request time, with nothing in the boot log to explain it.
 *
 * Requiring `<timestamp>_<module>_<rest>` makes that collision impossible by
 * construction, and this script refuses to run rather than trusting the convention.
 */

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

function fail(msg: string): never {
  console.error(`[modules] ${msg}`);
  process.exit(1);
}

const names = (process.env['PROXMATE_MODULES'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (names.length === 0) process.exit(0); // the community-edition path

// dist/scripts/ -> /app in the container; src/scripts/ -> backend/ under tsx in dev.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Prisma resolves a relative `file:` URL against the SCHEMA's directory, not the CWD.
 * Left relative, `file:./proxmate.db` would silently create an empty database inside
 * `prisma/modules/<name>/` and migrate that instead of the real one — a failure that
 * looks exactly like success.
 */
function absoluteDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) fail('DATABASE_URL is not set.');
  if (!url.startsWith('file:')) return url; // non-SQLite providers are already absolute
  const p = url.slice('file:'.length);
  if (path.isAbsolute(p)) return url;
  return `file:${path.resolve(appRoot, 'prisma', p)}`;
}

const databaseUrl = absoluteDatabaseUrl();

/** Prisma's own CLI, resolved from node_modules rather than found on PATH. */
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

for (const name of names) {
  if (!NAME_RE.test(name)) {
    fail(`PROXMATE_MODULES entry "${name}" is not a valid module name (lowercase kebab-case). Refusing to resolve it as a path.`);
  }

  // Pre-flight: never migrate for a module whose code is absent. Creating tables for
  // routes that will never be served leaves a database the operator cannot explain.
  const compiled = path.join(appRoot, 'dist', 'modules', name, 'index.js');
  const source = path.join(appRoot, 'src', 'modules', name, 'index.ts');
  if (!existsSync(compiled) && !existsSync(source)) {
    fail(`module "${name}" is named in PROXMATE_MODULES but its code was not found at dist/modules/${name}/ or src/modules/${name}/.`);
  }

  const schema = path.join(appRoot, 'prisma', 'modules', name, 'schema.prisma');
  if (!existsSync(schema)) {
    console.log(`[modules] "${name}" owns no Prisma schema — nothing to migrate.`);
    continue;
  }

  const migrationsDir = path.join(path.dirname(schema), 'migrations');
  if (existsSync(migrationsDir)) {
    const expected = new RegExp(`^\\d{14}_${name}_[a-z0-9_]+$`);
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // migration_lock.toml
      if (!expected.test(entry.name)) {
        fail(
          `module "${name}" migration directory "${entry.name}" must be named <14-digit timestamp>_${name}_<description>. ` +
            'Core and module migrations share one _prisma_migrations ledger keyed by directory name, so an un-namespaced ' +
            'name can silently collide with a core migration and be skipped without error.',
        );
      }
    }
  }

  console.log(`[modules] applying migrations for "${name}"…`);
  // Invoke Prisma's CLI entry point with THIS node binary, rather than shelling out to
  // `npx`. Three reasons, all of which bit during development: `npx` needs a shell on
  // Windows to resolve, `shell: true` concatenates rather than escapes arguments (Node
  // DEP0190) which is a real injection surface for a value that arrived in an
  // environment variable, and `npx` may reach the network for a package that is already
  // a local dependency.
  const res = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (res.status !== 0) fail(`migrations for module "${name}" failed (exit ${String(res.status)}).`);
}
