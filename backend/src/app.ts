import express, { type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import setupRoutes from './routes/setup.routes.js';
import authRoutes from './routes/auth.routes.js';
import inviteRoutes from './routes/invite.routes.js';
import vmRoutes from './routes/vm.routes.js';
import proxmoxRoutes from './routes/proxmox.routes.js';
import userRoutes from './routes/user.routes.js';
import adminRoutes from './routes/admin.routes.js';
import templateRoutes from './routes/template.routes.js';
import sshKeyRoutes from './routes/ssh-key.routes.js';
import apiTokenRoutes from './routes/api-token.routes.js';
import quotaRequestRoutes from './routes/quota-request.routes.js';
import passthroughRequestRoutes from './routes/passthrough-request.routes.js';
import downloadRoutes from './routes/download.routes.js';
import { openApiSpec } from './lib/openapi.js';
import { errorHandler } from './middleware/errorHandler.js';
import { observability } from './middleware/observability.js';
import { apiWriteLimiter } from './middleware/rate-limit.js';
import { prisma } from './lib/prisma.js';
import { registry } from './lib/metrics.js';
import { getVersion } from './services/proxmox.service.js';

const app = express();

// Behind a reverse proxy / tunnel (Cloudflare, Tailscale, nginx), set
// TRUST_PROXY to the number of trusted hops so rate limiting & req.ip use the
// real client IP. Default 0 = trust none (direct connections / dev).
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));

// ─── Global Middleware ────────────────────────────────────────
// Request id + structured access log + latency metric, first so everything is covered.
app.use(observability);
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());
// Explicit body cap: bounds request size (DoS) and is large enough for the
// admin template-icon data-URI (~400 KB) that the default 100 KB silently rejected.
app.use(express.json({ limit: '1mb' }));
// Throttle all mutating API requests (skips safe GETs) — see rate-limit.ts.
app.use('/api', apiWriteLimiter);

// ─── Health & Observability ───────────────────────────────────
// Liveness always checks the DB; `?deep=1` additionally probes Proxmox (slower).
app.get('/api/health', async (req: Request, res: Response) => {
  const deep = req.query['deep'] === '1' || req.query['deep'] === 'true';
  const checks: Record<string, string> = {};
  let ok = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks['db'] = 'ok';
  } catch {
    checks['db'] = 'down';
    ok = false;
  }
  if (deep) {
    try {
      await getVersion();
      checks['proxmox'] = 'ok';
    } catch {
      // Proxmox being unreachable is reported but isn't a liveness failure —
      // the app can still serve auth/UI while the cluster is down.
      checks['proxmox'] = 'unreachable';
    }
  }
  res
    .status(ok ? 200 : 503)
    .json({ status: ok ? 'ok' : 'degraded', service: 'proxmate-api', checks, timestamp: new Date().toISOString() });
});

// Prometheus scrape endpoint. Guard with METRICS_TOKEN (Bearer) when exposed.
app.get('/metrics', async (req: Request, res: Response) => {
  const token = process.env['METRICS_TOKEN'];
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.status(401).end();
    return;
  }
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// Machine-readable API description for the public REST API (CLI / Terraform / clients).
app.get('/api/openapi.json', (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

// ─── Routes ───────────────────────────────────────────────────
app.use('/api/setup', setupRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/vms', vmRoutes);
app.use('/api/proxmox', proxmoxRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/ssh-keys', sshKeyRoutes);
app.use('/api/api-tokens', apiTokenRoutes);
app.use('/api/quota-requests', quotaRequestRoutes);
app.use('/api/passthrough-requests', passthroughRequestRoutes);
// Public (token-authenticated) backup downloads — no session required.
app.use('/api/downloads', downloadRoutes);
// console.routes (VNC WebSocket proxy) is attached to the HTTP upgrade event in index.ts

// ─── Global Error Handler ─────────────────────────────────────
app.use(errorHandler);

export { app };
