import { Router, type Request, type Response } from 'express';
import { verifyUnsubscribeToken, setBroadcastOptOut } from '../services/broadcast-optout.service.js';
import { recordAudit } from '../services/audit.service.js';

/**
 * Public unsubscribe endpoint for admin broadcast (announcement) emails —
 * Community Edition only. Mounted OUTSIDE the auth middleware: the HMAC token in
 * the link is the credential (like a password-reset link), so no session or CSRF
 * cookie is involved.
 *
 * Two-step on purpose: the GET renders a confirmation page with a POST button.
 * Corporate mail scanners (Outlook SafeLinks etc.) prefetch every GET in an
 * email — if the GET itself unsubscribed, scanners would silently opt out every
 * recipient. Only the explicit POST changes anything.
 *
 * The confirmation form deliberately carries NO fields: it POSTs back to the
 * same URL (empty form action = current URL, query string included), so the
 * token rides the query string on both steps and no request-derived value is
 * ever rendered into the HTML (no reflected-input path, by construction).
 */
const router = Router();

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Minimal branded shell for the (rare) full-page backend responses. */
function page(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/><title>${title} · ProxMate</title></head>
<body style="margin:0;background:#f4f4f5;font-family:${FONT};">
<div style="max-width:440px;margin:80px auto;padding:36px 40px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;">
<div style="font-size:20px;font-weight:600;color:#18181b;margin-bottom:14px;">ProxMate</div>
${bodyHtml}
<p style="margin:26px 0 0;font-size:12px;color:#a1a1aa;">ProxMate · your self-hosted Proxmox portal</p>
</div></body></html>`;
}

const invalidPage = page(
  'Invalid link',
  `<h1 style="margin:0 0 10px;font-size:17px;color:#18181b;">This link isn't valid</h1>
<p style="margin:0;font-size:14px;line-height:1.6;color:#3f3f46;">This unsubscribe link is invalid or malformed. You can also manage announcement emails from <strong>Security &rarr; Email preferences</strong> inside ProxMate.</p>`,
);

// ─── GET /api/broadcast/unsubscribe?token=… ───────────────────
// Confirmation page only — never mutates (scanner-prefetch safe).

router.get('/unsubscribe', (req: Request, res: Response) => {
  const userId = verifyUnsubscribeToken(String(req.query['token'] ?? ''));
  res.type('html');
  if (!userId) { res.status(404).send(invalidPage); return; }
  // Static page — the form has no fields and POSTs back to this same URL
  // (query string, and thus the token, preserved by the browser).
  res.send(
    page(
      'Unsubscribe',
      `<h1 style="margin:0 0 10px;font-size:17px;color:#18181b;">Unsubscribe from announcements?</h1>
<p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#3f3f46;">You'll stop receiving announcement emails your administrator sends to all users (maintenance notices, general updates). Security and account emails — password resets, sign-in alerts — are <strong>not</strong> affected.</p>
<form method="post" style="margin:0;">
<button type="submit" style="padding:11px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#fff;background:#18181b;border:0;border-radius:8px;cursor:pointer;">Unsubscribe</button>
</form>
<p style="margin:18px 0 0;font-size:12px;color:#71717a;">Changed your mind later? Re-enable them in ProxMate under <strong>Security &rarr; Email preferences</strong>.</p>`,
    ),
  );
});

// ─── POST /api/broadcast/unsubscribe?token=… ──────────────────
// The explicit action (token from the query string, same as the GET).
// Idempotent; audited with the user as the actor.

router.post('/unsubscribe', async (req: Request, res: Response) => {
  const userId = verifyUnsubscribeToken(String(req.query['token'] ?? ''));
  res.type('html');
  if (!userId) { res.status(404).send(invalidPage); return; }

  const email = await setBroadcastOptOut(userId, true);
  if (!email) { res.status(404).send(invalidPage); return; }

  await recordAudit({ action: 'user.broadcast_optout', actor: { id: userId, email }, detail: 'via email link', req });
  res.send(
    page(
      'Unsubscribed',
      `<h1 style="margin:0 0 10px;font-size:17px;color:#18181b;">You're unsubscribed</h1>
<p style="margin:0;font-size:14px;line-height:1.6;color:#3f3f46;"><strong>${email.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)}</strong> will no longer receive announcement emails. Security and account emails still arrive. You can re-subscribe anytime in ProxMate under <strong>Security &rarr; Email preferences</strong>.</p>`,
    ),
  );
});

export default router;
