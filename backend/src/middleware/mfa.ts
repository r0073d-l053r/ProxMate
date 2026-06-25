import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from '../types/index.js';
import { isMfaSetupRequired } from '../services/mfa.service.js';

/**
 * Blocks protected resource access for a user whose admin required two-step auth
 * until they actually set up a method. Must run after `requireAuth`. The frontend
 * redirects such users to /security; this is the server-side backstop.
 */
export async function enforceMfaSetup(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as AuthRequest).user?.id;
  if (userId && (await isMfaSetupRequired(userId))) {
    res.status(403).json({
      error: 'Set up two-step authentication to continue — your administrator requires it.',
      code: 'mfa_setup_required',
    });
    return;
  }
  next();
}
