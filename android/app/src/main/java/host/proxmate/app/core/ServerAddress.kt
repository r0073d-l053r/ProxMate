package host.proxmate.app.core

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/**
 * The ProxMate server the app talks to, reduced to its origin
 * (scheme, host and port). ProxMate serves the web UI at the root of its origin
 * and the API under `/api` on the same origin, so any page address the user
 * pastes (`https://pm.example.com/vms/12`) resolves to the same server.
 */
data class ServerAddress(
    val scheme: String,
    val host: String,
    /** Explicit port, or -1 for the scheme's default port. */
    val port: Int,
) {
    val isCleartext: Boolean get() = scheme == "http"

    val effectivePort: Int get() = if (port != -1) port else defaultPort(scheme)

    /** `https://host[:port]`, with the default port left out. */
    val origin: String get() = if (port == -1) "$scheme://$host" else "$scheme://$host:$port"

    /** `host:port`, the key a trusted certificate is stored under. */
    val pinKey: String get() = "$host:$effectivePort"

    /** Host shown to the user (with a non-default port). */
    val displayName: String get() = if (port == -1) host else "$host:$port"

    /** Absolute URL for a path on this server; [path] must start with `/`. */
    fun url(path: String): String {
        require(path.startsWith("/")) { "path must start with /" }
        return origin + path
    }

    /** Whether [url] is on this exact origin (scheme, host and port). */
    fun isSameOrigin(url: String?): Boolean {
        val other = parseOrigin(url) ?: return false
        return other == this
    }

    companion object {
        fun defaultPort(scheme: String): Int = if (scheme == "http") 80 else 443

        /** Parse an absolute http(s) URL to its origin, or null if it isn't one. */
        fun parseOrigin(url: String?): ServerAddress? {
            if (url.isNullOrBlank()) return null
            val uri = try {
                URI(url.trim())
            } catch (_: URISyntaxException) {
                return null
            }
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return null
            val port = if (uri.port == defaultPort(scheme)) -1 else uri.port
            return ServerAddress(scheme, host, port)
        }

        /** Rebuild a saved origin string (as written by [origin]). */
        fun fromOrigin(origin: String?): ServerAddress? = parseOrigin(origin)
    }
}

/** Outcome of turning what the user typed into a server address. */
sealed class ServerInput {
    data class Valid(val address: ServerAddress) : ServerInput()
    data class Invalid(val message: String) : ServerInput()
}

object ServerUrls {
    /**
     * Normalise a typed server address: trims it, assumes `https://` when no
     * scheme is given, accepts only http and https, rejects embedded credentials,
     * and drops any path, query, fragment and trailing slashes so the result is
     * the bare origin.
     */
    fun normalize(input: String): ServerInput {
        val text = input.trim()
        if (text.isEmpty()) return ServerInput.Invalid("Enter the address you use to open ProxMate in a browser.")
        if (text.any { it.isWhitespace() }) return ServerInput.Invalid("The address can't contain spaces.")

        val withScheme = if (Regex("^[A-Za-z][A-Za-z0-9+.-]*://").containsMatchIn(text)) text else "https://$text"
        val uri = try {
            URI(withScheme)
        } catch (_: URISyntaxException) {
            return ServerInput.Invalid("That doesn't look like a web address.")
        }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") {
            return ServerInput.Invalid("The address must start with https:// (or http://).")
        }
        if (uri.rawUserInfo != null) {
            return ServerInput.Invalid("Leave the user name and password out of the address.")
        }
        val host = uri.host?.lowercase(Locale.ROOT)
        if (host.isNullOrEmpty()) return ServerInput.Invalid("That doesn't look like a web address.")
        if (host.endsWith(".")) {
            return ServerInput.Invalid("That doesn't look like a web address.")
        }
        val rawPort = uri.port
        if (rawPort == 0 || rawPort > 65535) return ServerInput.Invalid("The port number isn't valid.")
        val port = if (rawPort == ServerAddress.defaultPort(scheme)) -1 else rawPort
        return ServerInput.Valid(ServerAddress(scheme, host, port))
    }
}
