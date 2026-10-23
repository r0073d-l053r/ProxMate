package host.proxmate.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import host.proxmate.app.core.LoginOutcome
import host.proxmate.app.core.ServerAddress
import host.proxmate.app.core.VerifyOutcome
import host.proxmate.app.core.WebSignInReason
import host.proxmate.app.databinding.ActivityLoginBinding
import host.proxmate.app.net.ApiClient
import host.proxmate.app.net.CallError
import host.proxmate.app.net.CallResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Native sign-in with the same API calls as the web sign-in page:
 * `POST /api/auth/login`, then, for an account with two-factor authentication,
 * `POST /api/auth/2fa/verify` with the returned challenge and a TOTP or recovery
 * code. Passkey and single sign-on happen in the web sign-in page instead.
 */
class LoginActivity : AppCompatActivity() {
    private lateinit var binding: ActivityLoginBinding
    private lateinit var settings: AppSettings
    private lateinit var server: ServerAddress
    private lateinit var api: ApiClient

    /** The pending two-factor challenge; held in memory only. */
    private var challenge: String? = null
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep the password and codes out of screenshots and the recent-apps preview.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        settings = AppSettings(this)
        val saved = settings.server
        if (saved == null) {
            startActivity(ServerActivity.changeIntent(this))
            finish()
            return
        }
        server = saved
        api = settings.apiClient(server)

        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.serverName.text = server.displayName
        binding.cleartextWarning.visibility = if (server.isCleartext) View.VISIBLE else View.GONE
        intent.getStringExtra(EXTRA_MESSAGE)?.let { showError(it) }

        binding.passwordInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_GO) {
                signIn()
                true
            } else {
                false
            }
        }
        binding.codeInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_GO) {
                verifyCode()
                true
            } else {
                false
            }
        }
        binding.signInButton.setOnClickListener { signIn() }
        binding.verifyButton.setOnClickListener { verifyCode() }
        binding.codeBackButton.setOnClickListener { showPasswordStep(null) }
        binding.webSignInButton.setOnClickListener { openWebSignIn("/login") }
        binding.changeServerButton.setOnClickListener {
            startActivity(ServerActivity.changeIntent(this))
            finish()
        }

        showPasswordStep(null)
        loadServerInfo()
    }

    /** First-run setup goes to the web app; the SSO label, when enabled, names the web sign-in button. */
    private fun loadServerInfo() {
        lifecycleScope.launch {
            val setup = withContext(Dispatchers.IO) { api.setupComplete() }
            if (setup is CallResult.Failed && setup.error is CallError.Untrusted) {
                certificateProblem()
                return@launch
            }
            if (setup is CallResult.Ok && setup.value == false) {
                openWebSignIn("/setup")
                return@launch
            }
            val sso = withContext(Dispatchers.IO) { api.ssoLabel() }
            if (sso is CallResult.Ok && sso.value != null) {
                binding.webSignInButton.text = getString(R.string.login_web_sso, sso.value)
            }
        }
    }

    private fun signIn() {
        if (busy) return
        val email = binding.emailInput.text?.toString()?.trim().orEmpty()
        val password = binding.passwordInput.text?.toString().orEmpty()
        if (email.isEmpty() || password.isEmpty()) {
            showError(getString(R.string.login_missing_fields))
            return
        }
        showError(null)
        setBusy(true)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { api.login(email, password) }
            setBusy(false)
            when (result) {
                is CallResult.Failed -> handleCallError(result.error)
                is CallResult.Ok -> when (val outcome = result.value.outcome) {
                    LoginOutcome.Success -> finishSignIn(result.value.sessionSetCookies)
                    is LoginOutcome.TwoFactorRequired -> {
                        challenge = outcome.challenge
                        showCodeStep()
                    }
                    is LoginOutcome.WebSignInRequired -> explainWebSignIn(outcome.reason, outcome.message)
                    is LoginOutcome.Failure -> showError(outcome.message)
                }
            }
        }
    }

    private fun verifyCode() {
        if (busy) return
        val pending = challenge ?: return showPasswordStep(getString(R.string.login_code_expired))
        val code = binding.codeInput.text?.toString()?.trim()?.replace(" ", "").orEmpty()
        if (code.isEmpty()) {
            showError(getString(R.string.login_code_missing))
            return
        }
        showError(null)
        setBusy(true)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { api.verifyTwoFactor(pending, code) }
            setBusy(false)
            when (result) {
                is CallResult.Failed -> handleCallError(result.error)
                is CallResult.Ok -> when (val outcome = result.value.outcome) {
                    VerifyOutcome.Success -> finishSignIn(result.value.sessionSetCookies)
                    is VerifyOutcome.ChallengeExpired -> showPasswordStep(outcome.message)
                    is VerifyOutcome.Failure -> {
                        binding.codeInput.setText("")
                        showError(outcome.message)
                    }
                }
            }
        }
    }

    private fun finishSignIn(setCookies: List<String>?) {
        challenge = null
        binding.passwordInput.setText("")
        binding.codeInput.setText("")
        if (setCookies == null) {
            showPasswordStep(getString(R.string.login_no_cookies))
            return
        }
        setBusy(true)
        CookieTransfer.toWebView(server, setCookies) { stored ->
            setBusy(false)
            if (stored) {
                startActivity(MainActivity.intent(this, MainActivity.Mode.SESSION))
                finish()
            } else {
                showPasswordStep(getString(R.string.login_cookie_rejected))
            }
        }
    }

    private fun explainWebSignIn(reason: WebSignInReason, message: String) {
        val text = when (reason) {
            WebSignInReason.PASSKEY -> message + "\n\n" + getString(R.string.login_passkey_web)
            WebSignInReason.MFA_ENROLLMENT -> message
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.login_web_title)
            .setMessage(text)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.login_web_continue) { _, _ -> openWebSignIn("/login") }
            .show()
    }

    private fun openWebSignIn(path: String) {
        challenge = null
        startActivity(MainActivity.intent(this, MainActivity.Mode.WEB_SIGN_IN, path))
        finish()
    }

    private fun handleCallError(error: CallError) {
        when (error) {
            is CallError.Message -> showError(error.text)
            is CallError.Untrusted -> certificateProblem()
        }
    }

    private fun certificateProblem() {
        startActivity(ServerActivity.changeIntent(this, getString(R.string.cert_no_longer_trusted)))
        finish()
    }

    private fun showPasswordStep(message: String?) {
        challenge = null
        binding.passwordStep.visibility = View.VISIBLE
        binding.codeStep.visibility = View.GONE
        binding.webSignInButton.visibility = View.VISIBLE
        showError(message)
    }

    private fun showCodeStep() {
        binding.passwordStep.visibility = View.GONE
        binding.codeStep.visibility = View.VISIBLE
        binding.webSignInButton.visibility = View.GONE
        binding.codeInput.setText("")
        binding.codeInput.requestFocus()
        showError(null)
    }

    private fun setBusy(value: Boolean) {
        busy = value
        binding.progress.visibility = if (value) View.VISIBLE else View.INVISIBLE
        binding.signInButton.isEnabled = !value
        binding.verifyButton.isEnabled = !value
        binding.webSignInButton.isEnabled = !value
    }

    private fun showError(message: String?) {
        binding.errorText.text = message.orEmpty()
        binding.errorText.visibility = if (message.isNullOrEmpty()) View.GONE else View.VISIBLE
    }

    companion object {
        private const val EXTRA_MESSAGE = "message"

        fun intent(context: android.content.Context, message: String? = null): Intent =
            Intent(context, LoginActivity::class.java)
                .apply { if (message != null) putExtra(EXTRA_MESSAGE, message) }
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}
