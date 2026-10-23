package host.proxmate.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCookiesTest {
    // As Express's res.cookie writes them (backend/src/lib/cookies.ts).
    private val session =
        "proxmate_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig; Max-Age=86400; Path=/; " +
            "Expires=Fri, 24 Oct 2026 10:00:00 GMT; HttpOnly; Secure; SameSite=Lax"
    private val csrf =
        "proxmate_csrf=3f9a1c0d2b; Max-Age=86400; Path=/; Expires=Fri, 24 Oct 2026 10:00:00 GMT; Secure; SameSite=Lax"

    @Test
    fun readsCookieNamesAndValues() {
        assertEquals("proxmate_session", SessionCookies.cookieName(session))
        assertEquals("3f9a1c0d2b", SessionCookies.cookieValue(csrf))
        assertNull(SessionCookies.cookieName("=novalue"))
        assertNull(SessionCookies.cookieName("garbage"))
    }

    @Test
    fun keepsOnlyTheSessionCookiesUnchanged() {
        val other = "proxmate_webauthn=abc; Path=/; HttpOnly"
        val result = SessionCookies.sessionSetCookies(listOf(other, csrf, session))
        assertEquals(listOf(session, csrf), result)
    }

    @Test
    fun requiresBothCookiesWithValues() {
        assertNull(SessionCookies.sessionSetCookies(listOf(session)))
        assertNull(SessionCookies.sessionSetCookies(listOf(csrf)))
        assertNull(SessionCookies.sessionSetCookies(emptyList()))
        // clearCookie writes an empty value with an expiry in the past.
        val cleared = "proxmate_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        assertNull(SessionCookies.sessionSetCookies(listOf(cleared, csrf)))
    }

    @Test
    fun theLastHeaderForANameWins() {
        val newer = "proxmate_session=newer; Path=/; HttpOnly"
        assertEquals(listOf(newer, csrf), SessionCookies.sessionSetCookies(listOf(session, csrf, newer)))
    }

    @Test
    fun parsesCookieManagerStrings() {
        val parsed = SessionCookies.parseCookieHeader("proxmate_session=jwt.value; proxmate_csrf=abc%3D; theme=dark")
        assertEquals("jwt.value", parsed["proxmate_session"])
        assertEquals("abc%3D", parsed["proxmate_csrf"])
        assertEquals("dark", parsed["theme"])
        assertTrue(SessionCookies.parseCookieHeader(null).isEmpty())
        assertTrue(SessionCookies.parseCookieHeader("").isEmpty())
    }

    @Test
    fun detectsASession() {
        assertTrue(SessionCookies.hasSession("a=b; proxmate_session=x"))
        assertFalse(SessionCookies.hasSession("proxmate_csrf=x"))
        assertFalse(SessionCookies.hasSession("proxmate_session="))
        assertFalse(SessionCookies.hasSession(null))
    }

    @Test
    fun buildsLogoutHeadersWithTheCsrfEcho() {
        val headers = SessionCookies.authenticatedHeaders("theme=dark; proxmate_session=jwt; proxmate_csrf=tok%2Bx")!!
        assertEquals("proxmate_session=jwt; proxmate_csrf=tok%2Bx", headers["Cookie"])
        // decodeURIComponent semantics, as the web client uses.
        assertEquals("tok+x", headers[SessionCookies.CSRF_HEADER])
    }

    @Test
    fun noLogoutHeadersWithoutASession() {
        assertNull(SessionCookies.authenticatedHeaders("proxmate_csrf=tok"))
        assertNull(SessionCookies.authenticatedHeaders(null))
    }

    @Test
    fun percentDecodeMatchesDecodeUriComponent() {
        assertEquals("a+b", SessionCookies.percentDecode("a+b"))
        assertEquals("a b", SessionCookies.percentDecode("a%20b"))
        assertEquals("é", SessionCookies.percentDecode("%C3%A9"))
        assertEquals("100%", SessionCookies.percentDecode("100%"))
        assertEquals("%zz", SessionCookies.percentDecode("%zz"))
        assertEquals("plain", SessionCookies.percentDecode("plain"))
    }
}
