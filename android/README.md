# ProxMate for Android

A native Android app for an existing ProxMate server. It signs you in natively and
then shows the full ProxMate web UI, VM consoles included, in a WebView that already
holds your session.

- **Application ID:** `host.proxmate.app`
- **Android:** 8.0 (API 26) or newer; built against API 34
- **Version:** `versionName` is read from `backend/package.json` (1.3.0 if that file
  is missing); `versionCode` is 1

## What it does

1. **Server.** Enter the address you open ProxMate at in a browser. `https://` is
   assumed when you leave out the scheme. Any path is dropped, so pasting a page
   address works too. The app calls `GET /api/health` and only goes on when the answer
   comes from the ProxMate API. `http://` addresses work only after a warning that
   your password and session will travel unencrypted. The server is saved, and you can
   change it from the menu.
2. **Sign in.** Email and password go to `POST /api/auth/login`, the same call the web
   sign-in makes. If the account has two-factor authentication, the app asks for the
   TOTP or recovery code and exchanges it, with the challenge from the login response,
   at `POST /api/auth/2fa/verify`. The server's own messages are shown as they are:
   wrong password, lockout, rate limit, ended access.
   - **Passkeys and SSO** run in the web sign-in page inside the app. Use the
     *Sign in with SSO or a passkey* button. The app also opens it when the server
     answers `passkey_required`, or when the account still has to set up a required
     second factor.
   - On a server that hasn't finished first-run setup, the app opens the web setup
     page.
3. **Web UI.** After a native sign-in the session cookies are handed to the WebView
   (see below), and the app opens `/`. Pages on the server's origin stay in the app.
   Other links, and downloads, open in your browser. Windows the page opens (the
   pop-out console, the IDE) open on top and close with Back. File uploads use the
   system file picker. Back steps through the page history. VNC and serial consoles
   use WebSockets to the same origin, and nothing in the app blocks them.
4. **Session end.** When the web app lands on `/login`, the app clears the WebView's
   cookies and storage and goes back to the native sign-in. The web app goes there
   on any 401: you signed out in the web UI, or the session expired. The menu's
   **Sign out** calls `POST /api/auth/logout` (with the CSRF header) and clears
   everything. **Change server** does the same, then asks for the new address.

### How the session is shared with the WebView

The ProxMate API sets two cookies on sign-in (`backend/src/lib/cookies.ts`):
`proxmate_session`, an httpOnly session JWT, and `proxmate_csrf`, a token that is
echoed in the `X-CSRF-Token` header on state-changing requests (double-submit).

The native client keeps no cookie jar. When sign-in succeeds, the two `Set-Cookie`
headers from the response are passed unchanged to `android.webkit.CookieManager.setCookie`
for the server's origin, then flushed. Path, Max-Age, Secure, HttpOnly and SameSite
stay exactly as the server set them. The web UI then loads, finds the cookies, and
`/api/auth/me` signs it in. The web client reads `proxmate_csrf` itself, as it does in
a browser. For sign-out, the app reads the cookies back from CookieManager and sends
the session cookie with the decoded CSRF token in `X-CSRF-Token`.

This works because ProxMate serves the web UI and the API from one origin (`/api` behind
the reverse proxy), as the production setup in DEPLOYMENT.md describes. A deployment that
puts the API on a separate origin isn't supported.

## Security

- Only the system certificate authorities are trusted. User-installed CAs are not.
- **Self-signed certificates (trust on first use).** If the device doesn't trust the
  server's certificate, the app shows its subject, issuer, validity dates and SHA-256
  fingerprint. It goes on only if you tap *Trust this certificate*. From then on, for
  that host and port only, a certificate the system rejects is accepted if, and only
  if, it is exactly that certificate (same SHA-256) and within its validity dates. The
  native client and the WebView (`onReceivedSslError`) apply the same rule. Anything
  else is refused. If the certificate changes, the app warns you and asks again. In
  the WebView, a pinned self-signed certificate needs Android 10 or newer. On older
  versions, use a certificate from a trusted authority. You can remove saved
  certificates on the server screen (*Forget trusted certificates*). A certificate
  from a trusted authority, such as Let's Encrypt or one issued through a Cloudflare
  Tunnel, is the better option. Compare the fingerprint on the server with
  `openssl x509 -noout -fingerprint -sha256 -in cert.pem`.
- **Cleartext.** A network security config can't name a host chosen at run time.
  The platform setting therefore permits cleartext, and the app enforces the rule
  itself: plain http goes only to the exact origin you entered as `http://` after the
  warning. The native client refuses every other origin. The WebView blocks every
  other http request and navigation. Mixed content is never allowed.
- Nothing sensitive is stored besides what CookieManager keeps: no password, no
  token, no 2FA challenge (kept in memory only). The settings hold the server address
  and the fingerprints of certificates you trusted. Backup and device transfer are
  turned off.
- The app never logs passwords, codes or cookies. The WebView has file and content
  access turned off and no JavaScript interface. It denies camera, microphone and
  location requests. Downloads go to the browser, so the session cookie is never
  passed to another app.
- Other links open in the browser only when you tap them in the page itself. A
  redirect or script that tries to leave the app on its own is blocked.
- Sign-out clears the local session at once. The server-side logout runs in the
  background with the cookies captured beforehand, so closing the screen can't
  cancel it. Sign-in, code and sign-out requests are never retried automatically.
- When trusted certificates are added, removed or replaced, and on sign-out, the
  WebView's remembered certificate decisions are cleared. That way a removed pin
  can't be bypassed.
- The sign-in and web screens are hidden from screenshots and the recent-apps
  preview (`FLAG_SECURE`). Native API responses are capped at 256 KB.

### Known limitations

- **Passkeys** inside the app need a system WebView that supports WebAuthn for
  arbitrary sites. Many devices' WebViews don't yet. Use password + TOTP in the app,
  or ProxMate in a browser.
- **SSO** needs the identity provider on `https://`. Some providers refuse to sign
  in inside embedded WebViews.
- Downloads open in the browser. Links that need the session, rather than a token
  link, will ask you to sign in there.

## Building

Requirements: JDK 17 and the Android SDK (platform 34 and build tools; the Android
Gradle plugin downloads missing pieces when the SDK licences are accepted). Android
Studio Koala (2024.1) or newer opens the `android/` directory as a project.

```bash
cd android
./gradlew testDebugUnitTest   # JVM unit tests
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
./gradlew lintDebug           # report in app/build/reports/
```

Versions: Android Gradle plugin 8.5.2, Gradle 8.7 (wrapper), Kotlin 2.0.21, compile
and target SDK 34, minimum SDK 26.

### Installing the APK

Download the `proxmate-android-debug` artifact from a run of the **Android** workflow
(or build it locally). Unzip it, then either:

- `adb install -r app-debug.apk` with the phone connected and USB debugging on, or
- copy the APK to the phone and open it. Allow your file manager or browser to
  *install unknown apps* when Android asks.

A debug build and a release build are signed with different keys, so Android won't
install one over the other. Uninstall first when switching.

### Release signing

`assembleRelease` signs the APK when these environment variables are set, and
otherwise produces an unsigned APK:

| Variable | Meaning |
|---|---|
| `ANDROID_KEYSTORE_PATH` | Path to the keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

Create a keystore once and keep it safe. Every later update must be signed with the
same key.

```bash
keytool -genkeypair -v -keystore proxmate-release.jks -alias proxmate \
  -keyalg RSA -keysize 4096 -validity 10000
```

In CI, add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 proxmate-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

When all four are set and the run is for `main` or a version tag (`v*`), the workflow
decodes the keystore into the runner's temporary directory, builds `assembleRelease`,
uploads `proxmate-android-release`, and deletes the keystore. Other branches and pull
requests never build the signed APK, and it is skipped when any secret is missing.

## CI

`.github/workflows/android.yml` runs on pushes that touch `android/**` or the
workflow, on version tags (`v*`), on pull requests to `main` that touch `android/**`,
and on manual dispatch.
It runs the unit tests, builds the debug APK, and runs lint (report only). It uploads:

- `proxmate-android-debug`: `app-debug.apk`
- `proxmate-android-reports`: unit test and lint reports
- `proxmate-android-release`: the signed `app-release.apk` (only on `main` or a version tag, with signing secrets)

## Layout

```
android/
  app/src/main/java/host/proxmate/app/
    ServerActivity.kt     server address, health check, certificate confirmation
    LoginActivity.kt      native sign-in and 2FA code step
    MainActivity.kt       the WebView: navigation policy, session-end detection, menu
    AppSettings.kt        saved server and trusted-certificate fingerprints
    CookieTransfer.kt     native sign-in cookies → CookieManager
    net/ApiClient.kt      OkHttp client for health, login, 2FA, logout
    core/                 Android-free logic (URL handling, response parsing,
                          cookies, navigation policy, certificate pinning)
  app/src/test/           JVM unit tests for core/
```
