import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(), sendMail: vi.fn() }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: { user: { findMany: vi.fn() } } }));
// The SSRF guard does a real DNS lookup before the webhook POST; stub it so unit
// tests exercise the fan-out logic (webhook reachability is mocked via fetch).
vi.mock('../src/lib/url-safety.js', () => ({
  assertSafeOutboundUrl: vi.fn().mockResolvedValue(undefined),
  assertPublicHttpUrlShape: vi.fn(),
}));

import { getConfig, setConfig } from '../src/services/config.service.js';
import { getMailConfig, sendMail } from '../src/services/mail.service.js';
import { prisma } from '../src/lib/prisma.js';
import {
  notify,
  notifyWebhook,
  saveNotifyConfig,
  sendTestNotification,
  maskWebhookUrl,
  maskTelegramToken,
  parseNtfyTopicUrl,
} from '../src/services/notify.service.js';
import { assertSafeOutboundUrl } from '../src/lib/url-safety.js';

const getConfigMock = vi.mocked(getConfig);
const setConfigMock = vi.mocked(setConfig);
const getMailConfigMock = vi.mocked(getMailConfig);
const sendMailMock = vi.mocked(sendMail);
const findMany = vi.mocked(prisma.user.findMany);

/** Drive getConfig from a key→value map (defaults: all events on, channels off). */
function configure(over: Record<string, string | null> = {}) {
  const base: Record<string, string | null> = {
    notify_webhook_url: null,
    notify_email_enabled: 'false',
    notify_email_to: null,
    notify_events: 'backup.failed,vm.error,auth.lockout',
    ...over,
  };
  getConfigMock.mockImplementation(async (k: string) => (k in base ? base[k] : null));
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  sendMailMock.mockResolvedValue();
  findMany.mockResolvedValue([{ email: 'admin@x.y' }] as never);
});

describe('notify — dispatch + event filtering', () => {
  it('does nothing when the event is not enabled', async () => {
    configure({ notify_webhook_url: 'https://hook', notify_events: 'vm.error' });
    await notify({ event: 'backup.failed', title: 't', message: 'm' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('posts a Discord/Slack-shaped body to the webhook', async () => {
    configure({ notify_webhook_url: 'https://hook' });
    await notify({ event: 'backup.failed', title: 'web-01', message: 'vzdump failed' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://hook');
    const body = JSON.parse(opts.body);
    expect(body.content).toContain('Backup failed'); // Discord reads `content`
    expect(body.text).toContain('vzdump failed'); // Slack reads `text`
    expect(body.event).toBe('backup.failed');
  });

  it('emails all admins when email is enabled and SMTP is configured', async () => {
    configure({ notify_email_enabled: 'true' });
    getMailConfigMock.mockResolvedValue({ host: 'smtp' } as never);
    findMany.mockResolvedValue([{ email: 'a@x.y' }, { email: 'b@x.y' }] as never);

    await notify({ event: 'vm.error', title: 'box', message: 'oops' });

    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@x.y', subject: expect.stringContaining('VM error') }),
    );
  });

  it('emails the explicit recipient instead of admins when set', async () => {
    configure({ notify_email_enabled: 'true', notify_email_to: 'ops@x.y' });
    getMailConfigMock.mockResolvedValue({ host: 'smtp' } as never);

    await notify({ event: 'vm.error', title: 'b', message: 'm' });

    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@x.y' }));
    expect(findMany).not.toHaveBeenCalled();
  });

  it('is best-effort: a failing webhook never throws', async () => {
    configure({ notify_webhook_url: 'https://hook' });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(notify({ event: 'backup.failed', title: 't', message: 'm' })).resolves.toBeUndefined();
  });

  it('enables every event by default when none are stored', async () => {
    configure({ notify_webhook_url: 'https://hook', notify_events: null });
    await notify({ event: 'auth.lockout', title: 'u', message: 'm' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sendTestNotification', () => {
  it('throws when no channel is enabled', async () => {
    configure({});
    await expect(sendTestNotification()).rejects.toThrow(/No notification channel/);
  });

  it('reports per-channel success for the channels it reached', async () => {
    configure({ notify_webhook_url: 'https://hook', notify_email_enabled: 'true' });
    getMailConfigMock.mockResolvedValue({ host: 'smtp' } as never);
    const r = await sendTestNotification();
    expect(r.ok).toBe(true);
    expect(r.results.map((c) => c.channel)).toEqual(['webhook', 'email']);
    expect(r.results.every((c) => c.ok)).toBe(true);
  });

  it('reports a failing webhook instead of throwing (so the route never 502s)', async () => {
    configure({ notify_webhook_url: 'https://hook' });
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const r = await sendTestNotification();
    expect(r.ok).toBe(false);
    expect(r.results.find((c) => c.channel === 'webhook')).toMatchObject({ ok: false });
    expect(r.results.find((c) => c.channel === 'webhook')?.error).toContain('404');
  });

  it('surfaces an unreachable webhook cause (DNS/network)', async () => {
    configure({ notify_webhook_url: 'https://nope.invalid' });
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const r = await sendTestNotification();
    const wh = r.results.find((c) => c.channel === 'webhook');
    expect(wh?.ok).toBe(false);
    expect(wh?.error).toContain('ENOTFOUND');
  });

  it('isolates channels: a failing email does not mask a working webhook', async () => {
    configure({ notify_webhook_url: 'https://hook', notify_email_enabled: 'true' });
    getMailConfigMock.mockResolvedValue({ host: 'smtp' } as never);
    sendMailMock.mockRejectedValue(new Error('SMTP auth failed'));
    const r = await sendTestNotification();
    expect(r.ok).toBe(false);
    expect(r.results.find((c) => c.channel === 'webhook')?.ok).toBe(true);
    expect(r.results.find((c) => c.channel === 'email')?.ok).toBe(false);
  });
});

describe('saveNotifyConfig', () => {
  it('encrypts a present webhook URL and stores the event CSV', async () => {
    await saveNotifyConfig({ webhookUrl: 'https://hook', emailEnabled: true, emailTo: '', events: ['vm.error'] });
    expect(setConfigMock).toHaveBeenCalledWith('notify_webhook_url', 'https://hook', true);
    expect(setConfigMock).toHaveBeenCalledWith('notify_events', 'vm.error');
    expect(setConfigMock).toHaveBeenCalledWith('notify_email_enabled', 'true');
  });

  it('keeps the stored webhook when the field is blank', async () => {
    await saveNotifyConfig({ webhookUrl: '', emailEnabled: false, events: [] });
    await saveNotifyConfig({ emailEnabled: false, events: [] });
    expect(setConfigMock.mock.calls.filter((c) => c[0] === 'notify_webhook_url')).toEqual([]);
  });

  it('stores a removed webhook as a non-sensitive empty value', async () => {
    await saveNotifyConfig({ clearWebhookUrl: true, emailEnabled: false, events: [] });
    expect(setConfigMock).toHaveBeenCalledWith('notify_webhook_url', '', false);
  });
});

describe('maskWebhookUrl', () => {
  it('keeps only the scheme and host', () => {
    expect(maskWebhookUrl('https://hooks.slack.com/services/T0/B0/SECRET')).toBe('https://hooks.slack.com/…');
  });

  it('returns empty for no URL and a placeholder for an unparsable one', () => {
    expect(maskWebhookUrl('')).toBe('');
    expect(maskWebhookUrl('not a url SECRET')).toBe('…');
  });
});

const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('ntfy channel', () => {
  it('publishes JSON (topic, title, priority, tags) to the server root with the access token', async () => {
    configure({ notify_ntfy_url: 'https://ntfy.example.com/alerts-x1', notify_ntfy_token: 'tk_SECRET' });
    await notify({ event: 'auth.lockout', title: 'bob@example.com', message: 'locked — 5 attempts' });

    expect(assertSafeOutboundUrl).toHaveBeenCalledWith('https://ntfy.example.com/alerts-x1', 'ntfy URL');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string>; redirect: string }];
    expect(url).toBe('https://ntfy.example.com/');
    expect(opts.headers.authorization).toBe('Bearer tk_SECRET');
    expect(opts.redirect).toBe('error');
    expect(JSON.parse(opts.body)).toEqual({
      topic: 'alerts-x1',
      title: 'ProxMate — Account locked: bob@example.com',
      message: 'locked — 5 attempts',
      priority: 4,
      tags: ['proxmate', 'lock'],
    });
  });

  it('publishes anonymously without a token and keeps a server sub-path', async () => {
    configure({ notify_ntfy_url: 'https://example.com/ntfy/ops' });
    await notify({ event: 'access.expired', title: 't', message: 'm' });
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://example.com/ntfy/');
    expect(opts.headers.authorization).toBeUndefined();
    expect(JSON.parse(opts.body)).toMatchObject({ topic: 'ops', priority: 3 });
  });

  it('names a refused token in the test result', async () => {
    configure({ notify_ntfy_url: 'https://ntfy.sh/t', notify_ntfy_token: 'tk_bad' });
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const r = await sendTestNotification();
    expect(r.results).toEqual([{ channel: 'ntfy', ok: false, error: expect.stringContaining('access token') }]);
  });
});

describe('Telegram channel', () => {
  it('sends plain text to the Bot API sendMessage for the chat', async () => {
    configure({ notify_telegram_bot_token: TG_TOKEN, notify_telegram_chat_id: '-1001234567890' });
    await notify({ event: 'vm.error', title: 'web-01', message: 'create failed' });

    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string; redirect: string }];
    expect(url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    expect(opts.redirect).toBe('error');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ chat_id: '-1001234567890', disable_web_page_preview: true });
    expect(body.text).toContain('VM error');
    expect(body.text).toContain('create failed');
    expect(body.parse_mode).toBeUndefined();
  });

  it("reports the Bot API's reason, never the token, when a send fails", async () => {
    configure({ notify_telegram_bot_token: TG_TOKEN, notify_telegram_chat_id: '42' });
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
    const r = await sendTestNotification();
    expect(r.results[0]).toMatchObject({ channel: 'telegram', ok: false, error: 'Telegram responded 400: Bad Request: chat not found' });

    fetchMock.mockRejectedValue(Object.assign(new Error(`fetch failed for bot${TG_TOKEN}`), { cause: { code: 'ECONNRESET' } }));
    const r2 = await sendTestNotification();
    expect(r2.results[0]!.error).toBe("couldn't reach Telegram (ECONNRESET)");
    expect(JSON.stringify(r2)).not.toContain(TG_TOKEN.split(':')[1]);
  });

  it('is part of push-only dispatch alongside the webhook and ntfy', async () => {
    configure({
      notify_webhook_url: 'https://hook',
      notify_ntfy_url: 'https://ntfy.sh/t',
      notify_telegram_bot_token: TG_TOKEN,
      notify_telegram_chat_id: '42',
      notify_email_enabled: 'true',
    });
    getMailConfigMock.mockResolvedValue({ host: 'smtp' } as never);
    await notifyWebhook({ event: 'auth.lockout', title: 't', message: 'm' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe('saveNotifyConfig — ntfy and Telegram', () => {
  it('encrypts the ntfy URL and token and the Telegram bot token; the chat id is stored plain', async () => {
    await saveNotifyConfig({
      ntfyUrl: 'https://ntfy.sh/t',
      ntfyToken: 'tk_x',
      telegramBotToken: TG_TOKEN,
      telegramChatId: ' 42 ',
      emailEnabled: false,
      events: [],
    });
    expect(setConfigMock).toHaveBeenCalledWith('notify_ntfy_url', 'https://ntfy.sh/t', true);
    expect(setConfigMock).toHaveBeenCalledWith('notify_ntfy_token', 'tk_x', true);
    expect(setConfigMock).toHaveBeenCalledWith('notify_telegram_bot_token', TG_TOKEN, true);
    expect(setConfigMock).toHaveBeenCalledWith('notify_telegram_chat_id', '42');
  });

  it('keeps stored secrets when fields are blank or omitted, and clears on request', async () => {
    await saveNotifyConfig({ ntfyUrl: '', ntfyToken: '', telegramBotToken: '', emailEnabled: false, events: [] });
    const keys = () => setConfigMock.mock.calls.map((c) => c[0]);
    expect(keys()).not.toContain('notify_ntfy_url');
    expect(keys()).not.toContain('notify_ntfy_token');
    expect(keys()).not.toContain('notify_telegram_bot_token');
    expect(keys()).not.toContain('notify_telegram_chat_id');

    setConfigMock.mockClear();
    await saveNotifyConfig({ clearNtfy: true, clearTelegram: true, emailEnabled: false, events: [] });
    expect(setConfigMock).toHaveBeenCalledWith('notify_ntfy_url', '', false);
    expect(setConfigMock).toHaveBeenCalledWith('notify_ntfy_token', '', false);
    expect(setConfigMock).toHaveBeenCalledWith('notify_telegram_bot_token', '', false);
    expect(setConfigMock).toHaveBeenCalledWith('notify_telegram_chat_id', '');
  });
});

describe('maskTelegramToken / parseNtfyTopicUrl', () => {
  it('shows only the public bot id', () => {
    expect(maskTelegramToken(TG_TOKEN)).toBe('123456789:…');
    expect(maskTelegramToken('')).toBe('');
    expect(maskTelegramToken('garbage')).toBe('…');
  });

  it('splits a topic URL into server and topic, and refuses one without a topic', () => {
    expect(parseNtfyTopicUrl('https://ntfy.sh/my-topic')).toEqual({ server: 'https://ntfy.sh/', topic: 'my-topic' });
    expect(parseNtfyTopicUrl('https://x.example/a/b/topic_1')).toEqual({ server: 'https://x.example/a/b/', topic: 'topic_1' });
    expect(() => parseNtfyTopicUrl('https://ntfy.sh/')).toThrow(/topic/);
    expect(() => parseNtfyTopicUrl('https://ntfy.sh/t?auth=x')).toThrow(/plain topic URL/);
  });
});
