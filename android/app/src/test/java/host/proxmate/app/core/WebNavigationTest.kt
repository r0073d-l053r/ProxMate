package host.proxmate.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebNavigationTest {
    private val https = ServerAddress("https", "pm.example.com", -1)
    private val http = ServerAddress("http", "192.168.1.20", 3000)

    @Test
    fun keepsTheServerInTheApp() {
        assertEquals(NavigationTarget.IN_APP, WebNavigation.decide("https://pm.example.com/vms/1/console", https, false))
        assertEquals(NavigationTarget.IN_APP, WebNavigation.decide("about:blank", https, false))
    }

    @Test
    fun sendsOtherSitesOutside() {
        assertEquals(NavigationTarget.EXTERNAL, WebNavigation.decide("https://github.com/x", https, false))
        assertEquals(NavigationTarget.EXTERNAL, WebNavigation.decide("http://pm.example.com/", https, false))
        assertEquals(NavigationTarget.EXTERNAL, WebNavigation.decide("mailto:admin@example.com", https, false))
    }

    @Test
    fun allowsTheIdentityProviderDuringWebSignIn() {
        assertEquals(NavigationTarget.IN_APP, WebNavigation.decide("https://auth.example.com/authorize?x=1", https, true))
        assertEquals(NavigationTarget.EXTERNAL, WebNavigation.decide("http://auth.example.com/", https, true))
    }

    @Test
    fun blocksDangerousSchemes() {
        for (url in listOf("javascript:alert(1)", "file:///sdcard/x", "content://x/y", "data:text/html,hi", "intent://x#Intent;end", "", "::")) {
            assertEquals(url, NavigationTarget.BLOCKED, WebNavigation.decide(url, https, true))
        }
    }

    @Test
    fun recognisesTheLoginPage() {
        assertTrue(WebNavigation.isLoginPage("https://pm.example.com/login", https))
        assertTrue(WebNavigation.isLoginPage("https://pm.example.com/login?sso_error=x", https))
        assertTrue(WebNavigation.isLoginPage("https://pm.example.com/login/", https))
        assertFalse(WebNavigation.isLoginPage("https://pm.example.com/loginx", https))
        assertFalse(WebNavigation.isLoginPage("https://pm.example.com/", https))
        assertFalse(WebNavigation.isLoginPage("https://other.example.com/login", https))
    }

    @Test
    fun recognisesSignInPages() {
        assertTrue(WebNavigation.isAuthPage("https://pm.example.com/setup-2fa", https))
        assertTrue(WebNavigation.isAuthPage("https://pm.example.com/setup/proxmox", https))
        assertTrue(WebNavigation.isAuthPage("https://pm.example.com/api/auth/sso/callback?code=1", https))
        assertTrue(WebNavigation.isAuthPage("https://pm.example.com/register/abc", https))
        assertFalse(WebNavigation.isAuthPage("https://pm.example.com/", https))
        assertFalse(WebNavigation.isAuthPage("https://pm.example.com/security", https))
        assertFalse(WebNavigation.isAuthPage("https://pm.example.com/vms", https))
    }

    @Test
    fun routesInAppPages() {
        assertEquals(
            NavigationDecision.LOAD,
            WebNavigation.route("https://pm.example.com/vms", https, webSignIn = false, isMainFrame = true, hasGesture = false),
        )
        assertEquals(
            NavigationDecision.LOAD,
            WebNavigation.route("http://192.168.1.20:3000/vms", http, webSignIn = false, isMainFrame = true, hasGesture = false),
        )
    }

    @Test
    fun opensOutsideLinksOnlyForATopLevelGesture() {
        val link = "https://github.com/r0073d-l053r/ProxMate"
        assertEquals(NavigationDecision.OPEN_EXTERNAL, WebNavigation.route(link, https, false, isMainFrame = true, hasGesture = true))
        assertEquals(NavigationDecision.BLOCK, WebNavigation.route(link, https, false, isMainFrame = true, hasGesture = false))
        assertEquals(NavigationDecision.BLOCK, WebNavigation.route(link, https, false, isMainFrame = false, hasGesture = true))
    }

    @Test
    fun anOutsideHttpLinkGoesToTheBrowserNotTheCleartextError() {
        val link = "http://example.org/docs"
        assertEquals(NavigationDecision.OPEN_EXTERNAL, WebNavigation.route(link, https, false, isMainFrame = true, hasGesture = true))
        assertEquals(NavigationDecision.BLOCK, WebNavigation.route(link, https, false, isMainFrame = true, hasGesture = false))
        assertEquals(NavigationDecision.OPEN_EXTERNAL, WebNavigation.route(link, https, true, isMainFrame = true, hasGesture = true))
    }

    @Test
    fun routesBlockedSchemes() {
        assertEquals(NavigationDecision.BLOCK, WebNavigation.route("javascript:alert(1)", https, false, true, true))
        assertEquals(NavigationDecision.BLOCK, WebNavigation.route("intent://x#Intent;end", https, false, true, true))
    }

    @Test
    fun cleartextOnlyToAnHttpServerItself() {
        assertTrue(WebNavigation.cleartextAllowed("https://cdn.example.com/x.js", https))
        assertFalse(WebNavigation.cleartextAllowed("http://pm.example.com/", https))
        assertFalse(WebNavigation.cleartextAllowed("http://tracker.example.com/x", https))
        assertTrue(WebNavigation.cleartextAllowed("http://192.168.1.20:3000/api/health", http))
        assertFalse(WebNavigation.cleartextAllowed("http://192.168.1.20/", http))
        assertFalse(WebNavigation.cleartextAllowed("http://192.168.1.21:3000/", http))
        assertTrue(WebNavigation.cleartextAllowed("data:image/png;base64,AA", https))
    }
}
