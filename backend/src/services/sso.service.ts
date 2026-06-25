import { randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import { hashPassword } from './auth.service.js';
import type { User } from '@prisma/client';

/** Admin-facing SSO settings (never includes the client secret). */
export interface SsoConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  scopes: string; // space-separated, e.g. "openid profile email"
  groupsClaim: string; // ID-token claim to read group membership from
  adminGroup: string; // membership in this group maps to the admin role ("" = off)
  allowSignup: boolean; // JIT-provision brand-new users (off = invite/link-only)
  buttonLabel: string; // login-button text, e.g. "Sign in with Keycloak"
}

/** A normalized subset of the ID-token claims we actually consume. */
export interface SsoClaims {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
}

const DEFAULTS = { scopes: 'openid profile email', groupsClaim: 'groups', buttonLabel: 'Sign in with SSO' };

/** The provider redirects back here; must be registered in the IdP. */
export function callbackUrl(): string {
  const base = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`;
  return `${base.replace(/\/$/, '')}/api/auth/sso/callback`;
}

/** Read SSO settings (without the secret); null when no issuer is configured. */
export async function getSsoConfig(): Promise<SsoConfig | null> {
  const [issuer, clientId, enabled, scopes, groupsClaim, adminGroup, allowSignup, buttonLabel] = await Promise.all([
    getConfig('sso_issuer'),
    getConfig('sso_client_id'),
    getConfig('sso_enabled'),
    getConfig('sso_scopes'),
    getConfig('sso_groups_claim'),
    getConfig('sso_admin_group'),
    getConfig('sso_allow_signup'),
    getConfig('sso_button_label'),
  ]);
  if (!issuer || !clientId) return null;
  return {
    enabled: enabled === 'true',
    issuer,
    clientId,
    scopes: scopes || DEFAULTS.scopes,
    groupsClaim: groupsClaim || DEFAULTS.groupsClaim,
    adminGroup: adminGroup || '',
    allowSignup: allowSignup === 'true',
    buttonLabel: buttonLabel || DEFAULTS.buttonLabel,
  };
}

/** SSO is usable only when both configured AND enabled. */
export async function isSsoEnabled(): Promise<boolean> {
  const cfg = await getSsoConfig();
  return !!cfg?.enabled;
}

/** Minimal info the public login page needs to render the SSO button. */
export async function getPublicSsoInfo(): Promise<{ enabled: boolean; label: string }> {
  const cfg = await getSsoConfig();
  return { enabled: !!cfg?.enabled, label: cfg?.buttonLabel || DEFAULTS.buttonLabel };
}

/** Persist SSO settings; the client secret is encrypted and only set when supplied. */
export async function saveSsoConfig(data: {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  groupsClaim?: string;
  adminGroup?: string;
  allowSignup?: boolean;
  buttonLabel?: string;
}): Promise<void> {
  await setConfig('sso_issuer', data.issuer.trim());
  await setConfig('sso_client_id', data.clientId.trim());
  await setConfig('sso_enabled', String(data.enabled));
  await setConfig('sso_scopes', data.scopes?.trim() || DEFAULTS.scopes);
  await setConfig('sso_groups_claim', data.groupsClaim?.trim() || DEFAULTS.groupsClaim);
  await setConfig('sso_admin_group', data.adminGroup?.trim() ?? '');
  await setConfig('sso_allow_signup', String(data.allowSignup ?? false));
  await setConfig('sso_button_label', data.buttonLabel?.trim() || DEFAULTS.buttonLabel);
  if (data.clientSecret && data.clientSecret.trim().length > 0) {
    await setConfig('sso_client_secret', data.clientSecret, true);
  }
  resetOidcCache();
}

export async function hasClientSecret(): Promise<boolean> {
  return !!(await getConfig('sso_client_secret'));
}

// ─── OIDC discovery (cached) ──────────────────────────────────

let cached: { issuer: string; clientId: string; config: oidc.Configuration } | null = null;

export function resetOidcCache(): void {
  cached = null;
}

/** Run discovery against the saved settings — the admin "Test" button. Throws on failure. */
export async function verifyDiscovery(): Promise<{ ok: true }> {
  resetOidcCache();
  await getOidcConfig(); // fetches .well-known + JWKS; throws if issuer/secret/network are wrong
  return { ok: true };
}

async function getOidcConfig(): Promise<oidc.Configuration> {
  const cfg = await getSsoConfig();
  if (!cfg) throw new Error('SSO is not configured.');
  const clientSecret = await getConfig('sso_client_secret');
  if (!clientSecret) throw new Error('SSO client secret is not set.');

  if (cached && cached.issuer === cfg.issuer && cached.clientId === cfg.clientId) return cached.config;
  // Discovery fetches the provider's .well-known/openid-configuration + JWKS.
  const config = await oidc.discovery(new URL(cfg.issuer), cfg.clientId, clientSecret);
  cached = { issuer: cfg.issuer, clientId: cfg.clientId, config };
  return config;
}

// ─── Authorization flow ───────────────────────────────────────

/** Build the redirect to the IdP + the opaque state to stash in a cookie. */
export async function beginLogin(): Promise<{ url: string; cookie: string }> {
  const cfg = await getSsoConfig();
  if (!cfg?.enabled) throw new Error('SSO is not enabled.');
  const config = await getOidcConfig();

  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(),
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: url.href, cookie: JSON.stringify({ state, nonce, codeVerifier }) };
}

/** Exchange the callback for tokens, validate, and map to a local user. */
export async function completeLogin(currentUrl: string, cookieValue: string): Promise<User> {
  const cfg = await getSsoConfig();
  if (!cfg) throw new Error('SSO is not configured.');
  const { state, nonce, codeVerifier } = JSON.parse(cookieValue) as {
    state: string;
    nonce: string;
    codeVerifier: string;
  };
  const config = await getOidcConfig();

  // Validates state, exchanges the code (with PKCE), and verifies the ID token
  // signature (JWKS), issuer, audience, expiry, and nonce.
  const tokens = await oidc.authorizationCodeGrant(config, new URL(currentUrl), {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
    expectedNonce: nonce,
  });
  const idClaims = tokens.claims();
  if (!idClaims?.sub) throw new Error('Identity provider returned no subject.');

  const rawGroups = idClaims[cfg.groupsClaim];
  const claims: SsoClaims = {
    sub: String(idClaims.sub),
    email: typeof idClaims.email === 'string' ? idClaims.email : undefined,
    name:
      (typeof idClaims.name === 'string' && idClaims.name) ||
      (typeof idClaims.preferred_username === 'string' && idClaims.preferred_username) ||
      undefined,
    groups: Array.isArray(rawGroups) ? rawGroups.map(String) : typeof rawGroups === 'string' ? [rawGroups] : [],
  };
  return upsertSsoUser(claims, cfg);
}

// ─── Claims → local user (the testable core) ──────────────────

function isAdminByGroup(claims: SsoClaims, cfg: SsoConfig): boolean {
  return !!cfg.adminGroup && (claims.groups ?? []).includes(cfg.adminGroup);
}

/**
 * Resolve an SSO identity to a local account: link by prior `sub`, else link an
 * existing local account by email, else JIT-provision (only when allowed).
 * Admin group membership can *promote* (never auto-demotes, to avoid lockout).
 */
export async function upsertSsoUser(claims: SsoClaims, cfg: SsoConfig): Promise<User> {
  const email = claims.email?.toLowerCase();

  let user = await prisma.user.findUnique({ where: { ssoSubject: claims.sub } });

  if (!user && email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      user = await prisma.user.update({ where: { id: byEmail.id }, data: { ssoSubject: claims.sub } });
    }
  }

  if (!user) {
    if (!cfg.allowSignup) {
      throw new Error('Your account has not been provisioned. Please contact an administrator.');
    }
    if (!email) throw new Error('The identity provider did not supply an email address.');
    user = await prisma.user.create({
      data: {
        email,
        displayName: claims.name || email,
        role: isAdminByGroup(claims, cfg) ? 'admin' : 'user',
        // SSO users authenticate via the IdP; give them an unusable random local password.
        passwordHash: await hashPassword(randomBytes(32).toString('hex')),
        ssoSubject: claims.sub,
      },
    });
    return user;
  }

  // Promote to admin if the IdP now reports group membership (never auto-demote).
  if (isAdminByGroup(claims, cfg) && user.role !== 'admin') {
    user = await prisma.user.update({ where: { id: user.id }, data: { role: 'admin' } });
  }
  return user;
}
