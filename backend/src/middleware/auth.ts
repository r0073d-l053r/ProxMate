import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.service.js';
import type { AuthRequest } from '../types/index.js';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized — missing token' });
    return;
  }

  const user = await verifyToken(header.slice(7));
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  (req as AuthRequest).user = user;
  next();
}
