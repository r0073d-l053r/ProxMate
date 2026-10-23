package host.proxmate.app.net

import host.proxmate.app.core.ApiResponses
import host.proxmate.app.core.HealthResult
import host.proxmate.app.core.LoginOutcome
import host.proxmate.app.core.PinAwareHostnameVerifier
import host.proxmate.app.core.PinningTrustManager
import host.proxmate.app.core.ServerAddress
import host.proxmate.app.core.SessionCookies
import host.proxmate.app.core.UntrustedCertificateException
import host.proxmate.app.core.VerifyOutcome
import host.proxmate.app.core.findUntrustedCertificate
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.internal.tls.OkHostnameVerifier
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** A request that could not be completed. */
sealed class CallError {
    data class Message(val text: String) : CallError()

    /** The server's certificate isn't trusted; the user may review and pin it. */
    data class Untrusted(val error: UntrustedCertificateException) : CallError()
}

sealed class CallResult<out T> {
    data class Ok<T>(val value: T) : CallResult<T>()
    data class Failed(val error: CallError) : CallResult<Nothing>()
}

sealed class HealthCheck {
    data class Result(val health: HealthResult) : HealthCheck()

    /** The address answered with a redirect; [location] is where it pointed. */
    data class Redirect(val location: String?) : HealthCheck()
}

data class LoginResult(val outcome: LoginOutcome, val sessionSetCookies: List<String>?)
data class VerifyResult(val outcome: VerifyOutcome, val sessionSetCookies: List<String>?)

/**
 * Native HTTP client for the few ProxMate API calls the app makes itself
 * (health check, sign-in, second factor, sign-out). Everything else happens in
 * the WebView. It keeps no cookie jar: the session cookies of a sign-in are
 * returned to the caller to hand to the WebView, and the sign-out call takes the
 * WebView's cookies explicitly. Nothing here logs request or response content.
 *
 * Calls block; run them off the main thread.
 */
class ApiClient(
    private val server: ServerAddress,
    pinnedSha256: String?,
    userAgent: String,
) {
    private val client: OkHttpClient

    /** For POSTs: a sign-in, code or sign-out attempt is never replayed automatically. */
    private val noRetryClient: OkHttpClient

    init {
        val system = systemTrustManager()
        val trustManager = PinningTrustManager(system, pinnedSha256)
        val ssl = SSLContext.getInstance("TLS")
        ssl.init(null, arrayOf(trustManager), null)
        client = OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trustManager)
            .hostnameVerifier(PinAwareHostnameVerifier(OkHostnameVerifier, pinnedSha256))
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            // A redirect would leave the origin the user confirmed; report it instead.
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(true)
            .addInterceptor { chain ->
                val request = chain.request()
                if (!server.isSameOrigin(request.url.toString())) {
                    throw IOException("Refusing a request outside the configured server")
                }
                chain.proceed(request.newBuilder().header("User-Agent", userAgent).build())
            }
            .build()
        noRetryClient = client.newBuilder().retryOnConnectionFailure(false).build()
    }

    fun health(): CallResult<HealthCheck> = call(get("/api/health")) { response, body ->
        if (response.code in 300..399) {
            HealthCheck.Redirect(response.header("Location"))
        } else {
            HealthCheck.Result(ApiResponses.health(response.code, body))
        }
    }

    fun setupComplete(): CallResult<Boolean?> = call(get("/api/setup/status")) { response, body ->
        ApiResponses.setupComplete(response.code, body)
    }

    fun ssoLabel(): CallResult<String?> = call(get("/api/auth/sso/info")) { response, body ->
        ApiResponses.ssoLabel(response.code, body)
    }

    fun login(email: String, password: String): CallResult<LoginResult> {
        val json = JSONObject().put("email", email).put("password", password).toString()
        return call(post("/api/auth/login", json)) { response, body ->
            val outcome = ApiResponses.login(response.code, body)
            LoginResult(outcome, sessionCookiesFor(outcome is LoginOutcome.Success, response))
        }
    }

    fun verifyTwoFactor(challenge: String, code: String): CallResult<VerifyResult> {
        val json = JSONObject().put("challenge", challenge).put("code", code).toString()
        return call(post("/api/auth/2fa/verify", json)) { response, body ->
            val outcome = ApiResponses.verifyTwoFactor(response.code, body)
            VerifyResult(outcome, sessionCookiesFor(outcome is VerifyOutcome.Success, response))
        }
    }

    /**
     * End the session on the server. [cookieHeader] is the WebView's cookie
     * string for the server; the CSRF token is echoed from it (double-submit).
     */
    fun logout(cookieHeader: String?): CallResult<Unit> {
        val headers = SessionCookies.authenticatedHeaders(cookieHeader) ?: return CallResult.Ok(Unit)
        val builder = Request.Builder()
            .url(server.url("/api/auth/logout"))
            .post("{}".toRequestBody(JSON))
        headers.forEach { (name, value) -> builder.header(name, value) }
        return call(builder.build()) { _, _ -> }
    }

    private fun sessionCookiesFor(success: Boolean, response: Response): List<String>? =
        if (success) SessionCookies.sessionSetCookies(response.headers("Set-Cookie")) else null

    private fun get(path: String): Request = Request.Builder()
        .url(server.url(path))
        .header("Accept", "application/json")
        .get()
        .build()

    private fun post(path: String, json: String): Request = Request.Builder()
        .url(server.url(path))
        .header("Accept", "application/json")
        .post(json.toRequestBody(JSON))
        .build()

    private fun <T> call(request: Request, handle: (Response, String?) -> T): CallResult<T> {
        return try {
            val http = if (request.method == "GET") client else noRetryClient
            http.newCall(request).execute().use { response ->
                // API answers are small; never buffer more than MAX_BODY of whatever comes back.
                val body = response.body?.let { b ->
                    if (b.contentLength() > MAX_BODY) null else BodyLimit.readUtf8(b.source(), MAX_BODY)
                }
                CallResult.Ok(handle(response, body))
            }
        } catch (e: IOException) {
            CallResult.Failed(describe(e))
        } catch (e: RuntimeException) {
            // e.g. an unexpected certificate parsing failure inside the TLS stack.
            CallResult.Failed(CallError.Message("The connection failed: ${e.javaClass.simpleName}"))
        }
    }

    private fun describe(e: IOException): CallError {
        e.findUntrustedCertificate()?.let { return CallError.Untrusted(it) }
        val text = when (e) {
            is UnknownHostException -> "Can't find ${server.displayName}. Check the address and your network."
            is SocketTimeoutException -> "${server.displayName} didn't answer in time. Check the address and your network."
            is ConnectException -> "Couldn't connect to ${server.displayName}. Check the address, port and your network."
            is SSLPeerUnverifiedException ->
                "The server's certificate doesn't match ${server.host}. Use the address the certificate was issued for."
            is SSLHandshakeException -> {
                val expired = generateSequence<Throwable>(e) { it.cause }
                    .any { it is java.security.cert.CertificateExpiredException }
                if (expired) {
                    "The server's certificate has expired. Renew it on the server, then try again."
                } else {
                    "A secure connection to ${server.displayName} couldn't be set up."
                }
            }
            else -> "The connection to ${server.displayName} failed. Check the address and your network."
        }
        return CallError.Message(text)
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private const val MAX_BODY = 256L * 1024

        fun systemTrustManager(): X509TrustManager {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            factory.init(null as KeyStore?)
            return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
        }
    }
}
