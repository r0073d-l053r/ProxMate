import { Router, type Request, type Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { MODULE_API_VERSION, type ProxMateModule } from '../types.js';

/**
 * The reference module. Committed so the seam has a working example and so CI can
 * prove both halves of it, but **inert unless `PROXMATE_MODULES=example`** — a stock
 * ProxMate never imports this file.
 *
 * It exists to demonstrate exactly two things: a router mounted at `/api/ext/example`,
 * and a table this module owns via its own Prisma unit in `prisma/modules/example/`.
 *
 * Note it reads its own table through CE's **singleton** Prisma client with
 * `$queryRaw`, not a client of its own. That is the whole reason the module schema has
 * no `generator` block: a second generated client means a second connection pool
 * against a single-writer SQLite file, which is how you manufacture SQLITE_BUSY.
 */
const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<Array<{ hits: number }>>`SELECT hits FROM ModuleExample WHERE key = 'default'`;
    res.json({ module: 'example', apiVersion: MODULE_API_VERSION, hits: rows[0]?.hits ?? 0 });
  } catch {
    // Mapped locally on purpose: CE's errorHandler flattens everything to an opaque
    // 500, so a module that wants a useful status must set it itself.
    res.status(503).json({ error: 'example module table missing — run npm run db:migrate:modules' });
  }
});

router.post('/', async (_req: Request, res: Response) => {
  try {
    await prisma.$executeRaw`INSERT INTO ModuleExample (key, hits) VALUES ('default', 1)
      ON CONFLICT(key) DO UPDATE SET hits = hits + 1`;
    const rows = await prisma.$queryRaw<Array<{ hits: number }>>`SELECT hits FROM ModuleExample WHERE key = 'default'`;
    res.json({ module: 'example', hits: rows[0]?.hits ?? 0 });
  } catch {
    res.status(503).json({ error: 'example module table missing — run npm run db:migrate:modules' });
  }
});

const exampleModule: ProxMateModule = {
  name: 'example',
  apiVersion: MODULE_API_VERSION,
  // Default ('session') would be right for a real module. Stated explicitly here so
  // the example shows the field rather than hiding the decision behind a default.
  auth: 'session',
  router,
};

export default exampleModule;
