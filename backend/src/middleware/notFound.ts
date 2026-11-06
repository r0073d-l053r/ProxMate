import type { Request, Response } from 'express';

/**
 * Catch-all for requests no route claimed. Mounted after every route and module and
 * just before the error handler, so an unknown path gets a short JSON body instead of
 * Express's default HTML page (which names the framework and echoes the path back).
 */
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}
