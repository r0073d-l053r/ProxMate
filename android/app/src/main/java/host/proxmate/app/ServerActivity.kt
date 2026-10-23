package host.proxmate.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import host.proxmate.app.core.Fingerprints
import host.proxmate.app.core.HealthResult
import host.proxmate.app.core.ServerAddress
import host.proxmate.app.core.ServerInput
import host.proxmate.app.core.ServerUrls
import host.proxmate.app.databinding.ActivityServerBinding
import host.proxmate.app.net.CallError
import host.proxmate.app.net.CallResult
import host.proxmate.app.net.HealthCheck
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URI
import java.security.cert.X509Certificate
import java.text.DateFormat

/**
 * Entry point. With a saved server it goes straight on (to the web app when a
 * session cookie exists, otherwise to the sign-in screen); otherwise, or when
 * opened to change the server, it asks for the server address and checks that
 * it really is a ProxMate server before saving it.
 */
class ServerActivity : AppCompatActivity() {
    private lateinit var binding: ActivityServerBinding
    private lateinit var settings: AppSettings
    private var checking = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)

        val saved = settings.server
        if (saved != null && !intent.getBooleanExtra(EXTRA_CHANGE, false) && savedInstanceState == null) {
            routeFor(saved)
            finish()
            return
        }

        binding = ActivityServerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        ServerScreenMessage.take()?.let { showError(it) }
        if (savedInstanceState == null && saved != null) binding.serverInput.setText(saved.origin)

        binding.serverInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                submit()
                true
            } else {
                false
            }
        }
        binding.continueButton.setOnClickListener { submit() }
        binding.forgetCertsButton.setOnClickListener { confirmForgetCertificates() }
        updateForgetButton()
    }

    private fun routeFor(server: ServerAddress) {
        val next = if (AppSettings.hasSession(server)) {
            MainActivity.intent(this, MainActivity.Mode.SESSION)
        } else {
            Intent(this, LoginActivity::class.java)
        }
        startActivity(next)
    }

    private fun submit() {
        if (checking) return
        showError(null)
        when (val input = ServerUrls.normalize(binding.serverInput.text?.toString().orEmpty())) {
            is ServerInput.Invalid -> showError(input.message)
            is ServerInput.Valid -> {
                binding.serverInput.setText(input.address.origin)
                if (input.address.isCleartext) confirmCleartext(input.address) else check(input.address)
            }
        }
    }

    private fun confirmCleartext(server: ServerAddress) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.cleartext_title)
            .setMessage(getString(R.string.cleartext_message, server.displayName))
            .setNegativeButton(R.string.cleartext_use_https) { _, _ ->
                val https = ServerAddress("https", server.host, if (server.port == 80) -1 else server.port)
                binding.serverInput.setText(https.origin)
            }
            .setPositiveButton(R.string.cleartext_continue) { _, _ -> check(server) }
            .setCancelable(true)
            .show()
    }

    private fun check(server: ServerAddress) {
        setChecking(true)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { settings.apiClient(server).health() }
            setChecking(false)
            when (result) {
                is CallResult.Failed -> when (val error = result.error) {
                    is CallError.Message -> showError(error.text)
                    is CallError.Untrusted -> {
                        val leaf = error.error.leaf
                        if (leaf == null) {
                            showError(getString(R.string.cert_untrusted_no_chain))
                        } else {
                            askToTrust(server, leaf)
                        }
                    }
                }
                is CallResult.Ok -> when (val health = result.value) {
                    is HealthCheck.Redirect -> showRedirect(server, health.location)
                    is HealthCheck.Result -> when (health.health) {
                        HealthResult.Ok -> accept(server)
                        HealthResult.Degraded -> showError(getString(R.string.server_degraded))
                        HealthResult.NotProxMate -> showError(getString(R.string.server_not_proxmate))
                    }
                }
            }
        }
    }

    private fun showRedirect(server: ServerAddress, location: String?) {
        // Location may be relative; resolve it against the URL that was requested.
        val resolved = location?.let {
            runCatching { URI(server.url("/api/health")).resolve(it.trim()).toString() }.getOrNull()
        }
        val target = ServerAddress.parseOrigin(resolved)
        if (target != null && target != server) {
            binding.serverInput.setText(target.origin)
            showError(getString(R.string.server_redirects, target.origin))
        } else {
            showError(getString(R.string.server_not_proxmate))
        }
    }

    private fun askToTrust(server: ServerAddress, leaf: X509Certificate) {
        val fingerprint = Fingerprints.sha256(leaf)
        val previous = settings.pinFor(server)
        val dates = DateFormat.getDateInstance(DateFormat.MEDIUM)
        val details = getString(
            R.string.cert_details,
            server.displayName,
            leaf.subjectX500Principal.name,
            leaf.issuerX500Principal.name,
            dates.format(leaf.notBefore),
            dates.format(leaf.notAfter),
            fingerprint,
        )
        val title = if (previous != null) R.string.cert_changed_title else R.string.cert_untrusted_title
        val intro = if (previous != null) R.string.cert_changed_intro else R.string.cert_untrusted_intro
        MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setMessage(getString(intro) + "\n\n" + details + "\n\n" + getString(R.string.cert_verify_hint))
            .setNegativeButton(android.R.string.cancel) { _, _ -> showError(getString(R.string.cert_rejected)) }
            .setPositiveButton(R.string.cert_trust) { _, _ ->
                settings.setPin(server, fingerprint)
                updateForgetButton()
                check(server)
            }
            .setCancelable(false)
            .show()
    }

    private fun accept(server: ServerAddress) {
        val previous = settings.server
        val proceed = {
            settings.server = server
            routeFor(server)
            finish()
        }
        if (previous != null && previous != server) {
            // Never carry one server's session or stored data over to another.
            AppSettings.clearWebSession(this) { proceed() }
        } else {
            proceed()
        }
    }

    private fun confirmForgetCertificates() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.forget_certs_title)
            .setMessage(R.string.forget_certs_message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.forget_certs_confirm) { _, _ ->
                settings.clearPins()
                updateForgetButton()
            }
            .show()
    }

    private fun updateForgetButton() {
        binding.forgetCertsButton.visibility = if (settings.hasPins()) View.VISIBLE else View.GONE
    }

    private fun setChecking(value: Boolean) {
        checking = value
        binding.progress.visibility = if (value) View.VISIBLE else View.INVISIBLE
        binding.continueButton.isEnabled = !value
        binding.serverInputLayout.isEnabled = !value
    }

    private fun showError(message: String?) {
        binding.errorText.text = message.orEmpty()
        binding.errorText.visibility = if (message.isNullOrEmpty()) View.GONE else View.VISIBLE
    }

    companion object {
        private const val EXTRA_CHANGE = "change_server"

        /**
         * Open the server screen to change the server, optionally with a message.
         * The message travels in-process ([ServerScreenMessage]), never as an extra.
         */
        fun changeIntent(context: Context, message: String? = null): Intent {
            ServerScreenMessage.set(message)
            return Intent(context, ServerActivity::class.java)
                .putExtra(EXTRA_CHANGE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
    }
}
