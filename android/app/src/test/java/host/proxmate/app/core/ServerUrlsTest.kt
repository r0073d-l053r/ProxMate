package host.proxmate.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ServerUrlsTest {
    private fun valid(input: String): ServerAddress = when (val r = ServerUrls.normalize(input)) {
        is ServerInput.Valid -> r.address
        is ServerInput.Invalid -> {
            fail("expected $input to be valid, got: ${r.message}")
            throw AssertionError()
        }
    }

    private fun invalid(input: String) {
        assertTrue("expected $input to be rejected", ServerUrls.normalize(input) is ServerInput.Invalid)
    }

    @Test
    fun addsHttpsWhenNoSchemeIsGiven() {
        val s = valid("proxmate.example.com")
        assertEquals("https://proxmate.example.com", s.origin)
        assertFalse(s.isCleartext)
    }

    @Test
    fun stripsTrailingSlashesPathQueryAndFragment() {
        assertEquals("https://pm.example.com", valid("https://pm.example.com/").origin)
        assertEquals("https://pm.example.com", valid("https://pm.example.com///").origin)
        assertEquals("https://pm.example.com", valid("https://pm.example.com/login?next=/vms#x").origin)
        assertEquals("https://pm.example.com", valid("  https://pm.example.com/vms/12  ").origin)
    }

    @Test
    fun lowercasesSchemeAndHost() {
        assertEquals("https://pm.example.com", valid("HTTPS://PM.Example.COM").origin)
    }

    @Test
    fun dropsDefaultPortsAndKeepsOthers() {
        assertEquals("https://pm.example.com", valid("https://pm.example.com:443").origin)
        assertEquals("http://pm.lan", valid("http://pm.lan:80/").origin)
        val custom = valid("https://10.0.0.5:8443/")
        assertEquals("https://10.0.0.5:8443", custom.origin)
        assertEquals("10.0.0.5:8443", custom.pinKey)
        assertEquals("pm.example.com:443", valid("pm.example.com").pinKey)
    }

    @Test
    fun acceptsHttpAsCleartext() {
        val s = valid("http://192.168.1.20:3000")
        assertTrue(s.isCleartext)
        assertEquals("http://192.168.1.20:3000", s.origin)
    }

    @Test
    fun acceptsIpv6Literals() {
        val s = valid("https://[fd00::1]:8443/")
        assertEquals("https://[fd00::1]:8443", s.origin)
    }

    @Test
    fun rejectsBadInput() {
        invalid("")
        invalid("   ")
        invalid("ftp://pm.example.com")
        invalid("javascript:alert(1)")
        invalid("https://user:pass@pm.example.com")
        invalid("https://pm example.com")
        invalid("https://")
        invalid("https://pm.example.com:99999")
    }

    @Test
    fun buildsApiUrls() {
        val s = valid("https://pm.example.com/")
        assertEquals("https://pm.example.com/api/health", s.url("/api/health"))
    }

    @Test
    fun comparesOrigins() {
        val s = valid("https://pm.example.com")
        assertTrue(s.isSameOrigin("https://pm.example.com/vms/1"))
        assertTrue(s.isSameOrigin("https://PM.example.com:443/"))
        assertFalse(s.isSameOrigin("http://pm.example.com/"))
        assertFalse(s.isSameOrigin("https://pm.example.com:8443/"))
        assertFalse(s.isSameOrigin("https://evil.example.com/"))
        assertFalse(s.isSameOrigin("https://pm.example.com.evil.com/"))
        assertFalse(s.isSameOrigin(null))
        assertFalse(s.isSameOrigin("not a url"))
    }

    @Test
    fun roundTripsThroughTheSavedOrigin() {
        val s = valid("https://pm.example.com:8443")
        assertEquals(s, ServerAddress.fromOrigin(s.origin))
    }
}
