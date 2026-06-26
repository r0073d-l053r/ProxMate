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
];

/** Snippet filename for a feature combo, e.g. ['tailscale','docker'] → proxmate-docker-tailscale.yaml */
export function cloudInitSnippetFile(featureIds: string[]): string {
  return `proxmate-${[...featureIds].sort().join('-')}.yaml`;
}

/** The cloud-config vendor-data body for a feature combo (packages deduped, runcmd concatenated). */
export function cloudInitSnippetContent(featureIds: string[]): string {
  const ids = [...featureIds].sort();
  const feats = CLOUD_INIT_FEATURES.filter((f) => ids.includes(f.id));
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
      if (exitstatus && exitstatus !== 'OK') throw new Error(`Proxmox task failed: ${exitstatus}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Proxmox task timed out');
}

/** Update a VM's CPU cores and memory (MB). */
export async function setVmResources(
  node: string,
  vmid: number,
  cores: number,
  memory: number,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(
    `/nodes/${node}/qemu/${vmid}/config`,
    new URLSearchParams({ cores: String(cores), memory: String(memory) }),
  );
}

/** Grow a VM disk to an absolute size in GB (Proxmox only supports growing). */
export async function resizeDisk(
  node: string,
  vmid: number,
  disk: string,
  sizeGb: number,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  await c.put(
    `/nodes/${node}/qemu/${vmid}/resize`,
    new URLSearchParams({ disk, size: `${sizeGb}G` }),
  );
}

/** Read a VM's config as a string map. */
export async function getVmConfig(
  node: string,
  vmid: number,
  client?: AxiosInstance,
): Promise<Record<string, string>> {
  const c = client ?? (await getClient());
  const res = await c.get<{ data: Record<string, unknown> }>(`/nodes/${node}/qemu/${vmid}/config`);
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
 * Restore a backup into an EXISTING VMID (overwrites the VM in place). The VM must
 * be stopped first. Returns the Proxmox task UPID.
 */
export async function restoreBackup(
  opts: { node: string; vmid: number; volid: string; storage?: string },
  client?: AxiosInstance,
): Promise<string> {
  const c = client ?? (await getClient());
  const params = new URLSearchParams({
    vmid: String(opts.vmid),
    archive: opts.volid,
    force: '1', // overwrite the existing VM
  });
  if (opts.storage) params.set('storage', opts.storage);
  const res = await c.post<{ data: string }>(`/nodes/${opts.node}/qemu`, params);
  return res.data.data;
}

/** Ensure every NIC on a VM has the per-NIC firewall flag set (for cloned VMs). */
export async function ensureNicFirewall(
  node: string,
  vmid: number,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await getClient());
  const cfg = await getVmConfig(node, vmid, c);
  for (const k of Object.keys(cfg).filter((key) => /^net\d+$/.test(key))) {
    const val = cfg[k]!;
    if (/\bfirewall=1\b/.test(val)) continue;
    const updated = /\bfirewall=0\b/.test(val) ? val.replace(/\bfirewall=0\b/, 'firewall=1') : `${val},firewall=1`;
    await c.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ [k]: updated }));
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
