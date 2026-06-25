import nodemailer from 'nodemailer';
import { getConfig, setConfig } from './config.service.js';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Read SMTP config from SystemConfig, or null if not configured. */
export async function getMailConfig(): Promise<MailConfig | null> {
  const [host, port, secure, user, pass, from] = await Promise.all([
    getConfig('smtp_host'),
    getConfig('smtp_port'),
    getConfig('smtp_secure'),
    getConfig('smtp_user'),
    getConfig('smtp_pass'),
    getConfig('smtp_from'),
  ]);
  if (!host) return null;
  return {
    host,
    port: Number(port) || 587,
    secure: secure === 'true',
    user: user || undefined,
    pass: pass || undefined,
    from: from || user || `proxmate@${host}`,
  };
}

export async function isMailConfigured(): Promise<boolean> {
  return !!(await getConfig('smtp_host'));
}

/** Persist SMTP config; the password is stored encrypted and only updated when supplied. */
export async function saveMailConfig(data: {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from?: string;
}): Promise<void> {
  await setConfig('smtp_host', data.host);
  await setConfig('smtp_port', String(data.port));
  await setConfig('smtp_secure', String(data.secure));
  await setConfig('smtp_user', data.user ?? '');
  await setConfig('smtp_from', data.from ?? '');
  if (data.pass && data.pass.trim().length > 0) {
    await setConfig('smtp_pass', data.pass, true);
  }
}

function buildTransport(cfg: MailConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

export async function sendMail(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  const cfg = await getMailConfig();
  if (!cfg) throw new Error('SMTP is not configured');
  await buildTransport(cfg).sendMail({ from: cfg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
}

/** Verify the SMTP connection/credentials (used by the admin "Test" button). */
export async function verifyMailConfig(): Promise<{ ok: true }> {
  const cfg = await getMailConfig();
  if (!cfg) throw new Error('SMTP is not configured');
  await buildTransport(cfg).verify();
  return { ok: true };
}
