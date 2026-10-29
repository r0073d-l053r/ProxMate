# Small ProxMate API client for off-camera lab prep (cookie session + CSRF header, like the browser).
# usage: from pmapi import PM, admin; a = admin()  (logged in as the admin)  or  a = PM(); a.login(email, password)
#        a.call("GET", "/templates")
# env: PROXMATE_API (default http://192.168.1.50:4000/api), PROXMATE_URL (sent as Origin, default http://192.168.1.50:3000),
#      PMV_ADMIN_EMAIL (default alex@example.com), PMV_ADMIN_PASSWORD (required by admin())
import http.cookiejar, json, os, sys, urllib.request, urllib.error, urllib.parse

API = (os.environ.get("PROXMATE_API") or "http://192.168.1.50:4000/api").rstrip("/")
ORIGIN = (os.environ.get("PROXMATE_URL") or "http://192.168.1.50:3000").rstrip("/")
ADMIN_EMAIL = os.environ.get("PMV_ADMIN_EMAIL") or "alex@example.com"


def env(name):
    """A required variable (a password, say), or exit naming it."""
    v = os.environ.get(name)
    if not v: sys.exit(f"set {name}")
    return v


class PM:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), urllib.request.ProxyHandler({}))

    def csrf(self):
        return next((c.value for c in self.jar if c.name == "proxmate_csrf"), None)

    def call(self, method, path, body=None, ok=(200, 201, 202, 204)):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header("Origin", ORIGIN)
        if data is not None: req.add_header("Content-Type", "application/json")
        if self.csrf() and method != "GET": req.add_header("X-CSRF-Token", urllib.parse.unquote(self.csrf()))
        try:
            with self.op.open(req, timeout=900) as r:
                raw = r.read(); code = r.status
        except urllib.error.HTTPError as e:
            raw = e.read(); code = e.code
        try: out = json.loads(raw) if raw else None
        except ValueError: out = raw.decode(errors="replace")[:500]
        if code not in ok: raise RuntimeError(f"{method} {path} -> {code}: {out}")
        return out

    def login(self, email, password):
        return self.call("POST", "/auth/login", {"email": email, "password": password})


def admin():
    """A session logged in as the lab admin (PMV_ADMIN_EMAIL / PMV_ADMIN_PASSWORD)."""
    a = PM(); a.login(ADMIN_EMAIL, env("PMV_ADMIN_PASSWORD")); return a
