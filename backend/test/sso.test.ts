import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));
// hashPassword is async bcrypt — stub it so JIT-create tests don't spend real CPU.
vi.mock('../src/services/auth.service.js', () => ({ hashPassword: async (s: string) => `hashed:${s}` }));

import { prisma } from '../src/lib/prisma.js';
import { upsertSsoUser, type SsoConfig, type SsoClaims } from '../src/services/sso.service.js';

const findUnique = vi.mocked(prisma.user.findUnique);
const update = vi.mocked(prisma.user.update);
const create = vi.mocked(prisma.user.create);

const baseCfg: SsoConfig = {
  enabled: true,
  issuer: 'https://idp.example',
  clientId: 'proxmate',
  scopes: 'openid profile email',
  groupsClaim: 'groups',
  adminGroup: '',
  allowSignup: false,
  buttonLabel: 'SSO',
};

/** Make findUnique answer based on which unique field was queried. */
function whenLookedUp(opts: { bySub?: unknown; byEmail?: unknown }) {
  findUnique.mockImplementation((async (args: { where: { ssoSubject?: string; email?: string } }) => {
    if (args.where.ssoSubject) return opts.bySub ?? null;
    if (args.where.email) return opts.byEmail ?? null;
    return null;
  }) as never);
}

beforeEach(() => vi.clearAllMocks());

describe('upsertSsoUser', () => {
  it('returns the user already linked by ssoSubject (no create)', async () => {
    const existing = { id: 'u1', email: 'a@b.c', role: 'user', ssoSubject: 'sub-1' };
    whenLookedUp({ bySub: existing });

    const user = await upsertSsoUser({ sub: 'sub-1', email: 'a@b.c' }, baseCfg);

    expect(user).toBe(existing);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('links an existing local account by email on first SSO login', async () => {
    const local = { id: 'u2', email: 'jo@b.c', role: 'user', ssoSubject: null };
    whenLookedUp({ byEmail: local });
    update.mockResolvedValue({ ...local, ssoSubject: 'sub-2' } as never);

    const user = await upsertSsoUser({ sub: 'sub-2', email: 'Jo@B.c' }, baseCfg);

    expect(update).toHaveBeenCalledWith({ where: { id: 'u2' }, data: { ssoSubject: 'sub-2' } });
    expect(user.ssoSubject).toBe('sub-2');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to JIT-provision when allowSignup is off', async () => {
    whenLookedUp({});
    await expect(upsertSsoUser({ sub: 'new', email: 'new@b.c' }, baseCfg)).rejects.toThrow(/provisioned/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('JIT-creates a plain user when allowSignup is on', async () => {
    whenLookedUp({});
    create.mockResolvedValue({ id: 'u3', email: 'new@b.c', role: 'user' } as never);

    await upsertSsoUser({ sub: 'new', email: 'New@b.c', name: 'New User' }, { ...baseCfg, allowSignup: true });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data as { email: string; role: string; ssoSubject: string };
    expect(data.email).toBe('new@b.c'); // lowercased
    expect(data.role).toBe('user');
    expect(data.ssoSubject).toBe('new');
  });

  it('JIT-creates an admin when the user is in the configured admin group', async () => {
    whenLookedUp({});
    create.mockResolvedValue({ id: 'u4', role: 'admin' } as never);

    await upsertSsoUser(
      { sub: 'boss', email: 'boss@b.c', groups: ['staff', 'admins'] },
      { ...baseCfg, allowSignup: true, adminGroup: 'admins' },
    );

    expect((create.mock.calls[0][0].data as { role: string }).role).toBe('admin');
  });

  it('promotes a linked user to admin by group, but never auto-demotes', async () => {
    const linked = { id: 'u5', email: 'p@b.c', role: 'user', ssoSubject: 'sub-5' };
    whenLookedUp({ bySub: linked });
    update.mockResolvedValue({ ...linked, role: 'admin' } as never);

    const promoted = await upsertSsoUser(
      { sub: 'sub-5', groups: ['admins'] } as SsoClaims,
      { ...baseCfg, adminGroup: 'admins' },
    );
    expect(update).toHaveBeenCalledWith({ where: { id: 'u5' }, data: { role: 'admin' } });
    expect(promoted.role).toBe('admin');

    // An admin NOT in the group is left alone (no demotion).
    vi.clearAllMocks();
    const adminUser = { id: 'u6', role: 'admin', ssoSubject: 'sub-6' };
    whenLookedUp({ bySub: adminUser });
    const kept = await upsertSsoUser({ sub: 'sub-6', groups: ['staff'] } as SsoClaims, { ...baseCfg, adminGroup: 'admins' });
    expect(update).not.toHaveBeenCalled();
    expect(kept.role).toBe('admin');
  });
});
