import { describe, it, expect, vi, beforeEach } from 'vitest';

// Activity emails go to the tenant concerned only: skipped (and logged) when SMTP
// is off, skipped when the recipient opted out, never sent for one's own deploy.

vi.mock('../src/lib/prisma.js', () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(async () => 'https://pm.example.com/') }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(), sendMail: vi.fn(async () => undefined) }));

import { prisma } from '../src/lib/prisma.js';
import { getMailConfig, sendMail } from '../src/services/mail.service.js';
import {
  sendDeployedForTenantEmail,
  sendShareEmail,
  sendLater,
  resetShareNoticeWindow,
  SHARE_NOTICE_WINDOW_MS,
} from '../src/services/activity-mail.service.js';

const vm = { id: 'vm1', userId: 'tenant', name: 'web-01', type: 'qemu', cpu: 2, ram: 2048, storage: 20, quotaExempt: true };
const admin = { id: 'admin', displayName: 'Ada Admin' };
const tenant = {
  email: 'tenant@example.com',
  displayName: 'Tess',
  activityEmailOptOut: false,
  role: 'user',
  accessExpiresAt: null as Date | null,
  accessSuspendedAt: null as Date | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetShareNoticeWindow();
  vi.mocked(getMailConfig).mockResolvedValue({ host: 'smtp' } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(tenant as never);
});

describe('sendDeployedForTenantEmail', () => {
  it('emails the tenant a branded notice naming the VM, its size and the admin lock', async () => {
    expect(await sendDeployedForTenantEmail(vm, admin)).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'tenant' } }));
    const mail = vi.mocked(sendMail).mock.calls[0]![0];
    expect(mail.to).toBe('tenant@example.com');
    expect(mail.subject).toContain('web-01');
    expect(mail.text).toContain('Ada Admin');
    expect(mail.text).toContain('only an admin can resize or rebuild it');
    expect(mail.text).toContain('does not count toward your quota');
    expect(mail.text).toContain('https://pm.example.com/vms/vm1');
    expect(mail.html).toContain('ProxMate');
  });

  it('sends nothing when the creator is the owner', async () => {
    expect(await sendDeployedForTenantEmail({ ...vm, userId: 'admin' }, admin)).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('skips with a log line when SMTP is not configured', async () => {
    vi.mocked(getMailConfig).mockResolvedValue(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await sendDeployedForTenantEmail(vm, admin)).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SMTP is not configured'));
    log.mockRestore();
  });

  it('respects the tenant opting out of activity emails', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...tenant, activityEmailOptOut: true } as never);
    expect(await sendDeployedForTenantEmail(vm, admin)).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends nothing to an account whose access has ended or is suspended', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...tenant, accessExpiresAt: new Date(Date.now() - 1000) } as never);
    expect(await sendDeployedForTenantEmail(vm, admin)).toBe(false);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...tenant, accessSuspendedAt: new Date() } as never);
    expect(await sendDeployedForTenantEmail(vm, admin)).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('calls a container a container', async () => {
    await sendDeployedForTenantEmail({ ...vm, type: 'lxc' }, admin);
    expect(vi.mocked(sendMail).mock.calls[0]![0].subject).toContain('container');
  });
});

describe('sendShareEmail', () => {
  const notice = { userId: 'u2', vmId: 'vm1', vmName: 'web-01', role: 'operator' as const, previousRole: null };

  it('tells the recipient a VM was shared with them, at which level', async () => {
    expect(await sendShareEmail(notice, { displayName: 'Owen Owner', email: 'owen@example.com' })).toBe(true);
    const mail = vi.mocked(sendMail).mock.calls[0]![0];
    expect(mail.subject).toBe('[ProxMate] "web-01" was shared with you');
    // The free-text display name never stands alone: the sharer's address is shown with it.
    expect(mail.text).toContain('Owen Owner (owen@example.com) shared "web-01" with you as Operator.');
    expect(mail.html).toContain('Owen Owner (owen@example.com)');
  });

  it('sends at most one email per recipient and VM per window', async () => {
    const t0 = 1_000_000;
    expect(await sendShareEmail(notice, { email: 'o@example.com' }, t0)).toBe(true);
    expect(await sendShareEmail({ ...notice, role: 'manager', previousRole: 'operator' }, {}, t0 + 60_000)).toBe(false);
    // Another VM, or another recipient, has its own window.
    expect(await sendShareEmail({ ...notice, vmId: 'vm2' }, {}, t0 + 60_000)).toBe(true);
    expect(await sendShareEmail({ ...notice, userId: 'u3' }, {}, t0 + 60_000)).toBe(true);
    // Once the window has passed, the pair is notified again.
    expect(await sendShareEmail(notice, {}, t0 + SHARE_NOTICE_WINDOW_MS)).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(4);
  });

  it('sends nothing to a recipient whose access has ended, without using up the window', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...tenant, accessSuspendedAt: new Date() } as never);
    expect(await sendShareEmail(notice, {})).toBe(false);
    expect(await sendShareEmail(notice, {})).toBe(true);
  });

  it('tells the recipient their level changed', async () => {
    await sendShareEmail({ ...notice, role: 'manager', previousRole: 'viewer' }, { displayName: 'Owen', email: 'owen@example.com' });
    const mail = vi.mocked(sendMail).mock.calls[0]![0];
    expect(mail.subject).toContain('changed to Manager');
    expect(mail.text).toContain('Owen (owen@example.com) changed your access to "web-01" from Viewer to Manager');
  });

  it('respects an opt-out and a missing SMTP config', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...tenant, activityEmailOptOut: true } as never);
    expect(await sendShareEmail(notice, {})).toBe(false);
    vi.mocked(getMailConfig).mockResolvedValueOnce(null);
    vi.spyOn(console, 'log').mockImplementationOnce(() => undefined);
    expect(await sendShareEmail(notice, {})).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('sendLater', () => {
  it('runs after the current turn and swallows a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fn = vi.fn(async () => {
      throw new Error('smtp down');
    });
    sendLater('test', fn);
    expect(fn).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[activity-mail] test email failed:', expect.any(Error));
    warn.mockRestore();
  });
});
