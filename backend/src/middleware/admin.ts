import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from '../types/index.js';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if ((req as AuthRequest).user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden — admin access required' });
    return;
  }
  next();
}
