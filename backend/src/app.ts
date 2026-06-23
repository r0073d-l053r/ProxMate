import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import setupRoutes from './routes/setup.routes.js';
import authRoutes from './routes/auth.routes.js';
import inviteRoutes from './routes/invite.routes.js';
import vmRoutes from './routes/vm.routes.js';
import proxmoxRoutes from './routes/proxmox.routes.js';
import userRoutes from './routes/user.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// ─── Global Middleware ────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

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
// Phase 5: console.routes (VNC WebSocket proxy)

// ─── Global Error Handler ─────────────────────────────────────
app.use(errorHandler);

export { app };
