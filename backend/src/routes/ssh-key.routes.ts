import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
  listSshKeys,
  addSshKey,
  deleteSshKey,
  isValidPublicKey,
  DuplicateKeyError,
  TooManyKeysError,
} from '../services/ssh-key.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth);

// ─── GET /api/ssh-keys ────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  res.json(await listSshKeys(user.id));
});

// ─── POST /api/ssh-keys ───────────────────────────────────────

const CreateSchema = z.object({
  name: z.string().min(1).max(60),
  publicKey: z.string().min(1).max(16_384),
});

router.post('/', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  if (!isValidPublicKey(parsed.data.publicKey)) {
    res.status(400).json({ error: "That doesn't look like an OpenSSH public key." });
    return;
  }
  try {
    const key = await addSshKey(user.id, parsed.data.name, parsed.data.publicKey);
    res.status(201).json(key);
  } catch (err) {
    if (err instanceof DuplicateKeyError || err instanceof TooManyKeysError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// ─── DELETE /api/ssh-keys/:id ─────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const ok = await deleteSshKey(user.id, req.params['id'] as string);
  if (!ok) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ success: true });
});

export default router;
