package host.proxmate.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Response bodies below are the ones backend/src/routes/auth.routes.ts and app.ts send. */
class ApiResponsesTest {
    @Test
    fun healthRecognisesProxMate() {
        val ok = """{"status":"ok","service":"proxmate-api","checks":{"db":"ok"},"timestamp":"2026-01-01T00:00:00.000Z"}"""
        assertEquals(HealthResult.Ok, ApiResponses.health(200, ok))
        val degraded = """{"status":"degraded","service":"proxmate-api","checks":{"db":"down"}}"""
        assertEquals(HealthResult.Degraded, ApiResponses.health(503, degraded))
    }

    @Test
    fun healthRejectsOtherServers() {
        assertEquals(HealthResult.NotProxMate, ApiResponses.health(200, "<html>Proxmox VE</html>"))
        assertEquals(HealthResult.NotProxMate, ApiResponses.health(200, """{"status":"ok"}"""))
        assertEquals(HealthResult.NotProxMate, ApiResponses.health(404, null))
        assertEquals(HealthResult.NotProxMate, ApiResponses.health(200, """["proxmate-api"]"""))
    }

    @Test
    fun loginSuccess() {
        val body = """{"user":{"id":"u1","email":"a@b.c","role":"USER","displayName":"A"}}"""
        assertEquals(LoginOutcome.Success, ApiResponses.login(200, body))
    }

    @Test
    fun loginTwoFactorChallenge() {
        val body = """{"twoFactorRequired":true,"challenge":"eyJhbGciOi.challenge"}"""
        assertEquals(LoginOutcome.TwoFactorRequired("eyJhbGciOi.challenge"), ApiResponses.login(200, body))
    }

    @Test
    fun loginTwoFactorWithoutChallengeIsAFailure() {
        assertTrue(ApiResponses.login(200, """{"twoFactorRequired":true}""") is LoginOutcome.Failure)
    }

    @Test
    fun loginEnrollmentGoesToTheWeb() {
        val body = """{"mfaEnrollmentRequired":true,"enrollmentToken":"tok"}"""
        val outcome = ApiResponses.login(200, body)
        assertTrue(outcome is LoginOutcome.WebSignInRequired)
        assertEquals(WebSignInReason.MFA_ENROLLMENT, (outcome as LoginOutcome.WebSignInRequired).reason)
    }

    @Test
    fun loginPasskeyRequiredGoesToTheWeb() {
        val body = """{"code":"passkey_required","error":"Use your passkey to sign in."}"""
        val outcome = ApiResponses.login(401, body)
        assertEquals(
            LoginOutcome.WebSignInRequired(WebSignInReason.PASSKEY, "Use your passkey to sign in."),
            outcome,
        )
    }

    @Test
    fun loginErrorsShowTheServerMessage() {
        assertEquals(
            LoginOutcome.Failure("Invalid email or password"),
            ApiResponses.login(401, """{"error":"Invalid email or password"}"""),
        )
        val expired = ApiResponses.login(403, """{"code":"access_expired","error":"Your access ended on 1 March 2026."}""")
        assertEquals(LoginOutcome.Failure("Your access ended on 1 March 2026.", accessExpired = true), expired)
        assertEquals(
            LoginOutcome.Failure("Too many requests — please slow down and try again later."),
            ApiResponses.login(429, """{"error":"Too many requests — please slow down and try again later."}"""),
        )
    }

    @Test
    fun loginErrorsWithoutABodyGetAPlainMessage() {
        val rateLimited = ApiResponses.login(429, "Too many requests") as LoginOutcome.Failure
        assertTrue(rateLimited.message.contains("Too many attempts"))
        val gateway = ApiResponses.login(502, "<html>Bad Gateway</html>") as LoginOutcome.Failure
        assertTrue(gateway.message.contains("502"))
        val validation = ApiResponses.login(400, """{"error":"Validation failed","details":{}}""") as LoginOutcome.Failure
        assertEquals("Enter a valid email address and password.", validation.message)
    }

    @Test
    fun verifySuccess() {
        assertEquals(VerifyOutcome.Success, ApiResponses.verifyTwoFactor(200, """{"user":{"id":"u1"}}"""))
    }

    @Test
    fun verifyWrongCodeStaysOnTheCodeStep() {
        assertEquals(
            VerifyOutcome.Failure("Invalid authentication code."),
            ApiResponses.verifyTwoFactor(401, """{"error":"Invalid authentication code."}"""),
        )
    }

    @Test
    fun verifyExpiredChallengeRestartsSignIn() {
        val message = "Your login session expired — please sign in again."
        assertEquals(
            VerifyOutcome.ChallengeExpired(message),
            ApiResponses.verifyTwoFactor(401, """{"error":"$message"}"""),
        )
    }

    @Test
    fun verifyAccessExpired() {
        val outcome = ApiResponses.verifyTwoFactor(403, """{"code":"access_expired","error":"Access ended."}""")
        assertEquals(VerifyOutcome.Failure("Access ended.", accessExpired = true), outcome)
    }

    @Test
    fun setupAndSso() {
        assertEquals(true, ApiResponses.setupComplete(200, """{"setupComplete":true,"adminExists":true}"""))
        assertEquals(false, ApiResponses.setupComplete(200, """{"setupComplete":false,"adminExists":false}"""))
        assertNull(ApiResponses.setupComplete(500, null))
        assertEquals("Sign in with Authentik", ApiResponses.ssoLabel(200, """{"enabled":true,"label":"Sign in with Authentik"}"""))
        assertNull(ApiResponses.ssoLabel(200, """{"enabled":false,"label":"SSO"}"""))
        assertEquals("SSO", ApiResponses.ssoLabel(200, """{"enabled":true}"""))
    }
}
