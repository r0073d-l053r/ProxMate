import { Router, type Request, type Response, type NextFunction } from 'express';
import { Readable } from 'node:stream';
import {
  verifyGatewayToken,
  listGatewayModels,
  resolveModelRoute,
  type GatewayContext,
} from '../services/ide-gateway.service.js';
import { logger } from '../lib/logger.js';

/**
 * ProxMate LLM gateway routes — the OpenAI-compatible surface the in-guest AI
 * agent (OpenCode) calls at `/api/ide/:id/llm/v1/*`. Auth is the per-VM gateway
 * token (Bearer), NOT the browser session cookie, so these are exempt from CSRF
 * (no cookie = no CSRF surface, like the public API-token clients).
 *
 * Mounted BEFORE the session-authed ide.routes at `/api/ide` and deliberately
 * WITHOUT any router-level middleware, so a non-`/llm/` request (e.g. `/config`,
 * `/:id/gateway-token`) simply doesn't match here and falls through to the
 * session-authed router. Every LLM handler is individually gated by
 * `requireGatewayToken`.
 */

const router = Router();

interface GwRequest extends Request {
  gw?: GatewayContext;
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** Gate on a gateway token that must be scoped to the `:id` VM in the path. */
async function requireGatewayToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const vmId = req.params['id'] as string;
  const ctx = await verifyGatewayToken(bearer(req), vmId);
  if (!ctx) {
    res
      .status(401)
      .json({ error: { message: 'Invalid or expired ProxMate IDE gateway token', type: 'invalid_request_error' } });
    return;
  }
  (req as GwRequest).gw = ctx;
  next();
}

// ─── GET /api/ide/:id/llm/v1/models ───────────────────────────
// The models this token's user may use (shared:* always, byo:* when BYO is on).
// Never leaks the upstream endpoint, credentials, or real model names.
router.get('/:id/llm/v1/models', requireGatewayToken, async (req: Request, res: Response) => {
  const gw = (req as GwRequest).gw as GatewayContext;
  const data = await listGatewayModels(gw.user);
  res.json({ object: 'list', data });
});

// ─── POST /api/ide/:id/llm/v1/chat/completions ────────────────
// Enforce the allow-list (resolveModelRoute → 403 if not permitted), rewrite the
// model to its real upstream name, then forward — streaming the SSE response
// straight through when the client asked for `stream: true`.
router.post('/:id/llm/v1/chat/completions', requireGatewayToken, async (req: Request, res: Response) => {
  const gw = (req as GwRequest).gw as GatewayContext;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const modelId = typeof body['model'] === 'string' ? (body['model'] as string) : '';

  const route = await resolveModelRoute(gw.user, modelId);
  if (!route) {
    res
      .status(403)
      .json({ error: { message: `Model not available: ${modelId || '(none)'}`, type: 'invalid_request_error' } });
    return;
  }

  const wantStream = body['stream'] === true;
  const upstreamBody = JSON.stringify({ ...body, model: route.model });

  try {
    const upstream = await fetch(`${route.url}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}),
      },
      body: upstreamBody,
    });

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);

    if (wantStream && upstream.body) {
      res.setHeader('cache-control', 'no-cache');
      // Pipe the upstream SSE stream straight to the client, unbuffered.
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } else {
      res.send(await upstream.text());
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, kind: route.kind }, 'ide gateway upstream error');
    if (!res.headersSent) {
      res.status(502).json({ error: { message: 'ProxMate IDE gateway: upstream unreachable', type: 'api_error' } });
    } else {
      res.end();
    }
  }
});

export default router;
