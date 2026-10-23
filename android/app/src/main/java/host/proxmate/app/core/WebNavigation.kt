package host.proxmate.app.core

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/** Where a URL the WebView wants to open should go. */
enum class NavigationTarget {
    /** Load it in the app's WebView. */
    IN_APP,

    /** Hand it to another app (the browser, the mail app, ...). */
    EXTERNAL,

    /** Refuse it outright. */
    BLOCKED,
}

enum class NavigationDecision {
    /** Let the WebView load it. */
    LOAD,

    /** Open it in another app (the browser). */
    OPEN_EXTERNAL,

    /** Drop it silently. */
    BLOCK,

    /** Drop it and tell the user it would have been unencrypted. */
    BLOCK_CLEARTEXT,
}

object WebNavigation {
    /** Web pages that belong to signing in (or first-run setup) rather than the signed-in app. */
    private val AUTH_PREFIXES = listOf(
        "/login",
        "/setup-2fa",
        "/register",
        "/forgot-password",
        "/reset-password",
        "/setup",
        "/api/auth/sso",
    )

    private val BLOCKED_SCHEMES = setOf("javascript", "file", "content", "data", "blob", "intent")

    fun pathOf(url: String?): String? {
        if (url == null) return null
        return try {
            URI(url).rawPath?.ifEmpty { "/" } ?: "/"
        } catch (_: URISyntaxException) {
            null
        }
    }

    private fun matchesPrefix(path: String, prefix: String): Boolean =
        path == prefix || path.startsWith("$prefix/")

    /** Whether [url] is the server's web sign-in page. */
    fun isLoginPage(url: String?, server: ServerAddress): Boolean {
        if (!server.isSameOrigin(url)) return false
        val path = pathOf(url) ?: return false
        return matchesPrefix(path, "/login")
    }

    /** Whether [url] is one of the server's sign-in / setup pages. */
    fun isAuthPage(url: String?, server: ServerAddress): Boolean {
        if (!server.isSameOrigin(url)) return false
        val path = pathOf(url) ?: return false
        return AUTH_PREFIXES.any { matchesPrefix(path, it) }
    }

    /**
     * Decide where a navigation goes. Pages on the server's own origin stay in
     * the app. While the user is signing in through the web page
     * ([webSignIn]), https pages on other origins also stay in the app so a
     * single sign-on round trip through the identity provider can complete.
     * Everything else (links to documentation, mail links, ...) opens outside.
     */
    fun decide(url: String?, server: ServerAddress, webSignIn: Boolean): NavigationTarget {
        if (url.isNullOrBlank()) return NavigationTarget.BLOCKED
        if (url == "about:blank") return NavigationTarget.IN_APP
        val scheme = try {
            URI(url).scheme?.lowercase(Locale.ROOT)
        } catch (_: URISyntaxException) {
            null
        } ?: return NavigationTarget.BLOCKED
        if (scheme in BLOCKED_SCHEMES || scheme == "about") return NavigationTarget.BLOCKED
        if (server.isSameOrigin(url)) return NavigationTarget.IN_APP
        if (webSignIn && scheme == "https") return NavigationTarget.IN_APP
        return NavigationTarget.EXTERNAL
    }

    /**
     * What to do with a navigation the WebView reports. In-app pages load
     * (unless they would break the cleartext rule). Outside pages go to another
     * app only for a top-level navigation the user started with a gesture;
     * anything else that would leave the app (a script redirect, an iframe) is
     * blocked, so a page can't launch other apps on its own.
     */
    fun route(
        url: String?,
        server: ServerAddress,
        webSignIn: Boolean,
        isMainFrame: Boolean,
        hasGesture: Boolean,
    ): NavigationDecision = when (decide(url, server, webSignIn)) {
        NavigationTarget.IN_APP ->
            if (cleartextAllowed(url, server)) NavigationDecision.LOAD else NavigationDecision.BLOCK_CLEARTEXT
        NavigationTarget.EXTERNAL ->
            if (isMainFrame && hasGesture) NavigationDecision.OPEN_EXTERNAL else NavigationDecision.BLOCK
        NavigationTarget.BLOCKED -> NavigationDecision.BLOCK
    }

    /**
     * Whether a request the WebView makes may go out over plain http. Cleartext
     * is only ever allowed to the user's own server, and only when the user chose
     * an http:// address for it.
     */
    fun cleartextAllowed(url: String?, server: ServerAddress): Boolean {
        val target = ServerAddress.parseOrigin(url) ?: return true // not http(s): not our concern here
        if (target.scheme != "http") return true
        return server.isCleartext && target == server
    }
}
