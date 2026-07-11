import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';

// vm.routes.ts pulls in many services; stub the heavy ones so importing the
// module (for the pure guard) doesn't drag in real deps.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { rejectIfSizeLocked } from '../src/routes/vm.routes.js';

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown } as unknown as Response & {
    statusCode: number;
    body: unknown;
  };
  res.status = ((c: number) => {
    res.statusCode = c;
    return res;
  }) as never;
  res.json = ((b: unknown) => {
    res.body = b;
    return res;
  }) as never;
  return res;
}

describe('rejectIfSizeLocked — admin-managed VMs are resize-locked to admins', () => {
  it('blocks a non-admin from resizing an admin-managed VM (403)', () => {
    const res = fakeRes();
    expect(rejectIfSizeLocked({ adminManaged: true, quotaExempt: false }, { role: 'user' }, res)).toBe(true);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/only an admin can resize/i);
  });

  it('blocks a non-admin from resizing a quota-exempt grant (defensive quota-bypass guard)', () => {
    const res = fakeRes();
    expect(rejectIfSizeLocked({ adminManaged: false, quotaExempt: true }, { role: 'user' }, res)).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it('lets an ADMIN resize an admin-managed VM', () => {
    const res = fakeRes();
    expect(rejectIfSizeLocked({ adminManaged: true, quotaExempt: true }, { role: 'admin' }, res)).toBe(false);
    expect(res.statusCode).toBe(0);
  });

  it('lets a tenant resize their OWN normal VM (not admin-managed, not exempt)', () => {
    const res = fakeRes();
    expect(rejectIfSizeLocked({ adminManaged: false, quotaExempt: false }, { role: 'user' }, res)).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});
