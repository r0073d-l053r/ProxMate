import express from 'express';
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
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// Behind a reverse proxy / tunnel (Cloudflare, Tailscale, nginx), set
// TRUST_PROXY to the number of trusted hops so rate limiting & req.ip use the
// real client IP. Default 0 = trust none (direct connections / dev).
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));

// ─── Global Middleware ────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());
// Explicit body cap: bounds request size (DoS) and is large enough for the
// admin template-icon data-URI (~400 KB) that the default 100 KB silently rejected.
app.use(express.json({ limit: '1mb' }));

// ─── Health Check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'proxmate-api', timestamp: new Date().toISOString() });
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
// console.routes (VNC WebSocket proxy) is attached to the HTTP upgrade event in index.ts

// ─── Global Error Handler ─────────────────────────────────────
app.use(errorHandler);

export { app };
