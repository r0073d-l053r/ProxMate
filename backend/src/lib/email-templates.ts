const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

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
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px; max-width:480px; background-color:#ffffff; border:1px solid #e4e4e7; border-radius:12px;">
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
${bodyRows}
<tr>
<td style="padding:24px 40px 32px; border-top:1px solid #f0f0f0;">
<p style="margin:0; font-family:${FONT}; font-size:12px; line-height:1.5; color:#a1a1aa;">ProxMate &middot; your self-hosted Proxmox portal</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

/** Branded password-reset email (HTML + plain-text fallback). */
export function passwordResetEmail(resetUrl: string): { subject: string; text: string; html: string } {
  const subject = 'Reset your ProxMate password';

  const text =
    'Someone requested a password reset for your ProxMate account.\n\n' +
    `Reset it here (valid for 1 hour):\n${resetUrl}\n\n` +
    "If this wasn't you, you can ignore this email — your password won't change.";

  const bodyRows = `<tr>
<td style="padding:24px 40px 8px; font-family:${FONT};">
<h1 style="margin:0 0 14px; font-size:18px; font-weight:600; color:#18181b;">Reset your password</h1>
<p style="margin:0 0 22px; font-size:15px; line-height:1.6; color:#3f3f46;">Someone requested a password reset for your ProxMate account. Choose a new password with the button below.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="border-radius:8px; background-color:#18181b;">
<a href="${resetUrl}" style="display:inline-block; padding:12px 28px; font-family:${FONT}; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">Reset password</a>
</td>
</tr>
</table>
<p style="margin:22px 0 6px; font-size:13px; line-height:1.6; color:#71717a;">This link expires in <span style="color:#3f3f46;">1 hour</span>. If the button doesn't work, paste this URL into your browser:</p>
<p style="margin:0 0 18px; font-size:13px; line-height:1.5; word-break:break-all;"><a href="${resetUrl}" style="color:#2563eb; text-decoration:underline;">${resetUrl}</a></p>
<p style="margin:0; font-size:13px; line-height:1.6; color:#71717a;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
</td>
</tr>`;

  return {
    subject,
    text,
    html: wrapEmail('Reset your ProxMate password — this link is valid for 1 hour.', bodyRows),
  };
}
