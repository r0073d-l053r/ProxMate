import { describe, it, expect, vi, beforeEach } from 'vitest';

// The weekly digest describes only the recipient's own machines and usage, goes
// only to users who opted in, and is skipped entirely when the admin turned it
// off or SMTP is not set up.

type Where = { userId?: string; usageDigestOptIn?: boolean; createdAt?: { gte: Date; lt: Date } };

const USERS = [
  { id: 'alice', email: 'alice@example.com', displayName: 'Alice', maxCpu: 8, maxRam: 8192, maxStorage: 100, usageDigestOptIn: true },
  { id: 'bob', email: 'bob@example.com', displayName: 'Bob', maxCpu: 4, maxRam: 4096, maxStorage: 50, usageDigestOptIn: false },
  // Opted in, but their access window has ended / they are suspended.
  {
    id: 'carol', email: 'carol@example.com', displayName: 'Carol', maxCpu: 1, maxRam: 1024, maxStorage: 10,
    usageDigestOptIn: true, role: 'user', accessExpiresAt: new Date('2026-10-01T00:00:00Z'),
  },
  {
    id: 'dan', email: 'dan@example.com', displayName: 'Dan', maxCpu: 1, maxRam: 1024, maxStorage: 10,
    usageDigestOptIn: true, role: 'user', accessSuspendedAt: new Date('2026-10-01T00:00:00Z'),
  },
];
const VMS = [
  { id: 'a1', userId: 'alice', name: 'alice-web', cpu: 2, ram: 2048, storage: 20, quotaExempt: false },
  { id: 'a2', userId: 'alice', name: 'alice-gift', cpu: 4, ram: 4096, storage: 40, quotaExempt: true },
  { id: 'b1', userId: 'bob', name: 'bob-secret-db', cpu: 2, ram: 2048, storage: 20, quotaExempt: false },
];
const NOW = new Date('2026-10-26T08:00:00Z');
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);
const SAMPLES = [
  // alice-web: 12 samples (1 h) at 50% CPU, 1 GiB
  ...Array.from({ length: 12 }, () => ({ userId: 'alice', vmId: 'a1', cpu: 0.5, mem: 1024 ** 3, createdAt: at(2) })),
  // a machine of Alice's deleted during the week
  ...Array.from({ length: 6 }, () => ({ userId: 'alice', vmId: 'gone', cpu: 0.1, mem: 512 * 1024 ** 2, createdAt: at(3) })),
  // too old to count
  { userId: 'alice', vmId: 'a1', cpu: 1, mem: 0, createdAt: at(9) },
  // Bob's usage, which must never reach Alice
  ...Array.from({ length: 24 }, () => ({ userId: 'bob', vmId: 'b1', cpu: 0.9, mem: 2 * 1024 ** 3, createdAt: at(1) })),
];

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => USERS.find((u) => u.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        USERS.filter((u) => where.usageDigestOptIn === undefined || u.usageDigestOptIn === where.usageDigestOptIn),
      ),
    },
    virtualMachine: {
      findMany: vi.fn(async ({ where }: { where: Where }) => VMS.filter((v) => v.userId === where.userId)),
    },
    resourceSample: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        SAMPLES.filter(
          (s) =>
            s.userId === where.userId &&
            (!where.createdAt || (s.createdAt >= where.createdAt.gte && s.createdAt < where.createdAt.lt)),
        ),
      ),
    },
  },
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => null), setConfig: vi.fn() }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(), sendMail: vi.fn(async () => undefined) }));

import { prisma } from '../src/lib/prisma.js';
import { getConfig } from '../src/services/config.service.js';
import { getMailConfig, sendMail } from '../src/services/mail.service.js';
import { buildUsageDigest, runUsageDigest, digestRows } from '../src/services/usage-digest.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMailConfig).mockResolvedValue({ host: 'smtp' } as never);
  vi.mocked(getConfig).mockResolvedValue(null);
});

describe('buildUsageDigest', () => {
  it("includes only the recipient's own machines and usage", async () => {
    const d = (await buildUsageDigest('alice', NOW))!;
    expect(d.to).toBe('alice@example.com');
    const all = d.mail.subject + d.mail.text + d.mail.html;
    expect(all).toContain('alice-web');
    expect(all).not.toContain('bob');
    expect(all).not.toContain('Bob');
    // Every query is scoped to the recipient.
    expect(prisma.virtualMachine.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'alice' } }));
    expect(prisma.resourceSample.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'alice' }) }),
    );
  });

  it('reports running hours and averages from the last 7 days of samples', async () => {
    const { text } = (await buildUsageDigest('alice', NOW))!.mail;
    expect(text).toContain('- alice-web: 1 h running, avg CPU 50%, avg RAM 1 GB');
    expect(text).toContain('- alice-gift: 0 h running, avg CPU —, avg RAM —');
    expect(text).toContain('Total running time: 1.5 h');
  });

  it('lists a machine deleted during the week as "Deleted machine"', async () => {
    const { text } = (await buildUsageDigest('alice', NOW))!.mail;
    expect(text).toContain('- Deleted machine: 0.5 h running, avg CPU 10%, avg RAM 0.5 GB');
  });

  it('counts quota as the quota checks do (exempt grants left out)', async () => {
    const { text } = (await buildUsageDigest('alice', NOW))!.mail;
    expect(text).toContain('- vCPU: 2 of 8');
    expect(text).toContain('- Memory: 2 GB of 8 GB');
    expect(text).toContain('- Storage: 20 GB of 100 GB');
  });

  it('returns null for a user who no longer exists', async () => {
    expect(await buildUsageDigest('nobody', NOW)).toBeNull();
  });
});

describe('digestRows', () => {
  it("drops samples that aren't the user's even if handed them", () => {
    const rows = digestRows('alice', [{ id: 'a1', name: 'alice-web' }], [
      { userId: 'alice', vmId: 'a1', cpu: 0.2, mem: 0 },
      { userId: 'bob', vmId: 'b1', cpu: 0.9, mem: 0 },
      { userId: 'bob', vmId: 'a1', cpu: 0.9, mem: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'alice-web', exists: true, avgCpuPct: 20 });
  });
});

describe('runUsageDigest', () => {
  it('emails only users who opted in and whose access has not ended, each their own digest', async () => {
    const r = await runUsageDigest(NOW);
    expect(r).toEqual({ ran: true, sent: 1, failed: 0 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0]![0].to).toBe('alice@example.com');
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { usageDigestOptIn: true } }));
  });

  it('does nothing when the admin turned the digest off', async () => {
    vi.mocked(getConfig).mockImplementation(async (k: string) => (k === 'usage_digest_enabled' ? 'false' : null));
    expect(await runUsageDigest(NOW)).toMatchObject({ ran: false, reason: 'disabled by the admin' });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does nothing when SMTP is not configured', async () => {
    vi.mocked(getMailConfig).mockResolvedValue(null);
    expect(await runUsageDigest(NOW)).toMatchObject({ ran: false, reason: 'SMTP is not configured' });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('keeps going when one send fails', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([{ id: 'alice' }, { id: 'alice' }] as never);
    vi.mocked(sendMail).mockRejectedValueOnce(new Error('550'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runUsageDigest(NOW)).toEqual({ ran: true, sent: 1, failed: 1 });
    warn.mockRestore();
  });
});
