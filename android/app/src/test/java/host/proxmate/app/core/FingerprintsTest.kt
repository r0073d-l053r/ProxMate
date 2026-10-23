package host.proxmate.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException

class FingerprintsTest {
    @Test
    fun formatsSha256AsColonSeparatedHex() {
        // SHA-256("abc")
        assertEquals(
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD",
            Fingerprints.sha256("abc".toByteArray()),
        )
    }

    @Test
    fun normalizesForComparison() {
        assertEquals("BA7816BF", Fingerprints.normalize("ba:78:16:bf"))
        assertEquals("BA7816BF", Fingerprints.normalize("BA 78 16 BF"))
    }

    @Test
    fun findsTheUntrustedCertificateInACauseChain() {
        val untrusted = UntrustedCertificateException(emptyList(), CertificateException("no path"))
        val wrapped = IOException("outer", SSLHandshakeException("handshake").apply { initCause(untrusted) })
        assertSame(untrusted, wrapped.findUntrustedCertificate())
        assertNull(IOException("plain").findUntrustedCertificate())
    }
}
