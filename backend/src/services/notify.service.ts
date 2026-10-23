import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import { getMailConfig, sendMail } from './mail.service.js';
import { notificationEmail } from '../lib/email-templates.js';
import { assertSafeOutboundUrl } from '../lib/url-safety.js';

/**
 * Event notifications. A single admin-configured fan-out to optional channels:
 *  - an outgoing webhook (Discord / Slack / Mattermost / generic JSON receiver),
 *  - an ntfy topic (ntfy.sh or a self-hosted server, optional access token),
 *  - a Telegram chat (bot token + chat id, via the Bot API's sendMessage), and
 *  - email (reusing the SMTP config) to a chosen address or to all admins.
 * Each event type can be toggled. All sends are best-effort: a failing channel is
 * logged and never propagates into the operation that triggered the notification.
 */
export const NOTIFY_EVENTS = [
  'backup.failed',
  'vm.error',
  'auth.lockout',
  'access.expired',
  'deploy.agent_missing',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const NOTIFY_EVENT_LABEL: Record<NotifyEvent, string> = {
  'backup.failed': 'Backup failed',
  'vm.error': 'VM error',
  'auth.lockout': 'Account locked',
  'access.expired': 'Tenant access expired',
  'deploy.agent_missing': 'Guest agent missing on deploy',
};

/** ntfy priority (1 min … 5 max) and tags (emoji shortcodes ntfy renders) per event. */
const NTFY_STYLE: Record<NotifyEvent, { priority: number; tags: string[] }> = {
  'backup.failed': { priority: 4, tags: ['floppy_disk', 'x'] },
  'vm.error': { priority: 4, tags: ['computer', 'x'] },
  'auth.lockout': { priority: 4, tags: ['lock'] },
  'access.expired': { priority: 3, tags: ['hourglass'] },
  'deploy.agent_missing': { priority: 3, tags: ['warning'] },
};

export interface NotifyConfig {
  webhookUrl: string; // empty = webhook disabled
  ntfyUrl: string; // topic URL; empty = ntfy disabled
  ntfyToken: string; // optional access token
  telegramBotToken: string; // empty = Telegram disabled
  telegramChatId: string;
  emailEnabled: boolean;
  emailTo: string; // empty = all admins
  events: NotifyEvent[]; // which events fire
}

export interface NotifyPayload {
  event: NotifyEvent;
  title: string; // short, one line
  message: string; // body
}

/**
 * Events added AFTER the settings UI shipped. An install where an admin ever
 * saved notification settings holds a CSV that predates these, so filtering
 * strictly would leave the new event silently off forever — and nobody would
 * be told a tenant lapsed. Opt these in unless explicitly turned off, i.e.
 * unless the admin has saved settings SINCE the event existed (detected by the
 * marker below).
 */
const EVENTS_ADDED_LATER: NotifyEvent[] = ['access.expired', 'deploy.agent_missing'];

/** Bumped whenever EVENTS_ADDED_LATER grows; stored in `notify_events_version`. */
const EVENTS_VERSION = '3';

function parseEvents(csv: string | null, version: string | null): NotifyEvent[] {
  if (csv == null) return [...NOTIFY_EVENTS]; // default: everything on
  const set = new Set(csv.split(',').map((s) => s.trim()));
  // A CSV saved before these events existed cannot have opted out of them, so
  // treat them as on. Once the admin saves from a UI that knows about them the
  // version matches and a deliberate opt-out is respected.
  if (version !== EVENTS_VERSION) for (const e of EVENTS_ADDED_LATER) set.add(e);
  return NOTIFY_EVENTS.filter((e) => set.has(e));
}

export async function getNotifyConfig(): Promise<NotifyConfig> {
  const [url, ntfyUrl, ntfyToken, tgToken, tgChat, emailEnabled, emailTo, events, eventsVersion] = await Promise.all([
    getConfig('notify_webhook_url'),
    getConfig('notify_ntfy_url'),
    getConfig('notify_ntfy_token'),
    getConfig('notify_telegram_bot_token'),
    getConfig('notify_telegram_chat_id'),
    getConfig('notify_email_enabled'),
    getConfig('notify_email_to'),
    getConfig('notify_events'),
    getConfig('notify_events_version'),
  ]);
  return {
    webhookUrl: url ?? '',
    ntfyUrl: ntfyUrl ?? '',
    ntfyToken: ntfyToken ?? '',
    telegramBotToken: tgToken ?? '',
    telegramChatId: tgChat ?? '',
    emailEnabled: emailEnabled === 'true',
    emailTo: emailTo ?? '',
    events: parseEvents(events, eventsVersion),
  };
}

/**
 * A display form of the webhook URL that names where it points without the
 * path, which is where Discord/Slack/Mattermost put the token. '' when unset.
 * Also used for the ntfy topic URL: on a public server the topic name is what
 * lets anyone publish or subscribe, so it is treated the same way.
 */
export function maskWebhookUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '…';
  }
}

/**
 * A display form of a Telegram bot token: the bot's numeric id (the part before
 * the colon, which is public — it is the bot's user id) and nothing of the
 * secret half. '' when unset.
 */
export function maskTelegramToken(token: string): string {
  if (!token) return '';
  const id = /^(\d+):/.exec(token)?.[1];
  return id ? `${id}:…` : '…';
}

/** A Telegram bot token as BotFather issues it: `<bot id>:<secret>`. */
export const TELEGRAM_TOKEN_RE = /^\d{3,15}:[A-Za-z0-9_-]{30,80}$/;
/** A numeric chat id (groups/channels are negative) or a public `@channelname`. */
export const TELEGRAM_CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,63})$/;

/**
 * The publish endpoint and topic for an ntfy topic URL. ntfy can be served under
 * a sub-path, so the topic is the LAST path segment and everything before it is
 * the server. Throws when there is no topic.
 */
export function parseNtfyTopicUrl(url: string): { server: string; topic: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('ntfy URL is not a valid URL.');
  }
  if (u.search || u.hash) throw new Error('ntfy URL must be a plain topic URL, like https://ntfy.sh/my-topic.');
  const parts = u.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
    throw new Error('ntfy URL must end in a topic name, like https://ntfy.sh/my-topic.');
  }
  return { server: `${u.origin}/${parts.map((p) => `${p}/`).join('')}`, topic };
}

export async function saveNotifyConfig(cfg: {
  /** New URL; blank or omitted keeps the stored one (it is never sent back to the UI). */
  webhookUrl?: string;
  /** Remove the stored webhook (disables that channel). */
  clearWebhookUrl?: boolean;
  /** New ntfy topic URL; blank or omitted keeps the stored one. */
  ntfyUrl?: string;
  /** New ntfy access token; blank or omitted keeps the stored one. */
  ntfyToken?: string;
  /** Remove the ntfy topic and its token (disables that channel). */
  clearNtfy?: boolean;
  /** Remove only the ntfy access token (publish anonymously). */
  clearNtfyToken?: boolean;
  /** New Telegram bot token; blank or omitted keeps the stored one. */
  telegramBotToken?: string;
  /** Telegram chat id; omitted keeps the stored one. Not a secret, so it is shown as is. */
  telegramChatId?: string;
  /** Remove the Telegram bot token and chat id (disables that channel). */
  clearTelegram?: boolean;
  emailEnabled: boolean;
  emailTo?: string;
  events: NotifyEvent[];
}): Promise<void> {
  const url = (cfg.webhookUrl ?? '').trim();
  // A webhook URL is effectively a secret (anyone with it can post) → encrypt it
  // when present; store an empty marker (non-sensitive) when removed.
  if (cfg.clearWebhookUrl) await setConfig('notify_webhook_url', '', false);
  else if (url) await setConfig('notify_webhook_url', url, true);

  // ntfy: the topic URL and the token are both secrets (a public topic name is
  // its own credential), stored and cleared the same way as the webhook URL.
  const ntfyUrl = (cfg.ntfyUrl ?? '').trim();
  const ntfyToken = (cfg.ntfyToken ?? '').trim();
  if (cfg.clearNtfy) {
    await setConfig('notify_ntfy_url', '', false);
    await setConfig('notify_ntfy_token', '', false);
  } else {
    if (ntfyUrl) await setConfig('notify_ntfy_url', ntfyUrl, true);
    if (cfg.clearNtfyToken) await setConfig('notify_ntfy_token', '', false);
    else if (ntfyToken) await setConfig('notify_ntfy_token', ntfyToken, true);
  }

  // Telegram: the bot token is the secret; the chat id is not.
  const tgToken = (cfg.telegramBotToken ?? '').trim();
  if (cfg.clearTelegram) {
    await setConfig('notify_telegram_bot_token', '', false);
    await setConfig('notify_telegram_chat_id', '');
  } else {
    if (tgToken) await setConfig('notify_telegram_bot_token', tgToken, true);
    if (cfg.telegramChatId !== undefined) await setConfig('notify_telegram_chat_id', cfg.telegramChatId.trim());
  }

  await setConfig('notify_email_enabled', String(cfg.emailEnabled));
  await setConfig('notify_email_to', (cfg.emailTo ?? '').trim());
  await setConfig('notify_events', cfg.events.filter((e) => NOTIFY_EVENTS.includes(e)).join(','));
  // Records that this CSV was written by a UI aware of every current event, so
  // parseEvents stops auto-enabling the later additions and an explicit
  // opt-out sticks.
  await setConfig('notify_events_version', EVENTS_VERSION);
}

/**
 * fetch() with the options every channel shares, turning a network-level failure
 * into a message naming the cause (ENOTFOUND, ECONNREFUSED, TimeoutError) but
 * never the URL — the Telegram URL carries the bot token.
 */
async function postJson(url: string, body: unknown, what: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error', // do not follow redirects to a private host
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // DNS / connection / timeout failures throw here. Surface the underlying
    // cause so the admin can tell a bad/typo'd URL or an unreachable host from
    // a server bug.
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    throw new Error(`couldn't reach ${what}${code ? ` (${code})` : ''}`);
  }
}

/** POST a payload to the configured webhook. `content` is read by Discord, `text` by Slack/Mattermost. */
async function postWebhook(url: string, p: NotifyPayload): Promise<void> {
  // SSRF guard: never let an admin-configured webhook hit loopback/LAN/metadata.
  await assertSafeOutboundUrl(url, 'Webhook URL');
  const text = `**ProxMate — ${NOTIFY_EVENT_LABEL[p.event]}**\n${p.title}\n${p.message}`;
  const res = await postJson(url, { content: text, text, title: p.title, message: p.message, event: p.event }, 'the webhook URL');
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

/**
 * Publish to an ntfy topic with ntfy's JSON format (POST to the server root
 * with the topic in the body), which carries the title, priority and tags as
 * fields and keeps non-ASCII text intact where HTTP headers would not.
 */
async function postNtfy(url: string, token: string, p: NotifyPayload): Promise<void> {
  // Same SSRF guard as the webhook: the topic URL is admin-supplied.
  await assertSafeOutboundUrl(url, 'ntfy URL');
  const { server, topic } = parseNtfyTopicUrl(url);
  const style = NTFY_STYLE[p.event];
  const res = await postJson(
    server,
    {
      topic,
      title: `ProxMate — ${NOTIFY_EVENT_LABEL[p.event]}: ${p.title}`,
      message: p.message || p.title,
      priority: style.priority,
      tags: ['proxmate', ...style.tags],
    },
    'the ntfy server',
    token ? { authorization: `Bearer ${token}` } : {},
  );
  if (!res.ok) {
    throw new Error(res.status === 401 || res.status === 403 ? `ntfy refused the publish (${res.status} — check the access token)` : `ntfy responded ${res.status}`);
  }
}

/** Send a payload to a Telegram chat through the Bot API. Always api.telegram.org. */
async function postTelegram(botToken: string, chatId: string, p: NotifyPayload): Promise<void> {
  if (!chatId) throw new Error('Telegram chat id is not set');
  const text = `ProxMate — ${NOTIFY_EVENT_LABEL[p.event]}\n${p.title}\n\n${p.message}`;
  const res = await postJson(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    // Plain text (no parse_mode): titles and messages carry VM names and errors
    // that would otherwise need Markdown/HTML escaping.
    { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true },
    'Telegram',
  );
  if (!res.ok) {
    // The Bot API explains itself ("Bad Request: chat not found"); pass that on.
    const desc = await res
      .json()
      .then((b: { description?: unknown }) => (typeof b.description === 'string' ? b.description : ''))
      .catch(() => '');
    throw new Error(`Telegram responded ${res.status}${desc ? `: ${desc.slice(0, 200)}` : ''}`);
  }
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

type PushChannel = 'webhook' | 'ntfy' | 'telegram';

/** The configured non-email channels, each with its sender. */
function pushChannels(cfg: NotifyConfig): Array<{ channel: PushChannel; send: (p: NotifyPayload) => Promise<void> }> {
  const out: Array<{ channel: PushChannel; send: (p: NotifyPayload) => Promise<void> }> = [];
  if (cfg.webhookUrl) out.push({ channel: 'webhook', send: (p) => postWebhook(cfg.webhookUrl, p) });
  if (cfg.ntfyUrl) out.push({ channel: 'ntfy', send: (p) => postNtfy(cfg.ntfyUrl, cfg.ntfyToken, p) });
  if (cfg.telegramBotToken) {
    out.push({ channel: 'telegram', send: (p) => postTelegram(cfg.telegramBotToken, cfg.telegramChatId, p) });
  }
  return out;
}

/** Dispatch a notification to all enabled channels for its event. Best-effort. */
export async function notify(payload: NotifyPayload): Promise<void> {
  const cfg = await getNotifyConfig();
  if (!cfg.events.includes(payload.event)) return;
  await Promise.all([
    ...pushChannels(cfg).map((c) =>
      c.send(payload).catch((e) => console.warn(`[notify] ${c.channel} failed:`, e)),
    ),
    cfg.emailEnabled
      ? emailNotice(cfg, payload).catch((e) => console.warn('[notify] email failed:', e))
      : Promise.resolve(),
  ]);
}

/**
 * Push-only dispatch (webhook, ntfy, Telegram) — used where email is already
 * handled elsewhere (e.g. lockouts).
 */
export async function notifyWebhook(payload: NotifyPayload): Promise<void> {
  const cfg = await getNotifyConfig();
  if (!cfg.events.includes(payload.event)) return;
  await Promise.all(
    pushChannels(cfg).map((c) => c.send(payload).catch((e) => console.warn(`[notify] ${c.channel} failed:`, e))),
  );
}

export interface TestChannelResult {
  channel: PushChannel | 'email';
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

  for (const c of pushChannels(cfg)) {
    try {
      await c.send(payload);
      results.push({ channel: c.channel, ok: true });
    } catch (e) {
      results.push({ channel: c.channel, ok: false, error: msg(e) });
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
    throw new Error('No notification channel is enabled — set a webhook, ntfy topic or Telegram bot, or enable email first.');
  }
  return { ok: results.every((r) => r.ok), results };
}
