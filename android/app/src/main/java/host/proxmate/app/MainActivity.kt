package host.proxmate.app

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import host.proxmate.app.core.Fingerprints
import host.proxmate.app.core.NavigationTarget
import host.proxmate.app.core.ServerAddress
import host.proxmate.app.core.WebNavigation
import host.proxmate.app.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.security.cert.X509Certificate

/**
 * The ProxMate web UI in a full-screen WebView, signed in with the session
 * cookies the native sign-in handed over (or signing in through the web page
 * itself for passkeys and single sign-on).
 *
 * Navigation stays on the server's origin; other links open in the browser.
 * When the web app lands on its sign-in page outside a web sign-in (it does
 * that whenever the API answers 401), the session is over and the user is sent
 * back to the native sign-in screen.
 */
class MainActivity : AppCompatActivity() {
    enum class Mode { SESSION, WEB_SIGN_IN }

    private lateinit var binding: ActivityMainBinding
    private lateinit var settings: AppSettings
    private lateinit var server: ServerAddress

    /** True while the user is signing in through the web page (passkey, SSO, setup). */
    private var webSignIn = false
    private var leaving = false

    /** Set once the main WebView has been destroyed (after its renderer died). */
    private var mainDestroyed = false

    /** Windows opened by the page (window.open / target=_blank), stacked over the main view. */
    private val popups = mutableListOf<WebView>()

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val data = result.data
        val clip = data?.clipData
        val uris: Array<Uri>? = if (result.resultCode == RESULT_OK && clip != null && clip.itemCount > 0) {
            Array(clip.itemCount) { clip.getItemAt(it).uri }
        } else {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
        }
        callback.onReceiveValue(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)
        val saved = settings.server
        if (saved == null) {
            startActivity(ServerActivity.changeIntent(this))
            finish()
            return
        }
        server = saved

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.title = getString(R.string.app_name)
        supportActionBar?.subtitle = server.displayName

        val mode = intent.getStringExtra(EXTRA_MODE)?.let { runCatching { Mode.valueOf(it) }.getOrNull() } ?: Mode.SESSION
        webSignIn = savedInstanceState?.getBoolean(STATE_WEB_SIGN_IN) ?: (mode == Mode.WEB_SIGN_IN)

        configure(binding.webView)
        binding.retryButton.setOnClickListener {
            hideError()
            if (binding.webView.url.isNullOrEmpty()) loadStart() else binding.webView.reload()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val top = popups.lastOrNull()
                when {
                    top != null && top.canGoBack() -> top.goBack()
                    top != null -> closePopup(top)
                    binding.webView.canGoBack() -> binding.webView.goBack()
                    else -> finish()
                }
            }
        })

        if (savedInstanceState == null || binding.webView.restoreState(savedInstanceState) == null) {
            loadStart()
        }
    }

    private fun startUrl(): String {
        val path = intent.getStringExtra(EXTRA_PATH)?.takeIf { it.startsWith("/") && !it.startsWith("//") }
        return server.url(if (webSignIn) path ?: "/login" else "/")
    }

    private fun loadStart() {
        binding.webView.loadUrl(startUrl())
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString ${AppSettings.userAgent()}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        // Downloads (e.g. a backup link) open in the browser; the session cookie is never handed elsewhere.
        view.setDownloadListener { url, _, _, _, _ -> openExternal(url) }
    }

    // ─── Navigation and session tracking ──────────────────────────

    private fun onUrlChanged(url: String?) {
        if (leaving || url == null) return
        if (webSignIn) {
            // Back on the app's own pages: the web sign-in has finished.
            if (server.isSameOrigin(url) && !WebNavigation.isAuthPage(url, server)) {
                webSignIn = false
            }
        } else if (WebNavigation.isLoginPage(url, server)) {
            sessionEnded()
        }
    }

    /** The web app was signed out (or the session expired): back to the native sign-in. */
    private fun sessionEnded() {
        if (leaving) return
        leaving = true
        binding.webView.stopLoading()
        AppSettings.clearWebSession(this) {
            startActivity(LoginActivity.intent(this, getString(R.string.session_ended)))
            finish()
        }
    }

    private fun openExternal(url: String) {
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "mailto" && scheme != "tel") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (!WebNavigation.cleartextAllowed(url, server)) {
                if (request.isForMainFrame) showError(getString(R.string.cleartext_blocked))
                return true
            }
            return when (WebNavigation.decide(url, server, webSignIn)) {
                NavigationTarget.IN_APP -> false
                NavigationTarget.EXTERNAL -> {
                    openExternal(url)
                    // A new window whose only purpose was this external link: close it again.
                    if (view !== binding.webView && (view.url.isNullOrEmpty() || view.url == "about:blank")) {
                        closePopup(view)
                    }
                    true
                }
                NavigationTarget.BLOCKED -> true
            }
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            // Plain http is only ever allowed to the server itself, and only if the user chose http://.
            if (!WebNavigation.cleartextAllowed(request.url.toString(), server)) {
                return WebResourceResponse(
                    "text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)),
                )
            }
            return null
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (view === binding.webView) {
                binding.progress.visibility = View.VISIBLE
                hideError()
            }
            onUrlChanged(url)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view === binding.webView) binding.progress.visibility = View.GONE
            CookieManager.getInstance().flush()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // Also fires for the web app's client-side (history API) navigations.
            onUrlChanged(url)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && view === binding.webView) {
                showError(getString(R.string.page_load_failed, error.description))
            }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            // The web app redirects to /login on a 401 itself; this catches the same
            // signal if its own redirect doesn't happen.
            val url = request.url.toString()
            if (!webSignIn && errorResponse.statusCode == 401 && server.isSameOrigin(url) &&
                WebNavigation.pathOf(url) == "/api/auth/me"
            ) {
                sessionEnded()
            }
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            if (isPinnedCertificate(error)) {
                handler.proceed()
            } else {
                handler.cancel()
                if (server.isSameOrigin(error.url)) {
                    showError(getString(R.string.cert_rejected_web))
                }
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === binding.webView) {
                // The page's renderer died; rebuild the screen rather than crash.
                leaving = true
                mainDestroyed = true
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                startActivity(MainActivity.intent(this@MainActivity, Mode.SESSION))
                finish()
            } else {
                closePopup(view)
            }
            return true
        }
    }

    /**
     * Allow a certificate the system doesn't trust only when it is exactly the
     * one the user accepted for this server (same SHA-256), on the server's
     * origin, and the only problems are that it isn't trusted or names another
     * host. Expired, not-yet-valid or otherwise invalid certificates are refused.
     */
    private fun isPinnedCertificate(error: SslError): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        if (!server.isSameOrigin(error.url)) return false
        val pin = settings.pinFor(server) ?: return false
        if (error.hasError(SslError.SSL_EXPIRED) || error.hasError(SslError.SSL_NOTYETVALID) ||
            error.hasError(SslError.SSL_DATE_INVALID) || error.hasError(SslError.SSL_INVALID)
        ) {
            return false
        }
        val cert = certificateOf(error) ?: return false
        return try {
            cert.checkValidity()
            Fingerprints.matches(cert, pin)
        } catch (_: Exception) {
            false
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun certificateOf(error: SslError): X509Certificate? = error.certificate?.x509Certificate

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (view === binding.webView) binding.progress.setProgressCompat(newProgress, true)
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: WebChromeClient.FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = filePathCallback
            try {
                val chooser = fileChooserParams.createIntent()
                if (fileChooserParams.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                    chooser.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                fileChooser.launch(chooser)
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                filePathCallback.onReceiveValue(null)
                Toast.makeText(this@MainActivity, R.string.no_file_picker, Toast.LENGTH_SHORT).show()
            }
            return true
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (popups.size >= MAX_POPUPS) return false
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            val popup = WebView(this@MainActivity)
            configure(popup)
            binding.webContainer.addView(
                popup,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            popups.add(popup)
            invalidateOptionsMenu()
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            closePopup(window)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            // The web UI needs no camera, microphone or protected media.
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }
    }

    private fun closePopup(popup: WebView) {
        if (!popups.remove(popup)) return
        binding.webContainer.removeView(popup)
        popup.stopLoading()
        popup.destroy()
        invalidateOptionsMenu()
    }

    // ─── Error panel ──────────────────────────────────────────────

    private fun showError(message: String) {
        binding.errorMessage.text = message
        binding.errorPanel.visibility = View.VISIBLE
        binding.progress.visibility = View.GONE
    }

    private fun hideError() {
        binding.errorPanel.visibility = View.GONE
    }

    // ─── Menu ─────────────────────────────────────────────────────

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(R.id.action_close_window)?.isVisible = popups.isNotEmpty()
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.action_reload -> {
                hideError()
                val top = popups.lastOrNull() ?: binding.webView
                if (top.url.isNullOrEmpty()) loadStart() else top.reload()
            }
            R.id.action_close_window -> popups.lastOrNull()?.let { closePopup(it) }
            R.id.action_change_server -> confirm(R.string.change_server_confirm) {
                signOut { startActivity(ServerActivity.changeIntent(this)) }
            }
            R.id.action_sign_out -> confirm(R.string.sign_out_confirm) {
                signOut { startActivity(LoginActivity.intent(this)) }
            }
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun confirm(message: Int, action: () -> Unit) {
        MaterialAlertDialogBuilder(this)
            .setMessage(message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ -> action() }
            .show()
    }

    /** End the session on the server (best effort), then forget it locally. */
    private fun signOut(then: () -> Unit) {
        if (leaving) return
        leaving = true
        binding.progress.visibility = View.VISIBLE
        val cookies = CookieManager.getInstance().getCookie(server.origin)
        lifecycleScope.launch {
            // Whatever the server says, the local session is cleared below.
            withContext(Dispatchers.IO) { settings.apiClient(server).logout(cookies) }
            AppSettings.clearWebSession(this@MainActivity) {
                then()
                finish()
            }
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!::binding.isInitialized || mainDestroyed) return
        outState.putBoolean(STATE_WEB_SIGN_IN, webSignIn)
        binding.webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        if (!::binding.isInitialized || mainDestroyed) return
        binding.webView.onResume()
        popups.forEach { it.onResume() }
    }

    override fun onPause() {
        if (::binding.isInitialized && !mainDestroyed) {
            binding.webView.onPause()
            popups.forEach { it.onPause() }
        }
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        if (::binding.isInitialized) {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
            popups.toList().forEach { closePopup(it) }
            if (!mainDestroyed) {
                mainDestroyed = true
                (binding.webView.parent as? ViewGroup)?.removeView(binding.webView)
                binding.webView.destroy()
            }
        }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_MODE = "mode"
        private const val EXTRA_PATH = "path"
        private const val STATE_WEB_SIGN_IN = "web_sign_in"
        private const val MAX_POPUPS = 3

        fun intent(context: Context, mode: Mode, path: String? = null): Intent =
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_MODE, mode.name)
                .apply { if (path != null) putExtra(EXTRA_PATH, path) }
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}
