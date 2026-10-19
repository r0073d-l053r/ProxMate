import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  hashPassword,
  verifyPasswordSafe,
  createSession,
  retireSessionWithGrace,
  signChallenge,
  verifyChallenge,
  beginChallengeAttempt,
  endChallengeAttempt,
  signEnrollment,
} from '../services/auth.service.js';
import * as twofa from '../services/twofactor.service.js';
import * as passkeys from '../services/passkey.service.js';
import * as sso from '../services/sso.service.js';
import { isMfaSetupRequired } from '../services/mfa.service.js';
import {
  isAccessExpired,
  accessExpiryFrom,
  loginRefusal,
} from '../services/access.service.js';
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
import { issueWebauthnChallenge, takeWebauthnChallenge } from '../lib/webauthn-challenges.js';
import { requireAuth, requireSession, allowExpiredAccess } from '../middleware/auth.js';
import { claimPendingShares } from '../services/vm-share.service.js';
import { requireAuthOrEnrollment } from '../middleware/enrollment.js';
import { authLimiter, publicTokenLimiter, kioskExitLimiter } from '../middleware/rate-limit.js';
import { verifyKioskPin } from '../services/kiosk.service.js';
import { recordAudit } from '../services/audit.service.js';
import {
  isAccountLocked,
  reserveLoginAttempt,
  registerFailedLogin,
  clearFailedLogins,
  reserveSecondFactorAttempt,
  registerFailedSecondFactor,
  clearFailedSecondFactor,
} from '../services/account-lockout.service.js';
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

  // An invite sent to an address is for that address only. Registering it under
  // a different email would leave an account whose address nobody vouched for,
  // and SSO links IdP identities to accounts by email. Unaddressed invites
  // still accept any email, but the account is not marked as bound.
  const invitedEmail = invite.email?.toLowerCase().trim() || null;
  if (invitedEmail && email.toLowerCase().trim() !== invitedEmail) {
    res.status(400).json({ error: 'This invite was sent to a different email address — register with that address.' });
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
      emailBound: !!invitedEmail,
      passwordHash,
      displayName: displayName.trim(),
      maxCpu: invite.maxCpu,
      maxRam: invite.maxRam,
      maxStorage: invite.maxStorage,
      require2fa: invite.require2fa,
      // The compute window starts NOW, when the invite is redeemed — not when
      // it was minted. An invite that sits unopened for a week would otherwise
      // silently eat a week of the tenant's trial. Null = never expires.
      accessExpiresAt: accessExpiryFrom(invite.accessDuration),
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

  // VMs shared with this address before the account existed — only when the invite
  // was sent to the address, so it is confirmed (see claimPendingShares).
  await claimPendingShares(user).catch((err) => console.warn('[auth] claiming pending shares failed:', err));

  await recordAudit({ action: 'auth.register', actor: user, targetType: 'user', targetId: user.id, req });

  // If the invite required 2FA, mint NO session — hand back a scoped enrollment
  // token instead. The first real session is issued only at the post-enrollment
  // login (password + factor, or a passkey), so no session ever exists before a
  // second factor does.
  if (await isMfaSetupRequired(user.id)) {
    res.status(201).json({ mfaEnrollmentRequired: true, enrollmentToken: await signEnrollment(user.id) });
    return;
  }

  // no-access-gate: registration is the moment the window is CREATED, anchored at
  // redemption via accessExpiryFrom(invite.accessDuration, now) — so it is always
  // in the future here. There is no lapsed state to refuse.
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

  // Brute-force lockout: reserve this attempt against the account BEFORE the
  // password is checked, so a parallel burst cannot all be evaluated ahead of
  // being counted. A locked (or exhausted) account short-circuits with the SAME
  // generic response (and a dummy bcrypt for timing parity) so neither the lock
  // nor the account's existence leaks. The lock auto-expires (see account-lockout.service).
  if (user && !(await reserveLoginAttempt(user, req.ip ?? null))) {
    await verifyPasswordSafe(password, null);
    await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'account locked', req });
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Always runs bcrypt (dummy hash when no user) so timing can't enumerate accounts.
  const valid = await verifyPasswordSafe(password, user?.passwordHash);

  if (!user || !valid) {
    // The attempt was already counted; this may lock the account + alert admins.
    if (user) await registerFailedLogin(user, req.ip ?? null);
    await recordAudit({ action: 'auth.login_failed', targetType: 'email', targetId: email.toLowerCase(), req });
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Correct password — clear any prior failure streak before continuing.
  await clearFailedLogins(user);

  // Re-check the lock now that the password is verified: one may have been
  // applied while this request was in flight (by wrong 2FA codes or other wrong
  // passwords). A correct password never lifts it, and nothing is issued while it
  // holds — same generic answer as a wrong password.
  const current = await prisma.user.findUnique({ where: { id: user.id }, select: { lockedUntil: true } });
  if (current && isAccountLocked(current)) {
    await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'account locked', req });
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Compute-access window (admins exempt). This MUST come before the 2FA and
  // enrollment branches below: those hand out real credentials (a 5-minute 2FA
  // challenge, or an enrollment token), and a suspended tenant must not walk
  // away holding either. Deliberately a distinct, honest message — this is an
  // entitlement problem, not a wrong password, and the account is not a secret
  // to its own owner at this point (they just proved the password).
  const passwordRefusal = loginRefusal(user);
  if (passwordRefusal) {
    await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'compute access expired', req });
    res.status(403).json(passwordRefusal);
    return;
  }

  // Required 2FA but no factor enrolled yet → no session. Hand back an enrollment
  // token so an interrupted setup resumes here (a correct password never yields a
  // session until a second factor exists). No SSO exemption: an SSO-linked
  // account keeps its local password, and this login never involves the IdP.
  if (await isMfaSetupRequired(user.id, { ssoExempt: false })) {
    res.json({ mfaEnrollmentRequired: true, enrollmentToken: await signEnrollment(user.id) });
    return;
  }

  // A require2fa user whose only factor is a passkey has twoFactorEnabled=false;
  // a password alone must not be sufficient for them — they sign in passwordless
  // with the passkey (which is strong MFA on its own). Applies to SSO-linked
  // accounts too, for the same reason as above.
  if (user.require2fa && !user.twoFactorEnabled) {
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
  const challenge = await verifyChallenge(parsed.data.challenge);
  if (!challenge) {
    res.status(401).json({ error: 'Your login session expired — please sign in again.' });
    return;
  }
  const { userId, challengeId } = challenge;
  // Every code is counted twice, and both counts are taken BEFORE it is checked:
  // against this challenge (one check at a time, retired after a few) and against
  // the account (locks at the threshold). So neither re-using one challenge, nor
  // fetching fresh ones, nor firing many requests at once gives more guesses.
  if (!beginChallengeAttempt(challengeId)) {
    res.status(401).json({ error: 'Your login session expired — please sign in again.' });
    return;
  }
  let ok = false;
  let user: Awaited<ReturnType<typeof prisma.user.findUnique>> = null;
  try {
    user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(401).json({ error: 'Account not found.' });
      return;
    }
    // A lock (from wrong passwords or wrong codes) also stops challenges that were
    // issued before it, so the lock caps guessing rather than just new challenges.
    if (!(await reserveSecondFactorAttempt(user, req.ip ?? null))) {
      await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'account locked (2fa)', req });
      res.status(401).json({ error: 'Your login session expired — please sign in again.' });
      return;
    }
    ok =
      (await twofa.verifyTotp(userId, parsed.data.code)) ||
      (await twofa.verifyRecoveryCode(userId, parsed.data.code));
    if (!ok) {
      await registerFailedSecondFactor(user, req.ip ?? null);
      await recordAudit({ action: 'auth.2fa_failed', actor: { id: userId }, req });
      res.status(401).json({ error: 'Invalid authentication code.' });
      return;
    }
    await clearFailedSecondFactor(user);
  } finally {
    // A correct code spends the challenge (single-use); a wrong one frees it.
    endChallengeAttempt(challengeId, ok);
  }
  // Re-check entitlement rather than trusting the challenge. /login gates before
  // issuing one, but the challenge lives ~5 minutes, and an admin who suspends an
  // account in that gap should not have a session minted afterwards.
  const refusal = loginRefusal(user);
  if (refusal) {
    await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'compute access expired (2fa)', req });
    res.status(403).json(refusal);
    return;
  }
  const { token, csrfToken, expiresAt } = await createSession(user.id);
  setAuthCookies(res, token, csrfToken, expiresAt);
  await recordAudit({ action: 'auth.login', actor: user, detail: '2fa', req });
  res.json({ user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName } });
});

// ─── POST /api/auth/logout ────────────────────────────────────

router.post('/logout', allowExpiredAccess, requireAuth, async (req: Request, res: Response) => {
  const ar = req as AuthRequest;
  if (ar.sessionToken) await prisma.session.deleteMany({ where: { token: ar.sessionToken } });
  clearAuthCookies(res);
  await recordAudit({ action: 'auth.logout', actor: ar.user, req });
  res.json({ success: true });
});

// ─── POST /api/auth/session/refresh ───────────────────────────
// Slide the session forward: mint a fresh 24h session for the SAME user, set the
// new cookies, and retire the old session after a short overlap. Sessions are a
// fixed 24h JWT with no sliding renewal, so a long-lived unattended surface (the
// kiosk panel) would be logged out mid-use every 24h; its heartbeat calls this to
// stay alive. The old row must NOT be deleted outright — the kiosk polls every
// second, and in-flight requests still carrying the old cookie would 401, which
// the frontend treats as "logged out" (see retireSessionWithGrace). Grants no
// new privileges — it only re-ups the caller's own already-valid session, which
// is why an API token is refused here (requireSession): it is not a session.
// no-access-gate: sits behind requireAuth, which already 403s a lapsed window
// (chokepoint 3). Re-checking here would be dead code, and this mints no new
// privilege — it re-ups the caller's own already-validated session.
router.post('/session/refresh', requireAuth, requireSession, async (req: Request, res: Response) => {
  const ar = req as AuthRequest;
  const { token, csrfToken, expiresAt } = await createSession(ar.user.id);
  setAuthCookies(res, token, csrfToken, expiresAt);
  if (ar.sessionToken && ar.sessionToken !== token) {
    await retireSessionWithGrace(ar.sessionToken);
  }
  // Opportunistic tidy-up: nothing prunes expired Session rows on a schedule,
  // and a 24/7 kiosk rotates ~96 sessions a day — sweep this user's dead rows.
  await prisma.session.deleteMany({ where: { userId: ar.user.id, expiresAt: { lt: new Date() } } });
  res.json({ ok: true, expiresAt });
});

// ─── POST /api/auth/kiosk-exit ────────────────────────────────
// Re-auth check to LEAVE kiosk mode (the panel is admin-only + unattended, so the
// exit gate proves a human present is the admin). Passkey unlock uses the normal
// /passkeys/auth/verify flow; this covers the PIN and the account-password
// fallback. Session-authed (the kiosk already holds a valid admin session) +
// tightly rate-limited so a short PIN can't be swept by a passer-by.
//
// A rejected PIN, password or passkey answers 403 with `code: 'reauth_failed'`,
// never 401: the session is still valid, and the frontend reads any 401 as "the
// session is gone" and signs the browser out.
const REAUTH_FAILED = 'reauth_failed';
const KioskExitSchema = z.object({
  method: z.enum(['pin', 'password']),
  value: z.string().min(1).max(128),
});
router.post('/kiosk-exit', kioskExitLimiter, requireAuth, requireSession, async (req: Request, res: Response) => {
  const ar = req as AuthRequest;
  if (ar.user.role !== 'admin') {
    res.status(403).json({ error: 'Kiosk mode is admin-only.' });
    return;
  }
  const parsed = KioskExitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter your PIN or password.' });
    return;
  }
  let ok = false;
  if (parsed.data.method === 'pin') {
    ok = await verifyKioskPin(parsed.data.value);
  } else {
    const user = await prisma.user.findUnique({ where: { id: ar.user.id } });
    ok = await verifyPasswordSafe(parsed.data.value, user?.passwordHash ?? null);
  }
  if (!ok) {
    res.status(403).json({ code: REAUTH_FAILED, error: 'Incorrect — try again.' });
    return;
  }
  res.json({ ok: true });
});

// Kiosk exit via passkey. Unlike the passwordless-login passkey routes, these
// verify against the CURRENT session's admin and do NOT mint a new session — so
// presenting some other person's passkey can't downgrade the kiosk's session; it
// simply won't unlock. Session-authed + admin-only + rate-limited.
router.post('/kiosk-exit/passkey-options', kioskExitLimiter, requireAuth, requireSession, async (req: Request, res: Response) => {
  if ((req as AuthRequest).user.role !== 'admin') {
    res.status(403).json({ error: 'Kiosk mode is admin-only.' });
    return;
  }
  const options = await passkeys.authenticationOptions();
  setChallengeCookie(res, issueWebauthnChallenge(options.challenge, 'kiosk-exit', (req as AuthRequest).user.id));
  res.json(options);
});

router.post('/kiosk-exit/passkey-verify', kioskExitLimiter, requireAuth, requireSession, async (req: Request, res: Response) => {
  const ar = req as AuthRequest;
  if (ar.user.role !== 'admin') {
    res.status(403).json({ error: 'Kiosk mode is admin-only.' });
    return;
  }
  const challenge = takeWebauthnChallenge(req.cookies?.[WEBAUTHN_COOKIE], 'kiosk-exit', ar.user.id);
  clearChallengeCookie(res);
  if (!challenge) {
    res.status(400).json({ error: 'Passkey challenge expired — please try again.' });
    return;
  }
  try {
    const userId = await passkeys.verifyAuthentication(req.body, challenge);
    // Must be THIS admin's own passkey — no session is issued either way.
    if (userId !== ar.user.id) {
      res.status(403).json({ code: REAUTH_FAILED, error: "That passkey isn't for this account." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ code: REAUTH_FAILED, error: err instanceof Error ? err.message : 'Passkey check failed' });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────

router.get('/me', allowExpiredAccess, requireAuth, async (req: Request, res: Response) => {
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
      // Lets the kiosk unlock dialog offer the passkey button only when the
      // admin actually has one registered.
      hasPasskeys: (await prisma.passkey.count({ where: { userId: user.id } })) > 0,
      mfaSetupRequired: await isMfaSetupRequired(user.id),
      broadcastOptOut: user.broadcastOptOut,
      // Compute-access window. `accessExpiresAt: null` = never expires.
      // `accessExpired` is computed SERVER-side and is the only thing the UI may
      // trust to decide "expired" — a wrong client clock must not lock someone
      // out, nor let them look active. The date is for the countdown copy only.
      accessExpiresAt: user.accessExpiresAt,
      accessExpired: isAccessExpired(user),
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

// While 2FA is on, starting a new setup (to move to another authenticator)
// needs `{ currentCode }`: a current TOTP or recovery code, as for disabling.
const TwoFaSetupSchema = z.object({ currentCode: z.string().min(1).optional() }).optional();

router.post('/2fa/setup', requireAuthOrEnrollment, requireSession, async (req: Request, res: Response) => {
  const parsed = TwoFaSetupSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return; }
  const u = (req as AuthRequest).user;
  try {
    res.json(await twofa.beginSetup(u.id, u.email, parsed.data?.currentCode, req.ip ?? null));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '2FA setup failed' });
  }
});

const TwoFaCodeSchema = z.object({ code: z.string().min(1) });

router.post('/2fa/enable', requireAuthOrEnrollment, requireSession, async (req: Request, res: Response) => {
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

router.post('/2fa/disable', requireAuth, requireSession, async (req: Request, res: Response) => {
  const parsed = TwoFaCodeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a code to confirm.' }); return; }
  const u = (req as AuthRequest).user;
  try {
    await twofa.disable(u.id, parsed.data.code, req.ip ?? null);
    await recordAudit({ action: 'auth.2fa_disabled', actor: u, req });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '2FA disable failed' });
  }
});

router.get('/2fa/status', requireAuth, requireSession, async (req: Request, res: Response) => {
  res.json(await twofa.getStatus((req as AuthRequest).user.id));
});

// ─── Passkeys (WebAuthn) ──────────────────────────────────────

// Passwordless login: request assertion options (usernameless / discoverable).
router.post('/passkeys/auth/options', authLimiter, async (_req: Request, res: Response) => {
  const options = await passkeys.authenticationOptions();
  // The cookie holds only a handle; the challenge itself stays server-side.
  setChallengeCookie(res, issueWebauthnChallenge(options.challenge, 'login'));
  res.json(options);
});

// Passwordless login: verify the assertion → issue a real session.
router.post('/passkeys/auth/verify', authLimiter, async (req: Request, res: Response) => {
  const challenge = takeWebauthnChallenge(req.cookies?.[WEBAUTHN_COOKIE], 'login');
  clearChallengeCookie(res);
  if (!challenge) {
    res.status(400).json({ error: 'Passkey challenge expired — please try again.' });
    return;
  }
  try {
    const userId = await passkeys.verifyAuthentication(req.body, challenge);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(401).json({ error: 'Account not found.' });
      return;
    }
    // Compute-access window (admins exempt). The passwordless passkey path mints a
    // real session directly, so it needs the same gate the password login applies
    // — otherwise a suspended tenant signs in cleanly and is only stopped on their
    // next API call. Chokepoint 1 covers every login path, not just /login.
    const refusal = loginRefusal(user);
    if (refusal) {
      await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'compute access expired (passkey)', req });
      res.status(403).json(refusal);
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
router.post('/passkeys/register/options', requireAuthOrEnrollment, requireSession, async (req: Request, res: Response) => {
  const u = (req as AuthRequest).user;
  const options = await passkeys.registrationOptions(u.id, u.email);
  setChallengeCookie(res, issueWebauthnChallenge(options.challenge, 'register', u.id));
  res.json(options);
});

const PasskeyRegisterSchema = z.object({ response: z.any(), name: z.string().max(100).optional() });

router.post('/passkeys/register/verify', requireAuthOrEnrollment, requireSession, async (req: Request, res: Response) => {
  const u = (req as AuthRequest).user;
  const challenge = takeWebauthnChallenge(req.cookies?.[WEBAUTHN_COOKIE], 'register', u.id);
  clearChallengeCookie(res);
  if (!challenge) {
    res.status(400).json({ error: 'Passkey challenge expired — please try again.' });
    return;
  }
  const parsed = PasskeyRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed' });
    return;
  }
  try {
    await passkeys.verifyRegistration(u.id, parsed.data.response, challenge, parsed.data.name ?? 'Passkey');
    await recordAudit({ action: 'auth.passkey_added', actor: u, req });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Passkey registration failed' });
  }
});

router.get('/passkeys', requireAuth, requireSession, async (req: Request, res: Response) => {
  res.json({ passkeys: await passkeys.listPasskeys((req as AuthRequest).user.id) });
});

router.delete('/passkeys/:id', requireAuth, requireSession, async (req: Request, res: Response) => {
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
    // Compute-access window (admins exempt), same gate as the password and passkey
    // logins. The IdP authenticated them; entitlement is ours to decide. Rendered as
    // an sso_error redirect rather than JSON because this endpoint is a browser
    // navigation, and the tenant needs to land somewhere that explains itself.
    const refusal = loginRefusal(user);
    if (refusal) {
      await recordAudit({ action: 'auth.login_blocked', actor: user, detail: 'compute access expired (sso)', req });
      res.redirect(`${FRONTEND()}/login?sso_error=${encodeURIComponent(refusal.error)}`);
      return;
    }
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
    // The address registration must use, if the invite was sent to one.
    email: invite.email,
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
    // Passkeys survive a reset; name them so the person can remove any they don't recognise.
    res.json({ success: true, remainingPasskeys: user.remainingPasskeys });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Reset failed' });
  }
});

export default router;
