package host.proxmate.app

import android.content.Context
import android.content.SharedPreferences
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import host.proxmate.app.core.ServerAddress
import host.proxmate.app.net.ApiClient

/**
 * The app's only persistent settings: the chosen server and the certificates
 * the user explicitly trusted (by SHA-256 fingerprint, which is public
 * information). No credentials are stored here; the session lives only in the
 * WebView's CookieManager.
 */
class AppSettings(context: Context) {
    private val app = context.applicationContext
    private val prefs: SharedPreferences = app.getSharedPreferences("proxmate", Context.MODE_PRIVATE)
    private val pins: SharedPreferences = app.getSharedPreferences("proxmate_trusted_certs", Context.MODE_PRIVATE)

    var server: ServerAddress?
        get() = ServerAddress.fromOrigin(prefs.getString(KEY_SERVER, null))
        set(value) {
            prefs.edit().apply {
                if (value == null) remove(KEY_SERVER) else putString(KEY_SERVER, value.origin)
            }.apply()
        }

    fun pinFor(server: ServerAddress): String? =
        if (server.isCleartext) null else pins.getString(server.pinKey, null)

    fun pinForKey(pinKey: String): String? = pins.getString(pinKey, null)

    /** Must be called on the main thread (it resets the WebView's certificate decisions). */
    fun setPin(server: ServerAddress, sha256: String) {
        pins.edit().putString(server.pinKey, sha256).apply()
        clearWebCertificateDecisions(app)
    }

    fun hasPins(): Boolean = pins.all.isNotEmpty()

    /** Must be called on the main thread (it resets the WebView's certificate decisions). */
    fun clearPins() {
        pins.edit().clear().apply()
        clearWebCertificateDecisions(app)
    }

    fun apiClient(server: ServerAddress): ApiClient =
        ApiClient(server, pinFor(server), userAgent())

    companion object {
        private const val KEY_SERVER = "server_origin"

        fun userAgent(): String = "ProxMate-Android/${BuildConfig.VERSION_NAME}"

        /** Whether the WebView holds a session cookie for [server]. */
        fun hasSession(server: ServerAddress): Boolean =
            host.proxmate.app.core.SessionCookies.hasSession(CookieManager.getInstance().getCookie(server.origin))

        /**
         * Make the WebView forget every certificate error it was told to proceed
         * past, so a removed or replaced pin can't be bypassed by a decision the
         * WebView remembered. Main thread only.
         */
        fun clearWebCertificateDecisions(context: Context) {
            withScratchWebView(context) { it.clearSslPreferences() }
        }

        private fun withScratchWebView(context: Context, block: (WebView) -> Unit) {
            try {
                val view = WebView(context.applicationContext)
                try {
                    block(view)
                } finally {
                    view.destroy()
                }
            } catch (_: RuntimeException) {
                // No WebView provider available; there is nothing to clear.
            }
        }

        /**
         * Forget everything the WebView keeps for the signed-in user: cookies,
         * local/session storage, the HTTP cache and remembered certificate
         * decisions. Main thread only; [onDone] runs on the main thread.
         */
        fun clearWebSession(context: Context, onDone: () -> Unit = {}) {
            WebStorage.getInstance().deleteAllData()
            withScratchWebView(context) {
                it.clearCache(true)
                it.clearSslPreferences()
            }
            val cookies = CookieManager.getInstance()
            cookies.removeAllCookies {
                cookies.flush()
                onDone()
            }
        }
    }
}
