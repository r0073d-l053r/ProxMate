import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  isSetupComplete,
  createAdmin,
  saveProxmoxConfig,
  testProxmoxConnection,
  getProxmoxResources,
  saveDefaults,
  completeSetup,
  hasAdmin,
} from '../services/setup.service.js';
import { setAuthCookies } from '../lib/cookies.js';

const router = Router();

// ─── Always-accessible: setup status ─────────────────────────

router.get('/status', async (_req: Request, res: Response) => {
  const [setupComplete, adminExists] = await Promise.all([
    isSetupComplete(),
    hasAdmin(),
  ]);
  res.json({ setupComplete, adminExists });
});

// ─── Guard: block all routes below once setup is done ────────

router.use(async (_req: Request, res: Response, next) => {
  const complete = await isSetupComplete();
  if (complete) {
    res.status(403).json({ error: 'Setup already completed' });
    return;
  }
  next();
});

// ─── Step 1: Create admin account ────────────────────────────

const AdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(100),
});

router.post('/admin', async (req: Request, res: Response) => {
  const parsed = AdminSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await createAdmin(parsed.data);
    setAuthCookies(res, result.token, result.csrfToken, result.expiresAt);
    res.json({ success: true, user: result.user });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: msg });
  }
});

// ─── Step 2: Save Proxmox connection config ───────────────────

const ProxmoxConfigSchema = z.object({
  host: z.string().url('Must be a valid URL, e.g. https://192.168.1.100:8006'),
  tokenId: z.string().min(1),
  tokenSecret: z.string().min(1),
  verifySsl: z.boolean().default(true),
});

router.post('/proxmox', async (req: Request, res: Response) => {
  const parsed = ProxmoxConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    await saveProxmoxConfig(parsed.data);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

// ─── Step 2b: Test saved Proxmox connection ───────────────────

router.post('/proxmox/test', async (_req: Request, res: Response) => {
  try {
    const result = await testProxmoxConnection();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed';
    res.status(502).json({ connected: false, error: msg });
  }
});

// ─── Step 3: Fetch available Proxmox resources ────────────────

router.get('/proxmox/resources', async (_req: Request, res: Response) => {
  try {
    const resources = await getProxmoxResources();
    res.json(resources);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch resources';
    res.status(502).json({ error: msg });
  }
});

// ─── Step 3b: Save default VM settings ───────────────────────

const DefaultsSchema = z.object({
  storage: z.string().min(1),
  bridge: z.string().min(1),
  isoStorage: z.string().min(1),
});

router.post('/defaults', async (req: Request, res: Response) => {
  const parsed = DefaultsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    await saveDefaults(parsed.data);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

// ─── Step 4: Finalize setup ───────────────────────────────────

router.post('/complete', async (_req: Request, res: Response) => {
  try {
    const result = await completeSetup();
    setAuthCookies(res, result.token, result.csrfToken, result.expiresAt);
    res.json({ user: result.user, redirectTo: '/' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Setup completion failed';
    res.status(500).json({ error: msg });
  }
});

export default router;
