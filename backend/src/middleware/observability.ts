import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { httpRequestDuration } from '../lib/metrics.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Per-request correlation id, echoed back in the `x-request-id` header. */
    id?: string;
  }
}

/** A low-cardinality route label for metrics: the matched parameterized path. */
function routeLabel(req: Request): string {
  const path = req.route?.path;
  if (!path) return req.path === '/metrics' ? '/metrics' : 'unmatched';
  return `${req.baseUrl}${path}`;
}

/**
 * Assigns a request id, echoes it in `x-request-id`, then on completion records a
 * latency metric and a single structured access-log line. Health/metrics probes are
 * timed but not access-logged (they'd drown out everything else).
 */
export function observability(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durSec = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe(
      { method: req.method, route: routeLabel(req), status: String(res.statusCode) },
      durSec,
    );
    if (req.path === '/api/health' || req.path === '/metrics') return;
    logger.info(
      { reqId: id, method: req.method, url: req.originalUrl, status: res.statusCode, durMs: Math.round(durSec * 1000) },
      'request',
    );
  });

  next();
}
