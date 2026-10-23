package host.proxmate.app

import android.webkit.CookieManager
import host.proxmate.app.core.ServerAddress

/**
 * Hands the session cookies from a native sign-in to the WebView, so the web UI
 * opens already signed in. The raw `Set-Cookie` values from the server are set
 * unchanged for the server's origin, which keeps their Path, Max-Age, Secure,
 * HttpOnly and SameSite attributes exactly as the server chose them. The values
 * are never logged.
 */
object CookieTransfer {
    /** Must be called on the main thread; [onDone] is called there with whether every cookie was stored. */
    fun toWebView(server: ServerAddress, setCookies: List<String>, onDone: (Boolean) -> Unit) {
        val manager = CookieManager.getInstance()
        manager.setAcceptCookie(true)
        if (setCookies.isEmpty()) {
            onDone(false)
            return
        }
        val url = server.url("/")
        var remaining = setCookies.size
        var allStored = true
        for (header in setCookies) {
            manager.setCookie(url, header) { stored ->
                if (stored != true) allStored = false
                remaining--
                if (remaining == 0) {
                    manager.flush()
                    onDone(allStored)
                }
            }
        }
    }
}
