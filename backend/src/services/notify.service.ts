import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import { getMailConfig, sendMail } from './mail.service.js';

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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

/** Email a payload to the configured recipient, or to every admin if none is set. */
async function emailNotice(cfg: NotifyConfig, p: NotifyPayload): Promise<void> {
  if (!(await getMailConfig())) return; // SMTP off → silently skip
  const recipients = cfg.emailTo
    ? [cfg.emailTo]
    : (await prisma.user.findMany({ where: { role: 'admin' }, select: { email: true } })).map((a) => a.email);
  const subject = `[ProxMate] ${NOTIFY_EVENT_LABEL[p.event]}: ${p.title}`;
  for (const to of recipients) {
    await sendMail({ to, subject, text: p.message }).catch(() => undefined);
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

/** Fire a test notification to every enabled channel (admin "Send test" button). */
export async function sendTestNotification(): Promise<{ ok: true; channels: string[] }> {
  const cfg = await getNotifyConfig();
  const payload: NotifyPayload = {
    event: 'backup.failed',
    title: 'Test notification',
    message: 'If you can read this, ProxMate notifications are working.',
  };
  const channels: string[] = [];
  if (cfg.webhookUrl) {
    await postWebhook(cfg.webhookUrl, payload);
    channels.push('webhook');
  }
  if (cfg.emailEnabled) {
    await emailNotice(cfg, payload);
    channels.push('email');
  }
  if (channels.length === 0) {
    throw new Error('No notification channel is enabled — set a webhook URL or enable email first.');
  }
  return { ok: true, channels };
}
