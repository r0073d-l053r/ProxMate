import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireAdmin } from '../src/middleware/admin.js';

/** A minimal Response whose status/json are chainable spies. */
function mockRes() {
  const res = {} as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const call = (user: unknown) => {
  const res = mockRes();
  const next = vi.fn() as unknown as NextFunction;
  requireAdmin({ user } as unknown as Request, res, next);
  return { res, next: next as unknown as ReturnType<typeof vi.fn> };
};

describe('requireAdmin (authorization boundary)', () => {
  it('calls next() for an admin and never responds', () => {
    const { res, next } = call({ role: 'admin' });
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('403s a non-admin user and does NOT call next()', () => {
    const { res, next } = call({ role: 'user' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when there is no authenticated user', () => {
    const { res, next } = call(undefined);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
