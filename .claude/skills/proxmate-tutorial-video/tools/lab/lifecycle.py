# End-to-end check of the Proxmox stand-in (pve-lab.py) through its own API, each step timed: create VM 100 from an
# imported cloud image, add the cicustom snippet, start, guest-agent ping and exec, cloud-init clean, shutdown, template,
# full clone 101 with ciuser/sshkeys, resize, start, set a user password through the agent, exec, status.
# Leaves VMs 100 and 101 behind (reset-world.sh clears them). The node needs local:import/lifecycle-test.qcow2 (an Ubuntu
# cloud image) and local:snippets/proxmate-guest-agent.yaml (installs qemu-guest-agent).
# usage: python3 lifecycle.py   (env PMV_PVE_URL, PMV_PVE_TOKENS default /etc/pve-lab/tokens.json, PMV_PVE_TOKEN_ID default
#        root@pam!proxmate, PMV_VM_PASSWORD, PMV_FRIEND_PUBKEY default $PMV_LAB/mike_ed25519.pub; the token is never printed)
import json, os, ssl, time, urllib.request, urllib.parse, sys
WORK = os.path.expanduser(os.environ.get('PMV_WORK') or '~/pmv/work'); LAB = os.environ.get('PMV_LAB') or f'{WORK}/lab'
def env(k):
    if not os.environ.get(k): sys.exit(f'set {k}')
    return os.environ[k]
TOKEN_ID = os.environ.get('PMV_PVE_TOKEN_ID', 'root@pam!proxmate')
tok = json.load(open(os.environ.get('PMV_PVE_TOKENS') or '/etc/pve-lab/tokens.json'))[TOKEN_ID]['secret']
PUBKEY = os.environ.get('PMV_FRIEND_PUBKEY') or f'{LAB}/mike_ed25519.pub'
VM_PW = env('PMV_VM_PASSWORD')
ctx = ssl._create_unverified_context(); OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx)); BASE = os.environ.get('PMV_PVE_URL', 'https://192.168.1.10:8006').rstrip('/') + '/api2/json'
def call(m, path, data=None):
    body = urllib.parse.urlencode(data, doseq=True).encode() if data else None
    req = urllib.request.Request(BASE + path, data=body, method=m, headers={'Authorization': f'PVEAPIToken={TOKEN_ID}={tok}'})
    if body: req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    try:
        with OPENER.open(req, timeout=60) as r: return json.loads(r.read())['data']
    except urllib.error.HTTPError as e: return {'ERROR': e.code, 'msg': e.reason}
def wait(upid, t=600):
    t0 = time.time()
    while time.time() - t0 < t:
        st = call('GET', f'/nodes/pve1/tasks/{urllib.parse.quote(upid)}/status')
        if st.get('status') == 'stopped': return st.get('exitstatus')
        time.sleep(1)
    return 'TIMEOUT'
T = time.time(); el = lambda: f'{time.time()-T:6.1f}s'
print(el(), 'create 100', wait(call('POST', '/nodes/pve1/qemu', {'vmid': 100, 'name': 'ubuntu-24.04', 'memory': 1024, 'cores': 1, 'scsihw': 'virtio-scsi-single',
      'scsi0': 'local:0,import-from=local:import/lifecycle-test.qcow2', 'ide2': 'local:cloudinit', 'net0': 'virtio,bridge=vmbr0', 'serial0': 'socket', 'vga': 'serial0', 'boot': 'order=scsi0', 'agent': 'enabled=1'})))
print(el(), 'config', json.dumps(call('GET', '/nodes/pve1/qemu/100/config'))[:300])
call('PUT', '/nodes/pve1/qemu/100/config', {'cicustom': 'user=local:snippets/proxmate-guest-agent.yaml', 'ipconfig0': 'ip=dhcp', 'agent': 'enabled=1'})
print(el(), 'start', wait(call('POST', '/nodes/pve1/qemu/100/status/start')))
for i in range(60):
    r = call('POST', '/nodes/pve1/qemu/100/agent/ping')
    if 'ERROR' not in r: print(el(), 'agent ping OK', r); break
    time.sleep(5)
pid = call('POST', '/nodes/pve1/qemu/100/agent/exec', {'command': ['/usr/bin/cloud-init', 'status']})
time.sleep(2); print(el(), 'exec cloud-init status', call('GET', f"/nodes/pve1/qemu/100/agent/exec-status?pid={pid.get('pid')}"))
print(el(), 'ifaces', [ (i['name'], [a['ip-address'] for a in i.get('ip-addresses', [])]) for i in call('GET', '/nodes/pve1/qemu/100/agent/network-get-interfaces')['result']])
pid = call('POST', '/nodes/pve1/qemu/100/agent/exec', {'command': ['/usr/bin/cloud-init', 'clean', '--logs', '--seed']}); time.sleep(2)
print(el(), 'clean', call('GET', f"/nodes/pve1/qemu/100/agent/exec-status?pid={pid.get('pid')}"))
print(el(), 'shutdown', wait(call('POST', '/nodes/pve1/qemu/100/status/shutdown', {'timeout': 60})), call('GET', '/nodes/pve1/qemu/100/status/current')['status'])
call('PUT', '/nodes/pve1/qemu/100/config', {'delete': 'cicustom,ipconfig0'})
print(el(), 'template', wait(call('POST', '/nodes/pve1/qemu/100/template')))
print(el(), 'clone 101', wait(call('POST', '/nodes/pve1/qemu/100/clone', {'newid': 101, 'name': 'mike-test', 'full': 1})))
key = urllib.parse.quote(open(PUBKEY).read().strip(), safe='')
call('PUT', '/nodes/pve1/qemu/101/config', {'ciuser': 'mike', 'sshkeys': key, 'ipconfig0': 'ip=dhcp', 'vga': 'std', 'cores': 2, 'memory': 2048})
print(el(), 'resize', wait(call('PUT', '/nodes/pve1/qemu/101/resize', {'disk': 'scsi0', 'size': '20G'})))
print(el(), 'start 101', wait(call('POST', '/nodes/pve1/qemu/101/status/start')))
for i in range(60):
    r = call('POST', '/nodes/pve1/qemu/101/agent/ping')
    if 'ERROR' not in r: print(el(), 'agent 101 OK'); break
    time.sleep(5)
print(el(), 'set password', call('POST', '/nodes/pve1/qemu/101/agent/set-user-password', {'username': 'mike', 'password': VM_PW}))
pid = call('POST', '/nodes/pve1/qemu/101/agent/exec', {'command': ['/bin/sh', '-c', 'hostname; id mike; nproc; free -m | head -2; df -h / | tail -1']}); time.sleep(2)
print(el(), call('GET', f"/nodes/pve1/qemu/101/agent/exec-status?pid={pid.get('pid')}").get('out-data'))
print(el(), 'status', {k: v for k, v in call('GET', '/nodes/pve1/qemu/101/status/current').items() if k in ('status', 'cpu', 'mem', 'maxmem', 'uptime', 'pid')})
