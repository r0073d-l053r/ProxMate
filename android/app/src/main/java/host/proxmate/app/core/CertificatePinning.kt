package host.proxmate.app.core

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager

/**
 * Trust-on-first-use for servers with a certificate the device doesn't trust
 * (typically self-signed in a homelab).
 *
 * The system trust store is always consulted first. Only when it rejects the
 * chain is the server's own (leaf) certificate compared with the one the user
 * explicitly accepted for that host and port; it must match byte for byte (by
 * SHA-256) and be within its validity period. Anything else is rejected with
 * [UntrustedCertificateException], which carries the presented chain so the app
 * can show its fingerprint and ask the user.
 */
object Fingerprints {
    /** SHA-256 of [der], as upper-case hex pairs joined with colons. */
    fun sha256(der: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(der)
        return digest.joinToString(":") { "%02X".format(it.toInt() and 0xff) }
    }

    fun sha256(cert: X509Certificate): String = sha256(cert.encoded)

    /** Normalise a stored or displayed fingerprint for comparison. */
    fun normalize(fingerprint: String): String =
        fingerprint.filter { it.isLetterOrDigit() }.uppercase()

    fun matches(cert: X509Certificate, pinned: String?): Boolean {
        if (pinned.isNullOrBlank()) return false
        val actual = normalize(sha256(cert))
        val expected = normalize(pinned)
        return expected.length == 64 && MessageDigest.isEqual(actual.toByteArray(), expected.toByteArray())
    }
}

/** The server presented a certificate that is neither system-trusted nor the pinned one. */
class UntrustedCertificateException(
    val chain: List<X509Certificate>,
    cause: Throwable?,
) : CertificateException("Server certificate is not trusted", cause) {
    val leaf: X509Certificate? get() = chain.firstOrNull()
}

class PinningTrustManager(
    private val system: X509TrustManager,
    private val pinnedSha256: String?,
) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        system.checkClientTrusted(chain, authType)
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        try {
            system.checkServerTrusted(chain, authType)
        } catch (e: CertificateException) {
            val leaf = chain?.firstOrNull()
            if (leaf != null && Fingerprints.matches(leaf, pinnedSha256)) {
                // Exactly the certificate the user accepted; still refuse it once expired.
                leaf.checkValidity()
                return
            }
            throw UntrustedCertificateException(chain?.toList().orEmpty(), e)
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
}

/**
 * Hostname check: the normal verification, or, for a server whose exact
 * certificate the user pinned, the pin itself (a self-signed certificate often
 * names a different host, e.g. a Proxmox node name, than the address in use).
 */
class PinAwareHostnameVerifier(
    private val standard: HostnameVerifier,
    private val pinnedSha256: String?,
) : HostnameVerifier {
    override fun verify(hostname: String?, session: SSLSession?): Boolean {
        if (standard.verify(hostname, session)) return true
        if (pinnedSha256.isNullOrBlank() || session == null) return false
        val leaf = try {
            session.peerCertificates.firstOrNull() as? X509Certificate
        } catch (_: Exception) {
            null
        } ?: return false
        return Fingerprints.matches(leaf, pinnedSha256)
    }
}

/** Find an [UntrustedCertificateException] anywhere in a cause chain. */
fun Throwable.findUntrustedCertificate(): UntrustedCertificateException? {
    var t: Throwable? = this
    var depth = 0
    while (t != null && depth < 10) {
        if (t is UntrustedCertificateException) return t
        t.suppressed.forEach { s -> if (s is UntrustedCertificateException) return s }
        t = t.cause
        depth++
    }
    return null
}
