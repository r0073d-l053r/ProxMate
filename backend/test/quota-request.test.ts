import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    quotaRequest: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    user: { update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  createQuotaRequest,
  approveQuotaRequest,
  denyQuotaRequest,
} from '../src/services/quota-request.service.js';

const qrFindFirst = vi.mocked(prisma.quotaRequest.findFirst);
const qrCreate = vi.mocked(prisma.quotaRequest.create);
const qrFindUnique = vi.mocked(prisma.quotaRequest.findUnique);
const qrUpdate = vi.mocked(prisma.quotaRequest.update);
const userUpdate = vi.mocked(prisma.user.update);
const tx = vi.mocked(prisma.$transaction);

beforeEach(() => {
  vi.clearAllMocks();
  tx.mockResolvedValue([] as never);
  qrCreate.mockResolvedValue({} as never);
  qrUpdate.mockResolvedValue({} as never);
  userUpdate.mockResolvedValue({} as never);
});

describe('createQuotaRequest', () => {
  it('rejects a second pending request', async () => {
    qrFindFirst.mockResolvedValue({ id: 'x' } as never);
    await expect(createQuotaRequest('u1', { cpu: 8, ram: 16384, storage: 200 })).rejects.toMatchObject({ status: 409 });
    expect(qrCreate).not.toHaveBeenCalled();
  });

  it('creates when none pending (trims the reason)', async () => {
    qrFindFirst.mockResolvedValue(null as never);
    await createQuotaRequest('u1', { cpu: 8, ram: 16384, storage: 200, reason: '  more please  ' });
    expect(qrCreate).toHaveBeenCalledWith({
      data: { userId: 'u1', cpu: 8, ram: 16384, storage: 200, reason: 'more please' },
    });
  });
});

describe('approveQuotaRequest', () => {
  it('applies the requested caps to the user and resolves the request', async () => {
    qrFindUnique.mockResolvedValue({
      id: 'q1', userId: 'u1', cpu: 8, ram: 16384, storage: 200, status: 'pending', user: { email: 'a@b.c' },
    } as never);
    const r = await approveQuotaRequest('q1', 'admin1');
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { maxCpu: 8, maxRam: 16384, maxStorage: 200 },
    });
    expect(qrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q1' }, data: expect.objectContaining({ status: 'approved', resolvedById: 'admin1' }) }),
    );
    expect(r.email).toBe('a@b.c');
  });

  it('refuses to re-resolve, and 404s on a missing request', async () => {
    qrFindUnique.mockResolvedValue({ status: 'approved', user: {} } as never);
    await expect(approveQuotaRequest('q1', 'admin1')).rejects.toMatchObject({ status: 409 });
    qrFindUnique.mockResolvedValue(null as never);
    await expect(approveQuotaRequest('q1', 'admin1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('denyQuotaRequest', () => {
  it('marks denied without changing the quota', async () => {
    qrFindUnique.mockResolvedValue({ id: 'q1', status: 'pending', user: { email: 'a@b.c' } } as never);
    await denyQuotaRequest('q1', 'admin1');
    expect(userUpdate).not.toHaveBeenCalled();
    expect(qrUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'denied' }) }));
  });
});
