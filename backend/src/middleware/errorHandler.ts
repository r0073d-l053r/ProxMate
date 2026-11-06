import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

// `expose` is the http-errors flag (set by the body parser on a malformed or oversized
// JSON body). Upstream errors, such as a Proxmox call that failed, never carry it, so
// their status is never passed on to the browser.
type HttpError = Error & { status?: number; expose?: boolean };

export function errorHandler(err: HttpError, req: Request, res: Response, _next: NextFunction): void {
  if (err.expose === true && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.status === 413 ? 'Request body too large' : 'Bad request' });
    return;
  }
  logger.error({ reqId: req.id, err: { message: err.message, stack: err.stack } }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
