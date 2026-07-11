import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  hashPassword,
  verifyPasswordSafe,
  createSession,
  signChallenge,
  verifyChallenge,
  signEnrollment,
} from '../services/auth.service.js';
import * as twofa from '../services/twofactor.service.js';
import * as passkeys from '../services/passkey.service.js';
import * as sso from '../services/sso.service.js';
import { isMfaSetupRequired } from '../services/mfa.service.js';
import {
  setAuthCookies,
  clearAuthCookies,
  setChallengeCookie,
  clearChallengeCookie,
  WEBAUTHN_COOKIE,
  setSsoCookie,
  clearSsoCookie,
  SSO_COOKIE,
} from '../lib/cookies.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAuthOrEnrollment } from '../middleware/enrollment.js';
import { authLimiter, publicTokenLimiter } from '../middleware/rate-limit.js';
import { recordAudit } from '../services/audit.service.js';
import { isAccountLocked, registerFailedLogin, clearFailedLogins } from '../services/account-lockout.service.js';
import { requestReset, resetWithToken } from '../services/password-reset.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

// ─── POST /api/auth/register ──────────────────────────────────

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(100),
  inviteToken: z.string().min(1),
});

router.post('/register', authLimiter, async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { email, password, displayName, inviteToken } = parsed.data;

  const invite = await prisma.inviteToken.findUnique({ where: { token: inviteToken } });
  if (!invite || invite.usedById || invite.expiresAt < new Date()) {
    res.status(400).json({ error: 'Invalid or expired invite token' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      passwordHash,
      displayName: displayName.trim(),
      maxCpu: invite.maxCpu,
      maxRam: invite.maxRam,
      maxStorage: invite.maxStorage,
      require2fa: invite.require2fa,
    },
  });

  // Atomically claim the invite — only succeeds if still unused. Guards against
  // two concurrent registrations redeeming the same token (quota duplication).
  const claimed = await prisma.inviteToken.updateMany({
    where: { id: invite.id, usedById: null },
    data: { usedById: user.id },
  });
  if (claimed.count === 0) {
    await prisma.user.delete({ where: { id: user.id } });
    res.status(400).json({ error: 'Invite token already used' });
    return;
  }

  await recordAudit({ action: 'auth.register', actor: user, targetType: 'user', targetId: user.id, req });

  // If the invite required 2FA, mint NO session — hand back a scoped enrollment
  // token instead. The first real session is issued only at the post-enrollment
  // login (password + factor, or a passkey), so no session ever exists before a
  // second factor does.
  if (await isMfaSetupRequired(user.id)) {
    res.status(201).json({ mfaEnrollmentRequired: true, enrollmentToken: await signEnrollment(user.id) });
    return;
  }

  const { token, csrfToken, expiresAt } = await createSession(user.id);
  setAuthCookies(res, token, csrfToken, expiresAt);

  res.status(201).json({
    user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
  });
});

// ─── POST /api/auth/login ─────────────────────────────────────

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', authLimiter, async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Brute-force lockout: a locked account short-circuits with the SAME generic
  // response (and a dummy bcrypt for timing parity) so neither the lock nor the
  // account's existence leaks. The lock auto-expires (see account-lockout.service).
  if (user && isAccountLocked(user)) {
    await verifyPasswordSafe(password, null);
    await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'account locked', req });
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Always runs bcrypt (dummy hash when no user) so timing can't enumerate accounts.
  const valid = await verifyPasswordSafe(password, user?.passwordHash);

  if (!user || !valid) {
    // Count the failure against the (real) account; may lock it + alert admins.
    if (user) await registerFailedLogin(user, req.ip ?? null);
    await recordAudit({ action: 'auth.login_failed', targetType: 'email', targetId: email.toLowerCase(), req });
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Correct password — clear any prior failure streak before continuing.
  await clearFailedLogins(user);

  // Required 2FA but no factor enrolled yet → no session. Hand back an enrollment
  // token so an interrupted setup resumes here (a correct password never yields a
  // session until a second factor exists).
  if (await isMfaSetupRequired(user.id)) {
    res.json({ mfaEnrollmentRequired: true, enrollmentToken: await signEnrollment(user.id) });
    return;
  }

  // A require2fa user whose only factor is a passkey has twoFactorEnabled=false;
  // a password alone must not be sufficient for them — they sign in passwordless
  // with the passkey (which is strong MFA on its own).
  if (user.require2fa && !user.ssoSubject && !user.twoFactorEnabled) {
    res.status(401).json({ code: 'passkey_required', error: 'Use your passkey to sign in.' });
    return;
  }

  // 2FA: don't issue a session yet — hand back a short-lived challenge to be
  // exchanged (with a TOTP/recovery code) at /2fa/verify.
  if (user.twoFactorEnabled) {
    res.json({ twoFactorRequired: true, challenge: await signChallenge(user.id) });
    return;
  }

  const { token, csrfToken, expiresAt } = await createSession(user.id);
  setAuthCookies(res, token, csrfToken, expiresAt);

  await recordAudit({ action: 'auth.login', actor: user, req });

  res.json({
    user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
  });
});

// ─── POST /api/auth/2fa/verify ────────────────────────────────
// Exchange a login challenge + TOTP (or recovery) code for a real session.

const TwoFaVerifySchema = z.object({ challenge: z.string().min(1), code: z.string().min(1) });

router.post('/2fa/verify', authLimiter, async (req: Request, res: Response) => {
  const parsed = TwoFaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed' });
    return;
  }
  const userId = await verifyChallenge(parsed.data.challenge);
  if (!userId) {
    res.status(401).json({ error: 'Your login session expired — please sign in again.' });
    return;
  }
  const ok =
    (await twofa.verifyTotp(userId, parsed.data.code)) ||
    (await twofa.verifyRecoveryCode(userId, parsed.data.code));
  if (!ok) {
    await recordAudit({ action: 'auth.2fa_failed', actor: { id: userId }, req });
    res.status(401).json({ error: 'Invalid authentication code.' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(401).json({ error: 'Account not found.' });
    return;
  }
  const { token, csrfToken, expiresAt } = await createSession(user.id);
  setAuthCookies(res, token, csrfToken, expiresAt);
  await recordAudit({ action: 'auth.login', actor: user, detail: '2fa', req });
  res.json({ user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName } });
});

// ─── POST /api/auth/logout ────────────────────────────────────

router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const ar = req as AuthRequest;
  if (ar.sessionToken) await prisma.session.deleteMany({ where: { token: ar.sessionToken } });
  clearAuthCookies(res);
  await recordAudit({ action: 'auth.logout', actor: ar.user, req });
  res.json({ success: true });
});

// ─── GET /api/auth/me ─────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { id } = (req as AuthRequest).user;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // Admin-granted exempt VMs never count toward the quota bar (matches
  // assertWithinQuota / assertResizeWithinQuota).
  const vms = await prisma.virtualMachine.findMany({ where: { userId: id, quotaExempt: false } });
  const usedCpu = vms.reduce((s, v) => s + v.cpu, 0);
  const usedRam = vms.reduce((s, v) => s + v.ram, 0);
  const usedStorage = vms.reduce((s, v) => s + v.storage, 0);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      twoFactorEnabled: user.twoFactorEnabled,
      require2fa: user.require2fa,
      mfaSetupRequired: await isMfaSetupRequired(user.id),
      broadcastOptOut: user.broadcastOptOut,
      createdAt: user.createdAt,
      quota: {
        cpu: { used: usedCpu, max: user.maxCpu },
        ram: { used: usedRam, max: user.maxRam },
        storage: { used: usedStorage, max: user.maxStorage },
      },
    },
  });
});

// ─── PUT /api/auth/email-preferences ──────────────────────────
// Community Edition: opt in/out of admin broadcast (announcement) emails.
// Transactional / security / notification emails are unaffected by this flag.

const EmailPrefsSchema = z.object({ broadcastOptOut: z.boolean() });

router.put('/email-preferences', requireAuth, async (req: Request, res: Response) => {
  const parsed = EmailPrefsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid preference.' }); return; }
  const u = (req as AuthRequest).user;
  await prisma.user.update({ where: { id: u.id }, data: { broadcastOptOut: parsed.data.broadcastOptOut } });
  await recordAudit({
    action: parsed.data.broadcastOptOut ? 'user.broadcast_optout' : 'user.broadcast_optin',
    actor: u,
    detail: 'via email preferences',
    req,
  });
  res.json({ success: true, broadcastOptOut: parsed.data.broadcastOptOut });
});

// ─── 2FA (TOTP) management — authenticated ────────────────────

router.post('/2fa/setup', requireAuthOrEnrollment, async (req: Request, res: Response) => {
  const u = (req as AuthRequest).user;
  res.json(await twofa.beginSetup(u.id, u.email));
});

const TwoFaCodeSchema = z.object({ code: z.string().min(1) });

router.post('/2fa/enable', requireAuthOrEnrollment, async (req: Request, res: Response) => {
  const parsed = TwoFaCodeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter the 6-digit code from your app.' }); return; }
  const u = (req as AuthRequest).user;
  try {
    const { recoveryCodes } = await twofa.enable(u.id, parsed.data.code);
    await recordAudit({ action: 'auth.2fa_enabled', actor: u, req });
    res.json({ recoveryCodes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '2FA enable failed' });
  }
});

router.post('/2fa/disable', requireAuth, async (req: Request, res: Response) => {
  const parsed = TwoFaCodeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a code to confirm.' }); return; }
  const u = (req as AuthRequest).user;
  try {
    await twofa.disable(u.id, parsed.data.code);
    await recordAudit({ action: 'auth.2fa_disabled', actor: u, req });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '2FA disable failed' });
  }
});

router.get('/2fa/status', requireAuth, async (req: Request, res: Response) => {
  res.json(await twofa.getStatus((req as AuthRequest).user.id));
});

// ─── Passkeys (WebAuthn) ──────────────────────────────────────

// Passwordless login: request assertion options (usernameless / discoverable).
router.post('/passkeys/auth/options', authLimiter, async (_req: Request, res: Response) => {
  const options = await passkeys.authenticationOptions();
  setChallengeCookie(res, options.challenge);
  res.json(options);
});

// Passwordless login: verify the assertion → issue a real session.
router.post('/passkeys/auth/verify', authLimiter, async (req: Request, res: Response) => {
  const challenge = req.cookies?.[WEBAUTHN_COOKIE];
  if (!challenge) {
    res.status(400).json({ error: 'Passkey challenge expired — please try again.' });
    return;
  }
  try {
    const userId = await passkeys.verifyAuthentication(req.body, challenge);
    clearChallengeCookie(res);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(401).json({ error: 'Account not found.' });
      return;
    }
    const { token, csrfToken, expiresAt } = await createSession(user.id);
    setAuthCookies(res, token, csrfToken, expiresAt);
    await recordAudit({ action: 'auth.login', actor: user, detail: 'passkey', req });
    res.json({ user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName } });
  } catch (err) {
    await recordAudit({ action: 'auth.passkey_failed', req });
    res.status(401).json({ error: err instanceof Error ? err.message : 'Passkey login failed' });
  }
});

// Enroll a passkey (authenticated).
router.post('/passkeys/register/options', requireAuthOrEnrollment, async (req: Request, res: Response) => {
  const u = (req as AuthRequest).user;
  const options = await passkeys.registrationOptions(u.id, u.email);
  setChallengeCookie(res, options.challenge);
  res.json(options);
});

const PasskeyRegisterSchema = z.object({ response: z.any(), name: z.string().max(100).optional() });

router.post('/passkeys/register/verify', requireAuthOrEnrollment, async (req: Request, res: Response) => {
  const challenge = req.cookies?.[WEBAUTHN_COOKIE];
  if (!challenge) {
    res.status(400).json({ error: 'Passkey challenge expired — please try again.' });
    return;
  }
  const parsed = PasskeyRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed' });
    return;
  }
  const u = (req as AuthRequest).user;
  try {
    await passkeys.verifyRegistration(u.id, parsed.data.response, challenge, parsed.data.name ?? 'Passkey');
    clearChallengeCookie(res);
    await recordAudit({ action: 'auth.passkey_added', actor: u, req });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Passkey registration failed' });
  }
});

router.get('/passkeys', requireAuth, async (req: Request, res: Response) => {
  res.json({ passkeys: await passkeys.listPasskeys((req as AuthRequest).user.id) });
});

router.delete('/passkeys/:id', requireAuth, async (req: Request, res: Response) => {
  const u = (req as AuthRequest).user;
  await passkeys.deletePasskey(u.id, req.params.id as string);
  await recordAudit({ action: 'auth.passkey_removed', actor: u, req });
  res.json({ success: true });
});

// ─── SSO (OIDC) ───────────────────────────────────────────────

const FRONTEND = () => process.env.FRONTEND_URL || 'http://localhost:3000';

// Public: does the login page show an SSO button, and what does it say?
router.get('/sso/info', async (_req: Request, res: Response) => {
  res.json(await sso.getPublicSsoInfo());
});

// Kick off the flow: redirect the browser to the identity provider.
router.get('/sso/login', async (_req: Request, res: Response) => {
  try {
    const { url, cookie } = await sso.beginLogin();
    setSsoCookie(res, cookie);
    res.redirect(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SSO is unavailable';
    res.redirect(`${FRONTEND()}/login?sso_error=${encodeURIComponent(msg)}`);
  }
});

// Provider redirects back here with ?code&state → exchange + sign in.
router.get('/sso/callback', async (req: Request, res: Response) => {
  const cookieValue = req.cookies?.[SSO_COOKIE];
  clearSsoCookie(res);
  if (!cookieValue) {
    res.redirect(`${FRONTEND()}/login?sso_error=${encodeURIComponent('Login session expired — please try again.')}`);
    return;
  }
  try {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const user = await sso.completeLogin(`${sso.callbackUrl()}${qs}`, cookieValue);
    const { token, csrfToken, expiresAt } = await createSession(user.id);
    setAuthCookies(res, token, csrfToken, expiresAt);
    await recordAudit({ action: 'auth.login', actor: user, detail: 'sso', req });
    res.redirect(`${FRONTEND()}/`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SSO login failed';
    await recordAudit({ action: 'auth.sso_failed', detail: msg, req });
    res.redirect(`${FRONTEND()}/login?sso_error=${encodeURIComponent(msg)}`);
  }
});

// ─── GET /api/auth/invite/:token ──────────────────────────────

router.get('/invite/:token', publicTokenLimiter, async (req: Request, res: Response) => {
  const invite = await prisma.inviteToken.findUnique({
    where: { token: req.params['token'] as string },
  });

  if (!invite || invite.usedById || invite.expiresAt < new Date()) {
    res.status(404).json({ error: 'Invite token not found or already used' });
    return;
  }

  res.json({
    valid: true,
    quotas: { maxCpu: invite.maxCpu, maxRam: invite.maxRam, maxStorage: invite.maxStorage },
    expiresAt: invite.expiresAt.toISOString(),
    label: invite.label,
    require2fa: invite.require2fa,
  });
});

// ─── POST /api/auth/forgot-password ───────────────────────────
// If SMTP is configured, email a single-use reset link; otherwise file a request
// for an admin. Returns the same generic message regardless of email existence.

const ForgotSchema = z.object({ email: z.string().email() });

router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
  const parsed = ForgotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter a valid email address' });
    return;
  }
  const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const { method } = await requestReset(parsed.data.email, appUrl);
  res.json({
    method,
    message:
      method === 'email'
        ? 'If an account exists for that email, a reset link is on its way.'
        : 'If an account exists for that email, your administrator has been notified.',
  });
});

// ─── POST /api/auth/reset-password ────────────────────────────

const ResetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
  const parsed = ResetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const user = await resetWithToken(parsed.data.token, parsed.data.password);
    await recordAudit({ action: 'auth.password_reset', actor: user, targetType: 'user', targetId: user.id, req });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Reset failed' });
  }
});

export default router;
