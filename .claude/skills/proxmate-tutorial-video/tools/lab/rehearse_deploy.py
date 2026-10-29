# Rehearsal: deploy a cloud-init VM from a Template Store template through ProxMate's API and time each phase
# (clone, cloud-init lock, IP via the guest agent). Off camera.
# usage: python3 rehearse_deploy.py [vm name, default rehearse-01] [template name, default "Ubuntu 24.04"]
#   env as pmapi.py, plus PMV_VM_PASSWORD (the VM user's password) and PMV_DEPLOY_PUBKEY (default /home/alex/.ssh/id_ed25519.pub)
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pmapi import admin, env

name = sys.argv[1] if len(sys.argv) > 1 else "rehearse-01"
tname = sys.argv[2] if len(sys.argv) > 2 else "Ubuntu 24.04"
a = admin()
tpl = next(t for t in a.call("GET", "/templates") if t["name"] == tname)
key = open(os.environ.get("PMV_DEPLOY_PUBKEY") or "/home/alex/.ssh/id_ed25519.pub").read().strip()
t0 = time.time()
def say(*m): print(f"{time.time()-t0:7.1f}s", *m, flush=True)
say("deploy", tpl["name"], tpl["id"])
r = a.call("POST", "/templates/deploy", {"templateId": tpl["id"], "name": name, "cpu": 1, "ram": 2048, "storage": 20,
                                          "sshKey": key, "username": "ubuntu" if "Ubuntu" in tname else "debian",
                                          "password": env("PMV_VM_PASSWORD"), "features": ["docker", "tailscale"]})
vm = r["vm"]; say("created", vm["id"], vm.get("proxmoxVmId"), vm.get("status"))
last = None
while time.time() - t0 < 1800:
    v = a.call("GET", f"/vms/{vm['id']}")
    d = v.get("vm", v)
    ip = d.get("ipAddress")
    state = (d.get("status"), d.get("deployState") == "deploying", ip)
    if state != last: say("state", json.dumps({k: d.get(k) for k in d if any(s in k.lower() for s in ("status", "lock", "ip", "setup", "pending", "hold", "deploy"))})); last = state
    if state[0] == "running" and not state[1] and state[2]: break
    time.sleep(5)
say("done")
