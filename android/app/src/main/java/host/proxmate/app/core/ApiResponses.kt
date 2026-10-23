package host.proxmate.app.core

import org.json.JSONException
import org.json.JSONObject

/**
 * Parsing of the ProxMate API responses the app handles natively. Kept free of
 * Android and network types so it runs in plain JVM unit tests.
 *
 * The shapes match backend/src/routes/auth.routes.ts and backend/src/app.ts:
 *  - `GET /api/health` → `{ status, service: "proxmate-api", checks, timestamp }`
 *  - `POST /api/auth/login` → `{ user }` (session cookies set), or
 *    `{ twoFactorRequired: true, challenge }`, or
 *    `{ mfaEnrollmentRequired: true, enrollmentToken }`, or an error
 *    `{ error, code? }` (`code: "passkey_required"` / `"access_expired"`).
 *  - `POST /api/auth/2fa/verify` → `{ user }` or `{ error }`.
 */
object ApiResponses {
    const val PASSKEY_REQUIRED = "passkey_required"
    const val ACCESS_EXPIRED = "access_expired"
    const val PROXMATE_SERVICE = "proxmate-api"

    private fun parseObject(body: String?): JSONObject? {
        if (body.isNullOrBlank()) return null
        return try {
            JSONObject(body)
        } catch (_: JSONException) {
            null
        }
    }

    /** The `error` string of an API error body, if there is one. */
    fun errorMessage(body: String?): String? =
        parseObject(body)?.optString("error")?.takeIf { it.isNotBlank() }

    fun health(status: Int, body: String?): HealthResult {
        val json = parseObject(body) ?: return HealthResult.NotProxMate
        if (json.optString("service") != PROXMATE_SERVICE) return HealthResult.NotProxMate
        return if (status in 200..299 && json.optString("status") == "ok") {
            HealthResult.Ok
        } else {
            HealthResult.Degraded
        }
    }

    fun login(status: Int, body: String?): LoginOutcome {
        val json = parseObject(body)
        if (status in 200..299) {
            if (json == null) return LoginOutcome.Failure(UNEXPECTED)
            if (json.optBoolean("mfaEnrollmentRequired")) {
                return LoginOutcome.WebSignInRequired(
                    WebSignInReason.MFA_ENROLLMENT,
                    "Your account needs a second sign-in factor before it can be used. " +
                        "Finish setting it up in the web sign-in.",
                )
            }
            if (json.optBoolean("twoFactorRequired")) {
                val challenge = json.optString("challenge")
                return if (challenge.isNotBlank()) {
                    LoginOutcome.TwoFactorRequired(challenge)
                } else {
                    LoginOutcome.Failure(UNEXPECTED)
                }
            }
            if (json.optJSONObject("user") != null) return LoginOutcome.Success
            return LoginOutcome.Failure(UNEXPECTED)
        }
        val code = json?.optString("code").orEmpty()
        val error = json?.optString("error")?.takeIf { it.isNotBlank() }
        if (code == PASSKEY_REQUIRED) {
            return LoginOutcome.WebSignInRequired(
                WebSignInReason.PASSKEY,
                error ?: "Use your passkey to sign in.",
            )
        }
        return LoginOutcome.Failure(friendlyError(status, error), accessExpired = code == ACCESS_EXPIRED)
    }

    fun verifyTwoFactor(status: Int, body: String?): VerifyOutcome {
        val json = parseObject(body)
        if (status in 200..299) {
            return if (json?.optJSONObject("user") != null) VerifyOutcome.Success else VerifyOutcome.Failure(UNEXPECTED)
        }
        val error = json?.optString("error")?.takeIf { it.isNotBlank() }
        val code = json?.optString("code").orEmpty()
        // The server answers a spent, expired or locked challenge with a message
        // telling the user to sign in again; the password step has to be redone.
        if (status == 401 && error != null && error.contains("expired", ignoreCase = true)) {
            return VerifyOutcome.ChallengeExpired(error)
        }
        return VerifyOutcome.Failure(friendlyError(status, error), accessExpired = code == ACCESS_EXPIRED)
    }

    /** The server's own message where it has one, otherwise a plain description of the status. */
    fun friendlyError(status: Int, error: String?): String {
        if (status == 400 && (error == null || error == "Validation failed")) {
            return "Enter a valid email address and password."
        }
        if (error != null) return error
        return when (status) {
            401 -> "Invalid email or password."
            403 -> "The server refused the sign-in."
            404 -> "This server doesn't offer the ProxMate sign-in API. Check the address."
            429 -> "Too many attempts. Wait a few minutes and try again."
            in 500..599 -> "The ProxMate server had a problem (HTTP $status). Try again shortly."
            else -> "Unexpected response from the server (HTTP $status)."
        }
    }

    /** `GET /api/setup/status` → whether first-run setup is finished; null if unknown. */
    fun setupComplete(status: Int, body: String?): Boolean? {
        if (status !in 200..299) return null
        val json = parseObject(body) ?: return null
        if (!json.has("setupComplete")) return null
        return json.optBoolean("setupComplete")
    }

    /** `GET /api/auth/sso/info` → the SSO button label when SSO is enabled, else null. */
    fun ssoLabel(status: Int, body: String?): String? {
        if (status !in 200..299) return null
        val json = parseObject(body) ?: return null
        if (!json.optBoolean("enabled")) return null
        return json.optString("label").takeIf { it.isNotBlank() } ?: "SSO"
    }

    private const val UNEXPECTED = "Unexpected response from the server."
}

sealed class HealthResult {
    /** A ProxMate server that reports itself healthy. */
    object Ok : HealthResult()

    /** A ProxMate server that reports a problem (for example its database is down). */
    object Degraded : HealthResult()

    /** Something answered, but it isn't the ProxMate API. */
    object NotProxMate : HealthResult()
}

enum class WebSignInReason { PASSKEY, MFA_ENROLLMENT }

sealed class LoginOutcome {
    /** Signed in: the session and CSRF cookies are in the response. */
    object Success : LoginOutcome()

    /** Password accepted; exchange [challenge] plus a TOTP or recovery code at /2fa/verify. */
    data class TwoFactorRequired(val challenge: String) : LoginOutcome()

    /** This account can only finish signing in through the web sign-in page. */
    data class WebSignInRequired(val reason: WebSignInReason, val message: String) : LoginOutcome()

    data class Failure(val message: String, val accessExpired: Boolean = false) : LoginOutcome()
}

sealed class VerifyOutcome {
    object Success : VerifyOutcome()

    /** The login challenge can no longer be used; start again from the password. */
    data class ChallengeExpired(val message: String) : VerifyOutcome()

    data class Failure(val message: String, val accessExpired: Boolean = false) : VerifyOutcome()
}
