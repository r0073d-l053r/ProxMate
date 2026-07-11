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

/**
 * Dedicated throttle for public token-bearing GETs that are cheap to probe
 * (invite lookup, download tokens). Complements authLimiter (which only covers
 * credential POSTs) so a scanner can't hammer these as a free oracle.
 */
export const publicTokenLimiter = createRateLimiter({
  windowMs: Number(process.env.PUBLIC_TOKEN_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
  max: Number(process.env.PUBLIC_TOKEN_RATE_LIMIT_MAX ?? 60),
  message: 'Too many requests — please slow down and try again later.',
});

/**
 * Pre-auth throttle for the IDE LLM gateway. The gateway is exempt from
 * apiWriteLimiter (chat streaming must not be throttled mid-conversation), so
 * without this the Bearer-token verification — a hash + DB lookup on every
 * request — would be an unthrottled surface for token brute-forcing / DoS.
 * Keyed by IP and deliberately generous: several IDE VMs behind one NAT egress
 * share this budget, and the finer per-VM fixed window inside the gateway
 * routes handles per-tenant fairness after the token verifies.
 */
export const gatewayAuthLimiter = rateLimit({
  windowMs: Number(process.env.IDE_GATEWAY_RATE_LIMIT_WINDOW_MS ?? 60 * 1000),
  limit: Number(process.env.IDE_GATEWAY_RATE_LIMIT_MAX ?? 600),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { message: 'ProxMate IDE gateway: rate limit exceeded, slow down', type: 'rate_limit_error' },
  },
});
