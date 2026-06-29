import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ reqId: req.id, err: { message: err.message, stack: err.stack } }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
