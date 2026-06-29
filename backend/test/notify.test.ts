import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock('../src/services/mail.service.js', () => ({ getMailConfig: vi.fn(), sendMail: vi.fn() }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: { user: { findMany: vi.fn() } } }));

import { getConfig, setConfig } from '../src/services/config.service.js';
import { getMailConfig, sendMail } from '../src/services/mail.service.js';
import { prisma } from '../src/lib/prisma.js';
import { notify, saveNotifyConfig, sendTestNotification } from '../src/services/notify.service.js';

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

  it('reports the channels it reached', async () => {
    configure({ notify_webhook_url: 'https://hook', notify_email_enabled: 'true' });
    getMailConfigMock.mockResolvedValue({ host: 'smtp' } as never);
    const r = await sendTestNotification();
    expect(r.channels).toEqual(['webhook', 'email']);
  });
});

describe('saveNotifyConfig', () => {
  it('encrypts a present webhook URL and stores the event CSV', async () => {
    await saveNotifyConfig({ webhookUrl: 'https://hook', emailEnabled: true, emailTo: '', events: ['vm.error'] });
    expect(setConfigMock).toHaveBeenCalledWith('notify_webhook_url', 'https://hook', true);
    expect(setConfigMock).toHaveBeenCalledWith('notify_events', 'vm.error');
    expect(setConfigMock).toHaveBeenCalledWith('notify_email_enabled', 'true');
  });

  it('stores a cleared webhook as a non-sensitive empty value', async () => {
    await saveNotifyConfig({ webhookUrl: '', emailEnabled: false, events: [] });
    expect(setConfigMock).toHaveBeenCalledWith('notify_webhook_url', '', false);
  });
});
