import { describe, it, expect } from 'vitest';
import {
  passwordResetEmail,
  notificationEmail,
  accountLockedEmail,
  inviteEmail,
  announcementEmail,
  vmMaintenanceEmail,
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

const SAMPLES: Array<[string, RenderedEmail]> = [
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
