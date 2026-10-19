import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The notification webhook URL is a secret: the settings response reports only
// whether one is set plus a masked form, and saving with the field blank keeps it.

const HOOK = 'https://discord.com/api/webhooks/123/SECRET-HOOK-TOKEN';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'admin', role: 'admin' };
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
}));
vi.mock('../src/services/config.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/config.service.js')>()),
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/services/notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/notify.service.js')>()),
  getNotifyConfig: vi.fn(async () => ({ webhookUrl: HOOK, emailEnabled: false, emailTo: '', events: ['vm.error'] })),
  saveNotifyConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/services/mail.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/mail.service.js')>()),
  getMailConfig: vi.fn(async () => null),
}));
vi.mock('../src/services/sso.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/sso.service.js')>()),
  getSsoConfig: vi.fn(async () => null),
  callbackUrl: vi.fn(() => 'https://pm/cb'),
}));
vi.mock('../src/services/ide.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/ide.service.js')>()),
  getIdeConfig: vi.fn(async () => ({})),
}));
vi.mock('../src/services/appdb-backup.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/appdb-backup.service.js')>()),
  getAppDbBackupConfig: vi.fn(async () => ({ dir: '', keep: 7 })),
}));
vi.mock('../src/services/kiosk.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/kiosk.service.js')>()),
  isKioskPinSet: vi.fn(async () => false),
}));

import adminRouter from '../src/routes/admin.routes.js';
import { saveNotifyConfig } from '../src/services/notify.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => vi.clearAllMocks());

const put = (body: unknown) =>
  fetch(`${base}/admin/settings/notifications`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /api/admin/settings notify', () => {
  it('reports a set webhook with a masked value, never the URL', async () => {
    const res = await fetch(`${base}/admin/settings`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('SECRET-HOOK-TOKEN');
    const { notify } = JSON.parse(text) as { notify: Record<string, unknown> };
    expect(notify).toMatchObject({ hasWebhookUrl: true, webhookUrlMasked: 'https://discord.com/…', events: ['vm.error'] });
    expect(notify).not.toHaveProperty('webhookUrl');
  });
});

describe('PUT /api/admin/settings/notifications', () => {
  it('passes a blank webhook through as "keep the stored one"', async () => {
    expect((await put({ webhookUrl: '', emailEnabled: false, events: [] })).status).toBe(200);
    expect(saveNotifyConfig).toHaveBeenCalledWith(expect.objectContaining({ webhookUrl: '', clearWebhookUrl: false }));
  });

  it('removes the webhook only when asked explicitly', async () => {
    expect((await put({ clearWebhookUrl: true, emailEnabled: false, events: [] })).status).toBe(200);
    expect(saveNotifyConfig).toHaveBeenCalledWith(expect.objectContaining({ clearWebhookUrl: true }));
  });
});
