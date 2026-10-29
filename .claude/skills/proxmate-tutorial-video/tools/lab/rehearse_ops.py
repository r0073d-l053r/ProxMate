# Rehearsal of the VM-page operations on the real pve1 (off camera): snapshot + rollback, resize with its
# automatic snapshot, a MateState backup, power actions, duplicate; each timed.
# usage: python3 rehearse_ops.py <ProxMate vm id> <step>...   steps: snap rollback snaps resize backup states restart
#        stop start vm dup=<new name>      (env as pmapi.py)
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pmapi import admin

vid, steps = sys.argv[1], sys.argv[2:]
a = admin()
def timed(label, fn):
    t0 = time.time()
    try: r = fn(); print(f"{label}: ok in {time.time()-t0:.1f}s", json.dumps(r)[:300], flush=True); return r
    except Exception as e: print(f"{label}: FAILED in {time.time()-t0:.1f}s {e}", flush=True)

for s in steps:
    if s == "snap": timed("snapshot", lambda: a.call("POST", f"/vms/{vid}/snapshots", {"name": "before-oops", "description": "rehearsal"}))
    elif s == "rollback": timed("rollback", lambda: a.call("POST", f"/vms/{vid}/snapshots/before-oops/rollback", {}))
    elif s == "snaps": timed("list", lambda: a.call("GET", f"/vms/{vid}/snapshots"))
    elif s == "resize": timed("resize 2c/4G/24G", lambda: a.call("PATCH", f"/vms/{vid}", {"cpu": 2, "ram": 4096, "storage": 24}))
    elif s == "backup": timed("matestate", lambda: a.call("POST", f"/vms/{vid}/matestates", {}))
    elif s == "states": timed("matestates", lambda: a.call("GET", f"/vms/{vid}/matestates"))
    elif s == "restart": timed("restart", lambda: a.call("POST", f"/vms/{vid}/restart", {}))
    elif s == "stop": timed("stop", lambda: a.call("POST", f"/vms/{vid}/stop", {}))
    elif s == "start": timed("start", lambda: a.call("POST", f"/vms/{vid}/start", {}))
    elif s.startswith("dup="): timed("duplicate", lambda: a.call("POST", f"/vms/{vid}/duplicate", {"name": s[4:]}))
    elif s == "vm": timed("vm", lambda: {k: v for k, v in a.call("GET", f"/vms/{vid}").items() if k in ("status", "cpu", "ram", "storage", "ipAddress", "deployState", "opKind")})
