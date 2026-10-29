#!/usr/bin/env python3
"""pve-lab: a single-node Proxmox VE API ("pve1") for the ProxMate tutorial lab.

There is no Proxmox software here, and no KVM. This program speaks the part of /api2/json that ProxMate
uses and does the work for real on this machine:
  * storage "local" is the directory /var/lib/vz (iso, import, snippets, images, dump, ...)
  * download-url really downloads (e.g. Ubuntu's cloud image from cloud-images.ubuntu.com)
  * VM disks are raw image files: import-from = qemu-img convert, clones are full copies
  * cloud-init NoCloud data is generated the way Proxmox generates it (user-data from ciuser/sshkeys,
    network-config from ipconfig0, cicustom user=/vendor= snippets read from the snippets directory)
  * a VM's own disk image is booted as an LXC system container on the vmbr0 bridge (DHCP from the lab
    router): its own systemd, cloud-init, apt, qemu-guest-agent and getty. Emulated (TCG) VMs were ~15x
    too slow for ProxMate's real timeouts, so this is the stand-in for KVM. lxcfs makes /proc show the
    VM's configured memory and vCPUs.
  * agent/* calls reach the guest's own qemu-ga on /dev/virtio-ports/org.qemu.guest_agent.0; the text
    console (termproxy) is a real agetty login in the guest; status/cpu/memory/rrd come from cgroups
Tokens live in /etc/pve-lab/tokens.json ($PMV_PVE_TOKENS), {"root@pam!proxmate": {"secret": "<uuid>", "privsep": 0}, ...};
a privilege-separated token gets no permissions, like Proxmox. The TLS certificate is made on first start.

usage: install -m 755 pve-lab.py /usr/local/sbin/pve-lab; python3 -I /usr/local/sbin/pve-lab   (as root; pve-real.sh off
       and reset-world.sh start it). Needs vmbr0 (net.sh), lxc, lxcfs, qemu-img, sgdisk/sfdisk, e2fsprogs, cloud-guest-utils.
env: PVE_LAB_ADDR (default 192.168.1.10), PVE_LAB_PORT (8006), PVE_LAB_LOG (/var/log/pve-lab.log), PMV_PVE_TOKENS.
"""
import base64, hashlib, json, os, random, re, shutil, socket, ssl, struct, subprocess, sys, threading, time, uuid
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

NODE = "pve1"
ADDR = os.environ.get("PVE_LAB_ADDR", "192.168.1.10")
PORT = int(os.environ.get("PVE_LAB_PORT", "8006"))
VZ = "/var/lib/vz"
STATE = "/var/lib/pve-lab"
RUN = "/run/pve-lab"
ETC = "/etc/pve-lab"
LOGF = os.environ.get("PVE_LAB_LOG", "/var/log/pve-lab.log")
BRIDGE = "vmbr0"
PVE_VERSION = {"version": "9.2.4", "release": "9.2", "repoid": "lab"}
GB = 1024 ** 3
LOCK = threading.RLock()
for d in (STATE, RUN, ETC, f"{STATE}/qemu", f"{VZ}/images", f"{VZ}/import", f"{VZ}/snippets", f"{VZ}/dump", f"{VZ}/template/iso", f"{VZ}/template/cache"):
    os.makedirs(d, exist_ok=True)
_logf = open(LOGF, "a")


def log(*a):
    s = time.strftime("%H:%M:%S") + " " + " ".join(str(x) for x in a)
    print(s, flush=True); _logf.write(s + "\n"); _logf.flush()


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg); self.code = code; self.msg = msg


FULL_PRIVS = ["VM.Audit", "VM.Allocate", "VM.Clone", "VM.Config.CDROM", "VM.Config.CPU", "VM.Config.Cloudinit", "VM.Config.Disk",
              "VM.Config.HWType", "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options", "VM.Console", "VM.Migrate", "VM.PowerMgmt",
              "VM.Snapshot", "VM.Snapshot.Rollback", "VM.Backup", "VM.GuestAgent.Audit", "VM.GuestAgent.Unrestricted",
              "VM.GuestAgent.FileRead", "VM.GuestAgent.FileWrite", "VM.GuestAgent.FileSystemMgmt", "Datastore.Audit", "Datastore.Allocate",
              "Datastore.AllocateSpace", "Datastore.AllocateTemplate", "Sys.Audit", "Sys.Modify", "Sys.AccessNetwork", "Sys.Console",
              "Sys.PowerMgmt", "Sys.Syslog", "Sys.Incoming", "SDN.Audit", "SDN.Use", "SDN.Allocate", "Pool.Audit", "Pool.Allocate",
              "Mapping.Audit", "Mapping.Use", "Mapping.Modify", "Permissions.Modify", "Realm.Allocate", "Realm.AllocateUser", "User.Modify",
              "Group.Allocate"]

# ---------------------------------------------------------------- persistent state
def jload(p, default):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return default


def jsave(p, obj):
    tmp = p + ".tmp"
    with open(tmp, "w") as f: json.dump(obj, f, indent=1, sort_keys=True)
    os.replace(tmp, p)


STORAGE = jload(f"{STATE}/storage.json", {"local": {"type": "dir", "path": VZ, "content": "iso,vztmpl,backup,import,images,rootdir", "shared": 0}})
CLUSTER_FW = jload(f"{STATE}/cluster-fw.json", {"options": {"enable": 0}, "rules": []})
TOKENS = jload(os.environ.get("PMV_PVE_TOKENS") or f"{ETC}/tokens.json", {})
VMS = {}
for fn in sorted(os.listdir(f"{STATE}/qemu")):
    if fn.endswith(".json"):
        v = jload(f"{STATE}/qemu/{fn}", None)
        if v: v.update(proc=None, lock=None, qga_lock=threading.Lock(), samples=deque(maxlen=720), last=None); VMS[int(v["vmid"])] = v


def _rediscover():
    for vmid, v in VMS.items():
        st, pid = lxc_state(vmid)
        v.update(initpid=pid if st == "RUNNING" else None, started=time.time(), loop=None, mnt=None)


def save_storage(): jsave(f"{STATE}/storage.json", STORAGE)
def save_fw(): jsave(f"{STATE}/cluster-fw.json", CLUSTER_FW)


def save_vm(v):
    keep = {k: v[k] for k in ("vmid", "config", "template", "fw_opts", "fw_rules", "snapshots", "created")}
    jsave(f"{STATE}/qemu/{v['vmid']}.json", keep)


def new_vm(vmid, config):
    v = dict(vmid=vmid, config=config, template=0, fw_opts={}, fw_rules=[], snapshots=[], created=int(time.time()), initpid=None, loop=None, mnt=None,
             proc=None, lock=None, qga_lock=threading.Lock(), samples=deque(maxlen=720), last=None)
    VMS[vmid] = v; save_vm(v); return v


# ---------------------------------------------------------------- tasks
TASKS = {}


def make_upid(typ, vmid, user):
    pid = random.randint(0x1000, 0x3FFFFF); pstart = int(open("/proc/self/stat").read().split()[21]) + random.randint(1, 99999)
    return f"UPID:{NODE}:{pid:08X}:{pstart:08X}:{int(time.time()):08X}:{typ}:{vmid}:{user}:", pid, pstart


class Task:
    def __init__(self, typ, vmid, user, fn):
        self.upid, self.pid, self.pstart = make_upid(typ, vmid, user)
        self.type, self.id, self.user = typ, str(vmid), user
        self.starttime = int(time.time()); self.endtime = None
        self.status, self.exitstatus = "running", None
        self.lines = []; self.fn = fn
        TASKS[self.upid] = self
        threading.Thread(target=self._run, daemon=True).start()

    def log(self, line):
        self.lines.append(line)

    def _run(self):
        try:
            self.fn(self); self.exitstatus = "OK"; self.log("TASK OK")
        except Exception as e:
            msg = str(e) or e.__class__.__name__
            self.exitstatus = msg; self.log(f"TASK ERROR: {msg}"); log("TASK ERROR", self.type, self.id, msg)
        self.endtime = int(time.time()); self.status = "stopped"


# ---------------------------------------------------------------- volumes
def vol_path(volid):
    """Map a storage volume id on 'local' to its file."""
    store, rest = volid.split(":", 1)
    if store not in STORAGE: raise ApiError(500, f"storage '{store}' does not exist")
    base = STORAGE[store]["path"]
    rest = rest.split(",")[0]
    for prefix, sub in (("iso/", "template/iso/"), ("vztmpl/", "template/cache/"), ("import/", "import/"), ("snippets/", "snippets/"), ("backup/", "dump/")):
        if rest.startswith(prefix): return os.path.join(base, sub + rest[len(prefix):])
    parts = rest.split("/")
    if len(parts) == 4:  # linked clone: <base-vmid>/base-...qcow2/<vmid>/vm-...qcow2
        return os.path.join(base, "images", parts[2], parts[3])
    return os.path.join(base, "images", rest)


def disk_keys(cfg):
    return [k for k in cfg if re.match(r"^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$", k)]


def is_cdrom(val): return "media=cdrom" in val or val.split(",")[0] in ("none", "cdrom")
def is_cloudinit(val): return "cloudinit" in val.split(",")[0]


def size_str(nbytes):
    mb = int(round(nbytes / 1024 / 1024))
    return f"{mb // 1024}G" if mb % 1024 == 0 else f"{mb}M"


def qemu_img_vsize(path):
    out = subprocess.run(["qemu-img", "info", "--output=json", "-U", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)["virtual-size"]


def parse_size(s):
    m = re.match(r"^(\d+(?:\.\d+)?)([KMGT]?)$", s)
    if not m: raise ApiError(400, f"invalid size '{s}'")
    return int(float(m.group(1)) * {"": GB, "K": 1024, "M": 1024 ** 2, "G": GB, "T": 1024 ** 4}[m.group(2)])


def next_disk_name(vmid, prefix="vm"):
    d = os.path.join(VZ, "images", str(vmid)); os.makedirs(d, exist_ok=True)
    n = 0
    while any(os.path.exists(os.path.join(d, f"{p}-{vmid}-disk-{n}.raw")) for p in ("vm", "base")): n += 1
    return f"{prefix}-{vmid}-disk-{n}.raw"


def allocate_disks(vmid, cfg, task):
    """Turn create/update disk specs (local:N, local:0,import-from=..., local:cloudinit) into real files."""
    for k in disk_keys(cfg):
        val = cfg[k]; head, _, opts = val.partition(",")
        optd = dict(o.split("=", 1) if "=" in o else (o, "") for o in opts.split(",") if o)
        if is_cloudinit(val) and ":" in head and "/" not in head:
            store = head.split(":")[0]
            cfg[k] = f"{store}:{vmid}/vm-{vmid}-cloudinit.raw,media=cdrom"; continue
        if is_cdrom(val) or "/" in head.split(":", 1)[-1]: continue
        m = re.match(r"^([\w-]+):(\d+(?:\.\d+)?)$", head)
        if not m: continue
        store = m.group(1); name = next_disk_name(vmid); dst = os.path.join(VZ, "images", str(vmid), name)
        if "import-from" in optd:
            src = vol_path(optd.pop("import-from"))
            if not os.path.exists(src): raise ApiError(500, f"import-from: volume does not exist: {src}")
            task.log(f"importing disk '{src}' to VM {vmid} ...")
            p = subprocess.Popen(["qemu-img", "convert", "-p", "-O", "raw", src, dst], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            last = -10
            buf = ""
            while True:
                ch = p.stdout.read(1)
                if not ch: break
                buf += ch
                if ch in "\r\n":
                    mm = re.search(r"\((\d+\.\d+)/100%\)", buf); buf = ""
                    if mm and float(mm.group(1)) - last >= 10:
                        last = float(mm.group(1)); task.log(f"transferred {last:.1f}%")
            if p.wait() != 0: raise ApiError(500, "qemu-img convert failed")
            task.log(f"Successfully imported disk as '{k}:{store}:{vmid}/{name}'")
        else:
            gb = float(m.group(2))
            if gb <= 0: gb = 4
            subprocess.run(["truncate", "-s", f"{int(gb)}G", dst], check=True)
            task.log(f"Formatting '{dst}', fmt=raw size={int(gb * GB)}")
        optd["size"] = size_str(qemu_img_vsize(dst))
        cfg[k] = f"{store}:{vmid}/{name}" + "".join(f",{a}={b}" if b != "" else f",{a}" for a, b in optd.items())


# ---------------------------------------------------------------- cloud-init (NoCloud), the way Proxmox writes it
def mac_of(cfg):
    m = re.search(r"(?:virtio|e1000|vmxnet3|rtl8139)=([0-9A-Fa-f:]{17})", cfg.get("net0", ""))
    return m.group(1).lower() if m else None


def snippet_text(spec):
    return open(vol_path(spec)).read()


def build_seed_files(v):
    """The NoCloud data Proxmox would put on the cloud-init drive, as {filename: text}."""
    cfg = v["config"]; vmid = v["vmid"]
    if not next((k for k in disk_keys(cfg) if is_cloudinit(cfg[k])), None): return None
    cic = dict(p.split("=", 1) for p in cfg.get("cicustom", "").split(",") if "=" in p)
    name = cfg.get("name", f"VM{vmid}")
    if "user" in cic:
        user_data = snippet_text(cic["user"])
    else:
        lines = ["#cloud-config", f"hostname: {name}", "manage_etc_hosts: true", f"fqdn: {name}"]
        if cfg.get("ciuser"): lines.append(f"user: {cfg['ciuser']}")
        if cfg.get("cipassword"): lines.append(f"password: {cfg['cipassword']}")
        keys = [k for k in unquote(cfg.get("sshkeys", "")).splitlines() if k.strip()]
        if keys: lines += ["ssh_authorized_keys:"] + [f"  - {k.strip()}" for k in keys]
        lines += ["chpasswd:", "  expire: False", "users:", "  - default"]
        if cfg.get("ciupgrade", "1") not in ("0", "false"): lines.append("package_upgrade: true")
        user_data = "\n".join(lines) + "\n"
    if "network" in cic:
        net = snippet_text(cic["network"])
    else:
        # Same shape as Proxmox's nocloud network-config, except interfaces are matched by name:
        # a container's veth has no permanent MAC for netplan's macaddress match (a VM's virtio NIC does).
        net = ["version: 1", "config:"]
        for i in range(8):
            if f"net{i}" not in cfg: continue
            ipc = cfg.get(f"ipconfig{i}", "")
            net += [f"    - type: physical", f"      name: eth{i}", "      subnets:"]
            if "ip=dhcp" in ipc or not ipc: net.append("      - type: dhcp4")
            else:
                ip = re.search(r"ip=([\d.]+)/(\d+)", ipc); gw = re.search(r"gw=([\d.]+)", ipc)
                if ip: net += ["      - type: static", f"        address: '{ip.group(1)}'", f"        netmask: '{prefix_to_mask(int(ip.group(2)))}'"] + ([f"        gateway: '{gw.group(1)}'"] if gw else [])
        if cfg.get("nameserver"): net += ["    - type: nameserver", "      address:"] + [f"      - '{x}'" for x in cfg["nameserver"].split()]
        net = "\n".join(net) + "\n"
    vendor = snippet_text(cic["vendor"]) if "vendor" in cic else None
    meta = snippet_text(cic["meta"]) if "meta" in cic else f"instance-id: {hashlib.sha1((user_data + net + (vendor or '')).encode()).hexdigest()}\n"
    files = {"user-data": user_data, "meta-data": meta, "network-config": net}
    if vendor: files["vendor-data"] = vendor
    return files


def prefix_to_mask(p):
    m = (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF
    return ".".join(str((m >> s) & 255) for s in (24, 16, 8, 0))


# ---------------------------------------------------------------- guests: the VM's own disk image, booted as an LXC system container
# No KVM exists in this sandbox and emulated (TCG) Ubuntu is ~15x too slow for ProxMate's real timeouts
# (3-min task waits, 6-min template bake, 8-min deploy window). So each VM's raw disk is loop-mounted and
# its own OS (systemd, cloud-init, apt, qemu-guest-agent, getty) is booted with LXC on vmbr0. lxcfs makes
# /proc report the VM's configured memory and vCPUs.
LXC = "/var/lib/lxc"
MNT = os.path.join(STATE, "mnt")
os.makedirs(MNT, exist_ok=True)


def ct(vmid): return f"vm{vmid}"
def tap(vmid, i=0): return f"tap{vmid}i{i}"
def agent_sock(v): return f"/proc/{v.get('initpid')}/root/dev/virtio-ports/org.qemu.guest_agent.0"


def lxc_state(vmid):
    r = subprocess.run(["lxc-info", "-n", ct(vmid), "-s", "-p"], capture_output=True, text=True)
    d = dict((k.strip(), val.strip()) for k, _, val in (l.partition(":") for l in r.stdout.splitlines()) if val)
    pid = d.get("PID", "")
    return d.get("State", "STOPPED"), (int(pid) if pid.isdigit() else None)


def running(v):
    pid = v.get("initpid")
    if not pid or not os.path.exists(f"/proc/{pid}"): return False
    try: return open(f"/proc/{pid}/comm").read().strip() in ("systemd", "init")
    except Exception: return False


def root_partition(path):
    """(offset, size) in bytes of the root filesystem partition of a disk image."""
    out = subprocess.run(["sfdisk", "-J", path], capture_output=True, text=True)
    if out.returncode != 0: return 0, os.path.getsize(path)
    pt = json.loads(out.stdout)["partitiontable"]; ss = pt.get("sectorsize", 512)
    cands = [p for p in pt.get("partitions", []) if p.get("type", "").upper() in ("0FC63DAF-8483-4772-8E79-3D69D8477DE4", "4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709", "83")]
    if not cands: raise ApiError(500, "no Linux root partition found on the boot disk")
    p = max(cands, key=lambda x: x["size"])
    return p["start"] * ss, p["size"] * ss


def boot_disk(cfg):
    boot = re.search(r"order=([\w;]+)", cfg.get("boot", "")); order = boot.group(1).split(";") if boot else []
    for k in order + sorted(disk_keys(cfg)):
        val = cfg.get(k, "")
        if val and not is_cdrom(val) and not is_cloudinit(val): return k, vol_path(val.split(",")[0])
    raise ApiError(500, "no bootable disk")


def attach_root(v):
    vmid = v["vmid"]; key, path = boot_disk(v["config"]); off, size = root_partition(path)
    loop = subprocess.run(["losetup", "-f", "--show", "-o", str(off), "--sizelimit", str(size), path], capture_output=True, text=True, check=True).stdout.strip()
    if v.get("pending_growfs"):
        subprocess.run(["e2fsck", "-fy", loop], capture_output=True); subprocess.run(["resize2fs", loop], capture_output=True); v.pop("pending_growfs", None)
    mnt = os.path.join(MNT, str(vmid)); os.makedirs(mnt, exist_ok=True)
    subprocess.run(["mount", loop, mnt], check=True)
    v["loop"] = loop; v["mnt"] = mnt
    return loop, mnt


def detach_root(v):
    mnt = v.get("mnt") or os.path.join(MNT, str(v["vmid"]))
    subprocess.run(["umount", "-l", mnt], capture_output=True)
    if v.get("loop"): subprocess.run(["losetup", "-d", v["loop"]], capture_output=True)
    v["loop"] = None; v["mnt"] = None


def write_seed(v, mnt, task):
    files = build_seed_files(v)
    if files is None: return
    seed = os.path.join(mnt, "var/lib/cloud/seed/nocloud"); os.makedirs(seed, exist_ok=True)
    for f in os.listdir(seed): os.unlink(os.path.join(seed, f))
    for fn, txt in files.items():
        with open(os.path.join(seed, fn), "w") as f: f.write(txt)
    task.log(f"generating cloud-init NoCloud data ({', '.join(files)})")


def lxc_config(v, loop):
    cfg = v["config"]; vmid = v["vmid"]
    cores = max(1, min(os.cpu_count(), int(cfg.get("cores", "1")) * int(cfg.get("sockets", "1"))))
    mem = int(cfg.get("memory", "512")) * 1024 * 1024
    lines = ["lxc.include = /usr/share/lxc/config/common.conf", "lxc.arch = x86_64", f"lxc.uts.name = {cfg.get('name', 'vm' + str(vmid))}",
             f"lxc.rootfs.path = dir:{os.path.join(MNT, str(vmid))}", "lxc.apparmor.profile = unconfined", "lxc.tty.max = 2",
             f"lxc.cgroup.memory.limit_in_bytes = {mem}", f"lxc.cgroup.cpuset.cpus = 0-{cores - 1}",
             f"lxc.mount.entry = {loop} dev/{os.path.basename(loop)} none bind,optional,create=file 0 0",
             f"lxc.cgroup.devices.allow = b 7:{os.minor(os.stat(loop).st_rdev)} rwm"]  # the guest may use its own root disk, as in a VM
    # Lab-only: snapd cannot mount squashfs inside a container, so cloud-init's `snap refresh` (run when a
    # deploy asks for package upgrades) would fail here though it works in a real VM. Hide the snap CLI by
    # bind-mounting an empty, non-executable file over it; the guest disk itself is not modified.
    # LXC will not mount onto a symlink, and /usr/bin/snap is one in the cloud images, so cover its target.
    root = os.path.join(MNT, str(vmid)); rel = "usr/bin/snap"
    for _ in range(8):
        full = os.path.join(root, rel)
        if not os.path.islink(full): break
        t = os.readlink(full)
        rel = os.path.normpath(t.lstrip("/") if t.startswith("/") else os.path.join(os.path.dirname(rel), t))
    if os.path.isfile(os.path.join(root, rel)) and not os.path.islink(os.path.join(root, rel)):
        stub = os.path.join(STATE, "no-snap")
        if not os.path.exists(stub): open(stub, "w").close(); os.chmod(stub, 0o644)
        lines.append(f"lxc.mount.entry = {stub} {rel} none bind,ro 0 0")
    for i in range(8):
        if f"net{i}" not in cfg: continue
        mac = re.search(r"=([0-9A-Fa-f:]{17})", cfg[f"net{i}"]); br = re.search(r"bridge=([\w.-]+)", cfg[f"net{i}"])
        lines += [f"lxc.net.{i}.type = veth", f"lxc.net.{i}.link = {br.group(1) if br else BRIDGE}", f"lxc.net.{i}.name = eth{i}",
                  f"lxc.net.{i}.flags = up", f"lxc.net.{i}.veth.pair = {tap(vmid, i)}"] + ([f"lxc.net.{i}.hwaddr = {mac.group(1).lower()}"] if mac else [])
    os.makedirs(os.path.join(LXC, ct(vmid)), exist_ok=True)
    with open(os.path.join(LXC, ct(vmid), "config"), "w") as f: f.write("\n".join(lines) + "\n")


def start_vm(v, task):
    vmid = v["vmid"]
    if v["template"]: raise ApiError(500, "you can't start a template")
    if running(v): raise ApiError(500, f"VM {vmid} already running")
    loop, mnt = attach_root(v)
    try:
        write_seed(v, mnt, task); lxc_config(v, loop)
        r = subprocess.run(["lxc-start", "-n", ct(vmid), "-d", "-l", "WARN", "-o", os.path.join(RUN, f"{vmid}.lxc.log")], capture_output=True, text=True)
        if r.returncode != 0: raise ApiError(500, f"start failed: {r.stderr.strip() or 'lxc-start failed'}")
        for _ in range(150):
            st, pid = lxc_state(vmid)
            if st == "RUNNING" and pid: break
            time.sleep(0.1)
        if st != "RUNNING": raise ApiError(500, "start failed: guest did not come up")
    except Exception:
        detach_root(v); raise
    v["initpid"] = pid; v["started"] = time.time(); v["last"] = None
    task.log(f"start VM {vmid}: OK")
    threading.Thread(target=watch, args=(v, pid), daemon=True).start()


def watch(v, pid):
    """While the guest runs: wire up its guest agent once installed; clean up when it powers off."""
    vmid = v["vmid"]
    while os.path.exists(f"/proc/{pid}"):
        if str(v["config"].get("agent", "0")).split(",")[0] in ("1", "enabled=1") and not os.path.exists(agent_sock(v)):
            root = f"/proc/{pid}/root"
            if os.path.exists(root + "/usr/sbin/qemu-ga"):
                subprocess.run(["lxc-attach", "-n", ct(vmid), "--", "sh", "-c",
                                "mkdir -p /dev/virtio-ports && exec /usr/sbin/qemu-ga -d -m unix-listen -p /dev/virtio-ports/org.qemu.guest_agent.0 -f /run/qemu-ga.pid"],
                               capture_output=True, timeout=20)
                if os.path.exists(agent_sock(v)): log("VM", vmid, "guest agent channel up")
        time.sleep(2)
    subprocess.run(["lxc-stop", "-n", ct(vmid), "-k"], capture_output=True)
    detach_root(v); v["initpid"] = None
    log("VM", vmid, "powered off")


def stop_vm(v, task, timeout=10):
    if not running(v): return
    pid = v["initpid"]; subprocess.run(["lxc-stop", "-n", ct(v["vmid"]), "-k"], capture_output=True, timeout=60)
    for _ in range(100):
        if not os.path.exists(f"/proc/{pid}") and v.get("initpid") is None: break
        time.sleep(0.1)


def shutdown_vm(v, task, timeout=180, force=False):
    if not running(v): return
    pid = v["initpid"]
    r = subprocess.run(["lxc-stop", "-n", ct(v["vmid"]), "-t", str(timeout)], capture_output=True, text=True, timeout=timeout + 30)
    if os.path.exists(f"/proc/{pid}"):
        if force: task.log("VM quit/powerdown failed - terminating now with SIGTERM"); stop_vm(v, task)
        else: raise ApiError(500, f"VM {v['vmid']} quit/powerdown failed")
    for _ in range(100):
        if v.get("initpid") is None: break
        time.sleep(0.1)


# ---------------------------------------------------------------- QEMU guest agent (the guest's own qemu-ga, on its virtio-port path)
def qga(v, cmd, args=None, timeout=10):
    vmid = v["vmid"]
    if not running(v) or not os.path.exists(agent_sock(v)):
        raise ApiError(500, "QEMU guest agent is not running")
    with v["qga_lock"]:
        s = socket.socket(socket.AF_UNIX); s.settimeout(timeout)
        try:
            s.connect(agent_sock(v))
            sid = random.randint(1, 2 ** 31)
            s.sendall(b"\xff" + json.dumps({"execute": "guest-sync-delimited", "arguments": {"id": sid}}).encode() + b"\n")
            buf = b""
            while True:
                chunk = s.recv(65536)
                if not chunk: raise ApiError(500, "QEMU guest agent is not running")
                buf += chunk
                if b"\xff" in buf: buf = buf[buf.rindex(b"\xff") + 1:]
                for line in buf.split(b"\n"):
                    try:
                        if json.loads(line).get("return") == sid: break
                    except ValueError: continue
                else:
                    continue
                break
            s.sendall(json.dumps({"execute": cmd, **({"arguments": args} if args is not None else {})}).encode() + b"\n")
            if cmd in ("guest-shutdown",): return {}
            buf = b""
            while True:
                chunk = s.recv(1 << 20)
                if not chunk: break
                buf += chunk
                try:
                    r = json.loads(buf); break
                except ValueError: continue
            if "error" in r: raise ApiError(500, f"Agent error: {r['error'].get('desc')}")
            return r.get("return")
        except socket.timeout:
            raise ApiError(500, f"VM {vmid} qmp command '{cmd}' failed - got timeout")
        except (ConnectionRefusedError, FileNotFoundError):
            raise ApiError(500, "QEMU guest agent is not running")
        finally:
            s.close()


def agent_api(v, m, sub, qs, b):
    a = sub.split("/", 1)[1] if "/" in sub else b.get("command", "")
    if a == "exec":
        cmd = b.get("command", [])
        cmd = cmd if isinstance(cmd, list) else [cmd]
        if len(cmd) == 1 and " " in cmd[0] and not cmd[0].startswith("/"): cmd = cmd[0].split()
        args = {"path": cmd[0], "arg": cmd[1:], "capture-output": True}
        if b.get("input-data"): args["input-data"] = base64.b64encode(b["input-data"].encode()).decode()
        return qga(v, "guest-exec", args)
    if a == "exec-status":
        if not str(qs.get("pid", "")).isdigit(): raise ApiError(400, "pid: invalid integer value")
        r = qga(v, "guest-exec-status", {"pid": int(qs.get("pid", "0"))})
        for k in ("out-data", "err-data"):
            if k in r: r[k] = base64.b64decode(r[k]).decode("utf-8", "replace")
        return r
    if a == "set-user-password":
        pw = b.get("password", ""); crypted = b.get("crypted", "0") in ("1", "true")
        qga(v, "guest-set-user-password", {"username": b.get("username", "root"), "password": base64.b64encode(pw.encode()).decode(), "crypted": crypted})
        return {"result": {}}
    if a == "file-write":
        content = b.get("content", ""); data = content.encode() if b.get("encode", "1") in ("1", "true") else base64.b64decode(content)
        h = qga(v, "guest-file-open", {"path": b["file"], "mode": "w"})
        qga(v, "guest-file-write", {"handle": h, "buf-b64": base64.b64encode(data).decode()}); qga(v, "guest-file-close", {"handle": h})
        return None
    if a == "file-read":
        h = qga(v, "guest-file-open", {"path": qs.get("file") or b.get("file"), "mode": "r"}); out = b""
        while True:
            r = qga(v, "guest-file-read", {"handle": h, "count": 1 << 20}); out += base64.b64decode(r.get("buf-b64", ""))
            if r.get("eof"): break
        qga(v, "guest-file-close", {"handle": h})
        return {"content": out.decode("utf-8", "replace"), "bytes-read": len(out)}
    if a in ("shutdown",): qga(v, "guest-shutdown"); return None
    return {"result": qga(v, "guest-" + a)}


# ---------------------------------------------------------------- metrics from the real processes
def cg(ctl, vmid, f):
    for base in (f"/sys/fs/cgroup/{ctl}/lxc.payload.{ct(vmid)}", f"/sys/fs/cgroup/{ctl}/lxc/{ct(vmid)}"):
        try: return open(os.path.join(base, f)).read()
        except Exception: continue
    return None


def tap_bytes(vmid):
    try:
        rx = int(open(f"/sys/class/net/{tap(vmid)}/statistics/rx_bytes").read()); tx = int(open(f"/sys/class/net/{tap(vmid)}/statistics/tx_bytes").read())
        return tx, rx  # netin (to the VM), netout (from the VM)
    except Exception: return 0, 0


def vm_now(v):
    """Current cpu fraction, memory, io and net counters of a running guest."""
    if not running(v): return dict(cpu=0.0, mem=0, netin=0, netout=0, diskread=0, diskwrite=0)
    vmid = v["vmid"]; cores = int(v["config"].get("cores", "1")); t = time.time()
    cs = int(cg("cpuacct", vmid, "cpuacct.usage") or 0) / 1e9
    mem = 0
    st = cg("memory", vmid, "memory.stat")
    if st:
        d = dict(l.split() for l in st.splitlines() if l.strip()); mem = int(d.get("total_rss", 0)) + int(d.get("total_mapped_file", 0)) + int(d.get("total_shmem", 0))
    rd = wr = 0
    io = cg("blkio", vmid, "blkio.throttle.io_service_bytes")
    if io:
        for l in io.splitlines():
            p = l.split()
            if len(p) == 3 and p[1] == "Read": rd += int(p[2])
            if len(p) == 3 and p[1] == "Write": wr += int(p[2])
    ni, no = tap_bytes(vmid)
    last = v.get("last"); cpu = 0.0
    if last and t - last[0] > 0.5: cpu = max(0.0, min(1.0, (cs - last[1]) / (t - last[0]) / max(1, cores)))
    elif last: cpu = last[2]
    if not last or t - last[0] > 0.5: v["last"] = (t, cs, cpu)
    return dict(cpu=round(cpu, 4), mem=mem, netin=ni, netout=no, diskread=rd, diskwrite=wr)


HOST_CPU = {"last": None, "frac": 0.0}
NODE_SAMPLES = deque(maxlen=720)


class NullTask:
    def log(self, line): pass


def host_cpu():
    a = [int(x) for x in open("/proc/stat").readline().split()[1:]]; idle = a[3] + a[4]; tot = sum(a); t = time.time()
    if HOST_CPU["last"] and t - HOST_CPU["last"][0] > 0.5:
        _, i0, t0 = HOST_CPU["last"]; HOST_CPU["frac"] = round(max(0.0, 1 - (idle - i0) / max(1, tot - t0)), 4); HOST_CPU["last"] = (t, idle, tot)
    elif not HOST_CPU["last"]: HOST_CPU["last"] = (t, idle, tot)
    return HOST_CPU["frac"]


def meminfo():
    d = {}
    for line in open("/proc/meminfo"):
        k, val = line.split(":"); d[k] = int(val.split()[0]) * 1024
    return d["MemTotal"], d["MemTotal"] - d["MemAvailable"]


def fs(path):
    s = os.statvfs(path); total = s.f_blocks * s.f_frsize; avail = s.f_bavail * s.f_frsize; free = s.f_bfree * s.f_frsize
    return total, total - free, avail


def sampler():
    while True:
        time.sleep(10)
        with LOCK:
            c = host_cpu(); total, used = meminfo(); dt, du, _ = fs(VZ)
            NODE_SAMPLES.append(dict(time=int(time.time()), cpu=c, memused=used, memtotal=total, maxcpu=os.cpu_count(), rootused=du, roottotal=dt,
                                     loadavg=float(open("/proc/loadavg").read().split()[0])))
            for v in list(VMS.values()):
                if running(v):
                    n = vm_now(v); n["time"] = int(time.time()); v["samples"].append(n)


# ---------------------------------------------------------------- HTTP
TICKETS = {}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "pve-api-daemon/3.0"

    def log_message(self, *a): pass

    def _send(self, code, payload, reason=None):
        body = json.dumps(payload).encode()
        self.send_response(code, reason); self.send_header("Content-Type", "application/json;charset=UTF-8")
        self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "max-age=0"); self.end_headers(); self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        if "json" in self.headers.get("Content-Type", "") and raw:
            try:
                j = json.loads(raw)
                return {k: (val if isinstance(val, (str, list)) else json.dumps(val) if isinstance(val, dict) else ("1" if val is True else "0" if val is False else str(val))) for k, val in j.items()}
            except ValueError: pass
        out = {}
        for k, vs in parse_qs(raw, keep_blank_values=True).items(): out[k] = vs if k == "command" else vs[-1]
        return out

    def do_GET(self): self._route("GET")
    def do_POST(self): self._route("POST")
    def do_PUT(self): self._route("PUT")
    def do_DELETE(self): self._route("DELETE")

    def _route(self, method):
        u = urlparse(self.path); path = unquote(u.path); qs = {k: v[-1] for k, v in parse_qs(u.query).items()}
        auth = self.headers.get("Authorization", "")
        m = re.match(r"^PVEAPIToken=([^!]+@[^!]+)!([^=]+)=(.+)$", auth.strip())
        tok = TOKENS.get(f"{m.group(1)}!{m.group(2)}") if m else None
        if not m or not tok or tok.get("secret") != m.group(3):
            log(method, path, "-> 401 invalid token"); return self._send(401, {"data": None}, "invalid token value!")
        self.user = f"{m.group(1)}!{m.group(2)}"; self.privsep = bool(tok.get("privsep"))
        if self.headers.get("Upgrade", "").lower() == "websocket": return self._websocket(path, qs)
        body = self._body() if method in ("POST", "PUT") else {}
        if method == "DELETE": body = dict(qs)
        try:
            res = self.api(method, path.replace("/api2/json", "", 1), qs, body)
        except ApiError as e:
            log(method, path, json.dumps(body)[:200] if body else "", f"-> {e.code} {e.msg}")
            return self._send(e.code, {"data": None, **({"message": e.msg + "\n"} if e.code >= 400 else {})}, e.msg[:200].replace("\n", " "))
        except Exception as e:
            log("EXC", method, path, repr(e)); return self._send(500, {"data": None, "message": str(e)}, str(e)[:200])
        if res is NotImplemented:
            log("NOT-IMPLEMENTED", method, path, body); return self._send(501, {"data": None}, "Method not implemented in pve-lab")
        log(method, path, (json.dumps(body)[:200] if body else ""), "-> 200")
        return self._send(200, {"data": res})

    # ------------------------------------------------------------ API
    def perm(self, path, priv):
        if self.privsep: raise ApiError(403, f"Permission check failed ({path}, {priv})")

    def api(self, m, p, qs, b):
        if p == "/version": return PVE_VERSION
        if p == "/access/permissions": return {} if self.privsep else {"/": {k: 1 for k in FULL_PRIVS}}
        if p == "/nodes":
            if self.privsep: return []
            return [self.node_entry()]
        self.perm(p, "Sys.Audit")
        if p == "/cluster/status":
            return [dict(type="node", id=f"node/{NODE}", name=NODE, nodeid=0, online=1, local=1, ip=ADDR, level="")]
        if p == "/cluster/nextid":
            n = int(qs.get("vmid", "100"))
            while n in VMS: n += 1
            return str(n)
        if p == "/cluster/tasks": return [self.task_entry(t) for t in list(TASKS.values())[-50:]]
        if p in ("/cluster/mapping/pci", "/cluster/mapping/usb", "/cluster/sdn/vnets", "/cluster/sdn/zones", "/pools", "/cluster/ha/resources", "/cluster/replication", "/cluster/backup"):
            return []
        if p == "/cluster/options": return {"keyboard": "en-us"}
        if p == "/cluster/firewall/options":
            if m == "PUT":
                for k, val in b.items():
                    if k == "delete": [CLUSTER_FW["options"].pop(x, None) for x in val.split(",")]
                    elif k != "digest": CLUSTER_FW["options"][k] = int(val) if str(val).isdigit() else val
                save_fw(); return None
            return {"policy_in": "DROP", "policy_out": "ACCEPT", "ebtables": 1, **CLUSTER_FW["options"]}
        if p == "/cluster/firewall/rules":
            if m == "POST": self.add_rule(CLUSTER_FW["rules"], b); save_fw(); return None
            return [dict(r) for r in CLUSTER_FW["rules"]]
        mm = re.match(r"^/cluster/firewall/rules/(\d+)$", p)
        if mm:
            if m == "DELETE": self.del_rule(CLUSTER_FW["rules"], int(mm.group(1))); save_fw(); return None
            return CLUSTER_FW["rules"][int(mm.group(1))]
        if p == "/cluster/firewall/groups" or p == "/cluster/firewall/ipset" or p == "/cluster/firewall/aliases": return []
        if p == "/cluster/resources": return self.resources(qs.get("type"))
        if p == "/storage":
            return [dict(storage=s, type=d["type"], content=d["content"], shared=d["shared"], path=d["path"], digest="lab") for s, d in STORAGE.items()]
        mm = re.match(r"^/storage/([\w.-]+)$", p)
        if mm:
            s = STORAGE.get(mm.group(1))
            if not s: raise ApiError(500, f"storage '{mm.group(1)}' does not exist")
            if m == "PUT":
                if "content" in b: s["content"] = b["content"]
                save_storage(); return None
            return dict(storage=mm.group(1), **s)
        mm = re.match(r"^/nodes/([\w-]+)(?:/(.*))?$", p)
        if not mm: return NotImplemented
        if mm.group(1) != NODE: raise ApiError(500, f"hostname lookup '{mm.group(1)}' failed - failed to get address info")
        return self.node_api(m, mm.group(2) or "", qs, b)

    def add_rule(self, rules, b):
        r = dict(type=b.get("type", "in"), action=b.get("action", "ACCEPT"), enable=int(b.get("enable", 1)))
        for k in ("source", "dest", "dport", "sport", "proto", "comment", "macro", "iface", "log", "icmp-type"):
            if b.get(k, "") != "": r[k] = b[k]
        pos = int(b["pos"]) if str(b.get("pos", "")).isdigit() else len(rules)
        rules.insert(min(pos, len(rules)), r)
        for i, x in enumerate(rules): x["pos"] = i

    def del_rule(self, rules, pos):
        if pos < len(rules): rules.pop(pos)
        for i, x in enumerate(rules): x["pos"] = i

    def node_entry(self):
        total, used = meminfo(); dt, du, _ = fs(VZ)
        return dict(node=NODE, type="node", id=f"node/{NODE}", status="online", cpu=host_cpu(), maxcpu=os.cpu_count(), mem=used, maxmem=total,
                    disk=du, maxdisk=dt, uptime=int(float(open("/proc/uptime").read().split()[0])), level="", ssl_fingerprint=CERT_FP)

    def vm_entry(self, v):
        cfg = v["config"]; n = vm_now(v); run = running(v) and not v["template"]
        e = dict(id=f"qemu/{v['vmid']}", type="qemu", vmid=v["vmid"], node=NODE, name=cfg.get("name", ""), status="running" if run else "stopped",
                 template=v["template"], maxcpu=int(cfg.get("cores", "1")), maxmem=int(cfg.get("memory", "512")) * 1024 * 1024,
                 maxdisk=self.disk_bytes(cfg), disk=0, uptime=int(time.time() - v["started"]) if run else 0, **n)
        if cfg.get("tags"): e["tags"] = cfg["tags"]
        if v.get("lock"): e["lock"] = v["lock"]
        return e

    def disk_bytes(self, cfg):
        for k in sorted(disk_keys(cfg)):
            if is_cdrom(cfg[k]) or is_cloudinit(cfg[k]): continue
            mm = re.search(r"size=(\d+)([KMGT])", cfg[k])
            if mm: return int(mm.group(1)) * {"K": 1024, "M": 1024 ** 2, "G": GB, "T": 1024 ** 4}[mm.group(2)]
        return 0

    def resources(self, typ):
        out = []
        if typ in (None, "node"): out.append(self.node_entry())
        if typ in (None, "vm"): out += [self.vm_entry(v) for v in VMS.values()]
        if typ in (None, "storage"):
            for s, d in STORAGE.items():
                t, u, _ = fs(d["path"])
                out.append(dict(id=f"storage/{NODE}/{s}", type="storage", storage=s, node=NODE, status="available", disk=u, maxdisk=t, content=d["content"], shared=d["shared"], plugintype=d["type"]))
        if typ in (None, "sdn"): out.append(dict(id=f"sdn/{NODE}/localnetwork", type="sdn", sdn="localnetwork", node=NODE, status="ok"))
        return out

    def task_entry(self, t):
        e = dict(upid=t.upid, node=NODE, type=t.type, id=t.id, user=t.user, starttime=t.starttime, pid=t.pid, pstart=t.pstart, status=t.status)
        if t.status == "stopped": e["exitstatus"] = t.exitstatus; e["endtime"] = t.endtime
        return e

    def task(self, typ, vmid, fn): return Task(typ, vmid, self.user, fn).upid

    # ------------------------------------------------------------ /nodes/pve1/...
    def node_api(self, m, rest, qs, b):
        if rest == "": return [dict(name=x) for x in ("qemu", "lxc", "storage", "network", "tasks", "status", "firewall", "hardware", "vzdump")]
        if rest == "status":
            total, used = meminfo(); dt, du, da = fs("/"); un = os.uname(); ci = cpuinfo()
            la = open("/proc/loadavg").read().split()[:3]
            return {"cpu": host_cpu(), "wait": 0, "idle": 0, "uptime": int(float(open("/proc/uptime").read().split()[0])), "loadavg": la,
                    "memory": {"total": total, "used": used, "free": total - used}, "swap": {"total": 0, "used": 0, "free": 0},
                    "rootfs": {"total": dt, "used": du, "avail": da, "free": dt - du}, "cpuinfo": ci,
                    "current-kernel": {"sysname": un.sysname, "release": un.release, "version": un.version, "machine": un.machine},
                    "kversion": f"{un.sysname} {un.release} {un.version}", "pveversion": f"pve-manager/{PVE_VERSION['version']}/lab", "ksm": {"shared": 0}}
        if rest.startswith("network"):
            br = dict(iface=BRIDGE, type="bridge", method="static", cidr=f"{ADDR}/24", address=ADDR, netmask="24", gateway="192.168.1.1",
                      bridge_ports="", bridge_stp="off", bridge_fd="0", autostart=1, active=1, families=["inet"], priority=3)
            if rest == "network":
                items = [br, dict(iface="lo", type="loopback", method="loopback", active=1, autostart=1, families=["inet"], priority=1)]
                t = qs.get("type")
                if t in ("bridge", "any_bridge"): return [i for i in items if i["type"] == "bridge"]
                return items
            if rest == f"network/{BRIDGE}": return br
            raise ApiError(500, f"interface does not exist")
        if rest in ("hardware/pci", "hardware/usb", "disks/list", "scan/nfs", "capabilities/qemu/cpu"): return []
        if rest == "firewall/options" or rest == "firewall/rules": return {} if rest.endswith("options") else []
        if rest == "storage":
            out = []
            for s, d in STORAGE.items():
                if qs.get("content") and qs["content"] not in d["content"].split(","): continue
                t, u, a = fs(d["path"])
                out.append(dict(storage=s, type=d["type"], content=d["content"], shared=d["shared"], active=1, enabled=1, total=t, used=u, avail=a, used_fraction=round(u / t, 4)))
            return out
        mm = re.match(r"^storage/([\w.-]+)/(status|content)(?:/(.+))?$", rest)
        if mm: return self.storage_api(m, mm.group(1), mm.group(2), mm.group(3), qs, b)
        mm = re.match(r"^storage/([\w.-]+)/download-url$", rest)
        if mm and m == "POST": return self.download_url(mm.group(1), b)
        mm = re.match(r"^tasks/(UPID:[^/]+)(?:/(status|log))?$", rest)
        if mm:
            t = TASKS.get(mm.group(1))
            if not t: raise ApiError(500, f"no such task")
            if m == "DELETE": t.status = "stopped"; t.exitstatus = "interrupted by signal"; return None
            if mm.group(2) == "log":
                start = int(qs.get("start", "0")); limit = int(qs.get("limit", "500"))
                return [dict(n=i + 1, t=line) for i, line in enumerate(t.lines)][start:start + limit]
            return self.task_entry(t)
        if rest == "rrddata":
            step = {"hour": 60, "day": 1800, "week": 10800, "month": 43200, "year": 604800}.get(qs.get("timeframe", "hour"), 60); now = int(time.time()) // step * step; out = []
            for i in range(70):
                t = now - (69 - i) * step; ss = [x for x in NODE_SAMPLES if x["time"] // step * step == t]; e = dict(time=t)
                if ss: e.update(cpu=sum(x["cpu"] for x in ss) / len(ss), memused=ss[-1]["memused"], memtotal=ss[-1]["memtotal"], maxcpu=ss[-1]["maxcpu"], rootused=ss[-1]["rootused"], roottotal=ss[-1]["roottotal"], loadavg=ss[-1]["loadavg"])
                out.append(e)
            return out
        if rest == "tasks": return [self.task_entry(t) for t in list(TASKS.values())[-50:]]
        if rest == "lxc": return [] if m == "GET" else NotImplemented
        if rest == "qemu":
            if m == "GET": return [self.vm_list_entry(v) for v in VMS.values()]
            if m == "POST": return self.create_vm(b)
        mm = re.match(r"^qemu/(\d+)(?:/(.*))?$", rest)
        if mm: return self.vm_api(m, int(mm.group(1)), mm.group(2) or "", qs, b)
        if rest == "vzdump": return NotImplemented
        return NotImplemented

    def vm_list_entry(self, v):
        e = self.vm_entry(v)
        return dict(vmid=v["vmid"], name=e["name"], status=e["status"], cpus=e["maxcpu"], maxmem=e["maxmem"], maxdisk=e["maxdisk"], template=v["template"],
                    tags=v["config"].get("tags", ""), uptime=e["uptime"], cpu=e["cpu"], mem=e["mem"], pid=v.get("initpid") if running(v) else None)

    def storage_api(self, m, s, what, vol, qs, b):
        d = STORAGE.get(s)
        if not d: raise ApiError(500, f"storage '{s}' does not exist")
        if what == "status":
            t, u, a = fs(d["path"])
            return dict(type=d["type"], content=d["content"], shared=d["shared"], active=1, enabled=1, total=t, used=u, avail=a)
        if vol:
            path = vol_path(vol if ":" in vol else f"{s}:{vol}")
            if m == "DELETE":
                def fn(task):
                    if os.path.exists(path): os.unlink(path); task.log(f"Removed volume '{vol}'")
                return self.task("imgdel", "", fn)
            st = os.stat(path); return dict(path=path, size=st.st_size, used=st.st_size, format=fmt_of(path))
        content = qs.get("content"); out = []
        dirs = {"iso": "template/iso", "vztmpl": "template/cache", "import": "import", "snippets": "snippets", "backup": "dump"}
        for ct, sub in dirs.items():
            if content and content != ct: continue
            if ct not in d["content"].split(",") and not (ct == "snippets" and "snippets" in d["content"]): continue
            base = os.path.join(d["path"], sub)
            for f in sorted(os.listdir(base)) if os.path.isdir(base) else []:
                fp = os.path.join(base, f)
                if f.startswith(".") or not os.path.isfile(fp): continue
                out.append(dict(volid=f"{s}:{ct if ct != 'backup' else 'backup'}/{f}", content=ct, size=os.path.getsize(fp), format=fmt_of(fp), ctime=int(os.path.getmtime(fp))))
        if (not content or content in ("images", "rootdir")) and "images" in d["content"]:
            want = qs.get("vmid")
            for v in VMS.values():
                if want and str(v["vmid"]) != want: continue
                for k in disk_keys(v["config"]):
                    val = v["config"][k]
                    if is_cdrom(val) and not is_cloudinit(val): continue
                    volid = val.split(",")[0]; fp = vol_path(volid)
                    if os.path.exists(fp):
                        out.append(dict(volid=volid, content="images", vmid=v["vmid"], size=self.disk_bytes({k: val}) or os.path.getsize(fp), used=os.path.getsize(fp), format=fmt_of(fp), ctime=int(os.path.getmtime(fp))))
        return out

    def download_url(self, s, b):
        d = STORAGE.get(s)
        if not d: raise ApiError(500, f"storage '{s}' does not exist")
        url = b.get("url", ""); content = b.get("content", "iso"); fname = b.get("filename") or os.path.basename(urlparse(url).path)
        if not re.match(r"^[\w.+-]+$", fname): raise ApiError(400, "invalid filename")
        sub = {"iso": "template/iso", "vztmpl": "template/cache", "import": "import"}.get(content)
        if not sub: raise ApiError(400, f"content type '{content}' is not allowed")
        dst = os.path.join(d["path"], sub, fname); algo = b.get("checksum-algorithm"); want = b.get("checksum")

        def fn(task):
            task.log(f"downloading {url} to {dst}")
            tmp = dst + ".tmp_dwnl"; h = hashlib.new(algo) if algo else None
            req = urllib.request.Request(url, headers={"User-Agent": "pve-lab/1 (+download-url)"})
            with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0); got = 0; last = -10; t0 = time.time()
                task.log(f"download size: {total} bytes" if total else "download size: unknown")
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk: break
                    f.write(chunk); got += len(chunk)
                    if h: h.update(chunk)
                    if total:
                        pct = got * 100 / total
                        if pct - last >= 5:
                            last = pct; rate = got / max(0.1, time.time() - t0) / 1024 / 1024
                            task.log(f"{pct:5.1f}% ({got / 1024 / 1024:.0f} MiB of {total / 1024 / 1024:.0f} MiB) {rate:.1f} MiB/s")
            if h and want and h.hexdigest().lower() != want.lower(): os.unlink(tmp); raise ApiError(500, "checksum mismatch")
            if h and want: task.log(f"calculated checksum: {h.hexdigest()}  matches")
            os.replace(tmp, dst); task.log(f"download of '{url}' to '{dst}' finished")
        return self.task("download", fname, fn)

    # ------------------------------------------------------------ VMs
    def create_vm(self, b):
        vmid = int(b.get("vmid") or 0)
        if not vmid: raise ApiError(400, "vmid: property is missing")
        if vmid in VMS: raise ApiError(500, f"unable to create VM {vmid} - VM {vmid} already exists on node '{NODE}'")
        skip = ("vmid", "pool", "start", "archive", "unique", "force", "storage", "live-restore")
        cfg = {k: val for k, val in b.items() if k not in skip}
        cfg.setdefault("name", f"VM{vmid}")
        for i in range(8):
            k = f"net{i}"
            if k in cfg and not re.search(r"=[0-9A-Fa-f:]{17}", cfg[k].split(",")[0]):
                model = cfg[k].split(",")[0]; cfg[k] = cfg[k].replace(model, f"{model}={rand_mac()}", 1)
        cfg.setdefault("smbios1", f"uuid={uuid.uuid4()}"); cfg.setdefault("vmgenid", str(uuid.uuid4())); cfg.setdefault("meta", f"creation-qemu=8.2.2,ctime={int(time.time())}")
        v = new_vm(vmid, cfg); v["lock"] = "create"; start = b.get("start") in ("1", "true")

        def fn(task):
            try:
                allocate_disks(vmid, cfg, task); save_vm(v)
            except Exception:
                VMS.pop(vmid, None)
                try: os.unlink(f"{STATE}/qemu/{vmid}.json")
                except FileNotFoundError: pass
                shutil.rmtree(os.path.join(VZ, "images", str(vmid)), ignore_errors=True); raise
            finally:
                v["lock"] = None
            if start: start_vm(v, task)
        return self.task("qmcreate", vmid, fn)

    def vm_api(self, m, vmid, sub, qs, b):
        v = VMS.get(vmid)
        if v is None: raise ApiError(500, f"Configuration file 'nodes/{NODE}/qemu-server/{vmid}.conf' does not exist")
        cfg = v["config"]
        if sub == "" and m == "DELETE":
            if running(v): raise ApiError(500, f"VM {vmid} is running - destroy failed")
            v["lock"] = "destroy"

            def fn(task):
                for k in disk_keys(cfg):
                    val = cfg[k]
                    if is_cdrom(val) and not is_cloudinit(val): continue
                    fp = vol_path(val.split(",")[0])
                    if os.path.exists(fp): os.chmod(fp, 0o644); os.unlink(fp); task.log(f"Removed volume '{val.split(',')[0]}'")
                shutil.rmtree(os.path.join(VZ, "images", str(vmid)), ignore_errors=True)
                VMS.pop(vmid, None)
                try: os.unlink(f"{STATE}/qemu/{vmid}.json")
                except FileNotFoundError: pass
            return self.task("qmdestroy", vmid, fn)
        if sub == "":
            return [dict(subdir=x) for x in ("config", "status", "agent", "firewall", "rrddata", "snapshot", "termproxy", "vncproxy")]
        if sub == "config":
            if m == "GET":
                out = dict(cfg); out["digest"] = hashlib.sha1(json.dumps(cfg, sort_keys=True).encode()).hexdigest()
                if v["template"]: out["template"] = 1
                return out
            for k in [x for x in b.get("delete", "").split(",") if x]: cfg.pop(k, None)
            changed = False
            for k, val in b.items():
                if k in ("delete", "digest", "force", "skiplock", "background_delay", "revert"): continue
                cfg[k] = val; changed = True
            if any(re.match(r"^(scsi|virtio|sata|ide)\d+$", k) for k in b if k not in ("delete",)):
                if m == "POST" and any("import-from" in str(b[k]) for k in b):
                    def fn(task):
                        allocate_disks(vmid, cfg, task); save_vm(v)
                    return self.task("qmconfig", vmid, fn)
                allocate_disks(vmid, cfg, NullTask())
            save_vm(v)
            return None
        if sub == "pending": return [dict(key=k, value=val) for k, val in cfg.items()]
        if sub == "resize" and m == "PUT":
            disk = b.get("disk"); size = b.get("size", "")
            if disk not in cfg: raise ApiError(400, f"disk '{disk}' does not exist")
            fp = vol_path(cfg[disk].split(",")[0]); cur = qemu_img_vsize(fp)
            new = cur + parse_size(size[1:]) if size.startswith("+") else parse_size(size)
            if new < cur: raise ApiError(500, "shrinking disks is not supported")

            def fn(task):
                subprocess.run(["truncate", "-s", str(new), fp], check=True)
                subprocess.run(["sgdisk", "-e", fp], capture_output=True)
                part = subprocess.run(["sfdisk", "-J", fp], capture_output=True, text=True)
                if part.returncode == 0:
                    pts = [x for x in json.loads(part.stdout)["partitiontable"].get("partitions", []) if x.get("type", "").upper() == "0FC63DAF-8483-4772-8E79-3D69D8477DE4"]
                    if pts:
                        num = max(pts, key=lambda x: x["size"])["node"].rsplit(fp, 1)[-1]
                        subprocess.run(["growpart", fp, num], capture_output=True); v["pending_growfs"] = True
                task.log(f"growing disk {disk} to {size_str(new)}" + (" (filesystem grows at next boot)" if running(v) else ""))
                cfg[disk] = re.sub(r"size=[\d.]+[KMGT]", f"size={size_str(new)}", cfg[disk]); save_vm(v); task.log(f"resized {disk} to {size_str(new)}")
            return self.task("resize", vmid, fn)
        if sub == "template" and m == "POST":
            if running(v): raise ApiError(500, "you can't convert a running VM to a template")

            def fn(task):
                for k in disk_keys(cfg):
                    val = cfg[k]
                    if is_cdrom(val) or is_cloudinit(val): continue
                    head = val.split(",")[0]; fp = vol_path(head)
                    nb = os.path.basename(fp).replace(f"vm-{vmid}-", f"base-{vmid}-"); nfp = os.path.join(os.path.dirname(fp), nb)
                    os.rename(fp, nfp); os.chmod(nfp, 0o444); cfg[k] = val.replace(head, f"{head.split(':')[0]}:{vmid}/{nb}", 1)
                    task.log(f"renamed {os.path.basename(fp)} to {nb}")
                v["template"] = 1; cfg["template"] = "1"; save_vm(v)
            return self.task("qmtemplate", vmid, fn)
        if sub == "clone" and m == "POST": return self.clone(v, b)
        if sub == "status/current":
            n = vm_now(v); run = running(v) and not v["template"]
            out = dict(vmid=vmid, name=cfg.get("name"), status="running" if run else "stopped", qmpstatus="running" if run else "stopped",
                       cpus=int(cfg.get("cores", "1")), maxmem=int(cfg.get("memory", "512")) * 1024 * 1024, maxdisk=self.disk_bytes(cfg), disk=0,
                       uptime=int(time.time() - v["started"]) if run else 0, ha={"managed": 0}, template=v["template"], **n)
            if run:
                out["pid"] = v.get("initpid"); out["running-qemu"] = "8.2.2"; out["running-machine"] = "pc-i440fx-8.2"
                if lxc_state(vmid)[0] == "FROZEN": out["qmpstatus"] = "paused"
            if str(cfg.get("agent", "0")).split(",")[0] in ("1", "enabled=1"): out["agent"] = 1
            if cfg.get("tags"): out["tags"] = cfg["tags"]
            if v.get("lock"): out["lock"] = v["lock"]
            return out
        mm = re.match(r"^status/(start|stop|shutdown|reboot|reset|suspend|resume)$", sub)
        if mm and m == "POST":
            act = mm.group(1)
            if act == "start": return self.task("qmstart", vmid, lambda t: start_vm(v, t))
            if act == "stop": return self.task("qmstop", vmid, lambda t: stop_vm(v, t))
            if act == "shutdown":
                timeout = int(b.get("timeout", "180")); force = b.get("forceStop", "0") in ("1", "true")
                return self.task("qmshutdown", vmid, lambda t: shutdown_vm(v, t, timeout, force))
            if act == "reboot":
                def fn(t):
                    shutdown_vm(v, t, int(b.get("timeout", "180")), True); start_vm(v, t)
                return self.task("qmreboot", vmid, fn)
            if act == "reset": return self.task("qmreset", vmid, lambda t: subprocess.run(["lxc-attach", "-n", ct(vmid), "--", "systemctl", "reboot", "--force"], capture_output=True))
            if act == "suspend": return self.task("qmsuspend", vmid, lambda t: subprocess.run(["lxc-freeze", "-n", ct(vmid)], check=True))
            if act == "resume": return self.task("qmresume", vmid, lambda t: subprocess.run(["lxc-unfreeze", "-n", ct(vmid)], check=True))
        if sub == "rrddata": return self.rrd(v, qs.get("timeframe", "hour"))
        if sub.startswith("agent"):
            if not str(cfg.get("agent", "0")).split(",")[0] in ("1", "enabled=1"): raise ApiError(500, "No QEMU guest agent configured")
            return agent_api(v, m, sub, qs, b)
        if sub == "firewall/options":
            if m == "PUT":
                for k, val in b.items():
                    if k == "delete": [v["fw_opts"].pop(x, None) for x in val.split(",")]
                    elif k != "digest": v["fw_opts"][k] = int(val) if str(val).isdigit() else val
                save_vm(v); return None
            return dict(v["fw_opts"])
        if sub == "firewall/rules":
            if m == "POST": self.add_rule(v["fw_rules"], b); save_vm(v); return None
            return [dict(r) for r in v["fw_rules"]]
        mm = re.match(r"^firewall/rules/(\d+)$", sub)
        if mm:
            if m == "DELETE": self.del_rule(v["fw_rules"], int(mm.group(1))); save_vm(v); return None
            return v["fw_rules"][int(mm.group(1))]
        if sub in ("firewall/ipset", "firewall/aliases", "firewall/refs"): return []
        if sub == "snapshot":
            if m == "GET": return [dict(s) for s in v["snapshots"]] + [dict(name="current", digest="lab", running=1 if running(v) else 0, description="You are here!", parent=v["snapshots"][-1]["name"] if v["snapshots"] else None)]
            if m == "POST": return self.snapshot(v, b)
        mm = re.match(r"^snapshot/([\w.-]+)(?:/(config|rollback))?$", sub)
        if mm: return self.snapshot_op(v, m, mm.group(1), mm.group(2), b)
        if sub == "migrate":
            if m == "GET": return {"allowed_nodes": [], "not_allowed_nodes": {}, "local_disks": [], "local_resources": [], "running": 1 if running(v) else 0}
            raise ApiError(500, "no other nodes in this cluster")
        if sub == "vncproxy" and m == "POST":
            raise ApiError(500, f"VM {vmid}: no graphical display on this lab node (use the serial/text console)")
        if sub in ("termproxy", "vncproxy") and m == "POST":
            if not running(v): raise ApiError(500, f"VM {vmid} not running")
            tk = f"PVEVNC:{int(time.time()):08X}::" + base64.b64encode(os.urandom(32)).decode()
            TICKETS[tk] = (vmid, "term" if sub == "termproxy" else "vnc"); port = 5900 + len(TICKETS) % 100
            out = {"ticket": tk, "port": str(port), "user": self.user, "upid": make_upid("vncproxy", vmid, self.user)[0]}
            if sub == "vncproxy": out["cert"] = CERT_PEM; out["password"] = tk
            return out
        if sub == "sendkey" and m == "PUT": return None
        return NotImplemented

    def clone(self, v, b):
        vmid = v["vmid"]; cfg = v["config"]; newid = int(b.get("newid")); full = b.get("full") in ("1", "true") or not v["template"]
        if newid in VMS: raise ApiError(500, f"unable to create VM {newid}: config file already exists")
        ncfg = {k: val for k, val in cfg.items() if k not in ("template", "meta")}
        ncfg["name"] = b.get("name") or f"Copy-of-VM-{cfg.get('name', vmid)}"
        if b.get("description"): ncfg["description"] = b["description"]
        for i in range(8):
            if f"net{i}" in ncfg: ncfg[f"net{i}"] = re.sub(r"=([0-9A-Fa-f:]{17})", f"={rand_mac()}", ncfg[f"net{i}"], count=1)
        ncfg["smbios1"] = f"uuid={uuid.uuid4()}"; ncfg["vmgenid"] = str(uuid.uuid4()); ncfg["meta"] = f"creation-qemu=8.2.2,ctime={int(time.time())}"
        nv = new_vm(newid, ncfg); nv["lock"] = "clone"; v["lock"] = "clone" if not v["template"] else None

        def fn(task):
            try:
                os.makedirs(os.path.join(VZ, "images", str(newid)), exist_ok=True)
                for k in disk_keys(cfg):
                    val = cfg[k]; head = val.split(",")[0]; tail = val[len(head):]
                    if is_cloudinit(val): ncfg[k] = f"{head.split(':')[0]}:{newid}/vm-{newid}-cloudinit.raw,media=cdrom"; continue
                    if is_cdrom(val): continue
                    src = vol_path(head); name = next_disk_name(newid); dst = os.path.join(VZ, "images", str(newid), name); store = b.get("storage") or head.split(":")[0]
                    # raw images on a directory storage can only be full-cloned (like Proxmox)
                    task.log(f"create full clone of drive {k} ({head})")
                    subprocess.run(["cp", "--sparse=always", src, dst], check=True); os.chmod(dst, 0o644); ncfg[k] = f"{store}:{newid}/{name}{tail}"
                    task.log(f"transferred {size_str(qemu_img_vsize(dst))} of {size_str(qemu_img_vsize(dst))} (100.00%)")
                save_vm(nv)
            except Exception:
                VMS.pop(newid, None); shutil.rmtree(os.path.join(VZ, "images", str(newid)), ignore_errors=True)
                try: os.unlink(f"{STATE}/qemu/{newid}.json")
                except FileNotFoundError: pass
                raise
            finally:
                nv["lock"] = None; v["lock"] = None
        return self.task("qmclone", vmid, fn)

    def snapshot(self, v, b):
        raise ApiError(500, "snapshots are not supported on this lab node")
        name = b.get("snapname"); vmid = v["vmid"]
        if not name or any(s["name"] == name for s in v["snapshots"]): raise ApiError(400, "invalid or duplicate snapshot name")
        snap = dict(name=name, description=b.get("description", ""), snaptime=int(time.time()), vmstate=0, parent=v["snapshots"][-1]["name"] if v["snapshots"] else None)

        def fn(task):
            if running(v): r = qmp(vmid, "human-monitor-command", {"command-line": f"savevm {name}"}, timeout=600); task.log(r.get("return") or "saved")
            else:
                for k in disk_keys(v["config"]):
                    val = v["config"][k]
                    if is_cdrom(val) or is_cloudinit(val): continue
                    subprocess.run(["qemu-img", "snapshot", "-c", name, vol_path(val.split(",")[0])], check=True)
            v["snapshots"].append(snap); save_vm(v)
        return self.task("qmsnapshot", vmid, fn)

    def snapshot_op(self, v, m, name, op, b):
        s = next((x for x in v["snapshots"] if x["name"] == name), None)
        if s is None: raise ApiError(500, f"snapshot '{name}' does not exist")
        vmid = v["vmid"]
        if op == "config": return dict(v["config"])
        disks = [vol_path(v["config"][k].split(",")[0]) for k in disk_keys(v["config"]) if not (is_cdrom(v["config"][k]) or is_cloudinit(v["config"][k]))]
        if op == "rollback":
            def fn(task):
                if running(v): qmp(vmid, "human-monitor-command", {"command-line": f"loadvm {name}"}, timeout=600)
                else: [subprocess.run(["qemu-img", "snapshot", "-a", name, d], check=True) for d in disks]
            return self.task("qmrollback", vmid, fn)
        if m == "DELETE":
            def fn(task):
                if running(v): qmp(vmid, "human-monitor-command", {"command-line": f"delvm {name}"}, timeout=600)
                else: [subprocess.run(["qemu-img", "snapshot", "-d", name, d], check=True) for d in disks]
                v["snapshots"].remove(s); save_vm(v)
            return self.task("qmdelsnapshot", vmid, fn)
        return dict(s)

    def rrd(self, v, tf):
        step = {"hour": 60, "day": 1800, "week": 10800, "month": 43200, "year": 604800}.get(tf, 60); n = 70; now = int(time.time()) // step * step
        cfg = v["config"]; maxmem = int(cfg.get("memory", "512")) * 1024 * 1024; maxcpu = int(cfg.get("cores", "1"))
        buckets = {}
        samples = list(v["samples"])
        for i, s in enumerate(samples):
            b0 = s["time"] // step * step; buckets.setdefault(b0, []).append((i, s))
        out = []
        for i in range(n):
            t = now - (n - 1 - i) * step; e = dict(time=t, maxcpu=maxcpu, maxmem=maxmem, maxdisk=self.disk_bytes(cfg), disk=0)
            if t in buckets:
                items = buckets[t]; ss = [s for _, s in items]
                e["cpu"] = round(sum(s["cpu"] for s in ss) / len(ss), 4); e["mem"] = int(sum(s["mem"] for s in ss) / len(ss))
                first = samples[max(0, items[0][0] - 1)]; last = items[-1][1]; dt = max(1, last["time"] - first["time"])
                for k in ("netin", "netout", "diskread", "diskwrite"): e[k] = max(0, (last[k] - first[k]) / dt)
            out.append(e)
        return out

    # ------------------------------------------------------------ websockets (termproxy / vncproxy)
    def _websocket(self, path, qs):
        tk = qs.get("vncticket", ""); ent = TICKETS.get(tk)
        mm = re.search(r"/nodes/([\w-]+)/qemu/(\d+)/vncwebsocket", path)
        if not mm or not ent or ent[0] != int(mm.group(2)):
            log("WS denied", path); return self._send(401, {"data": None}, "invalid ticket")
        vmid, kind = ent; v = VMS.get(vmid)
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        proto = self.headers.get("Sec-WebSocket-Protocol", "")
        self.send_response(101, "Switching Protocols"); self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        if proto: self.send_header("Sec-WebSocket-Protocol", proto.split(",")[0].strip())
        self.end_headers(); self.wfile.flush()
        log("WS open", kind, "vm", vmid)
        try:
            if kind == "term": self._term_bridge(v)
            else: self._vnc_bridge(v)
        except Exception as e: log("WS end", kind, vmid, repr(e))
        self.close_connection = True

    def _ws_send(self, data, binary=True):
        if isinstance(data, str): data = data.encode()
        op = 0x82 if binary else 0x81; n = len(data)
        hdr = struct.pack("!BB", op, n) if n < 126 else struct.pack("!BBH", op, 126, n) if n < 65536 else struct.pack("!BBQ", op, 127, n)
        with self.send_lock: self.wfile.write(hdr + data); self.wfile.flush()

    def _ws_recv(self):
        h = self.rfile.read(2)
        if len(h) < 2: return None, None
        op = h[0] & 0x0F; masked = h[1] & 0x80; n = h[1] & 0x7F
        if n == 126: n = struct.unpack("!H", self.rfile.read(2))[0]
        elif n == 127: n = struct.unpack("!Q", self.rfile.read(8))[0]
        mask = self.rfile.read(4) if masked else None; data = self.rfile.read(n)
        if mask: data = bytes(x ^ mask[i % 4] for i, x in enumerate(data))
        return op, data

    def _pump_out(self, s, stop):
        try:
            while not stop.is_set():
                data = s.recv(65536)
                if not data: break
                self._ws_send(data)
        except Exception: pass
        stop.set()

    def _term_bridge(self, v):
        """termproxy protocol: client sends 'user:ticket\\n', we answer OK; then 0:LEN:DATA input, 1:COLS:ROWS: resize, 2 ping.
        The other end is a real agetty running inside the guest on a pseudo-terminal."""
        import pty, fcntl, termios, signal
        self.send_lock = threading.Lock()
        pid, fd = pty.fork()
        if pid == 0:
            os.execvp("lxc-attach", ["lxc-attach", "-n", ct(v["vmid"]), "--clear-env", "--", "/sbin/agetty", "--noclear", "-L", "-", "xterm-256color"])
        stop = threading.Event(); authed = False

        def out():
            try:
                while not stop.is_set():
                    data = os.read(fd, 65536)
                    if not data: break
                    self._ws_send(data)
            except Exception: pass
            stop.set()
        try:
            while not stop.is_set():
                op, data = self._ws_recv()
                if op is None or op == 8: break
                if op == 9: continue
                if not authed:
                    log(f"termproxy vm{v['vmid']} first frame {data[:60]!r}")
                    authed = True; self._ws_send("OK", binary=False); threading.Thread(target=out, daemon=True).start(); continue
                txt = data.decode("utf-8", "replace")
                if not txt.startswith("0:") and txt != "2": log(f"termproxy vm{v['vmid']} ctl {txt[:40]!r}")
                if txt.startswith("0:"):
                    _, ln, rest = txt.split(":", 2); os.write(fd, rest.encode())
                elif txt.startswith("1:"):
                    try:
                        _, cols, rows = txt.split(":")[:3]
                        size = struct.pack("HHHH", int(rows), int(cols), 0, 0)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
                        # The first resize can land before lxc-attach has set up the guest-side terminal and
                        # its SIGWINCH handler; re-apply it shortly after so the guest sees the real size.
                        def again(sz=size):
                            for delay in (0.8, 2.5):
                                time.sleep(delay)
                                if stop.is_set(): return
                                try: fcntl.ioctl(fd, termios.TIOCSWINSZ, sz); os.killpg(pid, signal.SIGWINCH)
                                except Exception: pass
                        threading.Thread(target=again, daemon=True).start()
                    except Exception: pass
                elif txt == "2": continue
                else: os.write(fd, data)
        finally:
            stop.set()
            try: os.killpg(pid, signal.SIGHUP)
            except Exception:
                try: os.kill(pid, signal.SIGHUP)
                except Exception: pass
            try: os.waitpid(pid, 0)
            except Exception: pass
            os.close(fd)

    def _vnc_bridge(self, v):
        self._ws_send(b"")


def fmt_of(path):
    return "qcow2" if path.endswith(".qcow2") or path.endswith(".img") else "raw" if path.endswith(".raw") else "iso" if path.endswith(".iso") else "raw" if path.endswith(".raw") else os.path.splitext(path)[1].lstrip(".") or "raw"


def rand_mac(): return "BC:24:11:%02X:%02X:%02X" % (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))


def cpuinfo():
    model = "QEMU"; mhz = "0"
    for line in open("/proc/cpuinfo"):
        if line.startswith("model name"): model = line.split(":", 1)[1].strip()
        if line.startswith("cpu MHz"): mhz = line.split(":", 1)[1].strip()
    return {"cpus": os.cpu_count(), "cores": os.cpu_count(), "sockets": 1, "model": model, "mhz": mhz, "hvm": "0", "user_hz": 100, "flags": ""}


CERT = os.path.join(ETC, "pve-ssl.pem"); KEY = os.path.join(ETC, "pve-ssl.key")
if not os.path.exists(CERT):
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", KEY, "-out", CERT, "-days", "3650", "-subj", f"/CN={NODE}",
                    "-addext", f"subjectAltName=DNS:{NODE},IP:{ADDR}"], check=True, capture_output=True)
CERT_PEM = open(CERT).read()
CERT_FP = subprocess.run(["openssl", "x509", "-in", CERT, "-noout", "-fingerprint", "-sha256"], capture_output=True, text=True).stdout.strip().split("=", 1)[-1]

if __name__ == "__main__":
    _rediscover()
    for _v in VMS.values():
        if _v.get("initpid"): threading.Thread(target=watch, args=(_v, _v["initpid"]), daemon=True).start()
    threading.Thread(target=sampler, daemon=True).start()
    srv = ThreadingHTTPServer((ADDR, PORT), H); srv.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(CERT, KEY)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    log(f"pve-lab listening on https://{ADDR}:{PORT}/api2/json  node={NODE}  vms={sorted(VMS)}")
    srv.serve_forever()
