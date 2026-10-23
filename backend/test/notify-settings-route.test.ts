import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The notification webhook URL is a secret: the settings response reports only
// whether one is set plus a masked form, and saving with the field blank keeps it.

const HOOK = 'https://discord.com/api/webhooks/123/SECRET-HOOK-TOKEN';
const TG = '123456789:SECRET-TELEGRAM-BOT-TOKEN-0123456789';

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
  getNotifyConfig: vi.fn(async () => ({
    webhookUrl: HOOK,
    ntfyUrl: 'https://ntfy.sh/SECRET-TOPIC',
    ntfyToken: 'tk_SECRET-NTFY-TOKEN',
    telegramBotToken: TG,
    telegramChatId: '-100123',
    emailEnabled: false,
    emailTo: '',
    events: ['vm.error'],
  })),
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

describe('ntfy and Telegram settings', () => {
  it('reports them masked, never the topic, the access token or the bot token', async () => {
    const text = await (await fetch(`${base}/admin/settings`)).text();
    expect(text).not.toContain('SECRET-TOPIC');
    expect(text).not.toContain('SECRET-NTFY-TOKEN');
    expect(text).not.toContain('SECRET-TELEGRAM');
    const { notify } = JSON.parse(text) as { notify: Record<string, unknown> };
    expect(notify).toMatchObject({
      hasNtfyUrl: true,
      ntfyUrlMasked: 'https://ntfy.sh/…',
      hasNtfyToken: true,
      hasTelegramBotToken: true,
      telegramBotTokenMasked: '123456789:…',
      telegramChatId: '-100123',
    });
    for (const k of ['ntfyUrl', 'ntfyToken', 'telegramBotToken']) expect(notify).not.toHaveProperty(k);
  });

  it('refuses an ntfy URL on a private host or without a topic', async () => {
    expect((await put({ ntfyUrl: 'http://127.0.0.1/topic', emailEnabled: false, events: [] })).status).toBe(400);
    expect((await put({ ntfyUrl: 'https://ntfy.sh/', emailEnabled: false, events: [] })).status).toBe(400);
    expect(saveNotifyConfig).not.toHaveBeenCalled();
  });

  it('refuses a malformed bot token or chat id, and a bot token without a chat id', async () => {
    expect((await put({ telegramBotToken: 'nope', emailEnabled: false, events: [] })).status).toBe(400);
    expect((await put({ telegramChatId: 'not a chat', emailEnabled: false, events: [] })).status).toBe(400);
    expect((await put({ telegramBotToken: TG.replace('SECRET-TELEGRAM-BOT-TOKEN', 'abcdefghijklmnopqrstuvwxy'), telegramChatId: '', emailEnabled: false, events: [] })).status).toBe(400);
    expect(saveNotifyConfig).not.toHaveBeenCalled();
  });

  it('refuses clearing the chat id while a bot token is stored, unless Telegram is removed', async () => {
    expect((await put({ telegramChatId: '', emailEnabled: false, events: [] })).status).toBe(400);
    expect((await put({ telegramChatId: '  ', emailEnabled: false, events: [] })).status).toBe(400);
    expect(saveNotifyConfig).not.toHaveBeenCalled();
    expect((await put({ telegramChatId: '', clearTelegram: true, emailEnabled: false, events: [] })).status).toBe(200);
  });

  it('saves a valid ntfy topic and Telegram bot', async () => {
    const tg = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const res = await put({ ntfyUrl: 'https://ntfy.sh/ops-x', ntfyToken: 'tk_abc', telegramBotToken: tg, telegramChatId: '@proxmate_ops', emailEnabled: false, events: [] });
    expect(res.status).toBe(200);
    expect(saveNotifyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ntfyUrl: 'https://ntfy.sh/ops-x', ntfyToken: 'tk_abc', telegramBotToken: tg, telegramChatId: '@proxmate_ops' }),
    );
  });
});
