import type { Request } from 'express';

/**
 * Whether a caller may see monitoring detail (the /api/health breakdown). Same rule as
 * /metrics: with METRICS_TOKEN set, the caller must send it as a Bearer token; with no
 * token, detail is open outside production (local/dev) and closed in production.
 */
export function monitoringAuthorized(req: Pick<Request, 'headers'>): boolean {
  const token = process.env['METRICS_TOKEN'];
  if (token) return req.headers.authorization === `Bearer ${token}`;
  return (process.env.NODE_ENV || 'development') !== 'production';
}
