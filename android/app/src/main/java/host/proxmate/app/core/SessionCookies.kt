package host.proxmate.app.core

/**
 * The ProxMate session cookies, and the small amount of handling the app needs
 * to move them between its native HTTP client and the WebView.
 *
 * The backend (backend/src/lib/cookies.ts) sets two cookies on sign-in:
 *  - `proxmate_session`: httpOnly session JWT;
 *  - `proxmate_csrf`: JS-readable token that must be echoed in the
 *    `X-CSRF-Token` header on every cookie-authenticated POST/PUT/PATCH/DELETE
 *    (double-submit).
 *
 * After a native sign-in the raw `Set-Cookie` headers are handed to the
 * WebView's CookieManager unchanged, so every attribute the server chose
 * (Path, Max-Age, Secure, HttpOnly, SameSite) is kept exactly.
 */
object SessionCookies {
    const val SESSION = "proxmate_session"
    const val CSRF = "proxmate_csrf"
    const val CSRF_HEADER = "X-CSRF-Token"

    /** The cookie name of a `Set-Cookie` header value, or null if it has none. */
    fun cookieName(setCookie: String): String? {
        val pair = setCookie.substringBefore(';')
        val eq = pair.indexOf('=')
        if (eq <= 0) return null
        return pair.substring(0, eq).trim().takeIf { it.isNotEmpty() }
    }

    /** The cookie value of a `Set-Cookie` header value. */
    fun cookieValue(setCookie: String): String? {
        val pair = setCookie.substringBefore(';')
        val eq = pair.indexOf('=')
        if (eq <= 0) return null
        return pair.substring(eq + 1).trim()
    }

    /**
     * The `Set-Cookie` headers from a sign-in response that should be copied to
     * the WebView: the session and CSRF cookies, and only when both are present
     * with a value (a cleared cookie has an empty value).
     */
    fun sessionSetCookies(setCookieHeaders: List<String>): List<String>? {
        val byName = LinkedHashMap<String, String>()
        for (header in setCookieHeaders) {
            val name = cookieName(header) ?: continue
            if (name == SESSION || name == CSRF) byName[name] = header
        }
        val session = byName[SESSION] ?: return null
        val csrf = byName[CSRF] ?: return null
        if (cookieValue(session).isNullOrEmpty() || cookieValue(csrf).isNullOrEmpty()) return null
        return listOf(session, csrf)
    }

    /**
     * Parse a `Cookie` request header (`a=1; b=2`, as returned by
     * CookieManager.getCookie) into name → value. The first value of a repeated
     * name wins, matching how cookie-parser reads the header on the server.
     */
    fun parseCookieHeader(header: String?): Map<String, String> {
        if (header.isNullOrBlank()) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (part in header.split(';')) {
            val eq = part.indexOf('=')
            if (eq <= 0) continue
            val name = part.substring(0, eq).trim()
            if (name.isEmpty() || out.containsKey(name)) continue
            out[name] = part.substring(eq + 1).trim()
        }
        return out
    }

    fun hasSession(cookieHeader: String?): Boolean =
        !parseCookieHeader(cookieHeader)[SESSION].isNullOrEmpty()

    /**
     * Headers for a cookie-authenticated mutating request (the logout call),
     * built from the WebView's cookies: the session and CSRF cookies, plus the
     * CSRF token echoed in its header. Null when there is no session to use.
     */
    fun authenticatedHeaders(cookieHeader: String?): Map<String, String>? {
        val cookies = parseCookieHeader(cookieHeader)
        val session = cookies[SESSION]?.takeIf { it.isNotEmpty() } ?: return null
        val csrfRaw = cookies[CSRF]?.takeIf { it.isNotEmpty() }
        val headers = LinkedHashMap<String, String>()
        headers["Cookie"] = buildString {
            append(SESSION).append('=').append(session)
            if (csrfRaw != null) append("; ").append(CSRF).append('=').append(csrfRaw)
        }
        if (csrfRaw != null) headers[CSRF_HEADER] = percentDecode(csrfRaw)
        return headers
    }

    /**
     * Decode `%XX` escapes the way JavaScript's decodeURIComponent does (the web
     * client decodes the CSRF cookie with it); unlike URLDecoder, `+` stays `+`.
     * Malformed escapes are left as they are.
     */
    fun percentDecode(value: String): String {
        if (!value.contains('%')) return value
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '%' && i + 2 < value.length) {
                val hi = Character.digit(value[i + 1], 16)
                val lo = Character.digit(value[i + 2], 16)
                if (hi >= 0 && lo >= 0) {
                    bytes.write(hi * 16 + lo)
                    i += 3
                    continue
                }
            }
            val encoded = c.toString().toByteArray(Charsets.UTF_8)
            bytes.write(encoded, 0, encoded.size)
            i++
        }
        return String(bytes.toByteArray(), Charsets.UTF_8)
    }
}
