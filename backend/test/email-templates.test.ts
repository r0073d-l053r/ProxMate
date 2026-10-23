import { describe, it, expect } from 'vitest';
import {
  vmRebuildFailedEmail,
  passwordResetEmail,
  notificationEmail,
  accountLockedEmail,
  inviteEmail,
  announcementEmail,
  vmMaintenanceEmail,
  alertEmail,
  vmDeployedForYouEmail,
  vmSharedEmail,
  usageDigestEmail,
  type RenderedEmail,
} from '../src/lib/email-templates.js';

/**
 * The whole point of email-templates.ts is that *every* transactional email shares
 * one identity. These markers come from the single `wrapEmail` shell, so asserting
 * them on each template guarantees the branding can't drift between, say, a
 * password reset and a notification.
 */
function expectBrandedShell(email: RenderedEmail) {
  expect(email.subject.length).toBeGreaterThan(0);
  expect(email.text.length).toBeGreaterThan(0);
  expect(email.html).toContain('<!DOCTYPE html>');
  expect(email.html).toContain('>ProxMate</span>'); // wordmark header
  expect(email.html).toContain('your self-hosted Proxmox portal'); // shared footer
  expect(email.html).toContain('background-color:#f4f4f5'); // shared canvas colour
  expect(email.html).toContain('#18181b'); // shared ink/brand colour
}

const DIGEST_ARGS = {
  displayName: 'Tess',
  periodStart: new Date('2026-10-19T08:00:00Z'),
  periodEnd: new Date('2026-10-26T08:00:00Z'),
  vms: [
    { name: 'web-1', exists: true, runningHours: 24.04, avgCpuPct: 12.6, avgMemMb: 1536 },
    { name: '', exists: false, runningHours: 2, avgCpuPct: 3, avgMemMb: 512 },
  ],
  quota: { cpu: [2, 8] as [number, number], ram: [2048, 0] as [number, number], storage: [20, 100] as [number, number] },
  dashboardUrl: 'https://pm.example',
};

const SAMPLES: Array<[string, RenderedEmail]> = [
  [
    'deployed for you',
    vmDeployedForYouEmail({ displayName: 'Tess', vmName: 'web-1', kind: 'vm', cpu: 2, ram: 2048, storage: 20, quotaExempt: false }),
  ],
  ['vm shared', vmSharedEmail({ vmName: 'web-1', role: 'viewer', sharedBy: 'Owen' })],
  ['usage digest', usageDigestEmail(DIGEST_ARGS)],
  ['password reset', passwordResetEmail('https://pm.example/reset-password?token=abc')],
  ['notification', notificationEmail('VM error', 'box-1', 'qemu exited unexpectedly')],
  [
    'account locked',
    accountLockedEmail({
      email: 'user@example.com',
      attempts: 10,
      ip: '203.0.113.5',
      lockedUntil: new Date('2026-06-29T12:00:00Z'),
      lockMinutes: 15,
    }),
  ],
  [
    'invite',
    inviteEmail({
      inviteUrl: 'https://pm.example/register/tok',
      label: 'Friend',
      maxCpu: 4,
      maxRam: 8192,
      maxStorage: 100,
      require2fa: true,
      expiresAt: new Date('2026-07-06T12:00:00Z'),
      inviterName: 'Admin',
    }),
  ],
  ['announcement', announcementEmail('Scheduled maintenance', 'Down 10–11pm ET tonight.')],
  ['vm maintenance (live)', vmMaintenanceEmail({ vmName: 'web-1', live: true })],
  ['vm maintenance (offline)', vmMaintenanceEmail({ vmName: 'web-1', live: false })],
];

describe('email-templates — shared branding', () => {
  it.each(SAMPLES)('%s email uses the branded ProxMate shell', (_name, email) => {
    expectBrandedShell(email);
  });
});

describe('passwordResetEmail', () => {
  it('embeds the reset URL in the button, the fallback link, and the text', () => {
    const url = 'https://pm.example/reset-password?token=xyz';
    const email = passwordResetEmail(url);
    expect(email.subject).toBe('Reset your ProxMate password');
    expect(email.html).toContain(`href="${url}"`);
    expect(email.text).toContain(url);
  });
});

describe('notificationEmail', () => {
  it('puts the event label + title in the subject and the message in the body', () => {
    const email = notificationEmail('Backup failed', 'nightly', 'disk full');
    expect(email.subject).toBe('[ProxMate] Backup failed: nightly');
    expect(email.html).toContain('disk full');
    expect(email.text).toContain('disk full');
  });

  it('escapes HTML in the message so notifications cannot inject markup', () => {
    const email = notificationEmail('VM error', 'x', '<script>alert(1)</script>');
    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});

describe('accountLockedEmail', () => {
  it('reports the account, attempts and source IP', () => {
    const email = accountLockedEmail({
      email: 'victim@example.com',
      attempts: 10,
      ip: '198.51.100.7',
      lockedUntil: new Date('2026-06-29T12:00:00Z'),
      lockMinutes: 15,
    });
    expect(email.subject).toContain('victim@example.com');
    expect(email.html).toContain('victim@example.com');
    expect(email.html).toContain('198.51.100.7');
    expect(email.html).toContain('10');
    expect(email.text).toContain('15 minutes');
  });

  it('omits the IP row when no IP is known', () => {
    const email = accountLockedEmail({
      email: 'a@b.c',
      attempts: 10,
      ip: null,
      lockedUntil: new Date('2026-06-29T12:00:00Z'),
      lockMinutes: 15,
    });
    expect(email.html).not.toContain('Source IP');
  });
});

describe('announcementEmail', () => {
  it('uses the admin subject and preserves the message, branded', () => {
    const email = announcementEmail('Maintenance tonight', 'VMs keep running.\nDashboard offline 10–11pm.');
    expect(email.subject).toBe('Maintenance tonight');
    expect(email.html).toContain('Maintenance tonight');
    expect(email.html).toContain('Dashboard offline 10–11pm.');
    expect(email.text).toContain('VMs keep running.');
  });

  it('escapes HTML in the admin-supplied message', () => {
    const email = announcementEmail('Heads up', '<b>bold</b> & <script>x</script>');
    expect(email.html).not.toContain('<script>x</script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('adds an unsubscribe footer link (html + text) when a URL is provided', () => {
    const url = 'https://pm.example/api/broadcast/unsubscribe?token=user1.abc';
    const email = announcementEmail('Maintenance', 'Details.', url);
    expect(email.html).toContain(`href="${url}"`);
    expect(email.html).toMatch(/Unsubscribe/);
    expect(email.html).toContain('security emails are unaffected');
    expect(email.text).toContain(url);
  });

  it('omits the unsubscribe footer when no URL is provided', () => {
    const email = announcementEmail('Maintenance', 'Details.');
    expect(email.html).not.toMatch(/Unsubscribe/);
    expect(email.text).not.toMatch(/Unsubscribe/);
  });
});

describe('vmMaintenanceEmail', () => {
  it('names the VM in the subject and tells a running guest to expect only a brief blip', () => {
    const email = vmMaintenanceEmail({ vmName: 'db-prod', live: true });
    expect(email.subject).toContain('db-prod');
    expect(email.html).toContain('db-prod');
    expect(email.text).toMatch(/momentary interruption|second or less/i);
    expect(email.text).toMatch(/no action is needed/i);
  });

  it('tells a stopped guest there is no extra interruption', () => {
    const email = vmMaintenanceEmail({ vmName: 'archive', live: false });
    expect(email.text).toMatch(/powered off|no extra interruption/i);
    expect(email.text).not.toMatch(/momentary interruption/i);
  });

  it('escapes HTML in the VM name', () => {
    const email = vmMaintenanceEmail({ vmName: '<script>x</script>', live: true });
    expect(email.html).not.toContain('<script>x</script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});

describe('inviteEmail', () => {
  it('embeds the invite URL and formats the quota (RAM MB → GB)', () => {
    const email = inviteEmail({
      inviteUrl: 'https://pm.example/register/tok',
      label: 'Friend',
      maxCpu: 4,
      maxRam: 8192,
      maxStorage: 100,
      require2fa: false,
      expiresAt: new Date('2026-07-06T12:00:00Z'),
      inviterName: 'Admin',
    });
    expect(email.subject).toBe("You're invited to ProxMate");
    expect(email.html).toContain('href="https://pm.example/register/tok"');
    expect(email.html).toContain('8 GB'); // 8192 MB → 8 GB
    expect(email.html).toContain('100 GB');
    expect(email.text).toContain('https://pm.example/register/tok');
    expect(email.text).toContain('Admin has invited you');
  });

  it('mentions required two-step auth only when require2fa is set', () => {
    const base = {
      inviteUrl: 'https://pm.example/register/tok',
      maxCpu: 2,
      maxRam: 4096,
      maxStorage: 50,
      expiresAt: new Date('2026-07-06T12:00:00Z'),
    };
    expect(inviteEmail({ ...base, require2fa: true }).html).toContain('Two-step auth');
    expect(inviteEmail({ ...base, require2fa: false }).html).not.toContain('Two-step auth');
  });
});

describe('vmDeployedForYouEmail', () => {
  it('names the machine, its size, the quota effect and the admin lock, escaping names', () => {
    const m = vmDeployedForYouEmail({
      displayName: 'Tess <t>',
      vmName: 'web-<1>',
      kind: 'vm',
      cpu: 2,
      ram: 3072,
      storage: 20,
      quotaExempt: true,
      adminName: 'Ada',
      vmUrl: 'https://pm.example/vms/v1',
    });
    expect(m.subject).toBe('[ProxMate] A new virtual machine was set up for you: web-<1>');
    expect(m.text).toContain('2 vCPU · 3 GB RAM · 20 GB storage. It does not count toward your quota.');
    expect(m.text).toContain('only an admin can resize or rebuild it');
    expect(m.html).toContain('web-&lt;1&gt;');
    expect(m.html).not.toContain('web-<1>');
    expect(m.html).toContain('href="https://pm.example/vms/v1"');
  });
});

describe('vmSharedEmail', () => {
  it('describes what the level allows', () => {
    expect(vmSharedEmail({ vmName: 'a', role: 'operator' }).text).toContain('power it on and off, and open its console');
  });

  it('treats a re-share at the same level as a plain share, not a change', () => {
    expect(vmSharedEmail({ vmName: 'a', role: 'viewer', previousRole: 'viewer' }).subject).toBe('[ProxMate] "a" was shared with you');
  });
});

describe('usageDigestEmail', () => {
  it('tabulates each machine, labels deleted ones, and shows quota with and without limits', () => {
    const m = usageDigestEmail(DIGEST_ARGS);
    expect(m.subject).toBe('[ProxMate] Your weekly usage: 2026-10-19 – 2026-10-26');
    expect(m.text).toContain('- web-1: 24 h running, avg CPU 13%, avg RAM 1.5 GB');
    expect(m.text).toContain('- Deleted machine: 2 h running');
    expect(m.text).toContain('- vCPU: 2 of 8');
    expect(m.text).toContain('- Memory: 2 GB (no limit set)');
    expect(m.text).toContain('Total running time: 26 h');
    expect(m.text).toContain('turn it off');
  });

  it('says so when there were no machines', () => {
    expect(usageDigestEmail({ ...DIGEST_ARGS, vms: [] }).text).toContain('No machines this week.');
  });
});

describe('vmRebuildFailedEmail', () => {
  it('tells the owner a backup can be restored into the empty VM slot when the machine was kept', () => {
    const m = vmRebuildFailedEmail({ vmName: 'web', kept: true, reason: 'storage full' });
    expect(m.text).toMatch(/restored while the VM slot is empty/);
    expect(m.html).toMatch(/restored while the VM slot is empty/);
    expect(m.text).toContain('storage full');
  });

  it('says the machine was removed when nothing was kept', () => {
    expect(vmRebuildFailedEmail({ vmName: 'web', kept: false, reason: 'x' }).text).toMatch(/removed from your list/);
  });
});

// User-supplied text (display names, emails, VM names) reaches the hidden preheader
// too, so it is escaped there exactly as in the body, and escaped only once.
describe('preheader escaping', () => {
  const INJECT = 'x</div><a href="https://evil.example/login">Re-verify</a><div>';

  it('escapes a notification title in the preheader', () => {
    const m = notificationEmail('Tenant access expired', `${INJECT} (a@b.c)`, 'msg');
    expect(m.html).not.toContain('<a href="https://evil.example');
    expect(m.html).toContain('x&lt;/div&gt;&lt;a href=');
  });

  it('escapes the locked account address in the preheader', () => {
    const m = accountLockedEmail({ email: INJECT, attempts: 5, ip: null, lockedUntil: new Date(), lockMinutes: 15 });
    expect(m.html).not.toContain('<a href="https://evil.example');
  });

  it('escapes a VM name once, not twice', () => {
    const rebuild = vmRebuildFailedEmail({ vmName: 'a&b', kept: true, reason: 'r' });
    const alert = alertEmail({ vmName: 'a&b', alertLabel: 'High CPU', detail: 'd' });
    const move = vmMaintenanceEmail({ vmName: 'a&b', live: true });
    for (const m of [rebuild, alert, move]) {
      expect(m.html).not.toContain('a&amp;amp;b');
      expect(m.html).toContain('a&amp;b');
    }
  });
});
