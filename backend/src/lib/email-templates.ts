/**
 * Branded transactional email templates. Every email ProxMate sends — password
 * resets, event notifications, lockout alerts, invites — is composed here so they
 * share one identity: the same wordmark header, palette, typography, footer, and
 * email-client-safe table layout. Add a new template by writing a `bodyRows`
 * builder and wrapping it with {@link wrapEmail}; never hand-roll a standalone
 * email elsewhere, or the branding drifts.
 */

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Fixed light palette matching the app's monochrome theme. Email clients can't be
// trusted with CSS variables or @media dark-mode, so colours are inlined literals.
const INK = '#18181b'; // headings / primary text
const BODY = '#3f3f46'; // body copy
const MUTED = '#71717a'; // secondary copy
const FAINT = '#a1a1aa'; // footer
const LINK = '#2563eb'; // hyperlinks
const HAIR = '#f0f0f0'; // hairline divider
const LINE = '#e4e4e7'; // panel border

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Wrap inner table rows in ProxMate's branded, email-client-safe shell: table
 * layout + inline styles (for Outlook/Gmail), a fixed light palette matching the
 * app's monochrome theme, a hidden preheader, and a wordmark header + footer.
 */
function wrapEmail(preheader: string, bodyRows: string): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>ProxMate</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px; max-width:480px; background-color:#ffffff; border:1px solid ${LINE}; border-radius:12px;">
<tr>
<td style="padding:32px 40px 4px;">
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
<tr>
<td style="vertical-align:middle; padding-right:11px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="42" style="width:42px; background-color:#18181b; border-radius:11px;">
<tr><td align="center" valign="middle" style="padding:11px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td style="width:22px; height:8px; background-color:#ffffff; border-radius:2px;"><div style="width:3px; height:3px; background-color:#18181b; border-radius:50%; margin:2px 0 0 3px; font-size:0; line-height:0;">&nbsp;</div></td></tr>
<tr><td style="height:4px; font-size:0; line-height:4px;">&nbsp;</td></tr>
<tr><td style="width:22px; height:8px; background-color:#ffffff; border-radius:2px;"><div style="width:3px; height:3px; background-color:#18181b; border-radius:50%; margin:2px 0 0 3px; font-size:0; line-height:0;">&nbsp;</div></td></tr>
</table>
</td></tr>
</table>
</td>
<td style="vertical-align:middle;">
<span style="font-family:${FONT}; font-size:22px; font-weight:600; letter-spacing:-0.02em; color:#18181b;">ProxMate</span>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:24px 40px 8px; font-family:${FONT};">
${bodyRows}
</td>
</tr>
<tr>
<td style="padding:24px 40px 32px; border-top:1px solid ${HAIR};">
<p style="margin:0; font-family:${FONT}; font-size:12px; line-height:1.5; color:${FAINT};">ProxMate &middot; your self-hosted Proxmox portal</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

// ─── Reusable content builders (drop into a body cell) ────────────────────────
// Keeping the markup for headings, paragraphs, buttons, link fallbacks and
// key/value panels in one place is what makes every email look the same.

const h1 = (text: string): string =>
  `<h1 style="margin:0 0 14px; font-size:18px; font-weight:600; color:${INK};">${text}</h1>`;

const p = (
  text: string,
  opts: { color?: string; size?: number; mt?: number; mb?: number } = {},
): string => {
  const { color = BODY, size = 15, mt = 0, mb = 22 } = opts;
  return `<p style="margin:${mt}px 0 ${mb}px; font-size:${size}px; line-height:1.6; color:${color};">${text}</p>`;
};

const button = (href: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="border-radius:8px; background-color:${INK};">
<a href="${href}" style="display:inline-block; padding:12px 28px; font-family:${FONT}; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">${label}</a>
</td>
</tr>
</table>`;

/** The "if the button doesn't work, paste this URL" fallback used after CTAs. */
const linkFallback = (url: string): string =>
  `<p style="margin:22px 0 6px; font-size:13px; line-height:1.6; color:${MUTED};">If the button doesn't work, paste this URL into your browser:</p>
<p style="margin:0 0 4px; font-size:13px; line-height:1.5; word-break:break-all;"><a href="${url}" style="color:${LINK}; text-decoration:underline;">${url}</a></p>`;

/** A bordered key/value panel (quotas, lockout details, …). */
const infoTable = (rows: Array<[string, string]>): string => {
  const cells = rows
    .map(([k, v], i) => {
      const border = i === rows.length - 1 ? '' : ` border-bottom:1px solid ${HAIR};`;
      return `<tr>
<td style="padding:10px 14px; font-size:13px; color:${MUTED};${border}">${k}</td>
<td style="padding:10px 14px; font-size:13px; font-weight:600; color:${INK}; text-align:right;${border}">${v}</td>
</tr>`;
    })
    .join('\n');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%; margin:4px 0 22px; border:1px solid ${LINE}; border-radius:8px;">
${cells}
</table>`;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const formatRamMb = (mb: number): string => {
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : Math.round(gb * 10) / 10} GB`;
};

const formatWhen = (d: Date | string): string => new Date(d).toUTCString();

// ─── Templates ────────────────────────────────────────────────────────────────

/** Branded password-reset email (HTML + plain-text fallback). */
export function passwordResetEmail(resetUrl: string): RenderedEmail {
  const subject = 'Reset your ProxMate password';

  const text =
    'Someone requested a password reset for your ProxMate account.\n\n' +
    `Reset it here (valid for 1 hour):\n${resetUrl}\n\n` +
    "If this wasn't you, you can ignore this email — your password won't change.";

  const bodyRows =
    h1('Reset your password') +
    p('Someone requested a password reset for your ProxMate account. Choose a new password with the button below.') +
    button(resetUrl, 'Reset password') +
    `<p style="margin:22px 0 6px; font-size:13px; line-height:1.6; color:${MUTED};">This link expires in <span style="color:${BODY};">1 hour</span>. If the button doesn't work, paste this URL into your browser:</p>
<p style="margin:0 0 18px; font-size:13px; line-height:1.5; word-break:break-all;"><a href="${resetUrl}" style="color:${LINK}; text-decoration:underline;">${resetUrl}</a></p>` +
    p("If you didn't request this, you can safely ignore this email — your password won't change.", {
      color: MUTED,
      size: 13,
      mb: 0,
    });

  return {
    subject,
    text,
    html: wrapEmail('Reset your ProxMate password — this link is valid for 1 hour.', bodyRows),
  };
}

/** Branded event notification (backup failed, VM error, lockout, test, …). */
export function notificationEmail(eventLabel: string, title: string, message: string): RenderedEmail {
  const subject = `[ProxMate] ${eventLabel}: ${title}`;
  const text = `${eventLabel}\n${title}\n\n${message}`;

  const bodyRows =
    h1(escapeHtml(eventLabel)) +
    p(escapeHtml(title), { color: INK, mb: 16 }) +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%; margin:0 0 22px; background-color:#fafafa; border:1px solid ${LINE}; border-radius:8px;">
<tr><td style="padding:14px 16px; font-family:${FONT}; font-size:14px; line-height:1.6; color:${BODY}; white-space:pre-wrap;">${escapeHtml(message)}</td></tr>
</table>` +
    p('This is an automated ProxMate notification. You can adjust which events email you on the admin Settings page.', {
      color: MUTED,
      size: 13,
      mb: 0,
    });

  return { subject, text, html: wrapEmail(`${eventLabel}: ${title}`, bodyRows) };
}

/** Branded brute-force account-lockout alert sent to admins. */
export function accountLockedEmail(opts: {
  email: string;
  attempts: number;
  ip: string | null;
  lockedUntil: Date;
  lockMinutes: number;
}): RenderedEmail {
  const { email, attempts, ip, lockedUntil, lockMinutes } = opts;
  const subject = `[ProxMate] Account locked after failed logins: ${email}`;

  const text =
    `The account "${email}" was locked after ${attempts} consecutive failed login attempts` +
    `${ip ? ` from IP ${ip}` : ''}.\n\n` +
    `It unlocks automatically at ${formatWhen(lockedUntil)} (${lockMinutes} minutes).\n\n` +
    `If this wasn't the account owner mistyping their password, someone may be ` +
    `attempting to brute-force this account. Review the audit log in ProxMate.`;

  const rows: Array<[string, string]> = [
    ['Account', escapeHtml(email)],
    ['Failed attempts', String(attempts)],
  ];
  if (ip) rows.push(['Source IP', escapeHtml(ip)]);
  rows.push(['Unlocks at', `${formatWhen(lockedUntil)} (${lockMinutes} min)`]);

  const bodyRows =
    h1('Account locked') +
    p(`A ProxMate account was locked after ${attempts} consecutive failed login attempts. It will unlock automatically.`) +
    infoTable(rows) +
    p(
      "If this wasn't the account owner mistyping their password, someone may be attempting to brute-force this account — review the audit log in ProxMate.",
      { color: MUTED, size: 13, mb: 0 },
    );

  return { subject, text, html: wrapEmail(`Account ${email} was locked after failed logins.`, bodyRows) };
}

/** Branded invite email — the link an admin sends to a prospective user. */
export function inviteEmail(opts: {
  inviteUrl: string;
  label?: string | null;
  maxCpu: number;
  maxRam: number; // MB
  maxStorage: number; // GB
  require2fa: boolean;
  expiresAt: Date;
  inviterName?: string | null;
}): RenderedEmail {
  const { inviteUrl, maxCpu, maxRam, maxStorage, require2fa, expiresAt, inviterName } = opts;
  const subject = "You're invited to ProxMate";

  const from = inviterName ? `${inviterName} has invited you` : "You've been invited";
  const text =
    `${from} to ProxMate — a private slice of a Proxmox cluster where you can spin up your own VMs.\n\n` +
    `Accept your invite (expires ${formatWhen(expiresAt)}):\n${inviteUrl}\n\n` +
    `Your quota: ${maxCpu} vCPU · ${formatRamMb(maxRam)} RAM · ${maxStorage} GB storage.` +
    (require2fa ? '\nYou will be asked to set up two-step authentication during sign-up.' : '');

  const rows: Array<[string, string]> = [
    ['vCPU', String(maxCpu)],
    ['Memory', formatRamMb(maxRam)],
    ['Storage', `${maxStorage} GB`],
    ['Invite expires', formatWhen(expiresAt)],
  ];
  if (require2fa) rows.push(['Two-step auth', 'Required at sign-up']);

  const bodyRows =
    h1("You're invited to ProxMate") +
    p(
      `${escapeHtml(from)} to ProxMate — a private slice of a Proxmox cluster where you can create and manage your own virtual machines, within the quota below.`,
    ) +
    button(inviteUrl, 'Accept invite') +
    infoTable(rows) +
    linkFallback(inviteUrl) +
    p('If you weren\'t expecting this invite, you can safely ignore this email.', {
      color: MUTED,
      size: 13,
      mt: 16,
      mb: 0,
    });

  return { subject, text, html: wrapEmail("You're invited to ProxMate — accept your invite link inside.", bodyRows) };
}

/**
 * Branded admin broadcast — a maintenance/downtime/general announcement sent to
 * every user. The admin controls the subject and free-text message (preserved
 * line breaks, HTML-escaped).
 */
export function announcementEmail(subject: string, message: string): RenderedEmail {
  const text = `${subject}\n\n${message}`;
  const bodyRows =
    h1(escapeHtml(subject)) +
    `<div style="font-family:${FONT}; font-size:15px; line-height:1.6; color:${BODY}; white-space:pre-wrap;">${escapeHtml(message)}</div>` +
    p("You're receiving this because you have a ProxMate account on this server.", {
      color: MUTED,
      size: 13,
      mt: 24,
      mb: 0,
    });
  return { subject, text, html: wrapEmail(subject, bodyRows) };
}

/**
 * Branded heads-up sent to a VM's owner when an admin migrates their VM to
 * another host (manual migrate or a maintenance node-drain). Reassures them that
 * a running guest keeps running with at most a momentary blip; a stopped guest
 * has no extra interruption.
 */
export function vmMaintenanceEmail(opts: { vmName: string; live: boolean }): RenderedEmail {
  const { vmName, live } = opts;
  const subject = `[ProxMate] Maintenance: your server "${vmName}" is being moved`;

  const blipText = live
    ? 'Your server keeps running throughout the move, but you may notice a brief, momentary interruption — typically a second or less — as it switches hosts. Active connections normally reconnect on their own.'
    : 'Your server is currently powered off, so there is no extra interruption — it will simply be on a different host the next time you start it.';

  const text =
    `Maintenance is being performed on the ProxMate cluster, and your VM "${vmName}" is being migrated to another host.\n\n` +
    `${blipText}\n\n` +
    `No action is needed on your part — this is just a heads-up.`;

  const bodyRows =
    h1('Maintenance on your server') +
    p(
      `Maintenance is being performed on the ProxMate cluster, and your VM <strong style="color:${INK};">${escapeHtml(vmName)}</strong> is being migrated to another host.`,
    ) +
    p(blipText) +
    p('No action is needed on your part — this message is just to let you know.', {
      color: MUTED,
      size: 13,
      mb: 0,
    });

  return {
    subject,
    text,
    html: wrapEmail(`Maintenance: your server "${escapeHtml(vmName)}" is being moved to another host.`, bodyRows),
  };
}

/**
 * Branded alert sent to a VM's owner when one of their per-VM resource alerts
 * trips (CPU/memory sustained high, disk nearly full, or an unexpected stop).
 * `detail` is a one-line human summary already composed by the alert service.
 */
export function alertEmail(opts: { vmName: string; alertLabel: string; detail: string; vmUrl?: string }): RenderedEmail {
  const { vmName, alertLabel, detail, vmUrl } = opts;
  const subject = `[ProxMate] Alert: ${vmName} — ${alertLabel}`;
  const text =
    `${alertLabel} on your server "${vmName}".\n\n${detail}\n\n` +
    (vmUrl ? `View it: ${vmUrl}\n\n` : '') +
    `You're receiving this because you set an alert on this machine. Manage alerts on its page under Settings.`;

  const bodyRows =
    h1(`${escapeHtml(alertLabel)}`) +
    p(
      `Your server <strong style="color:${INK};">${escapeHtml(vmName)}</strong> tripped an alert you set.`,
      { mb: 16 },
    ) +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%; margin:0 0 22px; background-color:#fafafa; border:1px solid ${LINE}; border-radius:8px;">
<tr><td style="padding:14px 16px; font-family:${FONT}; font-size:14px; line-height:1.6; color:${BODY};">${escapeHtml(detail)}</td></tr>
</table>` +
    (vmUrl
      ? p(`<a href="${escapeHtml(vmUrl)}" style="color:${LINK};">Open ${escapeHtml(vmName)} in ProxMate</a>`, { mb: 16 })
      : '') +
    p('You set this alert on the machine’s page. Adjust or remove it there under Settings → Alerts.', {
      color: MUTED,
      size: 13,
      mb: 0,
    });

  return { subject, text, html: wrapEmail(`${alertLabel}: ${escapeHtml(vmName)}`, bodyRows) };
}
