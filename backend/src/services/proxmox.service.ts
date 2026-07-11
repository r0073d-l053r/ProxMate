import https from 'node:https';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { access, mkdir, writeFile, rename } from 'node:fs/promises';
import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { getConfig } from './config.service.js';
import { proxmoxApiErrors } from '../lib/metrics.js';

// ─── Client builder ───────────────────────────────────────────

const TIMEOUT_MS = Number(process.env['PROXMOX_TIMEOUT_MS'] ?? 15_000);
// How many times to retry a *transient* failure. Only idempotent reads are retried
// (see below) so this can never double-submit a VM create/delete.
const MAX_RETRIES = Math.max(0, Number(process.env['PROXMOX_RETRIES'] ?? 2));
const IDEMPOTENT = new Set(['get', 'head', 'options']);

type RetryConfig = InternalAxiosRequestConfig & { _retryCount?: number; _noRetry?: boolean };

function classifyError(err: AxiosError): 'timeout' | 'network' | 'http' | 'other' {
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) return 'timeout';
  if (!err.response) return 'network';
  if (err.response) return 'http';
  return 'other';
}

/**
 * Retry transient Proxmox failures (timeouts, connection errors, 5xx, 429) with
 * exponential backoff. Mutations (POST/PUT/DELETE) are NOT retried — re-sending a
 * VM-create could provision a duplicate — only idempotent reads, which are the bulk
 * of traffic (status polling, resource listing). Genuine API failures are counted
 * for /metrics; expected 4xx client errors are not.
 */
function attachRetry(client: AxiosInstance): void {
  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const cfg = error.config as RetryConfig | undefined;
    const kind = classifyError(error);
    const status = error.response?.status;
    const transient = kind === 'timeout' || kind === 'network' || (status !== undefined && (status >= 500 || status === 429));
    if (transient) proxmoxApiErrors.inc({ kind });

    if (!cfg || cfg._noRetry || !transient || !IDEMPOTENT.has((cfg.method ?? 'get').toLowerCase())) throw error;
    const attempt = (cfg._retryCount ?? 0) + 1;
    if (attempt > MAX_RETRIES) throw error;
    cfg._retryCount = attempt;
    await new Promise((r) => setTimeout(r, Math.min(2_000, 250 * 2 ** (attempt - 1))));
    return client.request(cfg);
  });
}

export function buildClient(
  host: string,
  tokenId: string,
  tokenSecret: string,
  verifySsl: boolean,
  ca?: string,
): AxiosInstance {
  const client = axios.create({
    baseURL: `${host}/api2/json`,
    headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
    // When a custom CA is supplied we keep verification ON and trust that CA —
    // the enterprise-correct alternative to disabling verification for a private
    // Proxmox cert. `ca` is ignored when rejectUnauthorized is false.
    httpsAgent: new https.Agent({ rejectUnauthorized: verifySsl, ...(ca ? { ca } : {}) }),
    timeout: TIMEOUT_MS,
  });
  attachRetry(client);
  return client;
}

/**
 * Optional custom CA (PEM) so admins can keep TLS verification ON against a
 * private Proxmox CA instead of turning verification off. Sourced from
 * `PROXMOX_CA_CERT` (inline PEM) or `PROXMOX_CA_CERT_FILE` (path to a mounted
 * PEM). Returns undefined when neither is set/readable.
 */
export function getProxmoxCa(): string | undefined {
  const inline = process.env.PROXMOX_CA_CERT;
  if (inline && inline.includes('BEGIN CERTIFICATE')) return inline;
  const file = process.env.PROXMOX_CA_CERT_FILE;
  if (file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      /* unreadable path → fall through to default trust store */
    }
  }
  return undefined;
}

export interface ProxmoxConnection {
  host: string;
  tokenId: string;
  tokenSecret: string;
  verifySsl: boolean;
  ca?: string;
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
  return { host, tokenId, tokenSecret, verifySsl: verifySslStr === 'true', ca: getProxmoxCa() };
}

/** Build a client from the Proxmox connection config stored in SystemConfig. */
export async function getClient(): Promise<AxiosInstance> {
  const c = await getConnectionConfig();
  return buildClient(c.host, c.tokenId, c.tokenSecret, c.verifySsl, c.ca);
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

export type Arch = 'amd64' | 'arm64';

/** Normalize a `uname -m` machine string to our coarse arch buckets. */
export function normalizeArch(machine?: string): Arch | 'unknown' {
  const m = (machine ?? '').toLowerCase();
  if (m === 'x86_64' || m === 'amd64') return 'amd64';
  if (m === 'aarch64' || m === 'arm64') return 'arm64';
  return 'unknown';
}

interface NodeStatus {
  'current-kernel'?: { machine?: string };
  cpuinfo?: { flags?: string; model?: string };
}

const archCache = new Map<string, Arch | 'unknown'>();
let archCacheAt = 0;
const ARCH_TTL_MS = 5 * 60_000;

/**
 * Map of node → CPU architecture (amd64 / arm64 / unknown), from each online
 * node's `current-kernel.machine`. Node arch is static, so the production path
 * (no explicit client) caches it for a few minutes. Used to keep a guest off a
 * node of the wrong architecture — running an x86 image on an ARM host (or vice
 * versa) falls back to glacial TCG emulation, or simply won't boot.
 */
export async function getNodeArchMap(client?: AxiosInstance): Promise<Map<string, Arch | 'unknown'>> {
  const useCache = !client;
  if (useCache && archCache.size > 0 && Date.now() - archCacheAt < ARCH_TTL_MS) return new Map(archCache);

  const c = client ?? (await getClient());
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const nodes = res.data.data
    .filter((i) => i.type === 'node' && i.status === 'online' && i.node)
    .map((i) => i.node!);

  const map = new Map<string, Arch | 'unknown'>();
  await Promise.all(
    nodes.map(async (node) => {
      try {
        const st = await c.get<{ data: NodeStatus }>(`/nodes/${node}/status`);
        map.set(node, normalizeArch(st.data.data['current-kernel']?.machine));
      } catch {
        map.set(node, 'unknown'); // detection failure → don't block placement on it
      }
    }),
  );

  if (useCache) {
    archCache.clear();
    for (const [k, v] of map) archCache.set(k, v);
    archCacheAt = Date.now();
  }
  return map;
}

/** Does this node-status `cpuinfo.flags` string include AVX? Undefined flags → unknown. */
export function nodeHasAvx(flags?: string): boolean | 'unknown' {
  if (!flags) return 'unknown';
  return /(?:^|\s)avx(?:\s|$)/.test(flags.toLowerCase());
}

const avxCache = new Map<string, boolean | 'unknown'>();
let avxCacheAt = 0;

/**
 * Map of node → whether its PHYSICAL CPU exposes AVX (true / false / 'unknown'),
 * read from each online node's `/status` `cpuinfo.flags`. The ProxMate IDE's
 * agent runtime needs AVX, and a guest with `cpu: host` inherits the node's
 * flags — so this answers "which nodes can host an IDE VM". Mirrors
 * {@link getNodeArchMap}: static hardware fact, cached a few minutes, and a
 * detection failure yields 'unknown' rather than disqualifying the node.
 */
export async function getNodeAvxMap(client?: AxiosInstance): Promise<Map<string, boolean | 'unknown'>> {
  const useCache = !client;
  if (useCache && avxCache.size > 0 && Date.now() - avxCacheAt < ARCH_TTL_MS) return new Map(avxCache);

  const c = client ?? (await getClient());
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const nodes = res.data.data
    .filter((i) => i.type === 'node' && i.status === 'online' && i.node)
    .map((i) => i.node!);

  const map = new Map<string, boolean | 'unknown'>();
  await Promise.all(
    nodes.map(async (node) => {
      try {
        const st = await c.get<{ data: NodeStatus }>(`/nodes/${node}/status`);
        map.set(node, nodeHasAvx(st.data.data.cpuinfo?.flags));
      } catch {
        map.set(node, 'unknown');
      }
    }),
  );

  if (useCache) {
    avxCache.clear();
    for (const [k, v] of map) avxCache.set(k, v);
    avxCacheAt = Date.now();
  }
  return map;
}

export interface NodePlacement {
  node: string;
  score: number;
  freeCpu: number; // cores
  freeMemBytes: number;
  freeDiskBytes: number | null; // for the chosen pool on that node; null if unknown
  fits: boolean;
}

/**
 * Auto-schedule: pick the online node with the best available capacity for a
 * requested VM. Ranks by free RAM (weighted highest), free CPU, and — when the
 * target disk pool is node-local — free pool space. Nodes that can actually fit
 * the request get a large bonus so we prefer them, but we never hard-fail (so a
 * node is always returned even under memory overcommit). Used when the caller
 * doesn't pin a node (e.g. tenants, whose node dropdown is hidden).
 */
export async function pickBestNode(
  want: { cpu: number; ramMb: number; storageGb: number },
  storagePool?: string,
  client?: AxiosInstance,
  candidateNodes?: string[],
  arch?: Arch,
): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const items = res.data.data;

  let nodes = items.filter((i) => i.type === 'node' && i.status === 'online' && i.node);
  if (nodes.length === 0) throw new Error('No online Proxmox nodes available');

  const wantMem = want.ramMb * 1024 * 1024;
  const wantDisk = want.storageGb * 1024 * 1024 * 1024;

  // Per-node free space for the chosen pool (node-local pools like local-lvm).
  const poolByNode = new Map<string, { free: number; total: number }>();
  if (storagePool) {
    for (const s of items.filter((i) => i.type === 'storage' && i.storage === storagePool && i.node)) {
      if (s.status && s.status !== 'available') continue;
      poolByNode.set(s.node!, { free: Math.max(0, (s.maxdisk ?? 0) - (s.disk ?? 0)), total: s.maxdisk ?? 0 });
    }
  }

  // Only place where the VM can actually be built: the node must be in the
  // caller's candidate set (e.g. nodes that physically hold the install ISO) AND,
  // when a node-local disk pool is requested, must actually have that pool. (If
  // the pool isn't reported on any node we don't filter on it — better to try
  // than to block creation outright.)
  if (candidateNodes) nodes = nodes.filter((n) => candidateNodes.includes(n.node!));
  if (storagePool && poolByNode.size > 0) nodes = nodes.filter((n) => poolByNode.has(n.node!));
  if (nodes.length === 0) {
    throw new Error('No eligible node has both the install ISO and the configured disk pool');
  }

  // Architecture guardrail: never place a guest on a node of the wrong CPU arch.
  // Nodes whose arch can't be detected are left in (fail-open); we only error
  // when every remaining candidate is a *known* mismatch.
  if (arch) {
    const archMap = await getNodeArchMap(c);
    const matching = nodes.filter((n) => {
      const a = archMap.get(n.node!);
      return a === arch || a === 'unknown' || a === undefined;
    });
    if (matching.length === 0) {
      const detail = nodes.map((n) => `${n.node}=${archMap.get(n.node!) ?? 'unknown'}`).join(', ');
      throw new Error(`No ${arch} node is available to run this image (candidates: ${detail}).`);
    }
    nodes = matching;
  }

  const scored: NodePlacement[] = nodes.map((n) => {
    const maxcpu = n.maxcpu ?? 0;
    const freeCpu = Math.max(0, maxcpu - (n.cpu ?? 0) * maxcpu);
    const freeMem = Math.max(0, (n.maxmem ?? 0) - (n.mem ?? 0));
    const pool = n.node ? poolByNode.get(n.node) : undefined;
    const hasDisk = !!pool && pool.total > 0;
    const freeDisk = pool ? pool.free : null;

    const memFrac = n.maxmem ? freeMem / n.maxmem : 0;
    const cpuFrac = maxcpu ? freeCpu / maxcpu : 0;
    const diskFrac = hasDisk ? pool!.free / pool!.total : 0;

    let score = hasDisk
      ? memFrac * 0.5 + cpuFrac * 0.35 + diskFrac * 0.15
      : memFrac * 0.6 + cpuFrac * 0.4;

    const fits = freeMem >= wantMem && freeCpu >= want.cpu && (freeDisk === null || freeDisk >= wantDisk);
    if (fits) score += 1; // strongly prefer nodes that can actually hold the VM

    return { node: n.node!, score, freeCpu, freeMemBytes: freeMem, freeDiskBytes: freeDisk, fits };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  console.log(
    `[scheduler] placed VM (cpu=${want.cpu}, ram=${want.ramMb}MB, disk=${want.storageGb}GB) on ${best.node} ` +
      `(fits=${best.fits}, freeCpu=${best.freeCpu.toFixed(1)}, freeMem=${Math.round(best.freeMemBytes / 1024 / 1024)}MB)`,
  );
  return best.node;
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

/**
 * Which online nodes can actually serve a given ISO volume. Node-local ISO
 * storage (e.g. `local`) only holds the file on the node it was uploaded to, so
 * a VM referencing `<storage>:iso/<name>` can only be built where that file
 * physically exists; shared ISO storage returns every node. Used to constrain
 * auto-placement so a VM is never scheduled onto a node missing its install
 * media (which Proxmox rejects asynchronously).
 */
export async function getIsoNodes(
  isoStorage: string,
  iso: string,
  client?: AxiosInstance,
): Promise<string[]> {
  const c = client ?? (await getClient());
  const volid = `${isoStorage}:iso/${iso}`;
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const nodeNames = res.data.data
    .filter((i) => i.type === 'node' && i.status === 'online' && i.node)
    .map((i) => i.node!);

  const result: string[] = [];
  for (const node of nodeNames) {
    try {
      const content = await c.get<{ data: Array<{ volid: string }> }>(
        `/nodes/${node}/storage/${isoStorage}/content?content=iso`,
      );
      if (content.data.data?.some((i) => i.volid === volid)) result.push(node);
    } catch {
      // ISO storage not present/readable on this node → not a candidate.
    }
  }
  return result;
}

/** Storages on a node that accept disk images for `import-from` (content includes `import`). */
export async function getImportStorages(node: string, client?: AxiosInstance): Promise<string[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Array<{ storage: string; content?: string; active?: number }> }>(
    `/nodes/${node}/storage`,
  );
  return res.data.data
    .filter((s) => s.active !== 0 && (s.content ?? '').split(',').includes('import'))
    .map((s) => s.storage);
}

/**
 * Download a file (e.g. a cloud image) from a URL into a storage. Returns the
 * Proxmox task UPID. Cloud images must be stored with `content=import` and a
 * disk-image extension (`.qcow2`) so they can later be used with `import-from`.
 */
export async function downloadUrlToStorage(
  node: string,
  storage: string,
  opts: { url: string; filename: string; content?: string; checksum?: string; checksumAlgorithm?: string },
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    content: opts.content ?? 'import',
    url: opts.url,
    filename: opts.filename,
  });
  if (opts.checksum) {
    params.set('checksum', opts.checksum);
    params.set('checksum-algorithm', opts.checksumAlgorithm ?? 'sha256');
  }
  const res = await c.post<{ data: string }>(`/nodes/${node}/storage/${storage}/download-url`, params);
  return res.data.data;
}

/** Delete a storage volume by volid (e.g. a downloaded import image after it's imported). */
export async function deleteStorageVolume(node: string, volid: string, client?: AxiosInstance): Promise<void> {
  const c = client ?? (await getClient());
  const storage = volid.split(':')[0];
  await c.delete(`/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`);
}

// ─── Guest kind (QEMU VM vs LXC container) ────────────────────
//
// Almost every per-guest Proxmox endpoint is /nodes/{node}/{qemu|lxc}/{vmid}/…
// The shared lifecycle helpers below take an optional trailing `kind` (default
// 'qemu', so existing QEMU callers are unchanged). The GuestKind values are
// exactly the path segments, so they're interpolated directly.
export type GuestKind = 'qemu' | 'lxc';

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

// ─── LXC containers ───────────────────────────────────────────

export interface CreateLxcConfig {
  node: string;
  vmid: number;
  hostname: string;
  cores: number;
  memory: number; // MB
  swap?: number; // MB (default 512)
  diskGb: number;
  storage: string; // rootfs storage pool
  bridge: string;
  ostemplate: string; // full volid, e.g. "local:vztmpl/debian-12-standard_….tar.zst"
  password?: string;
  sshPublicKeys?: string; // OpenSSH public key(s)
  unprivileged?: boolean; // default true
}

/**
 * Create an LXC container. Returns the Proxmox task UPID. The NIC carries
 * `firewall=1` so tenant isolation (configureVmIsolation) applies before it ever
 * boots — same model as QEMU VMs. Started separately (start=0) so isolation can
 * be locked down first.
 */
export async function createLxc(config: CreateLxcConfig, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    vmid: String(config.vmid),
    hostname: config.hostname,
    cores: String(config.cores),
    memory: String(config.memory),
    swap: String(config.swap ?? 512),
    rootfs: `${config.storage}:${config.diskGb}`,
    // firewall=1 enables the per-NIC Proxmox firewall (tenant isolation).
    net0: `name=eth0,bridge=${config.bridge},firewall=1,ip=dhcp`,
    ostemplate: config.ostemplate,
    unprivileged: config.unprivileged === false ? '0' : '1',
    start: '0',
  });
  if (config.password) params.set('password', config.password);
  if (config.sshPublicKeys) params.set('ssh-public-keys', config.sshPublicKeys);
  const res = await c.post<{ data: string }>(`/nodes/${config.node}/lxc`, params);
  return res.data.data;
}

export interface PveLxcTemplate {
  volid: string; // e.g. "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst"
  name: string; // filename portion
  storage: string;
  size?: number;
}

/**
 * List LXC OS templates (vztmpl content) across the cluster, deduped by volid.
 * Admins add these via Proxmox `pveam` / the UI, just like ISOs. Scans every
 * storage that advertises `vztmpl` content on each node.
 */
export async function listLxcTemplates(client?: AxiosInstance): Promise<PveLxcTemplate[]> {
  const c = client ?? (await getClient());
  const [nodes, storages] = await Promise.all([getNodes(c), getStorages(c)]);
  const tmplStorages = storages.filter((s) => (s.content ?? '').split(',').includes('vztmpl')).map((s) => s.storage);
  const seen = new Map<string, PveLxcTemplate>();

  for (const { node } of nodes) {
    for (const storage of tmplStorages) {
      try {
        const res = await c.get<{ data: Array<{ volid: string; size?: number }> }>(
          `/nodes/${node}/storage/${storage}/content?content=vztmpl`,
        );
        for (const item of res.data.data) {
          if (!seen.has(item.volid)) {
            seen.set(item.volid, {
              volid: item.volid,
              name: item.volid.split('/').pop() ?? item.volid,
              storage,
              size: item.size,
            });
          }
        }
      } catch {
        // Storage not present/readable on this node (node-local storage) — skip.
      }
    }
  }
  return [...seen.values()];
}

/**
 * Which online nodes physically hold a given LXC template volume. Mirrors
 * getIsoNodes: node-local template storage (e.g. `local`) only holds the file on
 * the node it was downloaded to, so an LXC referencing it can only be built
 * there; shared storage returns every node. Constrains auto-placement.
 */
export async function getTemplateNodes(volid: string, client?: AxiosInstance): Promise<string[]> {
  const c = client ?? (await getClient());
  const storage = volid.split(':')[0];
  if (!storage) return [];
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const nodeNames = res.data.data
    .filter((i) => i.type === 'node' && i.status === 'online' && i.node)
    .map((i) => i.node!);

  const result: string[] = [];
  for (const node of nodeNames) {
    try {
      const content = await c.get<{ data: Array<{ volid: string }> }>(
        `/nodes/${node}/storage/${storage}/content?content=vztmpl`,
      );
      if (content.data.data?.some((i) => i.volid === volid)) result.push(node);
    } catch {
      // template storage not present/readable on this node → not a candidate.
    }
  }
  return result;
}

/** Both addresses we surface for a guest: the LAN IP and (if present) Tailscale's. */
export interface GuestIps {
  ip: string | null;
  tailscaleIp: string | null;
}

/**
 * True for addresses in Tailscale's CGNAT range, 100.64.0.0/10 (second octet
 * 64–127). Used to keep a guest's tailnet address out of the "IP address" field
 * and surface it separately — otherwise a running Tailscale can shadow the LAN IP.
 */
export function isTailscaleIp(ip: string): boolean {
  const m = ip.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

const isTailscaleIface = (name?: string) => (name ?? '').toLowerCase().startsWith('tailscale');

/**
 * Best-effort LXC container IPs (no guest agent needed — Proxmox reads them from
 * the container's network namespace). Returns the first non-loopback IPv4 as the
 * LAN address, plus the Tailscale address (by interface name or CGNAT range).
 */
export async function getLxcIps(node: string, vmid: number, client?: AxiosInstance): Promise<GuestIps> {
  const c = client ?? (await getClient());
  try {
    const res = await c.get<{ data: Array<{ name?: string; inet?: string }> }>(
      `/nodes/${node}/lxc/${vmid}/interfaces`,
      { timeout: 2000 },
    );
    let lan: string | null = null;
    let ts: string | null = null;
    for (const iface of res.data.data ?? []) {
      if (iface.name === 'lo') continue;
      // `inet` is a CIDR like "192.168.50.40/24"; strip the prefix.
      const ip = iface.inet?.split('/')[0];
      if (!ip || ip.startsWith('127.')) continue;
      if (isTailscaleIface(iface.name) || isTailscaleIp(ip)) {
        if (!ts) ts = ip;
      } else if (!lan) {
        lan = ip;
      }
    }
    return { ip: lan, tailscaleIp: ts };
  } catch {
    return { ip: null, tailscaleIp: null }; // container stopped, or interfaces unavailable
  }
}

export interface CloudInitVmConfig {
  node: string;
  vmid: number;
  name: string;
  importFrom: string; // e.g. "local:import/debian-12.qcow2"
  diskStorage: string; // where the imported disk + cloudinit drive live
  bridge: string;
  cores?: number;
  memory?: number; // MB
}

/**
 * Create a cloud-init-ready VM by importing a downloaded cloud image as the boot
 * disk and attaching a cloud-init drive + serial console. Meant to be converted
 * to a template afterwards. Returns the Proxmox task UPID.
 */
export async function createCloudInitVm(config: CloudInitVmConfig, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    vmid: String(config.vmid),
    name: config.name,
    cores: String(config.cores ?? 1),
    sockets: '1',
    memory: String(config.memory ?? 1024),
    scsihw: 'virtio-scsi-pci',
    // import-from converts the cloud image into the VM's primary disk.
    scsi0: `${config.diskStorage}:0,import-from=${config.importFrom}`,
    ide2: `${config.diskStorage}:cloudinit`,
    net0: `virtio,bridge=${config.bridge},firewall=1`,
    // Keep a serial port available (boot logs / `qm terminal`), but use a normal
    // VGA display so ProxMate's noVNC console shows a usable login terminal
    // instead of the "starting serial terminal" placeholder.
    serial0: 'socket',
    vga: 'std',
    boot: 'order=scsi0',
    ostype: 'l26',
    agent: '1',
  });
  const res = await c.post<{ data: string }>(`/nodes/${config.node}/qemu`, params);
  return res.data.data;
}

/** True if a VM config carries a cloud-init drive (so it's cloud-init capable). */
export function isCloudInitTemplate(config: Record<string, string>): boolean {
  return Object.values(config).some((v) => v.includes('cloudinit'));
}

/**
 * Set per-VM cloud-init parameters (applied on next boot). NOTE: Proxmox expects
 * `sshkeys` to be URL-encoded by the caller (it un-escapes it when generating the
 * cloud-init config), so we encode it explicitly on top of normal form-encoding.
 */
export async function setCloudInitConfig(
  node: string,
  vmid: number,
  opts: { ciuser?: string; cipassword?: string; sshKeys?: string; ipConfig?: string; vendorSnippet?: string },
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams();
  if (opts.ciuser) params.set('ciuser', opts.ciuser);
  if (opts.cipassword) params.set('cipassword', opts.cipassword);
  if (opts.sshKeys) params.set('sshkeys', encodeURIComponent(opts.sshKeys));
  // vendor-data MERGES with the generated user-data (ciuser/sshkeys still apply),
  // unlike a `user=` snippet which would replace it — that's why we use vendor.
  if (opts.vendorSnippet) params.set('cicustom', `vendor=${opts.vendorSnippet}`);
  params.set('ipconfig0', opts.ipConfig ?? 'ip=dhcp');
  await c.put(`/nodes/${node}/qemu/${vmid}/config`, params);
}

// ─── Cloud-init "extras" snippets (install Docker / Tailscale on boot) ───
//
// Each optional install is a cloud-init VENDOR-data snippet (merges with the
// SSH-key/user ProxMate injects, unlike a `user=` snippet which replaces it).
// Proxmox allows only ONE vendor snippet per VM, so a multi-feature deploy uses
// a *combined* snippet whose filename is the sorted feature ids joined by "-".
// The Proxmox API can't create snippet files, so admins place them once.

export interface CloudInitFeature {
  id: string;
  label: string;
  hint: string; // shown next to the toggle
  packages: string[];
  runcmd: string[];
}

export const CLOUD_INIT_FEATURES: CloudInitFeature[] = [
  {
    id: 'docker',
    label: 'Install Docker',
    hint: 'Installs Docker Engine on first boot and adds your user to the docker group.',
    packages: ['curl'],
    runcmd: [
      'curl -fsSL https://get.docker.com | sh',
      'systemctl enable --now docker 2>/dev/null || true',
      'usermod -aG docker $(id -nu 1000) 2>/dev/null || true',
    ],
  },
  {
    id: 'tailscale',
    label: 'Install Tailscale',
    hint: 'Installs Tailscale on first boot. SSH in and run `sudo tailscale up --ssh` to connect.',
    packages: ['curl'],
    runcmd: [
      'curl -fsSL https://tailscale.com/install.sh | sh',
      'systemctl enable --now tailscaled 2>/dev/null || true',
    ],
  },
  {
    id: 'guest-agent',
    label: 'Install QEMU guest agent',
    hint: "Lets ProxMate show the VM's IP address and shut it down cleanly. Recommended.",
    packages: ['qemu-guest-agent'],
    runcmd: ['systemctl enable --now qemu-guest-agent 2>/dev/null || true'],
  },
  {
    // superfile (spf) is a TUI file manager (github.com/yorukot/superfile) — it
    // runs in the terminal, so it works on headless VMs (unlike a GUI app).
    // Installed from a pinned GitHub release binary: there is no version-less
    // "latest" asset URL, so the version is pinned here and bumped in code when
    // updating. The command uses only double quotes → the generated YAML runcmd
    // stays valid with standard escaping.
    id: 'superfile',
    label: 'Install Superfile',
    hint: 'Installs superfile (spf), a terminal file manager (github.com/yorukot/superfile). Launch it by typing `spf`.',
    packages: ['curl', 'ca-certificates', 'tar'],
    runcmd: [
      'ARCH=$(dpkg --print-architecture) && curl -fsSL "https://github.com/yorukot/superfile/releases/download/v1.6.0/superfile-linux-v1.6.0-$ARCH.tar.gz" -o /tmp/superfile.tar.gz && mkdir -p /tmp/superfile && tar -xzf /tmp/superfile.tar.gz -C /tmp/superfile && install -m 0755 "$(find /tmp/superfile -type f -name spf | head -1)" /usr/local/bin/spf && rm -rf /tmp/superfile /tmp/superfile.tar.gz',
    ],
  },
  {
    id: 'cockpit',
    label: 'Install Cockpit',
    hint: 'Web admin console (services, logs, terminal, updates) on port 9090. Reach it over Tailscale.',
    packages: ['cockpit'],
    runcmd: ['systemctl enable --now cockpit.socket 2>/dev/null || true'],
  },
  {
    id: 'netdata',
    label: 'Install Netdata',
    hint: 'Real-time monitoring dashboard on port 19999. Reach it over Tailscale.',
    packages: ['netdata'],
    runcmd: ['systemctl enable --now netdata 2>/dev/null || true'],
  },
  {
    // Official Caddy APT repo (cloudsmith) — sets up the caddy service + user +
    // /etc/caddy/Caddyfile. The curls only fetch data (key + sources.list), no
    // remote script execution.
    id: 'caddy',
    label: 'Install Caddy',
    hint: 'Caddy web server with automatic HTTPS (caddyserver.com). Runs as a service; edit /etc/caddy/Caddyfile.',
    packages: ['debian-keyring', 'debian-archive-keyring', 'apt-transport-https', 'curl', 'gnupg'],
    runcmd: [
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list",
      'apt-get update && apt-get install -y caddy',
      'systemctl enable --now caddy 2>/dev/null || true',
    ],
  },
  {
    // VS Code in the browser, from the project's pinned GitHub .deb (bump the
    // version to update). Enabled for the cloud-init tenant user (uid 1000).
    id: 'code-server',
    label: 'Install code-server',
    hint: 'VS Code in the browser on port 8080 (github.com/coder/code-server). Binds localhost — reach it via an SSH tunnel, or set bind-addr and pair with Tailscale. Password is in ~/.config/code-server/config.yaml.',
    packages: ['curl', 'ca-certificates'],
    runcmd: [
      'ARCH=$(dpkg --print-architecture) && curl -fsSL "https://github.com/coder/code-server/releases/download/v4.127.0/code-server_4.127.0_$ARCH.deb" -o /tmp/code-server.deb && apt-get install -y /tmp/code-server.deb && rm -f /tmp/code-server.deb',
      'systemctl enable --now code-server@$(id -nu 1000) 2>/dev/null || true',
    ],
  },
];

/**
 * Always-on base: installed on EVERY cloud-init VM (not shown as checkboxes),
 * folded into the generated vendor snippet. Only applied when on-demand snippet
 * writing is configured (see `ensureCloudInitSnippet`) — that's what makes a
 * mandatory base practical without exponential manual placement.
 */
export const CLOUD_INIT_BASE: CloudInitFeature[] = [
  {
    id: 'unattended-upgrades',
    label: 'Automatic security updates',
    hint: 'Installs + enables unattended-upgrades so security patches apply automatically.',
    packages: ['unattended-upgrades'],
    runcmd: [
      "{ echo 'APT::Periodic::Update-Package-Lists \"1\";'; echo 'APT::Periodic::Unattended-Upgrade \"1\";'; } > /etc/apt/apt.conf.d/20auto-upgrades",
      'systemctl enable --now unattended-upgrades 2>/dev/null || true',
    ],
  },
  {
    id: 'fail2ban',
    label: 'SSH brute-force protection (fail2ban)',
    hint: 'Installs fail2ban to ban IPs after repeated failed SSH logins.',
    packages: ['fail2ban'],
    runcmd: ['systemctl enable --now fail2ban 2>/dev/null || true'],
  },
  {
    id: 'btop',
    label: 'Resource monitor (btop)',
    hint: 'Installs btop, a terminal resource monitor. Launch it by typing `btop`.',
    packages: ['btop'],
    runcmd: [],
  },
];

// ── The catalog + defaults ──
// The two lists above are just source data. Everything resolves against the
// combined CATALOG; which features are OFFERED to tenants (checkboxes) and which
// are ALWAYS-ON (installed on every VM) are ADMIN choices stored in config — see
// template.service (getOfferedFeatureIds / getBaseFeatureIds). The constants
// below are only the defaults for a fresh install.
export const CLOUD_INIT_CATALOG: CloudInitFeature[] = [...CLOUD_INIT_FEATURES, ...CLOUD_INIT_BASE];

/** Default tenant-offered options for a fresh install (admin overrides in the Template Store). */
export const DEFAULT_OFFERED_IDS = CLOUD_INIT_FEATURES.map((f) => f.id);

/** Suggested always-on base the setup wizard pre-selects (admin confirms or changes). */
export const RECOMMENDED_BASE_IDS = CLOUD_INIT_BASE.map((f) => f.id);

/** Snippet filename for a feature combo, e.g. ['tailscale','docker'] → proxmate-docker-tailscale.yaml */
export function cloudInitSnippetFile(featureIds: string[]): string {
  return `proxmate-${[...featureIds].sort().join('-')}.yaml`;
}

/** The cloud-config vendor-data body for a feature combo (packages deduped, runcmd concatenated). */
export function cloudInitSnippetContent(featureIds: string[]): string {
  const ids = [...featureIds].sort();
  // Resolve ids against the whole catalog (offered + base tools are one pool).
  const feats = CLOUD_INIT_CATALOG.filter((f) => ids.includes(f.id));
  const packages = [...new Set(feats.flatMap((f) => f.packages))];
  const runcmd = feats.flatMap((f) => f.runcmd);
  return [
    '#cloud-config',
    `# Managed by ProxMate — cloud-init vendor-data (${ids.join(', ')}).`,
    'package_update: true',
    'packages:',
    ...packages.map((p) => `  - ${p}`),
    'runcmd:',
    ...runcmd.map((c) => `  - [ sh, -c, ${JSON.stringify(c)} ]`),
    '',
  ].join('\n');
}

// Kept so the original Docker snippet filename is unchanged (already placed by admins).
export const DOCKER_SNIPPET_FILE = cloudInitSnippetFile(['docker']);

/**
 * On-demand snippet writing. The Proxmox API has no endpoint to create a snippet
 * file, so the historical model is "admin hand-places one file per feature combo
 * on every node" — which is 2ⁿ−1 files and doesn't scale. Instead, point ProxMate
 * at a **shared** storage whose `snippets/` directory is bind-mounted (writable)
 * into this container, and it writes the exact combo a deploy needs, when it needs
 * it. Configured via env (deployment infra, like `BACKUP_DOWNLOAD_DIR`):
 *   SNIPPET_DIR     — the writable container path (the storage's snippets/ dir)
 *   SNIPPET_STORAGE — the Proxmox storage id, for the cicustom volid
 * Unset ⇒ the feature is off and callers fall back to the pre-placed-file path.
 */
export function snippetWriteConfig(): { dir: string; storage: string } | null {
  const dir = process.env['SNIPPET_DIR'];
  const storage = process.env['SNIPPET_STORAGE'];
  return dir && storage ? { dir, storage } : null;
}

/**
 * Ensure the vendor-data snippet for a feature combo exists on the writable
 * snippet storage, writing it on demand (atomic via temp+rename, idempotent since
 * a combo's content is deterministic). Returns the cicustom volid
 * (`<storage>:snippets/<file>`), or null when on-demand writing isn't configured.
 * The content comes only from the fixed feature list — never tenant input — so
 * there is no injection surface in what gets written.
 */
export async function ensureCloudInitSnippet(featureIds: string[]): Promise<string | null> {
  const cfg = snippetWriteConfig();
  if (!cfg) return null;
  const file = cloudInitSnippetFile(featureIds);
  const target = path.join(cfg.dir, file);
  try {
    await access(target); // already present → reuse
  } catch {
    await mkdir(cfg.dir, { recursive: true }).catch(() => undefined);
    const tmp = path.join(cfg.dir, `.${file}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, cloudInitSnippetContent(featureIds), { mode: 0o644 });
    await rename(tmp, target); // atomic — Proxmox never reads a half-written file
  }
  return `${cfg.storage}:snippets/${file}`;
}

/** Ensure a (directory/file) storage has the `snippets` content type enabled. */
export async function ensureSnippetsEnabled(storage: string, client?: AxiosInstance): Promise<void> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Array<{ storage: string; content?: string }> }>('/storage');
  const s = res.data.data.find((x) => x.storage === storage);
  if (!s) throw new Error(`Storage "${storage}" not found`);
  const content = (s.content ?? '').split(',').filter(Boolean);
  if (content.includes('snippets')) return;
  await c.put(`/storage/${storage}`, new URLSearchParams({ content: [...content, 'snippets'].join(',') }));
}

/** Filesystem path of a storage (for showing the admin where to drop a snippet). */
export async function getStoragePath(storage: string, client?: AxiosInstance): Promise<string | undefined> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Array<{ storage: string; path?: string }> }>('/storage');
  return res.data.data.find((x) => x.storage === storage)?.path ?? undefined;
}

/** Online nodes that physically have a given snippet file on a storage. */
export async function nodesWithSnippet(
  storage: string,
  filename: string,
  client?: AxiosInstance,
): Promise<string[]> {
  const c = client ?? (await getClient());
  const volid = `${storage}:snippets/${filename}`;
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const nodeNames = res.data.data
    .filter((i) => i.type === 'node' && i.status === 'online' && i.node)
    .map((i) => i.node!);
  const out: string[] = [];
  for (const node of nodeNames) {
    try {
      const r = await c.get<{ data: Array<{ volid: string }> }>(
        `/nodes/${node}/storage/${storage}/content?content=snippets`,
      );
      if (r.data.data?.some((x) => x.volid === volid)) out.push(node);
    } catch {
      // snippets not enabled / not present on this node
    }
  }
  return out;
}

// ─── Templates & cloning ──────────────────────────────────────

export interface PveTemplate {
  vmid: number;
  node: string;
  name: string;
  maxdisk?: number; // bytes
}

/** List all Proxmox VM templates (template=1) across the cluster. */
export async function getTemplates(client?: AxiosInstance): Promise<PveTemplate[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Array<ClusterResource & { template?: number; vmid?: number; name?: string }> }>(
    '/cluster/resources?type=vm',
  );
  return res.data.data
    .filter((r) => r.type === 'qemu' && r.template === 1 && r.vmid && r.node)
    .map((r) => ({ vmid: r.vmid!, node: r.node!, name: r.name ?? `vm-${r.vmid}`, maxdisk: r.maxdisk }));
}

/** Convert an existing (stopped) VM into a template. */
export async function convertToTemplate(node: string, vmid: number, client?: AxiosInstance): Promise<void> {
  const c = client ?? (await getClient());
  await c.post(`/nodes/${node}/qemu/${vmid}/template`);
}

/** Clone a template into a new VM. Returns the Proxmox task UPID. */
export async function cloneVm(
  opts: { node: string; templateVmid: number; newVmid: number; name: string; full?: boolean; storage?: string },
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    newid: String(opts.newVmid),
    name: opts.name,
    full: opts.full ? '1' : '0',
  });
  if (opts.full && opts.storage) params.set('storage', opts.storage);
  const res = await c.post<{ data: string }>(
    `/nodes/${opts.node}/qemu/${opts.templateVmid}/clone`,
    params,
  );
  return res.data.data;
}

/** Poll a Proxmox task (UPID) until it finishes; throws if it failed. */
export async function waitForTask(
  node: string,
  upid: string,
  client?: AxiosInstance,
  timeoutMs = 180_000,
): Promise<void> {
  const c = client ?? (await getClient());
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await c.get<{ data: { status: string; exitstatus?: string } }>(
      `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
    );
    const { status, exitstatus } = res.data.data;
    if (status === 'stopped') {
      // Proxmox marks a fully-successful task "OK" and a task that completed with
      // non-fatal warnings "WARNINGS: N" — the latter is a success (common for LXC
      // creates and vzdump backups). Anything else is a genuine failure.
      if (exitstatus && exitstatus !== 'OK' && !exitstatus.startsWith('WARNINGS')) {
        throw new Error(`Proxmox task failed: ${exitstatus}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Proxmox task timed out');
}

/** Update a guest's CPU cores and memory (MB). Works for both QEMU and LXC. */
export async function setVmResources(
  node: string,
  vmid: number,
  cores: number,
  memory: number,
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(
    `/nodes/${node}/${kind}/${vmid}/config`,
    new URLSearchParams({ cores: String(cores), memory: String(memory) }),
  );
}

/** Set a VM's display name (the Proxmox `name`/hostname config field). */
export async function setVmName(
  node: string,
  vmid: number,
  name: string,
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<void> {
  const c = client ?? (await getClient());
  // QEMU calls it `name`; LXC calls it `hostname`.
  const key = kind === 'lxc' ? 'hostname' : 'name';
  await c.put(`/nodes/${node}/${kind}/${vmid}/config`, new URLSearchParams({ [key]: name }));
}

/** Grow a guest disk to an absolute size in GB (Proxmox only supports growing).
 *  For LXC the disk is `rootfs`; for QEMU a slot like `scsi0`. */
export async function resizeDisk(
  node: string,
  vmid: number,
  disk: string,
  sizeGb: number,
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(
    `/nodes/${node}/${kind}/${vmid}/resize`,
    new URLSearchParams({ disk, size: `${sizeGb}G` }),
  );
}

/** Allocate + attach a new disk at `slot` (e.g. "scsi1"), `sizeGb` GB, on `storage`. */
export async function attachDisk(
  node: string,
  vmid: number,
  slot: string,
  storage: string,
  sizeGb: number,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(
    `/nodes/${node}/qemu/${vmid}/config`,
    new URLSearchParams({ [slot]: `${storage}:${sizeGb}` }),
  );
}

/**
 * Detach a disk slot and destroy the volume it freed. Proxmox detach moves the
 * volume to an `unusedN` entry; we delete only the entry that *this* detach
 * created (captured by diffing the unused keys) so a pre-existing unused volume
 * is never touched.
 */
export async function removeDisk(node: string, vmid: number, slot: string, client?: AxiosInstance): Promise<void> {
  const c = client ?? (await getClient());
  const before = new Set(
    Object.keys(await getVmConfig(node, vmid, c)).filter((k) => /^unused\d+$/.test(k)),
  );
  await c.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ delete: slot }));
  const after = await getVmConfig(node, vmid, c);
  const freed = Object.keys(after).find((k) => /^unused\d+$/.test(k) && !before.has(k));
  if (freed) {
    await c.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ delete: freed }));
  }
}

/**
 * Nodes a running VM may be live-migrated to, per Proxmox's own migrate preflight
 * (`GET .../migrate` → `allowed_nodes`). An empty array means nowhere — e.g. the
 * guest's disks live on a node-local storage no other node has (a local ZFS pool
 * like `tank`), which Proxmox refuses to migrate. Returns `null` when the preflight
 * can't be read, so callers fail *open* (treat the VM as movable) rather than
 * wrongly pinning it.
 */
export async function migratableTargets(
  node: string,
  vmid: number,
  client?: AxiosInstance,
): Promise<string[] | null> {
  const c = client ?? (await getClient());
  try {
    const r = await c.get<{ data: { allowed_nodes?: string[] } }>(`/nodes/${node}/qemu/${vmid}/migrate`);
    return r.data.data.allowed_nodes ?? [];
  } catch {
    return null;
  }
}

/**
 * Migrate a VM to another node; `online` for a live migration of a running
 * guest. `opts.targetstorage` (offline migration) relocates every local disk
 * onto that storage on the target node — required when the source disks live on
 * storage the target doesn't have (e.g. a node-local ZFS pool). Returns the
 * task UPID.
 */
export async function migrateVm(
  node: string,
  vmid: number,
  target: string,
  online: boolean,
  client?: AxiosInstance,
  opts: { targetstorage?: string } = {},
): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({ target });
  if (online) {
    params.set('online', '1');
    // Allow live migration even when the guest sits on node-local storage
    // (local-lvm, local ZFS, …): Proxmox copies the disk during the move instead
    // of refusing. A no-op for VMs already on shared storage (Ceph/NFS), where
    // only RAM transfers. Same-named storage on the target is assumed.
    params.set('with-local-disks', '1');
  }
  // Storage relocation. Live migration mirrors disks over NBD, which works
  // across storage TYPES (zfs → nfs, lvm → dir, …); offline migration instead
  // needs a common export/import format between the two storage types, so
  // offline callers should prefer a same-type target storage.
  if (opts.targetstorage) params.set('targetstorage', opts.targetstorage);
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/migrate`, params);
  return res.data.data;
}

// ─── Migration progress (for an admin-facing loading bar) ────

export interface MigrationProgress {
  /** 0-100, aggregated across every disk the migration is transferring. */
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  /** Longest elapsed time reported across the migration's disk transfers. */
  elapsedSeconds: number;
  /** Estimated remaining seconds, or null until there's enough data to project. */
  etaSeconds: number | null;
}

const LOG_SIZE_UNITS: Record<string, number> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** Parse a Proxmox log size like "512.0 GiB" / "309.0 MiB" into bytes. */
function parseLogSize(value: string, unit: string): number {
  return Number(value) * (LOG_SIZE_UNITS[unit.toLowerCase()] ?? 1);
}

/** Parse a Proxmox log elapsed-time like "1h 2m 3s" / "3m 4s" / "12s" into seconds. */
function parseLogElapsed(text: string): number {
  const m = /(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/.exec(text.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

// A leading "YYYY-MM-DD HH:MM:SS " timestamp precedes some (not all) log lines.
const LOG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+/;

// Matches Proxmox's per-disk migration progress lines, one per drive, e.g.:
//   "drive-scsi0: transferred 1.0 GiB of 8.0 GiB (12.88%) in 12s"
//   "mirror-scsi0: transferred 309.0 MiB of 512.0 GiB (0.06%) in 8s"
const PROGRESS_LINE_RE =
  /^(drive-\S+|mirror-\S+):\s*transferred\s+([\d.]+)\s*(\w+)\s+of\s+([\d.]+)\s*(\w+)\s+\(([\d.]+)%\)\s+in\s+(.+)$/;

/**
 * Parse a migration task's log tail into an aggregate transfer progress across
 * every disk it's copying in parallel (a multi-disk VM logs one line per
 * drive; later lines for the same drive supersede earlier ones). Returns null
 * when the log has no progress lines yet — a task just starting, or a
 * migration path (e.g. an offline storage move) that doesn't report per-disk
 * transfer percentages the same way.
 */
export function parseMigrationProgress(logLines: string[]): MigrationProgress | null {
  const perDrive = new Map<string, { transferred: number; total: number; elapsed: number }>();
  for (const raw of logLines) {
    const m = PROGRESS_LINE_RE.exec(raw.replace(LOG_TIMESTAMP_RE, '').trim());
    if (!m) continue;
    const [, drive, tVal, tUnit, totVal, totUnit, , elapsed] = m;
    perDrive.set(drive!, {
      transferred: parseLogSize(tVal!, tUnit!),
      total: parseLogSize(totVal!, totUnit!),
      elapsed: parseLogElapsed(elapsed!),
    });
  }
  if (perDrive.size === 0) return null;

  let transferredBytes = 0;
  let totalBytes = 0;
  let elapsedSeconds = 0;
  for (const d of perDrive.values()) {
    transferredBytes += d.transferred;
    totalBytes += d.total;
    elapsedSeconds = Math.max(elapsedSeconds, d.elapsed);
  }
  const percent = totalBytes > 0 ? Math.min(100, (transferredBytes / totalBytes) * 100) : 0;
  // Projected from elapsed/percent so far — needs a little progress before it's
  // meaningful (avoids a wild estimate off the very first sampled line).
  const etaSeconds =
    percent > 0.5 && elapsedSeconds > 0 ? Math.round((elapsedSeconds / percent) * (100 - percent)) : null;
  return {
    percent: Math.round(percent * 10) / 10,
    transferredBytes,
    totalBytes,
    elapsedSeconds,
    etaSeconds,
  };
}

/**
 * The currently-running migration task for a guest, if any. `/cluster/tasks`
 * lists tasks cluster-wide with no `endtime` while still running — generic
 * across nodes, no topology assumptions.
 */
async function getActiveMigrationTask(
  vmid: number,
  client: AxiosInstance,
): Promise<{ node: string; upid: string } | null> {
  const res = await client.get<{
    data: Array<{ id?: string; type?: string; node?: string; upid?: string; endtime?: number }>;
  }>('/cluster/tasks');
  const task = (res.data.data ?? []).find(
    (t) => t.type === 'qmigrate' && t.id === String(vmid) && !t.endtime && t.node && t.upid,
  );
  return task ? { node: task.node!, upid: task.upid! } : null;
}

/**
 * Live progress of a guest's in-flight migration, for an admin-facing progress
 * bar. Returns null when there's no migration currently running for this VM
 * (not started yet, already finished, or between other apply steps). When a
 * migration IS running but hasn't logged a transfer percentage yet, returns a
 * zeroed placeholder rather than null, so the caller can still show "started,
 * still measuring" instead of nothing.
 */
export async function getMigrationProgress(vmid: number, client?: AxiosInstance): Promise<MigrationProgress | null> {
  const c = client ?? (await getClient());
  const active = await getActiveMigrationTask(vmid, c);
  if (!active) return null;
  // Proxmox's task-log endpoint pages from the START (`start`/`limit` are an
  // offset/count from line 1, not "last N lines" — a negative `start` errors,
  // and there's no total-count field to page backward from), so a small
  // `limit` here would keep re-reading the OLDEST lines and never see fresh
  // progress once a migration outlives it. `limit: 0` is Proxmox's documented
  // "no limit" — the response is one line of text per second of migration, so
  // even an hours-long transfer stays a trivial payload for an occasional poll.
  const res = await c.get<{ data: Array<{ t: string }> }>(
    `/nodes/${active.node}/tasks/${encodeURIComponent(active.upid)}/log`,
    { params: { limit: 0 } },
  );
  const lines = (res.data.data ?? []).map((l) => l.t);
  return (
    parseMigrationProgress(lines) ?? {
      percent: 0,
      transferredBytes: 0,
      totalBytes: 0,
      elapsedSeconds: 0,
      etaSeconds: null,
    }
  );
}

/** A storage on a specific node that can hold VM disk images. */
export interface NodeImagesStorage {
  storage: string;
  type: string;
  shared: boolean;
  availBytes: number | null; // free space, when the node reports it
}

/**
 * Storages on `node` that are enabled, active, and can hold disk images —
 * the candidates for relocating a VM's disks during an offline migration.
 */
export async function getNodeImagesStorages(
  node: string,
  client?: AxiosInstance,
): Promise<NodeImagesStorage[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{
    data: Array<{ storage: string; type: string; content?: string; shared?: number; active?: number; enabled?: number; avail?: number }>;
  }>(`/nodes/${node}/storage`, { params: { enabled: 1, content: 'images' } });
  return (res.data.data ?? [])
    .filter((s) => s.active !== 0)
    .map((s) => ({
      storage: s.storage,
      type: s.type,
      shared: s.shared === 1,
      availBytes: typeof s.avail === 'number' ? s.avail : null,
    }));
}

// Config keys whose values reference a disk volume (storage:volid,…). cdroms and
// detached "none" drives are filtered by value, not key.
const VOLUME_KEY_RE = /^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/;

/**
 * The distinct storage names a VM's volumes live on (from its config). Includes
 * the EFI/TPM state disks and generated cloud-init drives — those migrate as
 * volumes even though cloud-init presents as a cdrom. Only ISO cdroms and empty
 * drives are skipped (Proxmox doesn't storage-migrate ISO content).
 */
export function getVolumeStorages(config: Record<string, string>): string[] {
  const storages = new Set<string>();
  for (const [k, v] of Object.entries(config)) {
    if (!VOLUME_KEY_RE.test(k)) continue;
    const raw = String(v);
    if (raw === 'none' || raw.includes(':iso/')) continue;
    const m = /^([A-Za-z0-9_.-]+):/.exec(raw);
    if (m) storages.add(m[1]!);
  }
  return [...storages];
}

/** A generated cloud-init drive in a VM config (its content is derived from
 *  config keys — ciuser/sshkeys/ipconfig/cicustom — so it can be dropped and
 *  regenerated on another storage; Proxmox can't storage-migrate it across
 *  storage types, even live). */
export interface CloudInitDrive {
  slot: string; // e.g. "ide2"
  storage: string;
}

/** Find generated cloud-init drives (volid contains "cloudinit"). */
export function getCloudInitDrives(config: Record<string, string>): CloudInitDrive[] {
  const out: CloudInitDrive[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (!/^(ide|scsi|sata)\d+$/.test(k)) continue;
    const m = /^([A-Za-z0-9_.-]+):[^,]*cloudinit/.exec(String(v));
    if (m) out.push({ slot: k, storage: m[1]! });
  }
  return out;
}

/** Delete config keys (e.g. drop a cloud-init drive before a cross-type move). */
export async function deleteVmConfigKeys(
  node: string,
  vmid: number,
  keys: string[],
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ delete: keys.join(',') }));
}

/** (Re)create a generated cloud-init drive at `slot` on `storage`. */
export async function addCloudInitDrive(
  node: string,
  vmid: number,
  slot: string,
  storage: string,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ [slot]: `${storage}:cloudinit` }));
}

/**
 * Boot-readiness check for PCI/GPU passthrough. Passthrough (GPUs especially)
 * generally wants machine=q35 + bios=ovmf + an EFI disk. We only WARN — never
 * rewrite an existing guest's firmware/machine type: switching an installed
 * guest from SeaBIOS to OVMF typically makes it unbootable, which is strictly
 * worse than a GPU that needs manual host-side attention.
 */
export function passthroughBootReadiness(config: Record<string, string>): {
  q35: boolean;
  ovmf: boolean;
  efidisk: boolean;
  warnings: string[];
} {
  const q35 = /q35/i.test(config['machine'] ?? '');
  const ovmf = /^ovmf$/i.test((config['bios'] ?? '').trim());
  const efidisk = 'efidisk0' in config;
  const warnings: string[] = [];
  if (!q35) {
    warnings.push(
      'Machine type is not q35 — the device will be attached as legacy PCI (no pcie=1). GPUs usually need q35.',
    );
  }
  if (!ovmf) warnings.push('BIOS is not OVMF (UEFI) — GPU passthrough usually needs OVMF. Changing firmware on an installed guest can break its boot, so ProxMate will not change it automatically.');
  if (ovmf && !efidisk) warnings.push('OVMF is set but the VM has no EFI disk (efidisk0) — add one in Proxmox or boot settings will not persist.');
  return { q35, ovmf, efidisk, warnings };
}

/** Read a guest's config as a string map. Works for both QEMU and LXC. */
export async function getVmConfig(
  node: string,
  vmid: number,
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<Record<string, string>> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Record<string, unknown> }>(`/nodes/${node}/${kind}/${vmid}/config`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.data.data)) out[k] = String(v);
  return out;
}

/** Find the primary (bootable, non-cdrom) disk key in a VM config, e.g. "scsi0". */
export function findPrimaryDisk(config: Record<string, string>): string | undefined {
  return Object.keys(config)
    .filter((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k))
    .find((k) => !config[k]!.includes('media=cdrom'));
}

/**
 * Whether a VM config exposes a serial port (e.g. `serial0`), which is required
 * for the xterm.js text console (Proxmox `termproxy`). ProxMate's cloud-init VMs
 * are built with `serial0: 'socket'`; ISO VMs typically have none.
 */
export function hasSerialConsole(config: Record<string, string>): boolean {
  return Object.keys(config).some((k) => /^serial\d+$/.test(k));
}

/** Primary disk size in whole GB (rounded up), from a VM config. 0 if not found. */
export function primaryDiskSizeGb(config: Record<string, string>): number {
  const key = findPrimaryDisk(config);
  if (!key) return 0;
  const m = /\bsize=(\d+(?:\.\d+)?)([KMGT])?/i.exec(config[key]!);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? 'G').toUpperCase();
  const gb = unit === 'T' ? n * 1024 : unit === 'G' ? n : unit === 'M' ? n / 1024 : n / 1024 / 1024;
  return Math.max(1, Math.ceil(gb));
}

// ─── PCI / GPU passthrough ────────────────────────────────────
//
// ProxMate never picks raw PCI addresses. An admin defines named **resource
// mappings** in Proxmox (Datacenter → Resource Mappings → PCI), each pinning a
// device to specific nodes; ProxMate only lists those and attaches one to a VM
// as `hostpciN: mapping=<name>`. Host VFIO/IOMMU setup + defining the mapping
// stays the admin's job (not doable over the API). Attaching requires the VM
// stopped, and such a VM can't be live-migrated.

export interface PciMapping {
  id: string; // the mapping name (what we attach)
  description?: string;
  nodes: string[]; // nodes this mapping has a device path for
}

/** Extract node names from a mapping's `map` (entries are node-scoped strings or objects). */
function pciMappingNodes(map: unknown): string[] {
  if (!Array.isArray(map)) return [];
  const nodes = new Set<string>();
  for (const e of map) {
    if (typeof e === 'string') {
      const m = /(?:^|,)node=([^,]+)/.exec(e);
      if (m) nodes.add(m[1]!);
    } else if (e && typeof e === 'object' && typeof (e as { node?: unknown }).node === 'string') {
      nodes.add((e as { node: string }).node);
    }
  }
  return [...nodes];
}

/** Admin-defined PCI resource mappings on the cluster (`/cluster/mapping/pci`). */
export async function listPciMappings(client?: AxiosInstance): Promise<PciMapping[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Array<{ id: string; description?: string; map?: unknown }> }>(
    '/cluster/mapping/pci',
  );
  return (res.data.data ?? []).map((m) => ({
    id: m.id,
    description: m.description,
    nodes: pciMappingNodes(m.map),
  }));
}

/**
 * Attach a PCI resource mapping to a VM at `hostpci{index}`. `pcie=1` selects a
 * PCIe slot — valid only on machine=q35 (Proxmox refuses to START a non-q35
 * guest with pcie=1), so callers pass `opts.pcie=false` for i440fx guests and
 * the device lands in a legacy PCI slot instead. The VM must be stopped. The
 * admin remains responsible for host VFIO/IOMMU setup.
 */
export async function attachPci(
  node: string,
  vmid: number,
  index: number,
  mapping: string,
  client?: AxiosInstance,
  opts: { pcie?: boolean } = {},
): Promise<void> {
  const c = client ?? (await getClient());
  const value = opts.pcie === false ? `mapping=${mapping}` : `mapping=${mapping},pcie=1`;
  await c.put(
    `/nodes/${node}/qemu/${vmid}/config`,
    new URLSearchParams({ [`hostpci${index}`]: value }),
  );
}

/** Remove a PCI passthrough device (`hostpci{index}`) from a VM. */
export async function detachPci(
  node: string,
  vmid: number,
  index: number,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ delete: `hostpci${index}` }));
}

export interface PassthroughDevice {
  index: number; // N in hostpciN
  slot: string; // e.g. "hostpci0"
  mapping?: string; // the resource-mapping name, when attached via a mapping
  raw: string; // the full config value
}

/** Parse a VM config's attached PCI devices (its `hostpciN` keys). */
export function getPassthroughDevices(config: Record<string, string>): PassthroughDevice[] {
  const out: PassthroughDevice[] = [];
  for (const [k, v] of Object.entries(config)) {
    const m = /^hostpci(\d+)$/.exec(k);
    if (!m) continue;
    const raw = String(v);
    const mapping = /(?:^|,)mapping=([^,]+)/.exec(raw)?.[1];
    out.push({ index: Number(m[1]), slot: k, mapping, raw });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ─── PCI passthrough host-readiness (pre-flight) ──────────────
//
// Before an approval STOPS/MIGRATES/ATTACHES a device, verify what the API can
// actually see about the target node: the device is present, its identity still
// matches the mapping, and its IOMMU group is active (group -1 ⇒ IOMMU disabled
// ⇒ passthrough is guaranteed to fail). The one thing the Proxmox API does NOT
// expose is a device's current kernel driver, so vfio-pci binding — the classic
// "the VM's start hangs and takes the node offline" cause (see the pve-4 GTX1650
// incident) — can only be WARNED on, never confirmed. Consistent with
// passthroughBootReadiness: hard-block only the certain failures; surface the
// rest so the admin gives informed consent BEFORE a long migration.

export interface PciMappingEntry {
  node: string;
  path: string; // e.g. "0000:01:00" (Proxmox stores the function-less slot)
  id?: string; // vendor:device, e.g. "10de:1f82"
  iommugroup?: number; // recorded when the mapping was created
  subsystemId?: string;
}

/** Parse one `/cluster/mapping/pci` map entry (a "k=v,k=v" string or an object). */
export function parsePciMappingEntry(raw: unknown): PciMappingEntry | null {
  const kv = new Map<string, string>();
  if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      const i = part.indexOf('=');
      if (i > 0) kv.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) kv.set(k, String(v));
  } else {
    return null;
  }
  const node = kv.get('node');
  const path = kv.get('path');
  if (!node || !path) return null;
  const grp = kv.get('iommugroup');
  return {
    node,
    path,
    id: kv.get('id') || undefined,
    iommugroup: grp !== undefined && grp !== '' ? Number(grp) : undefined,
    subsystemId: kv.get('subsystem-id') || undefined,
  };
}

/** All per-node entries (path/id/iommugroup) for a named PCI resource mapping. */
export async function getPciMappingEntries(mappingId: string, client?: AxiosInstance): Promise<PciMappingEntry[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Array<{ id: string; map?: unknown }> }>('/cluster/mapping/pci');
  const m = (res.data.data ?? []).find((x) => x.id === mappingId);
  if (!m || !Array.isArray(m.map)) return [];
  return m.map.map(parsePciMappingEntry).filter((e): e is PciMappingEntry => e !== null);
}

export interface NodePciDevice {
  id: string; // "0000:01:00.0"
  class?: string; // "0x030000"
  className?: string;
  vendor?: string; // "0x10de"
  device?: string; // "0x1f82"
  vendorName?: string;
  deviceName?: string;
  iommugroup: number | null; // null when the field is absent; -1 ⇒ no IOMMU group
}

/** Live PCI devices on a node (`/nodes/{node}/hardware/pci`). */
export async function getNodePciDevices(node: string, client?: AxiosInstance): Promise<NodePciDevice[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Array<Record<string, unknown>> }>(`/nodes/${node}/hardware/pci`);
  return (res.data.data ?? []).map((d) => ({
    id: String(d['id']),
    class: d['class'] != null ? String(d['class']) : undefined,
    className: d['class_name'] != null ? String(d['class_name']) : undefined,
    vendor: d['vendor'] != null ? String(d['vendor']) : undefined,
    device: d['device'] != null ? String(d['device']) : undefined,
    vendorName: d['vendor_name'] != null ? String(d['vendor_name']) : undefined,
    deviceName: d['device_name'] != null ? String(d['device_name']) : undefined,
    iommugroup: d['iommugroup'] != null ? Number(d['iommugroup']) : null,
  }));
}

export interface PassthroughReadiness {
  device: {
    path: string;
    expectedId?: string;
    liveId?: string;
    iommugroup: number | null;
    className?: string;
    deviceName?: string;
  } | null;
  isGpu: boolean;
  /** No certain failure — the destructive apply may proceed. */
  ok: boolean;
  /** Certain failures — the apply MUST be refused before any stop/migrate. */
  blockers: string[];
  /** Advisory / API-unverifiable (vfio-pci binding, q35/OVMF, IOMMU-group sharing). */
  warnings: string[];
  /**
   * False for the observed node-crash combo (a GPU attached to a guest that
   * isn't BOTH q35 and OVMF): attach the device but do NOT auto-start — a GPU
   * without OVMF frequently hangs the host. Live-confirmed twice on pve-4: an
   * NVIDIA GTX 1650 wedged the node under i440fx/SeaBIOS AND under q35/SeaBIOS;
   * OVMF (UEFI) is the missing piece. The admin starts it manually once the VM
   * is q35 + OVMF and the device is confirmed bound to vfio-pci.
   */
  safeToAutoStart: boolean;
}

const isGpuClass = (cls?: string) => /^0x03/.test(cls ?? '');
const normId = (s?: string) => (s ?? '').replace(/^0x/i, '').toLowerCase();

/**
 * Pure host-readiness evaluation (unit-tested). Given the mapping's entry for the
 * target node, the node's live PCI devices, and the VM's boot readiness, decide
 * what would CERTAINLY fail (blockers) versus what the admin must confirm
 * (warnings). Deliberately side-effect-free so the security-critical decision is
 * easy to test — the async wrapper below just feeds it live data.
 */
export function evaluatePassthroughReadiness(
  targetNode: string,
  entry: PciMappingEntry | undefined,
  devices: NodePciDevice[],
  boot: { q35: boolean; ovmf: boolean; efidisk: boolean; warnings: string[] },
): PassthroughReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!entry) {
    return {
      device: null,
      isGpu: false,
      ok: false,
      blockers: [`The PCI mapping has no device entry for node ${targetNode}.`],
      warnings: [],
      safeToAutoStart: false,
    };
  }

  const own = (d: NodePciDevice) => d.id === entry.path || d.id.startsWith(`${entry.path}.`);
  const matched = devices.filter(own);
  const primary =
    matched.find((d) => entry.id && `${normId(d.vendor)}:${normId(d.device)}` === normId(entry.id)) ?? matched[0];

  if (!primary) {
    blockers.push(
      `PCI device ${entry.path} is not present on ${targetNode} (removed, disabled, or re-enumerated) — passthrough would fail to start.`,
    );
    return {
      device: { path: entry.path, expectedId: entry.id, iommugroup: null },
      isGpu: false,
      ok: false,
      blockers,
      warnings,
      safeToAutoStart: false,
    };
  }

  const liveId = `${normId(primary.vendor)}:${normId(primary.device)}`;
  if (entry.id && liveId !== normId(entry.id)) {
    blockers.push(
      `The device at ${entry.path} on ${targetNode} is now ${liveId} but the mapping expects ${normId(entry.id)}. Re-verify the resource mapping in Proxmox.`,
    );
  }

  const group = primary.iommugroup;
  if (group == null || group < 0) {
    blockers.push(
      `IOMMU is not active for ${entry.path} on ${targetNode} (no IOMMU group). Enable IOMMU on the node (intel_iommu=on / amd_iommu=on), reboot, then retry.`,
    );
  } else {
    if (entry.iommugroup != null && entry.iommugroup !== group) {
      warnings.push(
        `IOMMU group for ${entry.path} changed since the mapping was created (was ${entry.iommugroup}, now ${group}) — verify the host hasn't been reconfigured.`,
      );
    }
    const others = devices.filter((d) => d.iommugroup === group && !own(d));
    if (others.length > 0) {
      warnings.push(
        `IOMMU group ${group} on ${targetNode} also contains ${others
          .map((d) => d.id)
          .join(', ')} — passing this device also removes those from the host. Confirm none are host-critical (or enable ACS override).`,
      );
    }
  }

  // The Proxmox API never exposes a device's current kernel driver, so vfio-pci
  // binding — the usual "start hangs and takes the node down" cause — cannot be
  // confirmed here. Always surface it so the admin verifies before proceeding.
  warnings.push(
    `ProxMate can't confirm over the API that ${entry.path} on ${targetNode} is bound to vfio-pci. ` +
      `If a host driver still holds it, the VM's start can hang the node. On ${targetNode} run ` +
      `"lspci -nnks ${entry.path}" and confirm it shows "Kernel driver in use: vfio-pci".`,
  );

  warnings.push(...boot.warnings);

  const isGpu = isGpuClass(primary.class);
  // A GPU is only safe to auto-start on q35 AND OVMF — live-confirmed twice that
  // this NVIDIA card hangs the host without OVMF (even on q35). Non-GPU devices
  // aren't gated on firmware.
  const safeToAutoStart = blockers.length === 0 && !(isGpu && !(boot.q35 && boot.ovmf));

  return {
    device: {
      path: entry.path,
      expectedId: entry.id,
      liveId,
      iommugroup: group,
      className: primary.className,
      deviceName: primary.deviceName,
    },
    isGpu,
    ok: blockers.length === 0,
    blockers,
    warnings,
    safeToAutoStart,
  };
}

/** Fetch live cluster state and evaluate host readiness for `mappingId` on `targetNode`. */
export async function checkPassthroughHostReadiness(
  targetNode: string,
  mappingId: string,
  vmConfig: Record<string, string>,
  client?: AxiosInstance,
): Promise<PassthroughReadiness> {
  const c = client ?? (await getClient());
  const [entries, devices] = await Promise.all([
    getPciMappingEntries(mappingId, c),
    getNodePciDevices(targetNode, c),
  ]);
  const entry = entries.find((e) => e.node === targetNode);
  return evaluatePassthroughReadiness(targetNode, entry, devices, passthroughBootReadiness(vmConfig));
}

// ─── Backups (vzdump / restore / list / delete) ──────────────

/** Kick off a vzdump backup. Returns the Proxmox task UPID. */
export async function startBackup(
  opts: { node: string; vmid: number; storage: string; mode?: 'snapshot' | 'suspend' | 'stop'; notes?: string },
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    vmid: String(opts.vmid),
    storage: opts.storage,
    mode: opts.mode ?? 'snapshot',
    compress: 'zstd',
    remove: '0', // never let Proxmox's own retention prune — ProxMate manages it
  });
  if (opts.notes) params.set('notes-template', opts.notes);
  const res = await c.post<{ data: string }>(`/nodes/${opts.node}/vzdump`, params);
  return res.data.data;
}

export interface PveBackup {
  volid: string;
  storage: string;
  node: string;
  size: number;
  ctime: number;
  vmid?: number;
}

/** List all backup volumes on a storage. Searches every node where the storage exists. */
export async function listBackups(
  storage: string,
  client?: AxiosInstance,
): Promise<PveBackup[]> {
  const c = client ?? (await getClient());
  const nodes = await getNodes(c);
  const seen = new Map<string, PveBackup>();
  for (const { node } of nodes) {
    try {
      const res = await c.get<{ data: Array<{ volid: string; size: number; ctime: number; vmid?: number }> }>(
        `/nodes/${node}/storage/${storage}/content?content=backup`,
      );
      for (const b of res.data.data) {
        // Shared storage reports the same volid on every node — dedupe.
        if (!seen.has(b.volid)) {
          seen.set(b.volid, { volid: b.volid, storage, node, size: b.size, ctime: b.ctime, vmid: b.vmid });
        }
      }
    } catch {
      /* storage not on this node */
    }
  }
  return [...seen.values()];
}

/** Delete a backup volume. */
export async function deleteBackup(
  node: string,
  storage: string,
  volid: string,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  // The volid is "<storage>:backup/<filename>" — the path needs the encoded volid.
  await c.delete(`/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`);
}

/**
 * Restore a backup into an EXISTING VMID (overwrites the guest in place). The
 * guest must be stopped first. Returns the Proxmox task UPID. QEMU and LXC use
 * different restore shapes: QEMU takes `archive=<volid>` on POST /qemu; LXC takes
 * `ostemplate=<volid>` + `restore=1` on POST /lxc.
 */
export async function restoreBackup(
  opts: { node: string; vmid: number; volid: string; storage?: string },
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<string> {
  const c = client ?? (await getClient());
  if (kind === 'lxc') {
    const params = new URLSearchParams({
      vmid: String(opts.vmid),
      ostemplate: opts.volid,
      restore: '1',
      force: '1', // overwrite the existing container
    });
    if (opts.storage) params.set('storage', opts.storage);
    const res = await c.post<{ data: string }>(`/nodes/${opts.node}/lxc`, params);
    return res.data.data;
  }
  const params = new URLSearchParams({
    vmid: String(opts.vmid),
    archive: opts.volid,
    force: '1', // overwrite the existing VM
  });
  if (opts.storage) params.set('storage', opts.storage);
  const res = await c.post<{ data: string }>(`/nodes/${opts.node}/qemu`, params);
  return res.data.data;
}

/**
 * Restore a backup as a brand-NEW guest (fresh VMID — no force/overwrite).
 * `unique=1` regenerates the NIC MAC addresses so a guest migrated from another
 * cluster/instance can't collide with (or spoof) the original. `storage` remaps
 * every restored volume onto that pool — essential cross-cluster, where the
 * storage names inside the archive's config may not exist here.
 */
export async function restoreNewGuest(
  opts: { node: string; vmid: number; volid: string; storage?: string },
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    vmid: String(opts.vmid),
    unique: '1',
  });
  if (opts.storage) params.set('storage', opts.storage);
  if (kind === 'lxc') {
    params.set('ostemplate', opts.volid);
    params.set('restore', '1');
  } else {
    params.set('archive', opts.volid);
  }
  const res = await c.post<{ data: string }>(`/nodes/${opts.node}/${kind}`, params);
  return res.data.data;
}

/**
 * Read the guest config embedded in a vzdump archive (no restore needed).
 * Returns the raw `key: value` config text — used to quota-check an uploaded
 * backup before committing to restore it.
 */
export async function extractBackupConfig(
  node: string,
  volid: string,
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: string }>(
    `/nodes/${node}/vzdump/extractconfig?volume=${encodeURIComponent(volid)}`,
  );
  return res.data.data;
}

/**
 * Online nodes whose `storage` listing actually contains the backup `volid`.
 * Mirrors getIsoNodes: with node-local backup storage a file written via the
 * mounted share only exists on one node — restoring anywhere else would fail
 * asynchronously in Proxmox.
 */
export async function getBackupNodes(
  storage: string,
  volid: string,
  client?: AxiosInstance,
): Promise<string[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: ClusterResource[] }>('/cluster/resources');
  const nodeNames = res.data.data
    .filter((i) => i.type === 'node' && i.status === 'online' && i.node)
    .map((i) => i.node!);

  const result: string[] = [];
  for (const node of nodeNames) {
    try {
      const content = await c.get<{ data: Array<{ volid: string }> }>(
        `/nodes/${node}/storage/${storage}/content?content=backup`,
      );
      if (content.data.data?.some((i) => i.volid === volid)) result.push(node);
    } catch {
      // backup storage not present/readable on this node → not a candidate
    }
  }
  return result;
}

// ─── Snapshots (live, in-place point-in-time — distinct from vzdump backups) ──

export interface PveSnapshot {
  name: string;
  description?: string;
  snaptime?: number; // epoch seconds
  vmstate?: number; // 1 if the RAM state was captured too
  parent?: string;
}

/**
 * A VM's snapshots, newest first. Proxmox includes a synthetic `current`
 * pseudo-entry representing the live (un-snapshotted) state — we drop it.
 */
export async function listSnapshots(
  node: string,
  vmid: number,
  client?: AxiosInstance,
): Promise<PveSnapshot[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: PveSnapshot[] }>(`/nodes/${node}/qemu/${vmid}/snapshot`);
  return (res.data.data ?? [])
    .filter((s) => s.name !== 'current')
    .sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0));
}

/** Create a snapshot (optionally capturing RAM state). Returns the task UPID. */
export async function createSnapshot(
  node: string,
  vmid: number,
  snapname: string,
  opts: { description?: string; vmstate?: boolean } = {},
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({ snapname });
  if (opts.description) params.set('description', opts.description);
  if (opts.vmstate) params.set('vmstate', '1');
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/snapshot`, params);
  return res.data.data;
}

/** Delete a snapshot by name. Returns the task UPID. */
export async function deleteSnapshot(
  node: string,
  vmid: number,
  snapname: string,
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.delete<{ data: string }>(
    `/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}`,
  );
  return res.data.data;
}

/** Roll the VM back to a snapshot (reverts disk + RAM if captured). Task UPID. */
export async function rollbackSnapshot(
  node: string,
  vmid: number,
  snapname: string,
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(
    `/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`,
  );
  return res.data.data;
}

/** Ensure every NIC on a guest has the per-NIC firewall flag set (for cloned VMs
 *  and restores). Works for both QEMU and LXC (both use `netN` keys). */
export async function ensureNicFirewall(
  node: string,
  vmid: number,
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<void> {
  const c = client ?? (await getClient());
  const cfg = await getVmConfig(node, vmid, c, kind);
  for (const k of Object.keys(cfg).filter((key) => /^net\d+$/.test(key))) {
    const val = cfg[k]!;
    if (/\bfirewall=1\b/.test(val)) continue;
    const updated = /\bfirewall=0\b/.test(val) ? val.replace(/\bfirewall=0\b/, 'firewall=1') : `${val},firewall=1`;
    await c.put(`/nodes/${node}/${kind}/${vmid}/config`, new URLSearchParams({ [k]: updated }));
  }
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
  uptime?: number;
}

/** An entry from /cluster/status (either the cluster summary or a node). */
interface ClusterStatusEntry {
  type: string; // 'cluster' | 'node'
  name?: string;
  quorate?: number; // cluster entry only: 1 = quorate
  nodes?: number; // cluster entry only: configured node count
  online?: number; // node entry only: 1 = online
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

export interface NodeHealth {
  name: string;
  online: boolean;
  cpu: number; // 0..1 load fraction
  mem: { used: number; total: number };
  uptime: number; // seconds
}

export interface ClusterHealth {
  quorate: boolean;
  expected: number; // configured node count
  online: number;
  nodes: NodeHealth[];
}

/**
 * Per-node health + cluster quorum for the kiosk command center. Merges
 * /cluster/status (authoritative quorum + online flags) with /cluster/resources
 * (per-node CPU/mem/uptime). On a standalone (non-clustered) node, /cluster/status
 * has no `cluster` entry, so quorum falls back to "any node online".
 */
export async function getNodesHealth(client?: AxiosInstance): Promise<ClusterHealth> {
  const c = client ?? (await getClient());
  const [statusRes, resourceRes] = await Promise.all([
    c.get<{ data: ClusterStatusEntry[] }>('/cluster/status'),
    c.get<{ data: ClusterResource[] }>('/cluster/resources?type=node'),
  ]);

  const status = statusRes.data.data;
  const cluster = status.find((s) => s.type === 'cluster');
  const nodeEntries = status.filter((s) => s.type === 'node');
  const byName = new Map(
    resourceRes.data.data.filter((r) => r.type === 'node' && r.node).map((r) => [r.node!, r]),
  );

  const nodes: NodeHealth[] = nodeEntries
    .map((n) => {
      const r = n.name ? byName.get(n.name) : undefined;
      return {
        name: n.name ?? 'unknown',
        online: n.online === 1,
        cpu: r?.cpu ?? 0,
        mem: { used: r?.mem ?? 0, total: r?.maxmem ?? 0 },
        uptime: r?.uptime ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const online = nodes.filter((n) => n.online).length;
  return {
    quorate: cluster ? cluster.quorate === 1 : online > 0,
    expected: cluster?.nodes ?? nodes.length,
    online,
    nodes,
  };
}

/**
 * Lock a VM down for tenant isolation: enable its firewall with a default-deny
 * inbound policy and outbound rules that block all RFC1918 ranges (the owner's
 * LAN, other VMs, and the Proxmox host) while still allowing the internet and
 * DNS. DNS is permitted to the admin-configured resolver(s) when set (tightest),
 * otherwise to any destination — so a tenant VM can always resolve names no
 * matter where its DNS server lives (gateway, Pi-hole, a separate subnet, …).
 * Idempotent enough to re-run.
 *
 * NOTE: guest firewalls only take effect once the cluster firewall is enabled.
 */
export async function configureVmIsolation(
  node: string,
  vmid: number,
  opts: { dnsServers?: string[] } = {},
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<void> {
  const c = client ?? (await getClient());
  const base = `/nodes/${node}/${kind}/${vmid}/firewall`;

  // Default-deny inbound, allow outbound (further restricted by rules below),
  // permit DHCP, and block MAC/IP spoofing.
  await c.put(
    `${base}/options`,
    new URLSearchParams({
      enable: '1',
      dhcp: '1',
      ndp: '1',
      macfilter: '1',
      // ipfilter would require registering each tenant VM's (DHCP-assigned) IP in an
      // `ipfilter-net*` ipset; without that, Proxmox drops ALL of the VM's traffic once
      // the cluster firewall is on (no internet, no DNS). Isolation is enforced by the
      // destination RFC1918 DROP rules below + macfilter, so keep ipfilter off.
      ipfilter: '0',
      policy_in: 'DROP',
      policy_out: 'ACCEPT',
    }),
  );

  // Rules are evaluated top-to-bottom; first match wins, else the default policy.
  // The DNS allow must sit above the broad RFC1918 drops, so we POST the drops
  // first and the DNS allow(s) last (each insert prepends at pos=0).
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
  // DNS must keep working for the tenant to reach the internet. Allow it to the
  // admin-configured resolver(s) when set (tightest), else to ANY destination so
  // resolution works no matter where the DNS server lives. The rest of RFC1918
  // stays blocked, so the tenant still can't reach any other internal service.
  const dnsServers = (opts.dnsServers ?? []).filter(Boolean);
  const dnsTargets: (string | undefined)[] = dnsServers.length > 0 ? dnsServers : [undefined];
  for (const dest of dnsTargets) {
    for (const proto of ['udp', 'tcp'] as const) {
      await post({
        type: 'out',
        action: 'ACCEPT',
        proto,
        dport: '53',
        ...(dest ? { dest } : {}),
        comment: dest ? `ProxMate: DNS to ${dest}` : 'ProxMate: DNS (any resolver)',
      });
    }
  }
}

/** Marker comment identifying the managed ProxMate IDE firewall pinhole. */
const IDE_PINHOLE_COMMENT = 'ProxMate IDE: reverse-proxy pinhole';

/**
 * Punch ONE inbound hole in a guest's tenant-isolation firewall so the ProxMate
 * reverse proxy can reach the in-guest code-server on `port`. This is the IDE's
 * managed counterpart to {@link configureVmIsolation}: the guest keeps
 * `policy_in: DROP` (isolated from every other tenant), and we add a single
 * `IN ACCEPT` scoped to `source` — the ProxMate INFRASTRUCTURE only (the node /
 * subnet-router / backend host that fronts the proxy), NEVER another tenant — so
 * tenant-to-tenant isolation is untouched. Conntrack lets the replies back out,
 * so no outbound rule is needed. Idempotent: keyed on the rule comment.
 */
export async function ensureIdePinhole(
  node: string,
  vmid: number,
  opts: { port: number; source: string },
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<void> {
  const c = client ?? (await getClient());
  // Never open the guest's :8080 to the world — the source MUST be the specific
  // ProxMate infrastructure address, or tenant isolation is meaningless.
  const src = opts.source.trim();
  if (!src || src === '0.0.0.0/0' || src === '0.0.0.0' || src === '::/0' || src === '*') {
    throw new Error('IDE ingress source must be a specific ProxMate address, not a wildcard (0.0.0.0/0).');
  }
  const base = `/nodes/${node}/${kind}/${vmid}/firewall`;
  const existing = await c.get<{ data: Array<{ comment?: string }> }>(`${base}/rules`);
  if (existing.data.data.some((r) => r.comment === IDE_PINHOLE_COMMENT)) return;
  await c.post(
    `${base}/rules`,
    new URLSearchParams({
      enable: '1',
      type: 'in',
      action: 'ACCEPT',
      proto: 'tcp',
      dport: String(opts.port),
      source: opts.source,
      comment: IDE_PINHOLE_COMMENT,
    }),
  );
}

/** Remove the managed IDE pinhole(s) from a guest (best-effort; highest pos first). */
export async function removeIdePinhole(
  node: string,
  vmid: number,
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<void> {
  const c = client ?? (await getClient());
  const base = `/nodes/${node}/${kind}/${vmid}/firewall`;
  const existing = await c.get<{ data: Array<{ pos: number; comment?: string }> }>(`${base}/rules`);
  const positions = existing.data.data
    .filter((r) => r.comment === IDE_PINHOLE_COMMENT)
    .map((r) => r.pos)
    .sort((a, b) => b - a); // delete from the bottom up so positions don't shift
  for (const pos of positions) await c.delete(`${base}/rules/${pos}`);
}

/**
 * Ensure a QEMU VM uses the host CPU model (`cpu: host`) so guest software that
 * needs modern instruction sets — notably AVX, which the OpenCode agent's Bun
 * runtime requires — actually sees them. The default `kvm64` masks AVX and makes
 * OpenCode crash with an illegal instruction. Idempotent; returns true if it
 * changed the config. NOTE: a CPU-model change only takes effect on the next VM
 * boot, so callers must have the guest rebooted before relying on it.
 */
export async function ensureHostCpu(
  node: string,
  vmid: number,
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<boolean> {
  const c = client ?? (await getClient());
  const cfg = await getVmConfig(node, vmid, c);
  const current = String((cfg as Record<string, unknown>)['cpu'] ?? '');
  if (current.split(',')[0] === 'host') return false;
  await c.put(`/nodes/${node}/${kind}/${vmid}/config`, new URLSearchParams({ cpu: 'host' }));
  return true;
}

export async function deleteVm(node: string, vmid: number, client?: AxiosInstance, kind: GuestKind = 'qemu'): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.delete<{ data: string }>(`/nodes/${node}/${kind}/${vmid}`);
  return res.data.data;
}

export async function startVm(node: string, vmid: number, client?: AxiosInstance, kind: GuestKind = 'qemu'): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/${kind}/${vmid}/status/start`);
  return res.data.data;
}

/** Graceful ACPI shutdown. */
export async function shutdownVm(node: string, vmid: number, client?: AxiosInstance, kind: GuestKind = 'qemu'): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/${kind}/${vmid}/status/shutdown`);
  return res.data.data;
}

/** Hard power-off. */
export async function stopVm(node: string, vmid: number, client?: AxiosInstance, kind: GuestKind = 'qemu'): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/${kind}/${vmid}/status/stop`);
  return res.data.data;
}

export async function rebootVm(node: string, vmid: number, client?: AxiosInstance, kind: GuestKind = 'qemu'): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/${kind}/${vmid}/status/reboot`);
  return res.data.data;
}

/**
 * Pause a running VM (QEMU suspend: execution freezes, RAM stays resident, the
 * console shows the frozen frame). QEMU-only — LXC suspend is experimental in
 * Proxmox and not exposed here.
 */
export async function suspendVm(node: string, vmid: number, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/status/suspend`);
  return res.data.data;
}

/** Resume a paused (suspended) VM. QEMU-only, the counterpart of {@link suspendVm}. */
export async function resumeVm(node: string, vmid: number, client?: AxiosInstance): Promise<string> {
  const c = client ?? (await getClient());
  const res = await c.post<{ data: string }>(`/nodes/${node}/qemu/${vmid}/status/resume`);
  return res.data.data;
}

/**
 * Set a user's password inside the guest via the QEMU guest agent's dedicated
 * `set-user-password` call (no arbitrary command execution involved). Requires
 * the agent to be installed and running; Proxmox errors clearly when it isn't.
 */
export async function setGuestUserPassword(
  node: string,
  vmid: number,
  username: string,
  password: string,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.post(
    `/nodes/${node}/qemu/${vmid}/agent/set-user-password`,
    new URLSearchParams({ username, password }),
  );
}

/** Exec-status shape while polling a guest-agent exec pid. */
interface AgentExecStatus {
  exited: 0 | 1 | boolean;
  exitcode?: number;
  'out-data'?: string;
  'err-data'?: string;
}

/**
 * The fixed authorized_keys-append script run inside the guest. The username and
 * key arrive as $1/$2 (argv positionals via `sh -c script sh u k`) — they are
 * NEVER interpolated into the script text, so validated inputs cannot change
 * what runs. Idempotent (exact-line match), guards a missing trailing newline,
 * and sets the ownership/permissions sshd's StrictModes demands (700 / 600).
 * Exit 3 = the user does not exist (mapped to a clear error below).
 */
const APPEND_KEY_SCRIPT = [
  'u="$1"; k="$2"',
  'h=$(getent passwd "$u" | cut -d: -f6)',
  '[ -n "$h" ] || exit 3',
  'f="$h/.ssh/authorized_keys"',
  'mkdir -p "$h/.ssh"',
  'touch "$f"',
  // If the file exists without a trailing newline, a plain >> would glue the new
  // key onto the last line — pad it first.
  '[ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && echo >> "$f"',
  `grep -qxF "$k" "$f" || printf '%s\\n' "$k" >> "$f"`,
  'chown -R "$u:$(id -gn "$u")" "$h/.ssh"',
  'chmod 700 "$h/.ssh"',
  'chmod 600 "$f"',
].join('\n');

/**
 * Append an SSH public key to a guest user's ~/.ssh/authorized_keys via the
 * QEMU guest agent (`agent/exec` + `exec-status` polling). The post-create
 * counterpart of the deploy wizard's key injection — cloud-init only applies
 * `sshkeys` on first boot. Requires the agent, like set-user-password; Proxmox
 * errors clearly when it isn't running.
 */
export async function injectGuestSshKey(
  node: string,
  vmid: number,
  username: string,
  publicKey: string,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams();
  // `command` is an array param — repeated keys; $0 is 'sh', then $1/$2.
  for (const part of ['/bin/sh', '-c', APPEND_KEY_SCRIPT, 'sh', username, publicKey]) {
    params.append('command', part);
  }
  const res = await c.post<{ data: { pid: number } }>(`/nodes/${node}/qemu/${vmid}/agent/exec`, params);
  const pid = res.data.data.pid;

  // The append is near-instant — poll briefly for completion.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const st = await c.get<{ data: AgentExecStatus }>(`/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
    const s = st.data.data;
    if (s.exited) {
      if (s.exitcode === 3) throw new Error(`User "${username}" does not exist in the guest`);
      if (s.exitcode !== 0) {
        const detail = (s['err-data'] ?? '').trim();
        throw new Error(`Adding the key failed inside the guest${detail ? `: ${detail}` : ` (exit ${s.exitcode})`}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for the guest agent to finish adding the key');
}

/** True if the QEMU guest agent answers a ping (fail-fast, no retry). */
export async function guestAgentPing(node: string, vmid: number, client?: AxiosInstance): Promise<boolean> {
  const c = client ?? (await getClient());
  try {
    await c.post(`/nodes/${node}/qemu/${vmid}/agent/ping`, undefined, {
      timeout: 3000,
      _noRetry: true,
    } as AxiosRequestConfig & { _noRetry: boolean });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file inside the guest via the agent. `encode=1` tells PROXMATE-side to
 * base64 the content for the QEMU agent channel (the guest decodes it), so we pass
 * the RAW content here — do NOT pre-encode it (double-encoding writes the base64
 * text verbatim). Content up to ~60 KiB.
 */
export async function guestFileWrite(
  node: string,
  vmid: number,
  file: string,
  content: string,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams();
  params.append('file', file);
  params.append('content', content);
  params.append('encode', '1');
  await c.post(`/nodes/${node}/qemu/${vmid}/agent/file-write`, params);
}

/** Fire a command in the guest and return its pid — does NOT wait for it to finish. */
export async function guestExec(
  node: string,
  vmid: number,
  argv: string[],
  client?: AxiosInstance,
): Promise<number> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams();
  for (const part of argv) params.append('command', part);
  const res = await c.post<{ data: { pid: number } }>(`/nodes/${node}/qemu/${vmid}/agent/exec`, params);
  return res.data.data.pid;
}

/** Result of a short-lived guest-agent exec that we wait on. */
export interface GuestExecResult {
  exitcode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a short command in the guest via the agent and WAIT for its output
 * (`agent/exec` then poll `exec-status`). For quick, near-instant probes only —
 * e.g. reading `cloud-init status`. Times out (default 10s) rather than hanging
 * the caller; a timeout throws so callers can treat it as "couldn't determine".
 */
export async function guestExecOutput(
  node: string,
  vmid: number,
  argv: string[],
  client?: AxiosInstance,
  timeoutMs = 10_000,
): Promise<GuestExecResult> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams();
  for (const part of argv) params.append('command', part);
  const res = await c.post<{ data: { pid: number } }>(`/nodes/${node}/qemu/${vmid}/agent/exec`, params);
  const pid = res.data.data.pid;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await c.get<{ data: AgentExecStatus }>(`/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
    const s = st.data.data;
    if (s.exited) {
      return {
        exitcode: s.exitcode ?? 0,
        stdout: (s['out-data'] ?? '').trim(),
        stderr: (s['err-data'] ?? '').trim(),
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Timed out waiting for the guest agent to finish the command');
}

// ─── Rescue mode ──────────────────────────────────────────────
// Boot a VM from an admin-designated rescue ISO: the ISO goes on the ide3 slot
// (ide2 belongs to the cloud-init drive / install ISO) and the boot order is
// pinned to it. The prior boot config is snapshotted so exit can restore it.

export interface RescueSnapshot {
  boot: string | null; // previous `boot` line (null = Proxmox default order)
  ide3: string | null; // previous ide3 device, if any
}

/** Attach the rescue ISO on ide3 and make it the sole boot device. */
export async function applyRescueConfig(
  node: string,
  vmid: number,
  isoVolid: string,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(
    `/nodes/${node}/qemu/${vmid}/config`,
    new URLSearchParams({ ide3: `${isoVolid},media=cdrom`, boot: 'order=ide3' }),
  );
}

/** Restore the pre-rescue boot config (and ide3 slot) from its snapshot. */
export async function restoreBootConfig(
  node: string,
  vmid: number,
  snap: RescueSnapshot,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams();
  const del: string[] = [];
  if (snap.boot) params.set('boot', snap.boot);
  else del.push('boot');
  if (snap.ide3) params.set('ide3', snap.ide3);
  else del.push('ide3');
  if (del.length > 0) params.set('delete', del.join(','));
  await c.put(`/nodes/${node}/qemu/${vmid}/config`, params);
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
  kind: GuestKind = 'qemu',
): Promise<PveVmStatus> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: PveVmStatus }>(`/nodes/${node}/${kind}/${vmid}/status/current`);
  return res.data.data;
}

export type RrdTimeframe = 'hour' | 'day' | 'week' | 'month' | 'year';

/** One sample from Proxmox's per-VM RRD store. cpu is a 0..1 fraction; mem/maxmem
 *  are bytes; netin/netout/disk* are per-second rates. Fields are absent when the
 *  VM wasn't running for that bucket. */
export interface RrdPoint {
  time: number; // epoch seconds (bucket start)
  cpu?: number;
  mem?: number;
  maxmem?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
}

/**
 * Historical resource usage for a VM from Proxmox's built-in RRD store — the same
 * data the Proxmox UI graphs. No agent or polling needed; Proxmox keeps hour/day/
 * week/month/year rollups for every guest. `cf=AVERAGE` is the averaged series.
 */
export async function getVmRrdData(
  node: string,
  vmid: number,
  timeframe: RrdTimeframe = 'hour',
  client?: AxiosInstance,
  kind: GuestKind = 'qemu',
): Promise<RrdPoint[]> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: RrdPoint[] }>(`/nodes/${node}/${kind}/${vmid}/rrddata`, {
    params: { timeframe, cf: 'AVERAGE' },
  });
  return res.data.data ?? [];
}

interface AgentNetworkInterface {
  name?: string;
  'ip-addresses'?: Array<{ 'ip-address-type'?: string; 'ip-address'?: string }>;
}

/**
 * Best-effort guest IPs via the QEMU guest agent. The LAN address is the first
 * non-loopback IPv4 (preferred) or global IPv6; a Tailscale address (interface
 * named tailscale* or an IPv4 in 100.64.0.0/10) is reported separately so it
 * never shadows the LAN IP. Null fields when the agent isn't installed/running
 * (VM off, or the guest has no `qemu-guest-agent` daemon). Fail-fast (short
 * timeout) so it never hangs a VM list.
 */
export async function getVmIps(
  node: string,
  vmid: number,
  client?: AxiosInstance,
): Promise<GuestIps> {
  const c = client ?? (await getClient());
  try {
    // Best-effort + fail-fast: a short timeout AND no retries. For a VM whose
    // guest agent is enabled-in-config but not actually running (installing, mid
    // boot, or never installed), this call hangs until timeout — retrying it just
    // multiplies the wait and drags every VM-list / detail load. One quick attempt.
    const res = await c.get<{ data: { result?: AgentNetworkInterface[] } }>(
      `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
      { timeout: 1500, _noRetry: true } as AxiosRequestConfig & { _noRetry: boolean },
    );
    let v4: string | null = null;
    let v6: string | null = null;
    let ts: string | null = null;
    for (const iface of res.data.data?.result ?? []) {
      if (iface.name === 'lo') continue;
      const tsIface = isTailscaleIface(iface.name);
      for (const addr of iface['ip-addresses'] ?? []) {
        const ip = addr['ip-address'];
        if (!ip) continue;
        if (addr['ip-address-type'] === 'ipv4' && !ip.startsWith('127.')) {
          if (tsIface || isTailscaleIp(ip)) {
            if (!ts) ts = ip;
          } else if (!v4) {
            v4 = ip;
          }
        } else if (addr['ip-address-type'] === 'ipv6' && !tsIface && !v6 && !ip.startsWith('::1') && !ip.toLowerCase().startsWith('fe80')) {
          v6 = ip;
        }
      }
    }
    return { ip: v4 ?? v6, tailscaleIp: ts };
  } catch {
    return { ip: null, tailscaleIp: null }; // agent absent/not running, or VM stopped
  }
}
