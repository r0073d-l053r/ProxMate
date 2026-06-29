import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import { getMailConfig, sendMail } from './mail.service.js';
import { notificationEmail } from '../lib/email-templates.js';

/**
 * Event notifications. A single admin-configured fan-out to two optional channels:
 *  - an outgoing webhook (Discord / Slack / Mattermost / generic JSON receiver), and
 *  - email (reusing the SMTP config) to a chosen address or to all admins.
 * Each event type can be toggled. All sends are best-effort: a failing channel is
 * logged and never propagates into the operation that triggered the notification.
 */
export const NOTIFY_EVENTS = ['backup.failed', 'vm.error', 'auth.lockout'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const NOTIFY_EVENT_LABEL: Record<NotifyEvent, string> = {
  'backup.failed': 'Backup failed',
  'vm.error': 'VM error',
  'auth.lockout': 'Account locked',
};

export interface NotifyConfig {
  webhookUrl: string; // empty = webhook disabled
  emailEnabled: boolean;
  emailTo: string; // empty = all admins
  events: NotifyEvent[]; // which events fire
}

export interface NotifyPayload {
  event: NotifyEvent;
  title: string; // short, one line
  message: string; // body
}

function parseEvents(csv: string | null): NotifyEvent[] {
  if (csv == null) return [...NOTIFY_EVENTS]; // default: everything on
  const set = new Set(csv.split(',').map((s) => s.trim()));
  return NOTIFY_EVENTS.filter((e) => set.has(e));
}

export async function getNotifyConfig(): Promise<NotifyConfig> {
  const [url, emailEnabled, emailTo, events] = await Promise.all([
    getConfig('notify_webhook_url'),
    getConfig('notify_email_enabled'),
    getConfig('notify_email_to'),
    getConfig('notify_events'),
  ]);
  return {
    webhookUrl: url ?? '',
    emailEnabled: emailEnabled === 'true',
    emailTo: emailTo ?? '',
    events: parseEvents(events),
  };
}

export async function saveNotifyConfig(cfg: {
  webhookUrl?: string;
  emailEnabled: boolean;
  emailTo?: string;
  events: NotifyEvent[];
}): Promise<void> {
  const url = (cfg.webhookUrl ?? '').trim();
  // A webhook URL is effectively a secret (anyone with it can post) → encrypt it
  // when present; store an empty marker (non-sensitive) when cleared.
  await setConfig('notify_webhook_url', url, url.length > 0);
  await setConfig('notify_email_enabled', String(cfg.emailEnabled));
  await setConfig('notify_email_to', (cfg.emailTo ?? '').trim());
  await setConfig('notify_events', cfg.events.filter((e) => NOTIFY_EVENTS.includes(e)).join(','));
}

/** POST a payload to the configured webhook. `content` is read by Discord, `text` by Slack/Mattermost. */
async function postWebhook(url: string, p: NotifyPayload): Promise<void> {
  const text = `**ProxMate — ${NOTIFY_EVENT_LABEL[p.event]}**\n${p.title}\n${p.message}`;
  const body = JSON.stringify({ content: text, text, title: p.title, message: p.message, event: p.event });
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // DNS / connection / timeout failures throw here. Surface the underlying
    // cause (e.g. ENOTFOUND, ECONNREFUSED, TimeoutError) so the admin can tell a
    // bad/typo'd URL or an unreachable host from a server bug.
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    throw new Error(`couldn't reach the webhook URL${code ? ` (${code})` : ''}`);
  }
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

/** Email a payload to the configured recipient, or to every admin if none is set. */
async function emailNotice(cfg: NotifyConfig, p: NotifyPayload): Promise<void> {
  if (!(await getMailConfig())) return; // SMTP off → silently skip
  const recipients = cfg.emailTo
    ? [cfg.emailTo]
    : (await prisma.user.findMany({ where: { role: 'admin' }, select: { email: true } })).map((a) => a.email);
  const { subject, text, html } = notificationEmail(NOTIFY_EVENT_LABEL[p.event], p.title, p.message);
  for (const to of recipients) {
    // Let send failures propagate. The real dispatch paths (notify/notifyWebhook)
    // wrap this in .catch() to stay best-effort; the "send test" path surfaces it.
    await sendMail({ to, subject, text, html });
  }
}

/** Dispatch a notification to all enabled channels for its event. Best-effort. */
export async function notify(payload: NotifyPayload): Promise<void> {
  const cfg = await getNotifyConfig();
  if (!cfg.events.includes(payload.event)) return;
  await Promise.all([
    cfg.webhookUrl
      ? postWebhook(cfg.webhookUrl, payload).catch((e) => console.warn('[notify] webhook failed:', e))
      : Promise.resolve(),
    cfg.emailEnabled
      ? emailNotice(cfg, payload).catch((e) => console.warn('[notify] email failed:', e))
      : Promise.resolve(),
  ]);
}

/** Webhook-only dispatch — used where email is already handled elsewhere (e.g. lockouts). */
export async function notifyWebhook(payload: NotifyPayload): Promise<void> {
  const cfg = await getNotifyConfig();
  if (!cfg.events.includes(payload.event) || !cfg.webhookUrl) return;
  await postWebhook(cfg.webhookUrl, payload).catch((e) => console.warn('[notify] webhook failed:', e));
}

export interface TestChannelResult {
  channel: 'webhook' | 'email';
  ok: boolean;
  error?: string;
}

/**
 * Fire a test notification to every enabled channel (admin "Send test" button).
 * Each channel is attempted independently and its outcome reported — a failing
 * channel does NOT throw (so one bad webhook can't mask a working email, and the
 * caller gets the real per-channel error instead of an opaque 5xx).
 */
export async function sendTestNotification(): Promise<{ ok: boolean; results: TestChannelResult[] }> {
  const cfg = await getNotifyConfig();
  const payload: NotifyPayload = {
    event: 'backup.failed',
    title: 'Test notification',
    message: 'If you can read this, ProxMate notifications are working.',
  };
  const msg = (e: unknown) => (e instanceof Error ? e.message : 'failed');
  const results: TestChannelResult[] = [];

  if (cfg.webhookUrl) {
    try {
      await postWebhook(cfg.webhookUrl, payload);
      results.push({ channel: 'webhook', ok: true });
    } catch (e) {
      results.push({ channel: 'webhook', ok: false, error: msg(e) });
    }
  }
  if (cfg.emailEnabled) {
    try {
      if (!(await getMailConfig())) throw new Error('SMTP is not configured');
      await emailNotice(cfg, payload);
      results.push({ channel: 'email', ok: true });
    } catch (e) {
      results.push({ channel: 'email', ok: false, error: msg(e) });
    }
  }
  if (results.length === 0) {
    throw new Error('No notification channel is enabled — set a webhook URL or enable email first.');
  }
  return { ok: results.every((r) => r.ok), results };
}
