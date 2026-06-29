import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

// Defaults are intentionally generous (this is brute-force protection, not a
// per-user API budget) and overridable via env for stricter public deployments.
const WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000);
const MAX = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20);

/** Build a fixed-window IP rate limiter that responds 429 with a JSON error. */
export function createRateLimiter(opts?: {
  windowMs?: number;
  max?: number;
  message?: string;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts?.windowMs ?? WINDOW_MS,
    limit: opts?.max ?? MAX,
    standardHeaders: 'draft-7', // RateLimit-* headers
    legacyHeaders: false,
    message: { error: opts?.message ?? 'Too many requests — please slow down and try again later.' },
  });
}

/**
 * Throttle for credential / invite endpoints — an internet-reachable invite
 * system with no throttling is a brute-force liability. Keyed by client IP, so
 * honor `trust proxy` (set in app.ts) when behind a reverse proxy / tunnel.
 */
export const authLimiter = createRateLimiter();

const API_WRITE_WINDOW_MS = Number(process.env.API_WRITE_RATE_LIMIT_WINDOW_MS ?? 60 * 1000);
const API_WRITE_MAX = Number(process.env.API_WRITE_RATE_LIMIT_MAX ?? 60);

/**
 * Throttle for *mutating* API requests (anything that isn't a safe GET/HEAD/OPTIONS).
 * The auth limiter only guards the login surface; without this a logged-in tenant
 * could spam `POST /api/vms` and hammer Proxmox. Reads/polling are never limited.
 */
export const apiWriteLimiter = rateLimit({
  windowMs: API_WRITE_WINDOW_MS,
  limit: API_WRITE_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  message: { error: 'Too many requests — please slow down and try again later.' },
});
