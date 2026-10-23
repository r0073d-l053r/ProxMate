package host.proxmate.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * A message for the server screen, handed over inside the process. The server
 * screen is the exported launcher activity, so it takes no message text from
 * intent extras that any other app could set.
 */
object ServerScreenMessage {
    @Volatile
    private var pending: String? = null

    fun set(message: String?) {
        pending = message
    }

    /** The pending message, once. */
    fun take(): String? {
        val message = pending
        pending = null
        return message
    }
}

/**
 * Work that must finish even when the screen that started it is closed (the
 * server-side sign-out), so it isn't tied to an activity's lifecycle.
 */
object AppScope {
    val io: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
}
