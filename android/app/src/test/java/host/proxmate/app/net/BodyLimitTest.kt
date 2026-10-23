package host.proxmate.app.net

import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BodyLimitTest {
    @Test
    fun readsBodiesWithinTheLimit() {
        assertEquals("""{"status":"ok"}""", BodyLimit.readUtf8(Buffer().writeUtf8("""{"status":"ok"}"""), 1024))
        assertEquals("", BodyLimit.readUtf8(Buffer(), 1024))
        assertEquals("abcd", BodyLimit.readUtf8(Buffer().writeUtf8("abcd"), 4))
    }

    @Test
    fun refusesBodiesOverTheLimit() {
        assertNull(BodyLimit.readUtf8(Buffer().writeUtf8("abcde"), 4))
    }

    @Test
    fun neverBuffersMoreThanTheLimitOfAnEndlessBody() {
        // A chunked body with no declared length that never ends.
        var produced = 0L
        val endless = object : Source {
            override fun read(sink: Buffer, byteCount: Long): Long {
                val n = minOf(byteCount, 8192L)
                sink.write(ByteArray(n.toInt()) { 'x'.code.toByte() })
                produced += n
                return n
            }

            override fun timeout(): Timeout = Timeout.NONE
            override fun close() {}
        }
        val source: BufferedSource = endless.buffer()
        assertNull(BodyLimit.readUtf8(source, 256L * 1024))
        assertTrue("read $produced bytes", produced <= 256L * 1024 + 8192)
    }
}
