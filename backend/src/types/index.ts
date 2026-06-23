import type { Request } from 'express';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  displayName: string;
}

export interface AuthRequest extends Request {
  user: AuthUser;
}
