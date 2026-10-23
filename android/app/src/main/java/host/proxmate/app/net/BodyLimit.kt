package host.proxmate.app.net

import okio.BufferedSource

object BodyLimit {
    /**
     * Read a response body as UTF-8 only if it is at most [maxBytes] long,
     * buffering no more than [maxBytes] + 1 bytes whatever the server sends
     * (a chunked body has no declared length). Returns null for a larger body.
     */
    fun readUtf8(source: BufferedSource, maxBytes: Long): String? {
        require(maxBytes >= 0)
        // request() buffers up to the given count and reports whether it got them all.
        if (source.request(maxBytes + 1)) return null
        return source.buffer.readUtf8()
    }
}
