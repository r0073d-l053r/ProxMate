# Reset ProxMate on the lab box and set it up off camera through its API, the way a video's starting world needs:
# the admin (Alex), the Proxmox connection (token read from its 0600 file, never printed), defaults, the
# encryption-key backup confirmed, and optionally the friend Mike registered through an invite with part one's quota.
# usage: setup_world.py [--no-reset] [--mike] [--storage local] [--bridge vmbr0]
# env: PMV_ADMIN_PASSWORD (required), PMV_FRIEND_PASSWORD (with --mike), PMV_ADMIN_EMAIL (default alex@example.com),
#      PMV_PVE_URL (default https://192.168.1.10:8006), PMV_PVE_TOKEN_FILE (default $PMV_WORK/pve1-token.json: the
#      JSON `pveum user token add ... --output-format json` printed), PROXMATE_API, PROXMATE_URL
import argparse, json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pmapi import PM, env, ADMIN_EMAIL

ap = argparse.ArgumentParser()
ap.add_argument("--no-reset", action="store_true"); ap.add_argument("--mike", action="store_true")
ap.add_argument("--storage", default="local"); ap.add_argument("--bridge", default="vmbr0")
a = ap.parse_args()
WORK = os.environ.get("PMV_WORK") or os.path.expanduser("~/pmv/work")
PVE = os.environ.get("PMV_PVE_URL") or "https://192.168.1.10:8006"
tok = json.load(open(os.environ.get("PMV_PVE_TOKEN_FILE") or f"{WORK}/pve1-token.json"))
admin_pw = env("PMV_ADMIN_PASSWORD")

if not a.no_reset:  # a clean database: compose down -v drops ProxMate's volume
    subprocess.run(["runuser", "-u", "alex", "--", "ssh", "-o", "BatchMode=yes", "alex@proxmate",
                    "cd ~/proxmate && docker compose down -v >/dev/null 2>&1; docker compose up -d >/dev/null 2>&1"], check=True)
pm = PM()
for _ in range(90):  # the backend answers once its migrations have run
    try:
        st = pm.call("GET", "/setup/status"); break
    except Exception: time.sleep(2)
else: sys.exit("ProxMate did not come up")
print("setup status:", {k: st.get(k) for k in ("setupComplete", "hasAdmin", "proxmoxConfigured") if k in st})

pm.call("POST", "/setup/admin", {"email": ADMIN_EMAIL, "password": admin_pw, "displayName": "Alex"})
pm.call("POST", "/setup/proxmox", {"host": PVE, "tokenId": tok["full-tokenid"], "tokenSecret": tok["value"], "verifySsl": False})
t = pm.call("POST", "/setup/proxmox/test")
print("proxmox test:", {k: t.get(k) for k in ("success", "connected", "version", "warning") if k in t})
pm.call("POST", "/setup/defaults", {"storage": a.storage, "bridge": a.bridge, "isoStorage": "local"})
pm.call("POST", "/setup/complete")
pm.call("POST", "/admin/encryption-key-backup/confirm")
print("setup complete; encryption-key backup confirmed")

if a.mike:  # part one's friend, a plain account (no two-step sign-in)
    inv = pm.call("POST", "/invites", {"maxCpu": 4, "maxRam": 8, "maxStorage": 80, "label": "Mike"})
    PM().call("POST", "/auth/register", {"email": "mike@example.com", "password": env("PMV_FRIEND_PASSWORD"),
                                         "displayName": "Mike", "inviteToken": inv["token"]})
    print("Mike registered (4 vCPU, 8 GB RAM, 80 GB disk)")
