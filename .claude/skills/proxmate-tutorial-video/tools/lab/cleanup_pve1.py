# Lab clean-up after a video on the real pve1, part 1, through ProxMate (so its records and Proxmox stay in step): every
# MateState, every VM and container, then every Template Store template (which also removes it from Proxmox).
# Part 2 is by hand on pve1: the rest of the plan's clean-up list (examples/plan-part2.md), e.g. the API token.
# usage: python3 cleanup_pve1.py [--dry-run]   (env as pmapi.py)
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pmapi import admin

dry = "--dry-run" in sys.argv
pm = admin()
items = lambda r: r.get("items", r) if isinstance(r, dict) else r

for v in items(pm.call("GET", "/vms")):
    for ms in items(pm.call("GET", f"/vms/{v['id']}/matestates")):
        print("MateState", v["name"], ms.get("id"), ms.get("status"))
        if not dry: pm.call("DELETE", f"/vms/{v['id']}/matestates/{ms['id']}")
    print("VM", v["name"], v.get("status"))
    if not dry:
        pm.call("DELETE", f"/vms/{v['id']}")
if not dry:  # deletes run in the background on Proxmox; wait until ProxMate lists no machines
    for _ in range(120):
        if not items(pm.call("GET", "/vms")): break
        time.sleep(5)
    print("machines left:", [v["name"] for v in items(pm.call("GET", "/vms"))])

for t in items(pm.call("GET", "/templates")):
    print("template", t.get("name"), t.get("id"))
    if not dry:
        for attempt in range(12):  # a linked clone may still be on its way out
            try: pm.call("DELETE", f"/templates/{t['id']}"); break
            except RuntimeError as e:
                if "409" not in str(e) or attempt == 11: raise
                time.sleep(10)
if not dry: print("templates left:", [t.get("name") for t in items(pm.call("GET", "/templates"))])
