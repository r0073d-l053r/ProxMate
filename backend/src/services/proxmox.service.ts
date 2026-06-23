import https from 'node:https';
import axios, { AxiosError, type AxiosInstance } from 'axios';
import { getConfig } from './config.service.js';

// ─── Client builder ───────────────────────────────────────────

export function buildClient(
  host: string,
  tokenId: string,
  tokenSecret: string,
  verifySsl: boolean,
): AxiosInstance {
  return axios.create({
    baseURL: `${host}/api2/json`,
    headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
    httpsAgent: new https.Agent({ rejectUnauthorized: verifySsl }),
    timeout: 15_000,
  });
}

export interface ProxmoxConnection {
  host: string;
  tokenId: string;
  tokenSecret: string;
  verifySsl: boolean;
}

/** Read the Proxmox connection config from SystemConfig. */
export async function getConnectionConfig(): Promise<ProxmoxConnection> {
  const [host, tokenId, tokenSecret, verifySslStr] = await Promise.all([
    getConfig('proxmox_host'),
    getConfig('proxmox_token_id'),
    getConfig('proxmox_token_secret'),
    getConfig('proxmox_verify_ssl'),
  ]);
  if (!host || !tokenId || !tokenSecret) throw new Error('Proxmox is not configured');
  return { host, tokenId, tokenSecret, verifySsl: verifySslStr === 'true' };
}

/** Build a client from the Proxmox connection config stored in SystemConfig. */
export async function getClient(): Promise<AxiosInstance> {
  const c = await getConnectionConfig();
  return buildClient(c.host, c.tokenId, c.tokenSecret, c.verifySsl);
}

/** Extract a human-readable message from a Proxmox/axios error. */
export function pveMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data as { errors?: Record<string, string>; message?: string } | undefined;
    if (data?.errors) return Object.values(data.errors).join('; ');
    if (data?.message) return data.message;
    if (err.response) return `Proxmox responded ${err.response.status}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Unknown Proxmox error';
}

// ─── Cluster / connection info ────────────────────────────────

export async function getVersion(client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: { version: string } }>('/version');
  return res.data.data.version;
}

export interface PveNode {
  node: string;
  status: string;
  maxcpu?: number;
  maxmem?: number;
  cpu?: number;
  mem?: number;
}

export async function getNodes(client?: AxiosInstance): Promise<PveNode[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: PveNode[] }>('/nodes');
  return res.data.data;
}

/** Returns the name of the first available node, or throws if none. */
export async function getDefaultNode(client?: AxiosInstance): Promise<string> {
  const nodes = await getNodes(client);
  const node = nodes[0]?.node;
  if (!node) throw new Error('No Proxmox nodes available');
  return node;
}

// ─── Storage / network / ISO listing ──────────────────────────

export interface PveStorage {
  storage: string;
  type: string;
  content?: string;
}

export async function getStorages(client?: AxiosInstance): Promise<PveStorage[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: PveStorage[] }>('/storage');
  return res.data.data;
}

export interface PveBridge {
  iface: string;
  type: string;
}

export async function getBridges(node?: string, client?: AxiosInstance): Promise<PveBridge[]> {
  const c = client ?? (await getClient());
  const targetNode = node ?? (await getDefaultNode(c));
  const res = await c.get<{ data: PveBridge[] }>(`/nodes/${targetNode}/network?type=bridge`);
  return res.data.data;
}

export interface PveIso {
  volid: string;
  name: string;
  size?: number;
}

/**
 * List ISO images on the given storage across all nodes, deduped by volid
 * (shared storage reports the same volids on every node).
 */
export async function getIsos(storage?: string, client?: AxiosInstance): Promise<PveIso[]> {
  const c = client ?? (await getClient());
  const isoStorage = storage ?? (await getConfig('iso_storage'));
  if (!isoStorage) throw new Error('No ISO storage configured');

  const nodes = await getNodes(c);
  const seen = new Map<string, PveIso>();

  for (const { node } of nodes) {
    try {
      const res = await c.get<{ data: Array<{ volid: string; size?: number }> }>(
        `/nodes/${node}/storage/${isoStorage}/content?content=iso`,
      );
      for (const item of res.data.data) {
        if (!seen.has(item.volid)) {
          seen.set(item.volid, {
            volid: item.volid,
            name: item.volid.split('/').pop() ?? item.volid,
            size: item.size,
          });
        }
      }
    } catch {
      // Storage may not exist on this node (node-local storage); skip it.
    }
  }

  return [...seen.values()];
}

// ─── VM lifecycle ─────────────────────────────────────────────

export async function getNextVmId(client?: AxiosInstance): Promise<number> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: string }>('/cluster/nextid');
  return parseInt(res.data.data, 10);
}

export interface CreateVmConfig {
  node: string;
  vmid: number;
  name: string;
  cores: number;
  memory: number; // MB
  diskGb: number;
  storage: string; // storage pool name
  bridge: string;
  isoStorage: string;
  iso: string; // ISO filename
}

/** Create a QEMU VM. Returns the Proxmox task UPID. */
export async function createVm(config: CreateVmConfig, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    vmid: String(config.vmid),
    name: config.name,
    cores: String(config.cores),
    sockets: '1',
    memory: String(config.memory),
    scsihw: 'virtio-scsi-pci',
    scsi0: `${config.storage}:${config.diskGb}`,
    // firewall=1 enables the per-VM Proxmox firewall on this NIC (tenant isolation).
    net0: `virtio,bridge=${config.bridge},firewall=1`,
    ide2: `${config.isoStorage}:iso/${config.iso},media=cdrom`,
    boot: 'order=scsi0;ide2',
    ostype: 'l26',
    agent: '1',
  });
  const res = await c.post<{ data: string }>(`/nodes/${config.node}/qemu`, params);
  return res.data.data;
}

// ─── Firewall / tenant isolation ──────────────────────────────

/** Get the configured gateway IP for a bridge, if any. */
export async function getBridgeGateway(
  bridge: string,
  node: string,
  client?: AxiosInstance,
): Promise<string | undefined> {
  const c = client ?? (await getClient());
  try {
    const res = await c.get<{ data: { gateway?: string } }>(`/nodes/${node}/network/${bridge}`);
    return res.data.data.gateway;
  } catch {
    return undefined;
  }
}

/** Whether the cluster-wide firewall is enabled (required for guest firewalls to take effect). */
export async function isClusterFirewallEnabled(client?: AxiosInstance): Promise<boolean> {
  const c = client ?? (await getClient());
  try {
    const res = await c.get<{ data: { enable?: number } }>('/cluster/firewall/options');
    return res.data.data.enable === 1;
  } catch {
    return false;
  }
}

/** Get a bridge's gateway and CIDR (e.g. for deriving the management subnet). */
export async function getBridgeNetwork(
  bridge: string,
  node: string,
  client?: AxiosInstance,
): Promise<{ gateway?: string; cidr?: string }> {
  const c = client ?? (await getClient());
  try {
    const res = await c.get<{ data: { gateway?: string; cidr?: string } }>(
      `/nodes/${node}/network/${bridge}`,
    );
    return { gateway: res.data.data.gateway, cidr: res.data.data.cidr };
  } catch {
    return {};
  }
}

/** Compute the network address (e.g. 192.168.50.122/24 → 192.168.50.0/24) for an IPv4 CIDR. */
export function ipv4NetworkCidr(cidr: string): string | undefined {
  const [ip, prefixStr] = cidr.split('/');
  if (!ip || !prefixStr) return undefined;
  const prefix = parseInt(prefixStr, 10);
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return undefined;
  const ipNum = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ipNum & mask) >>> 0;
  return `${net >>> 24 & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

/**
 * Enable or disable the cluster-wide firewall. When enabling, first ensure
 * management (web UI + SSH) allow-rules exist for the given source CIDRs so the
 * admin doesn't get locked out. Proxmox auto-permits cluster/corosync traffic.
 */
export async function setClusterFirewall(
  enabled: boolean,
  mgmtCidrs: string[] = [],
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());

  if (enabled) {
    // Fetch existing rules so we don't add duplicate management rules.
    let existing: Array<{ comment?: string }> = [];
    try {
      const res = await c.get<{ data: Array<{ comment?: string }> }>('/cluster/firewall/rules');
      existing = res.data.data;
    } catch {
      /* none yet */
    }
    const hasMgmt = existing.some((r) => r.comment?.includes('ProxMate: management access'));
    if (!hasMgmt) {
      for (const source of mgmtCidrs) {
        for (const dport of ['8006', '22']) {
          await c.post(
            '/cluster/firewall/rules',
            new URLSearchParams({
              type: 'in',
              action: 'ACCEPT',
              source,
              dport,
              proto: 'tcp',
              enable: '1',
              pos: '0',
              comment: 'ProxMate: management access',
            }),
          );
        }
      }
    }
    await c.put('/cluster/firewall/options', new URLSearchParams({ enable: '1' }));
  } else {
    await c.put('/cluster/firewall/options', new URLSearchParams({ enable: '0' }));
  }
}

export interface ClusterStats {
  nodes: number;
  cpu: { total: number; used: number }; // cores
  memory: { total: number; used: number }; // bytes
  storage: { total: number; used: number }; // bytes (the given disk pool)
  vmCount: number;
}

interface ClusterResource {
  type: string;
  status?: string;
  node?: string;
  storage?: string;
  shared?: number;
  maxcpu?: number;
  cpu?: number;
  maxmem?: number;
  mem?: number;
  maxdisk?: number;
  disk?: number;
}

/** Live cluster-wide capacity + usage, aggregated from /cluster/resources. */
export async function getClusterStats(
  diskPool?: string,
  client?: AxiosInstance,
): Promise<ClusterStats> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const items = res.data.data;

  const nodes = items.filter((i) => i.type === 'node' && i.status === 'online');
  const cpuTotal = nodes.reduce((s, n) => s + (n.maxcpu ?? 0), 0);
  const cpuUsed = nodes.reduce((s, n) => s + (n.cpu ?? 0) * (n.maxcpu ?? 0), 0);
  const memTotal = nodes.reduce((s, n) => s + (n.maxmem ?? 0), 0);
  const memUsed = nodes.reduce((s, n) => s + (n.mem ?? 0), 0);
  const vmCount = items.filter((i) => i.type === 'qemu' || i.type === 'lxc').length;

  // Disk pool capacity — dedupe shared storages, sum node-local ones.
  let stTotal = 0;
  let stUsed = 0;
  if (diskPool) {
    const seen = new Set<string>();
    for (const s of items.filter((i) => i.type === 'storage' && i.storage === diskPool)) {
      const key = s.shared ? s.storage! : `${s.node}:${s.storage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stTotal += s.maxdisk ?? 0;
      stUsed += s.disk ?? 0;
    }
  }

  return {
    nodes: nodes.length,
    cpu: { total: cpuTotal, used: Math.round(cpuUsed * 10) / 10 },
    memory: { total: memTotal, used: memUsed },
    storage: { total: stTotal, used: stUsed },
    vmCount,
  };
}

/**
 * Lock a VM down for tenant isolation: enable its firewall with a default-deny
 * inbound policy and outbound rules that block all RFC1918 ranges (the owner's
 * LAN, other VMs, and the Proxmox host) while still allowing the internet and
 * DNS via the gateway. Idempotent enough to re-run.
 *
 * NOTE: guest firewalls only take effect once the cluster firewall is enabled.
 */
export async function configureVmIsolation(
  node: string,
  vmid: number,
  opts: { gateway?: string } = {},
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  const base = `/nodes/${node}/qemu/${vmid}/firewall`;

  // Default-deny inbound, allow outbound (further restricted by rules below),
  // permit DHCP, and block MAC/IP spoofing.
  await c.put(
    `${base}/options`,
    new URLSearchParams({
      enable: '1',
      dhcp: '1',
      ndp: '1',
      macfilter: '1',
      ipfilter: '1',
      policy_in: 'DROP',
      policy_out: 'ACCEPT',
    }),
  );

  // Rules are evaluated top-to-bottom; first match wins, else the default policy.
  // We want DNS-to-gateway allowed before the broad RFC1918 drops, so we POST in
  // reverse with pos=0 (each insert prepends).
  const post = (params: Record<string, string>) =>
    c.post(`${base}/rules`, new URLSearchParams({ enable: '1', pos: '0', ...params }));

  for (const dest of ['192.168.0.0/16', '172.16.0.0/12', '10.0.0.0/8']) {
    await post({
      type: 'out',
      action: 'DROP',
      dest,
      comment: 'ProxMate isolation: block local/private networks',
    });
  }
  if (opts.gateway) {
    await post({ type: 'out', action: 'ACCEPT', dest: opts.gateway, proto: 'tcp', dport: '53', comment: 'ProxMate: DNS via gateway' });
    await post({ type: 'out', action: 'ACCEPT', dest: opts.gateway, proto: 'udp', dport: '53', comment: 'ProxMate: DNS via gateway' });
  }
}

export async function deleteVm(node: string, vmid: number, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.delete<{ data: string }>(`/nodes/${node}/qemu/${vmid}`);
  return res.data.data;
}

export async function startVm(node: string, vmid: number, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/status/start`);
  return res.data.data;
}

/** Graceful ACPI shutdown. */
export async function shutdownVm(node: string, vmid: number, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/status/shutdown`);
  return res.data.data;
}

/** Hard power-off. */
export async function stopVm(node: string, vmid: number, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/status/stop`);
  return res.data.data;
}

export async function rebootVm(node: string, vmid: number, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/status/reboot`);
  return res.data.data;
}

export interface PveVmStatus {
  status: string; // running | stopped
  qmpstatus?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
}

export async function getVmStatus(
  node: string,
  vmid: number,
  client?: AxiosInstance,
): Promise<PveVmStatus> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: PveVmStatus }>(`/nodes/${node}/qemu/${vmid}/status/current`);
  return res.data.data;
}
