import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Changes to connection credentials, settings, invites, SSH keys and accounts all
// leave an audit entry naming what changed — and never the secret values themselves.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    inviteToken: {
      create: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    user: { findUnique: vi.fn(), delete: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'admin', email: 'admin@example.com', role: 'admin', displayName: 'Admin' };
    next();
  },
  requireSession: (_req: unknown, _res: unknown, next: () => void) => next(),
  allowExpiredAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/audit.service.js', () => ({
  recordAudit: vi.fn(async () => undefined),
  listAudit: vi.fn(async () => []),
  listAuditForTarget: vi.fn(async () => []),
}));
vi.mock('../src/services/config.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/config.service.js')>()),
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/services/mail.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/mail.service.js')>()),
  saveMailConfig: vi.fn(async () => undefined),
  isMailConfigured: vi.fn(async () => true),
  sendMail: vi.fn(async () => undefined),
}));
vi.mock('../src/services/ssh-key.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/ssh-key.service.js')>()),
  addSshKey: vi.fn(async () => ({ id: 'k1', name: 'laptop' })),
  deleteSshKey: vi.fn(async () => true),
}));
vi.mock('../src/services/vm.service.js', () => ({
  destroyVm: vi.fn(async () => undefined),
  destroyBlocker: vi.fn(async () => null),
  getOwnedVm: vi.fn(),
  listUnmatchedVms: vi.fn(),
  adoptGuest: vi.fn(),
  AdoptError: class extends Error {},
  refreshVmIps: vi.fn(),
  getStoragePinningReport: vi.fn(),
}));

import adminRouter from '../src/routes/admin.routes.js';
import inviteRouter from '../src/routes/invite.routes.js';
import sshKeyRouter from '../src/routes/ssh-key.routes.js';
import userRouter from '../src/routes/user.routes.js';
import { recordAudit } from '../src/services/audit.service.js';
import { prisma } from '../src/lib/prisma.js';
import { setConfig } from '../src/services/config.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use('/invites', inviteRouter);
  app.use('/ssh-keys', sshKeyRouter);
  app.use('/users', userRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => vi.clearAllMocks());

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The one audit entry recorded with `action`, failing the test when there is none. */
function auditEntry(action: string) {
  const calls = vi.mocked(recordAudit).mock.calls.map((c) => c[0]);
  const hit = calls.find((c) => c.action === action);
  expect(hit, `expected an audit entry "${action}", got ${JSON.stringify(calls.map((c) => c.action))}`).toBeDefined();
  return hit!;
}

const allAuditText = () => JSON.stringify(vi.mocked(recordAudit).mock.calls.map((c) => ({ ...c[0], req: undefined })));

describe('admin settings', () => {
  it('audits a Proxmox connection change without the token secret', async () => {
    const res = await call('PUT', '/admin/settings/proxmox', {
      host: 'https://pve.example:8006',
      tokenId: 'root@pam!pm',
      tokenSecret: 'SUPER-SECRET-TOKEN',
      verifySsl: true,
    });
    expect(res.status).toBe(200);
    const e = auditEntry('admin.proxmox_config');
    expect(e.detail).toContain('https://pve.example:8006');
    expect(e.detail).toContain('secret replaced');
    expect(allAuditText()).not.toContain('SUPER-SECRET-TOKEN');
  });

  it('audits an SMTP change without the password', async () => {
    const res = await call('PUT', '/admin/settings/smtp', {
      host: 'smtp.example',
      port: 587,
      user: 'mailer',
      pass: 'SMTP-PASSWORD',
    });
    expect(res.status).toBe(200);
    expect(auditEntry('admin.smtp_config').detail).toContain('smtp.example');
    expect(allAuditText()).not.toContain('SMTP-PASSWORD');
  });

  it('audits the rescue ISO and template-refresh toggles', async () => {
    expect((await call('PUT', '/admin/settings/rescue', { iso: 'local:iso/rescue.iso' })).status).toBe(200);
    expect(auditEntry('admin.rescue_config').detail).toContain('local:iso/rescue.iso');
    expect((await call('PUT', '/admin/settings/template-refresh', { enabled: true })).status).toBe(200);
    expect(auditEntry('admin.template_refresh_config').detail).toContain('enabled');
  });

  it('audits the automatic-snapshot setting and validates the keep count', async () => {
    expect((await call('PUT', '/admin/settings/auto-snapshot', { enabled: true, keep: 4 })).status).toBe(200);
    expect(auditEntry('admin.auto_snapshot_config').detail).toBe('automatic snapshots on, keep 4');
    expect((await call('PUT', '/admin/settings/auto-snapshot', { enabled: true, keep: 0 })).status).toBe(400);
    expect((await call('PUT', '/admin/settings/auto-snapshot', { enabled: true, keep: 11 })).status).toBe(400);
  });

  it('records who confirmed the ENCRYPTION_KEY backup, without ever returning the key', async () => {
    const before = process.env['ENCRYPTION_KEY'];
    const key = 'c'.repeat(64);
    process.env['ENCRYPTION_KEY'] = key;
    const res = await call('POST', '/admin/encryption-key-backup/confirm').finally(() => {
      if (before === undefined) delete process.env['ENCRYPTION_KEY'];
      else process.env['ENCRYPTION_KEY'] = before;
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(key);
    const stored = vi.mocked(setConfig).mock.calls.find((c) => c[0] === 'encryption_key_backup_confirmed');
    expect(JSON.parse(stored![1])).toMatchObject({ by: 'admin@example.com', userId: 'admin', at: expect.any(String) });
    expect(stored![1]).not.toContain(key);
    const e = auditEntry('admin.encryption_key_backup_confirmed');
    expect(e.actor).toMatchObject({ id: 'admin', email: 'admin@example.com' });
    const status = await (await call('GET', '/admin/encryption-key-backup')).json();
    expect(Object.keys(status).sort()).toEqual(['confirmed', 'confirmedAt', 'confirmedBy', 'keyChanged']);
  });
});

describe('notification settings', () => {
  it('audits what changed about the webhook, email and events, never the URL', async () => {
    const put = (body: unknown) => call('PUT', '/admin/settings/notifications', body);
    expect(
      (await put({ webhookUrl: 'https://hooks.example.com/SECRET-PATH', emailEnabled: true, events: ['vm.error', 'auth.lockout'] }))
        .status,
    ).toBe(200);
    expect(auditEntry('admin.notify_config').detail).toBe('webhook replaced, email on, 2 events');
    vi.mocked(recordAudit).mockClear();
    await put({ clearWebhookUrl: true, emailEnabled: false, events: [] });
    expect(auditEntry('admin.notify_config').detail).toBe('webhook removed, email off, 0 events');
    vi.mocked(recordAudit).mockClear();
    await put({ emailEnabled: false, events: ['vm.error'] });
    expect(auditEntry('admin.notify_config').detail).toBe('webhook kept, email off, 1 event');
    expect(allAuditText()).not.toContain('SECRET-PATH');
  });

  it('audits ntfy and Telegram changes without the topic, the access token or the bot token', async () => {
    const put = (body: unknown) => call('PUT', '/admin/settings/notifications', body);
    const tg = '123456789:SECRETBOTTOKENabcdefghijklmnopqrstu';
    expect(
      (
        await put({
          ntfyUrl: 'https://ntfy.sh/SECRET-TOPIC',
          ntfyToken: 'tk_SECRET-NTFY',
          telegramBotToken: tg,
          telegramChatId: '-100123',
          emailEnabled: false,
          events: [],
        })
      ).status,
    ).toBe(200);
    expect(auditEntry('admin.notify_config').detail).toBe(
      'webhook kept, ntfy replaced (token replaced), telegram replaced (chat -100123), email off, 0 events',
    );
    vi.mocked(recordAudit).mockClear();
    await put({ clearNtfy: true, clearTelegram: true, emailEnabled: false, events: [] });
    expect(auditEntry('admin.notify_config').detail).toBe('webhook kept, ntfy removed, telegram removed, email off, 0 events');
    vi.mocked(recordAudit).mockClear();
    await put({ ntfyUrl: '', ntfyToken: '', clearNtfyToken: true, emailEnabled: false, events: [] });
    expect(auditEntry('admin.notify_config').detail).toBe('webhook kept, ntfy kept (token removed), email off, 0 events');
    expect(allAuditText()).not.toContain('SECRET');
  });

  it('audits the weekly usage digest toggle', async () => {
    expect((await call('PUT', '/admin/settings/usage-digest', { enabled: false })).status).toBe(200);
    expect(auditEntry('admin.usage_digest_config').detail).toBe('weekly digest disabled');
  });
});

describe('tenant isolation', () => {
  it('audits isolation settings changes', async () => {
    expect((await call('PUT', '/admin/isolation', { enabled: false })).status).toBe(200);
    expect(auditEntry('admin.isolation_config').detail).toContain('isolation off');
  });
});

describe('invites', () => {
  const invite = {
    id: 'inv1',
    token: 'INVITE-TOKEN-VALUE',
    label: 'team',
    email: null as string | null,
    maxCpu: 2,
    maxRam: 2048,
    maxStorage: 20,
    require2fa: false,
    accessDuration: null,
    usedById: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  it('audits create, send and revoke without the invite token', async () => {
    vi.mocked(prisma.inviteToken.create).mockResolvedValue({ ...invite } as never);
    vi.mocked(prisma.inviteToken.findUnique).mockResolvedValue({ ...invite } as never);

    expect((await call('POST', '/invites', { maxCpu: 2, maxRam: 2048, maxStorage: 20 })).status).toBe(201);
    expect(auditEntry('invite.create').targetId).toBe('inv1');
    expect((await call('POST', '/invites/inv1/send', { email: 'new@example.com' })).status).toBe(200);
    expect(auditEntry('invite.send').detail).toContain('new@example.com');
    expect((await call('DELETE', '/invites/inv1')).status).toBe(200);
    expect(auditEntry('invite.revoke').targetId).toBe('inv1');
    expect(allAuditText()).not.toContain('INVITE-TOKEN-VALUE');
  });
});

describe('SSH keys', () => {
  it('audits adding and removing a key', async () => {
    const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq2m4c5qL0E3m3b6fW3dO3o3sQd6Q8X1c4h0k7k2b9a me@host';
    expect((await call('POST', '/ssh-keys', { name: 'laptop', publicKey: pub })).status).toBe(201);
    expect(auditEntry('ssh_key.add').detail).toContain('laptop');
    expect((await call('DELETE', '/ssh-keys/k1')).status).toBe(200);
    expect(auditEntry('ssh_key.delete').targetId).toBe('k1');
  });
});

describe('accounts', () => {
  it('audits deleting a user', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', email: 'gone@example.com', vms: [] } as never);
    expect((await call('DELETE', '/users/u1')).status).toBe(200);
    const e = auditEntry('admin.delete_user');
    expect(e.targetId).toBe('u1');
    expect(e.detail).toContain('gone@example.com');
  });
});
