# Design proposal: no session until post-2FA login (enrollment-token model)

**Status:** accepted — recommended defaults locked in (§7); ready to implement. Decisions are revisable until coded.
**Author:** Claude (Opus) for r0073d-l053r
**Date:** 2026-06-25
**Scope:** backend auth core (`register`, `login`, 2FA/passkey enrollment) + the registration/onboarding frontend. No schema change.

---

## 1. Problem (what the review found)

When an invite sets `require2fa`, the current flow mints a **full session at registration**, before any second factor exists:

```
POST /auth/register  ──▶  createSession()  ──▶  proxmate_session cookie (real Session row)
                                                 user is "logged in", but 2FA not set up
```

A per-route middleware (`enforceMfaSetup`) then *gates* that session out of resource routes until a factor is enrolled.

Two problems with that, both raised in review:

1. **One session class, two trust levels, distinguished only by a scattered predicate.** The pre-2FA session and the post-2FA session are the *same object*; the only thing holding the weak one back is `enforceMfaSetup` being remembered on every resource router. Miss it on one new router and the weak session walks through. ("Secure and insecure sessions passing through the same controller layer.")
2. **Silent in-place privilege elevation.** When the user finishes 2FA, `twoFactorEnabled` flips and **the exact same token becomes fully privileged** — no rotation, no re-authentication. The credential issued in the weak state is the credential used in the strong state. That's a latent escalation path that gets easier to trip as the codebase grows.

The route-gating that shipped in `fix/mobile-invite-2fa-onboarding` (mounting `enforceMfaSetup` on *all* resource routers) is a **mitigation** of #1, not a fix, and does nothing for #2.

### Adjacent finding (in scope to fix here)

Login currently issues a session on a correct password whenever `twoFactorEnabled === false`:

```ts
if (user.twoFactorEnabled) { /* challenge */ } else { /* issue session */ }
```

A `require2fa` user who enrolled a **passkey only** has `twoFactorEnabled === false` (passkeys don't set that flag). So **password-only login succeeds for them and skips the second factor.** This bypass exists today, independent of the refactor, and the new model must close it.

---

## 2. Goal

> There should be no valid session at all until the second factor is **registered** *and* **used to log in**.

- No ambient credential of any kind exists before 2FA is set up.
- The first real `Session` is minted only by a full authentication (password + TOTP, or a passkey) *after* the factor is registered — so the privilege boundary coincides with a fresh authentication and a fresh token. Nothing elevates in place.
- Resource controllers only ever see fully-authenticated sessions. The "is this session allowed yet?" question disappears.

**Non-goals:** changing the non-`require2fa` flow (no 2FA → a session at registration is correct, nothing to defer to); changing SSO (the IdP owns MFA; SSO users are exempt today and stay exempt); changing the logged-in `/security` self-service enrollment for existing users.

---

## 3. The model

This reuses a pattern **already in the codebase**: the login 2FA step issues a `signChallenge()` JWT — `{ sub, twofa:true }`, 5-min TTL, **no `Session` row** — which `requireAuth → verifySession` rejects everywhere because it demands a persisted session. The challenge token is a scoped, resource-incapable credential. We add a sibling for enrollment.

### Credential: the enrollment token

| property | value |
|---|---|
| shape | JWT `{ sub: userId, enroll: true }` |
| TTL | **15 min** (decided, §7) |
| backing | **none** — stateless, **no `Session` row** |
| transport | response body → frontend holds it **in memory only**, sends as `Authorization: Bearer <token>` |
| accepted by | `requireEnrollment` only (the 4 enrollment endpoints) |
| rejected by | `requireAuth` (no `Session` row) → **cannot reach any resource route** |
| inert when | `isMfaSetupRequired(userId)` is false (i.e., once any factor lands) — see §5 |

Because it carries no `Session` row, it is **structurally** incapable of authenticating to `/api/vms`, `/api/templates`, `/api/proxmox`, `/api/users`, or anything else behind `requireAuth`. It is not a weak session — it is a different credential type that can do exactly one thing: enrol a first factor.

### State machine (for a `require2fa`, non-SSO user)

```
                       password ok &&
   ┌──────────────┐    isMfaSetupRequired      ┌────────────────────┐
   │  REGISTERED  │ ─────────────────────────▶ │  ENROLLING         │
   │  no factor   │   (register OR re-login     │  holds enrollment  │
   │  NO SESSION  │    both hand back an        │  token in memory   │
   └──────────────┘    enrollment token)        └─────────┬──────────┘
          ▲                                                │ enrol TOTP or passkey
          │ token lost (mobile tab evicted)                │ (enrollment token)
          │ → re-login with password                       ▼
          │                                       ┌────────────────────┐
          └───────────────────────────────────── │  ENROLLED          │
                                                  │  factor registered │
                                                  │  STILL NO SESSION  │
                                                  └─────────┬──────────┘
                                                            │ log in WITH the factor
                                                            │ (password+TOTP, or passkey)
                                                            ▼
                                                  ┌────────────────────┐
                                                  │  AUTHENTICATED     │
                                                  │  first real Session│
                                                  └────────────────────┘
```

At no point before `AUTHENTICATED` does a `Session` row exist.

---

## 4. Backend changes

No schema change (the enrollment token is a stateless JWT, like the challenge token).

### 4.1 `auth.service.ts` — add the enrollment credential
```ts
// mirrors signChallenge/verifyChallenge
export async function signEnrollment(userId: string): Promise<string> {
  const secret = await getJwtSecret();
  return jwt.sign({ sub: userId, enroll: true }, secret, { expiresIn: '15m' });
}
export async function verifyEnrollment(token: string): Promise<string | null> {
  try {
    const payload = jwt.verify(token, await getJwtSecret()) as { sub: string; enroll?: boolean };
    return payload.enroll ? payload.sub : null;
  } catch { return null; }
}
```

### 4.2 `middleware/mfa.ts` (or new `enrollment.ts`) — `requireEnrollment` + `requireAuthOrEnrollment`
- `requireEnrollment`: read `Authorization: Bearer`, `verifyEnrollment` → userId; **then re-check `isMfaSetupRequired(userId)` and 403 if false** (token is inert once a factor exists). Sets `req.user`.
- `requireAuthOrEnrollment`: try `requireAuth`'s session path first; if no/invalid session, fall back to `requireEnrollment`. Used by the four enrollment endpoints so both a logged-in user (on `/security`) and a first-time enrollee can hit them. Tag `req.authKind = 'session' | 'enrollment'`.
- CSRF: the enrollment path is Bearer-only (no cookie) → no CSRF surface, consistent with the existing Bearer exemption in `requireAuth`. The session path keeps CSRF.

### 4.3 `POST /auth/register`
- Create user + claim invite **exactly as today** (invite stays single-use; account created).
- **Branch on the requirement instead of always `createSession`:**
  ```ts
  if (await isMfaSetupRequired(user.id)) {     // require2fa, non-SSO, no factor yet
    return res.status(201).json({ mfaEnrollmentRequired: true,
                                  enrollmentToken: await signEnrollment(user.id) });
  }
  const s = await createSession(user.id); setAuthCookies(res, ...);   // unchanged path
  return res.status(201).json({ user: {...} });
  ```
- No cookie is set in the enrollment branch.

### 4.4 `POST /auth/login`
Insert the enrollment branch **before** the existing 2FA-challenge branch, and close the passkey bypass:
```ts
if (!user || !valid) → 401
if (await isMfaSetupRequired(user.id)) {                 // required but no factor → no session
  return res.json({ mfaEnrollmentRequired: true, enrollmentToken: await signEnrollment(user.id) });
}
if (user.require2fa && !user.ssoSubject && !user.twoFactorEnabled) {
  // factor exists but it's a passkey only → password alone is insufficient
  return res.status(401).json({ error: 'Sign in with your passkey to continue.',
                                code: 'passkey_required' });
}
if (user.twoFactorEnabled) { return /* existing challenge */ }
const s = await createSession(...);  // only reached when MFA not required, or already satisfied this request
```
This is the resume path too: an interrupted enrollee re-logs-in with their password and gets a **fresh enrollment token, never a session**.

### 4.5 Enrollment endpoints: swap `requireAuth → requireAuthOrEnrollment`
- `POST /auth/2fa/setup`, `POST /auth/2fa/enable`, `POST /auth/passkeys/register/options`, `POST /auth/passkeys/register/verify`.
- `POST /auth/2fa/disable`, `GET /auth/2fa/status`, `GET/DELETE /auth/passkeys`, and **everything else stay `requireAuth`** — an enrollment token can register a first factor and nothing else.
- `/auth/me`: stays `requireAuth`. A pre-session enrollee has no `/auth/me`; the frontend drives the enrollment screen off the in-memory token, not `/auth/me`.

### 4.6 `enforceMfaSetup`
Keep it on the resource routers as **defense-in-depth** (it now almost never fires, because a `require2fa` user can't get a session pre-2FA — but it still covers "admin flips `require2fa` on an existing, already-logged-in user", see §6).

---

## 5. Why this satisfies the review

- **No two session classes in the controller layer.** Resource routers see only real sessions; the enrollment token can't reach them (`verifySession` requires a `Session` row). The `enforceMfaSetup` predicate stops being load-bearing.
- **No in-place elevation.** There is no pre-existing token to elevate. The first `Session` is minted at the post-enrol login — a fresh authentication, a fresh token.
- **Bounded credential.** The enrollment token (a) can only hit the 4 enrol endpoints, (b) is honored only while `isMfaSetupRequired` is true, so it goes inert the instant the first factor lands, (c) is short-lived, (d) is held in memory only — nothing ambient to steal, and a mobile tab-eviction simply drops it (resume = re-login).
- **Closes the passkey-only password bypass** (§4.4).

---

## 6. Flows / edge cases

| scenario | behaviour |
|---|---|
| **Happy path, TOTP** | register → enrollment token → `/setup-2fa` → scan QR, confirm code (enable) → "2FA set, sign in" → login w/ password+TOTP → first session. |
| **Happy path, passkey** | register → enrollment token → `/setup-2fa` → register passkey → "sign in" → passwordless passkey login → first session. |
| **Mobile tab eviction mid-setup** | in-memory token lost → frontend has no token → redirect to `/login` w/ note → password login → `isMfaSetupRequired` still true → **new enrollment token** → resume. No session ever existed. |
| **Non-`require2fa` invite** | unchanged: register issues a session directly. |
| **SSO user** | exempt (IdP handles MFA), unchanged. |
| **Admin flips `require2fa` on an existing, logged-in user** | **their sessions are invalidated on flip** (decided, §7) → next request 401s → clean re-login, which (no factor yet) returns an enrollment token, not a session. Fallback if ever relaxed: keep the session, corralled to `/security` by `enforceMfaSetup` + `AuthGuard`. |
| **Leaked enrollment token (<15 min, before any factor)** | attacker could only enrol *their own* authenticator as the victim's first factor — which the victim's next login would expose (their code won't work) and which an account-recovery path resolves. Bounded, short, and strictly weaker than leaking a session. Mitigated further by the short TTL + inert-after-first-factor rule. |

---

## 7. Decisions (locked in — revisable until coded)

1. **Enrollment token TTL — 15 min.** Enough to scan a QR and app-switch; if it lapses, resume is a cheap re-login. (Drop to 10 if review prefers; no code impact beyond the constant.)
2. **In-memory bearer, not a cookie.** Nothing ambient exists before 2FA — matches the review's "no valid session at all." Accepted cost: a password re-entry if the mobile tab is evicted mid-setup (the secure resume path, §6). A scoped httpOnly cookie was considered (survives eviction) but rejected: it reintroduces an ambient pre-2FA credential, even if resource-incapable.
3. **Explicit login required after enrol — yes.** Even though `/2fa/enable` verifies a live code, the boundary is "first session == first full login." The post-enrol screen routes to `/login`.
4. **Passkey-only `require2fa` users sign in passwordless.** Password-only login for such a user returns `code: passkey_required` and the frontend prompts the passkey button. Closes the current bypass; no password→passkey step-up to build.
5. **Flipping `require2fa` on an existing user invalidates that user's sessions** (`prisma.session.deleteMany({ where: { userId } })` at the point the admin sets the flag). Forces the clean re-login → enrollment flow rather than leaving a pre-existing session riding behind the gate. *Note:* there is no "set `require2fa` on an existing user" endpoint today — the flag is set at registration, before any session exists, so this rule is a guardrail for **if/when** such an admin toggle is added.

> These are the recommended defaults, adopted so the spec is implementable as-is. Any can be overridden before coding — note the change here and the affected section.

---

## 8. Frontend changes (summary)

- **New `/setup-2fa` route** (in the `(auth)` group, **no** `AuthGuard` — there's no session). Drives TOTP/passkey enrollment off the in-memory enrollment token. This is also Dia's "separate route for the authenticator step."
- **Register page**: on `{ mfaEnrollmentRequired, enrollmentToken }`, stash the token in memory and route to `/setup-2fa`. (The `/auth/me`-forward added in the mitigation can be simplified, since there's no pre-2FA session to forward.)
- **Login page**: handle `{ mfaEnrollmentRequired }` (resume → `/setup-2fa`) and `{ code: 'passkey_required' }` (prompt the passkey button).
- **`/setup-2fa`** with no token in memory → redirect to `/login`.
- **On successful enable/register** → redirect to `/login` with a "2FA set up — sign in to finish" toast.
- **`/security`** (logged-in self-service enrollment) — unchanged; still uses the session.

---

## 9. Testing

- Unit: `signEnrollment`/`verifyEnrollment`; `requireEnrollment` rejects session tokens and goes inert once `isMfaSetupRequired` is false; `requireAuth` rejects an enrollment token (no `Session` row).
- Route: `register(require2fa)` sets **no** cookie + returns an enrollment token; `login(require2fa, 0 factors)` returns an enrollment token, **not** a session; an enrollment token gets **403** on `/api/vms` & friends; `login` with password-only for a passkey-only `require2fa` user → `passkey_required`.
- Integration walkthrough: register → enrol (token) → login (factor) → first session → resource access 200. Plus the eviction-resume path.
- Keep the existing 87 green.

---

## 10. Rollout

- One branch (extends or follows `fix/mobile-invite-2fa-onboarding`). The route-gating from the mitigation **stays** as defense-in-depth.
- No migration. Fully-onboarded existing users are unaffected (they already have sessions and factors).
- Live verification on the deployment with Dia's single-phone repro is the acceptance test.

**Definition of done**
- [ ] `register(require2fa)` sets **no** cookie and returns an enrollment token; `login(require2fa, 0 factors)` returns an enrollment token, not a session.
- [ ] An enrollment token gets **401/403** on every resource route (`/api/vms`, `/api/templates`, `/api/proxmox`, `/api/users`) and is inert once `isMfaSetupRequired` is false.
- [ ] Password-only login for a passkey-only `require2fa` user → `passkey_required` (bypass closed).
- [ ] First `Session` appears only at the post-enrol login (TOTP or passkey); verified by inspecting `Session` rows across the flow.
- [ ] Mobile eviction resume = re-login → fresh enrollment token, still no session.
- [ ] §9 tests added and green; existing 87 still green; `tsc` clean both sides.
- [ ] Live single-phone walk-through on the deployment passes (the original repro).
