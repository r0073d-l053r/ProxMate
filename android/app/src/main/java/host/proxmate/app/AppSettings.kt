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

    fun setPin(server: ServerAddress, sha256: String) {
        pins.edit().putString(server.pinKey, sha256).apply()
    }

    fun hasPins(): Boolean = pins.all.isNotEmpty()

    fun clearPins() {
        pins.edit().clear().apply()
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
         * Forget everything the WebView keeps for the signed-in user: cookies,
         * local/session storage and the HTTP cache. [onDone] runs on the main thread.
         */
        fun clearWebSession(context: Context, onDone: () -> Unit = {}) {
            WebStorage.getInstance().deleteAllData()
            try {
                WebView(context.applicationContext).apply {
                    clearCache(true)
                    destroy()
                }
            } catch (_: RuntimeException) {
                // No WebView provider available; nothing cached to clear.
            }
            val cookies = CookieManager.getInstance()
            cookies.removeAllCookies {
                cookies.flush()
                onDone()
            }
        }
    }
}
