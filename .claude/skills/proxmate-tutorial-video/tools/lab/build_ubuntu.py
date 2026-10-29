# Off camera: build the "Ubuntu 24.04" Template Store template (amd64 cloud image) through ProxMate's API and time it.
# usage: python3 build_ubuntu.py   (env as pmapi.py: PROXMATE_API, PMV_ADMIN_EMAIL, PMV_ADMIN_PASSWORD)
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pmapi import admin
a = admin()
imgs = a.call("GET", "/templates/cloud-images")
img = next(i for i in imgs if i.get("label", "").startswith("Ubuntu 24.04") and "ARM" not in i.get("label", ""))
print("image:", {k: img.get(k) for k in ("label", "url", "os", "arch")}, flush=True)
t0 = time.time()
t = a.call("POST", "/templates/cloud-image", {"name": "Ubuntu 24.04", "imageUrl": img["url"], "os": img.get("os"), "arch": img.get("arch", "amd64")})
print(f"built in {time.time()-t0:.0f}s:", {k: t.get(k) for k in ("id", "name", "proxmoxVmId", "node", "diskGb", "cloudInit", "guestAgent")}, flush=True)
