import type { Template, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig, setConfig } from './config.service.js';
import * as pve from './proxmox.service.js';

/** Published templates shown in the user-facing Template Store. */
export function listPublished(): Promise<Template[]> {
  return prisma.template.findMany({ where: { published: true }, orderBy: { createdAt: 'desc' } });
}

/** All registered templates (admin view). */
export function listAll(): Promise<Template[]> {
  return prisma.template.findMany({ orderBy: { createdAt: 'desc' } });
}

/** Proxmox templates that exist on the cluster but aren't registered in the store yet. */
export async function discover(): Promise<
  Array<{ vmid: number; node: string; name: string; diskGb: number; arch: pve.Arch }>
> {
  const [pveTemplates, registered, archMap] = await Promise.all([
    pve.getTemplates(),
    prisma.template.findMany(),
    pve.getNodeArchMap(),
  ]);
  const known = new Set(registered.map((t) => t.proxmoxVmId));
  return pveTemplates
    .filter((t) => !known.has(t.vmid))
    .map((t) => ({
      vmid: t.vmid,
      node: t.node,
      name: t.name,
      diskGb: t.maxdisk ? Math.round(t.maxdisk / 1024 / 1024 / 1024) : 0,
      // A template on an arm64 node is an arm64 template (cross-arch templates
      // aren't useful); fall back to amd64 when the node's arch is undetectable.
      arch: archMap.get(t.node) === 'arm64' ? 'arm64' : 'amd64',
    }));
}

export interface RegisterTemplateInput {
  proxmoxVmId: number;
  node: string;
  name: string;
  description?: string;
  os?: string;
  diskGb?: number;
  notes?: string;
  cloudInit?: boolean;
  arch?: pve.Arch;
  sourceUrl?: string; // cloud image URL, so the store can rebuild a fresh template
}

/** Register a Proxmox template into the store (or update an existing registration). */
export async function register(input: RegisterTemplateInput): Promise<Template> {
  // Trust the disk size from Proxmox if the caller didn't supply one.
  let diskGb = input.diskGb ?? 0;
  if (!diskGb) {
    const found = (await pve.getTemplates()).find((t) => t.vmid === input.proxmoxVmId);
    if (found?.maxdisk) diskGb = Math.round(found.maxdisk / 1024 / 1024 / 1024);
  }

  // Auto-detect cloud-init capability and guest arch when the caller didn't
  // assert them (host-made templates published via "Add from cluster"). A single
  // config read covers both.
  let cloudInit = input.cloudInit;
  let arch: pve.Arch | undefined = input.arch;
  if (cloudInit === undefined || arch === undefined) {
    try {
      const cfg = await pve.getVmConfig(input.node, input.proxmoxVmId);
      if (cloudInit === undefined) cloudInit = pve.isCloudInitTemplate(cfg);
      if (arch === undefined) arch = (cfg as { arch?: string }).arch === 'aarch64' ? 'arm64' : 'amd64';
    } catch {
      if (cloudInit === undefined) cloudInit = false;
      if (arch === undefined) arch = 'amd64';
    }
  }

  return prisma.template.upsert({
    where: { proxmoxVmId: input.proxmoxVmId },
    update: {
      name: input.name,
      description: input.description ?? null,
      os: input.os ?? null,
      arch: arch ?? null,
      proxmoxNode: input.node,
      diskGb,
      cloudInit,
      published: true,
      // Only touch notes when the caller supplied them, so re-registering
      // doesn't silently wipe an admin's saved credentials.
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
    },
    create: {
      name: input.name,
      description: input.description ?? null,
      os: input.os ?? null,
      arch: arch ?? null,
      proxmoxVmId: input.proxmoxVmId,
      proxmoxNode: input.node,
      diskGb,
      cloudInit,
      notes: input.notes ?? null,
      sourceUrl: input.sourceUrl ?? null,
    },
  });
}

/** Admin: edit a template's notes, description, and/or custom icon. */
export async function updateTemplate(
  id: string,
  data: { notes?: string | null; description?: string | null; icon?: string | null },
): Promise<Template> {
  return prisma.template.update({
    where: { id },
    data: {
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      ...(data.description !== undefined ? { description: data.description || null } : {}),
      ...(data.icon !== undefined ? { icon: data.icon || null } : {}),
    },
  });
}

/**
 * Remove a template from the store AND delete the underlying Proxmox template VM.
 * Tolerates the Proxmox template already being gone (still cleans up the row).
 * Re-throws other Proxmox errors — notably "still has linked clones": ProxMate
 * deploys are linked clones, so a template can't be deleted while VMs cloned from
 * it exist. In that case the store row is kept so the store stays in sync.
 */
export async function unregister(id: string): Promise<void> {
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return;

  try {
    const client = await pve.getClient();
    await pve.deleteVm(template.proxmoxNode, template.proxmoxVmId, client);
  } catch (err) {
    const msg = pve.pveMessage(err);
    if (!/does not exist|not found|no such/i.test(msg)) throw err;
  }

  await prisma.template.delete({ where: { id } });
}

/**
 * Convert an existing ProxMate VM into a template and register it in the store.
 * The VM is stopped, converted on Proxmox, removed from the VM list, and added
 * as a template.
 */
export async function convertVmToTemplate(
  vm: VirtualMachine,
  meta: { name: string; description?: string; os?: string },
): Promise<Template> {
  const client = await pve.getClient();

  // Templates must be stopped before conversion.
  try {
    const status = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client);
    if (status.status !== 'stopped') {
      const upid = await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, client);
      await pve.waitForTask(vm.proxmoxNode, upid, client);
    }
  } catch {
    /* best effort — proceed to convert */
  }

  await pve.convertToTemplate(vm.proxmoxNode, vm.proxmoxVmId, client);

  // It's no longer a usable VM — move the record into the template store.
  await prisma.virtualMachine.delete({ where: { id: vm.id } });
  return register({
    proxmoxVmId: vm.proxmoxVmId,
    node: vm.proxmoxNode,
    name: meta.name,
    description: meta.description,
    os: meta.os ?? vm.os,
    diskGb: vm.storage,
  });
}

// ─── Cloud-init images ────────────────────────────────────────

export interface CuratedImage {
  id: string;
  label: string;
  url: string;
  os: string;
  defaultUser: string;
}

/**
 * Vetted cloud images (genericcloud/cloudimg, all qcow2 format) the admin can
 * one-click add. Every URL was confirmed to resolve. Most use a stable
 * `latest`/`current` path; Fedora and Oracle pin a specific build (their
 * projects publish no "latest" symlink), so those two may need a version bump
 * over time — the custom-URL field covers anything not listed here.
 */
export const CURATED_IMAGES: CuratedImage[] = [
  // ─── Debian ───
  {
    id: 'debian-13',
    label: 'Debian 13 (Trixie)',
    url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2',
    os: 'Debian 13',
    defaultUser: 'debian',
  },
  {
    id: 'debian-12',
    label: 'Debian 12 (Bookworm)',
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2',
    os: 'Debian 12',
    defaultUser: 'debian',
  },
  {
    id: 'debian-11',
    label: 'Debian 11 (Bullseye)',
    url: 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-genericcloud-amd64.qcow2',
    os: 'Debian 11',
    defaultUser: 'debian',
  },
  // ─── Ubuntu ───
  {
    id: 'ubuntu-24.04',
    label: 'Ubuntu 24.04 LTS (Noble)',
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
    os: 'Ubuntu 24.04',
    defaultUser: 'ubuntu',
  },
  {
    id: 'ubuntu-22.04',
    label: 'Ubuntu 22.04 LTS (Jammy)',
    url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    os: 'Ubuntu 22.04',
    defaultUser: 'ubuntu',
  },
  {
    id: 'ubuntu-20.04',
    label: 'Ubuntu 20.04 LTS (Focal)',
    url: 'https://cloud-images.ubuntu.com/focal/current/focal-server-cloudimg-amd64.img',
    os: 'Ubuntu 20.04',
    defaultUser: 'ubuntu',
  },
  // ─── Fedora ───
  {
    id: 'fedora-42',
    label: 'Fedora 42',
    url: 'https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2',
    os: 'Fedora 42',
    defaultUser: 'fedora',
  },
  // ─── RHEL family (AlmaLinux / Rocky / CentOS Stream / Oracle) ───
  {
    id: 'almalinux-9',
    label: 'AlmaLinux 9',
    url: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2',
    os: 'AlmaLinux 9',
    defaultUser: 'almalinux',
  },
  {
    id: 'almalinux-8',
    label: 'AlmaLinux 8',
    url: 'https://repo.almalinux.org/almalinux/8/cloud/x86_64/images/AlmaLinux-8-GenericCloud-latest.x86_64.qcow2',
    os: 'AlmaLinux 8',
    defaultUser: 'almalinux',
  },
  {
    id: 'rocky-9',
    label: 'Rocky Linux 9',
    url: 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2',
    os: 'Rocky Linux 9',
    defaultUser: 'rocky',
  },
  {
    id: 'rocky-8',
    label: 'Rocky Linux 8',
    url: 'https://download.rockylinux.org/pub/rocky/8/images/x86_64/Rocky-8-GenericCloud-Base.latest.x86_64.qcow2',
    os: 'Rocky Linux 8',
    defaultUser: 'rocky',
  },
  {
    id: 'centos-stream-10',
    label: 'CentOS Stream 10',
    url: 'https://cloud.centos.org/centos/10-stream/x86_64/images/CentOS-Stream-GenericCloud-10-latest.x86_64.qcow2',
    os: 'CentOS Stream 10',
    defaultUser: 'cloud-user',
  },
  {
    id: 'centos-stream-9',
    label: 'CentOS Stream 9',
    url: 'https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2',
    os: 'CentOS Stream 9',
    defaultUser: 'cloud-user',
  },
  {
    id: 'oracle-9',
    label: 'Oracle Linux 9',
    url: 'https://yum.oracle.com/templates/OracleLinux/OL9/u5/x86_64/OL9U5_x86_64-kvm-b259.qcow2',
    os: 'Oracle Linux 9',
    defaultUser: 'cloud-user',
  },
  // ─── Others ───
  {
    id: 'opensuse-leap-15.6',
    label: 'openSUSE Leap 15.6',
    url: 'https://download.opensuse.org/distribution/leap/15.6/appliances/openSUSE-Leap-15.6-Minimal-VM.x86_64-Cloud.qcow2',
    os: 'openSUSE Leap 15.6',
    defaultUser: 'opensuse',
  },
  {
    id: 'arch',
    label: 'Arch Linux',
    url: 'https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2',
    os: 'Arch Linux',
    defaultUser: 'arch',
  },
  // ─── ARM64 (aarch64) — for ARM nodes (e.g. Raspberry Pi running the Proxmox ARM port) ───
  {
    id: 'debian-13-arm64',
    label: 'Debian 13 (Trixie) · ARM64',
    url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-arm64.qcow2',
    os: 'Debian 13',
    defaultUser: 'debian',
  },
  {
    id: 'debian-12-arm64',
    label: 'Debian 12 (Bookworm) · ARM64',
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2',
    os: 'Debian 12',
    defaultUser: 'debian',
  },
  {
    id: 'ubuntu-24.04-arm64',
    label: 'Ubuntu 24.04 LTS (Noble) · ARM64',
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-arm64.img',
    os: 'Ubuntu 24.04',
    defaultUser: 'ubuntu',
  },
  {
    id: 'ubuntu-22.04-arm64',
    label: 'Ubuntu 22.04 LTS (Jammy) · ARM64',
    url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-arm64.img',
    os: 'Ubuntu 22.04',
    defaultUser: 'ubuntu',
  },
];

/** Infer guest arch from a cloud-image filename (they encode amd64/arm64/aarch64). */
export function archFromImageUrl(url: string): pve.Arch {
  return /(?:arm64|aarch64)/i.test(url) ? 'arm64' : 'amd64';
}

/** Curated images with their arch resolved from the URL (for the admin picker). */
export function curatedImagesWithArch(): Array<CuratedImage & { arch: pve.Arch }> {
  return CURATED_IMAGES.map((i) => ({ ...i, arch: archFromImageUrl(i.url) }));
}

export interface AddCloudImageInput {
  name: string;
  imageUrl: string;
  os?: string;
  description?: string;
  node?: string;
  arch?: pve.Arch;
}

/**
 * Core cloud-image import, shared by {@link addCloudImage} and
 * {@link refreshTemplate}: download the image → import it as a VM disk + attach a
 * cloud-init drive → convert to a template. Returns the new template VMID, its
 * node, disk size and arch. Does NOT register a store row (callers decide whether
 * to create one or repoint an existing one). Cleans up its own artifacts on
 * failure. Long-running (the image download is hundreds of MB).
 */
async function buildCloudTemplateVm(opts: {
  name: string;
  imageUrl: string;
  node?: string;
  arch?: pve.Arch;
}): Promise<{ node: string; vmid: number; diskGb: number; arch: pve.Arch }> {
  const client = await pve.getClient();
  const diskStorage = await getConfig('default_storage');
  const bridge = await getConfig('default_bridge');
  if (!diskStorage || !bridge) {
    throw new Error('Server defaults are not configured — finish setup first');
  }

  // Arch comes from the image filename unless pinned; the build node (where the
  // template — and its full clones — live) must match it.
  const arch = opts.arch ?? archFromImageUrl(opts.imageUrl);
  const node =
    opts.node ?? (await pve.pickBestNode({ cpu: 1, ramMb: 1024, storageGb: 4 }, diskStorage, client, undefined, arch));

  const importStorages = await pve.getImportStorages(node, client);
  if (importStorages.length === 0) {
    throw new Error(`No storage on "${node}" accepts disk images (enable the "import" content type on a directory storage).`);
  }
  const isoStorage = (await getConfig('iso_storage')) ?? '';
  const importStorage = importStorages.includes(isoStorage) ? isoStorage : importStorages[0]!;

  const safeName = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cloud-image';
  const filename = `${safeName}-${Date.now()}.qcow2`;
  const importFrom = `${importStorage}:import/${filename}`;
  const vmid = await pve.getNextVmId(client);

  const dlUpid = await pve.downloadUrlToStorage(node, importStorage, { url: opts.imageUrl, filename }, client);
  await pve.waitForTask(node, dlUpid, client, 900_000);

  try {
    const createUpid = await pve.createCloudInitVm({ node, vmid, name: safeName, importFrom, diskStorage, bridge }, client);
    await pve.waitForTask(node, createUpid, client, 600_000);
    const diskGb = pve.primaryDiskSizeGb(await pve.getVmConfig(node, vmid, client));
    await pve.convertToTemplate(node, vmid, client);
    await pve.deleteStorageVolume(node, importFrom, client).catch(() => {}); // image no longer needed
    return { node, vmid, diskGb, arch };
  } catch (err) {
    await pve.deleteStorageVolume(node, importFrom, client).catch(() => {});
    await pve.deleteVm(node, vmid, client).catch(() => {});
    throw err;
  }
}

/**
 * Build a cloud-init template from a cloud image and register it in the store
 * (flagged `cloudInit`), remembering the source URL so it can be refreshed later.
 */
export async function addCloudImage(input: AddCloudImageInput): Promise<Template> {
  const built = await buildCloudTemplateVm({ name: input.name, imageUrl: input.imageUrl, node: input.node, arch: input.arch });
  return register({
    proxmoxVmId: built.vmid,
    node: built.node,
    name: input.name,
    description: input.description,
    os: input.os,
    diskGb: built.diskGb,
    cloudInit: true,
    arch: built.arch,
    sourceUrl: input.imageUrl,
  });
}

/**
 * Rebuild a cloud-image template from its remembered source URL so new deploys
 * start from a freshly-downloaded (patched) base. Builds a NEW template VM, then
 * repoints the SAME store row at it (keeping its id/name/notes/icon so deploy
 * links and admin edits survive), and deletes the old Proxmox template VM. Safe
 * because cloud-init templates are FULL-cloned on deploy — the old template has
 * no linked clones depending on it. Admin-only.
 */
export async function refreshTemplate(id: string): Promise<Template> {
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) throw new Error('Template not found');
  if (!tpl.cloudInit || !tpl.sourceUrl) {
    throw new Error('Only cloud-image templates built from a URL can be refreshed');
  }

  const built = await buildCloudTemplateVm({
    name: tpl.name,
    imageUrl: tpl.sourceUrl,
    arch: (tpl.arch as pve.Arch | null) ?? undefined,
  });

  const oldVmid = tpl.proxmoxVmId;
  const oldNode = tpl.proxmoxNode;

  // Repoint the store row at the new template VM (same id → deploy links hold).
  const updated = await prisma.template.update({
    where: { id },
    data: {
      proxmoxVmId: built.vmid,
      proxmoxNode: built.node,
      diskGb: built.diskGb,
      arch: built.arch,
      refreshedAt: new Date(),
    },
  });

  // The old template VM is now unreferenced (cloud images are full-cloned) — remove it.
  const client = await pve.getClient();
  await pve.deleteVm(oldNode, oldVmid, client).catch((e) => console.warn('[template] old template cleanup failed:', e));

  return updated;
}

/** Refresh every refreshable cloud-image template (scheduled monthly job). Best-effort. */
export async function refreshAllTemplates(): Promise<{ refreshed: number; failed: number }> {
  const templates = await prisma.template.findMany({ where: { cloudInit: true, NOT: { sourceUrl: null } } });
  let refreshed = 0;
  let failed = 0;
  for (const t of templates) {
    try {
      await refreshTemplate(t.id);
      refreshed += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[template] refresh of "${t.name}" failed:`, e);
    }
  }
  return { refreshed, failed };
}

// ─── Cloud-init "extras" support (install Docker / Tailscale snippets) ─

/** The storage we use for snippets (the ISO storage is a directory). */
export async function getSnippetStorage(): Promise<string> {
  return (await getConfig('iso_storage')) ?? 'local';
}

// ── Admin-configurable cloud-init feature selection ──
// Which catalog features are OFFERED to tenants (checkboxes) and which are
// ALWAYS-ON (installed on every VM) are admin choices, not hardcoded — so any
// deployment can shape its own defaults.

const catalogIds = () => new Set(pve.CLOUD_INIT_CATALOG.map((f) => f.id));

/** Feature ids offered to tenants as checkboxes (config; default = the app features). */
export async function getOfferedFeatureIds(): Promise<string[]> {
  const known = catalogIds();
  const raw = await getConfig('cloudinit_offered');
  if (raw) {
    try {
      return (JSON.parse(raw) as string[]).filter((id) => known.has(id));
    } catch {
      /* fall back to default */
    }
  }
  return pve.DEFAULT_OFFERED_IDS.filter((id) => known.has(id));
}

/** Feature ids installed on EVERY cloud-init VM (config; default = none). */
export async function getBaseFeatureIds(): Promise<string[]> {
  const raw = await getConfig('cloudinit_base');
  if (!raw) return [];
  const known = catalogIds();
  try {
    return (JSON.parse(raw) as string[]).filter((id) => known.has(id));
  } catch {
    return [];
  }
}

/** Save the admin's offered + always-on-base selections (validated to the catalog). */
export async function setCloudInitConfig(offered: string[], base: string[]): Promise<void> {
  const known = catalogIds();
  const clean = (ids: string[]) => [...new Set(ids.filter((id) => known.has(id)))];
  await setConfig('cloudinit_offered', JSON.stringify(clean(offered)));
  await setConfig('cloudinit_base', JSON.stringify(clean(base)));
}

/** The full catalog (id/label/hint) + the admin's current offered/base selection + the recommended base. */
export async function getCloudInitConfig(): Promise<{
  catalog: Array<{ id: string; label: string; hint: string }>;
  offered: string[];
  base: string[];
  recommendedBase: string[];
}> {
  return {
    catalog: pve.CLOUD_INIT_CATALOG.map((f) => ({ id: f.id, label: f.label, hint: f.hint })),
    offered: await getOfferedFeatureIds(),
    base: await getBaseFeatureIds(),
    recommendedBase: pve.RECOMMENDED_BASE_IDS,
  };
}

/** Non-empty combinations of the given feature ids (all combos ≤8 ids, else singles). */
function featureCombos(ids: string[]): string[][] {
  if (ids.length > 8) return ids.map((id) => [id]); // 2ⁿ blows up past this — singles only
  const out: string[][] = [];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    out.push(ids.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

export interface CloudInitBundle {
  features: string[];
  label: string; // e.g. "Docker + Tailscale"
  file: string;
  volid: string;
  content: string;
  command: string; // one-liner the admin runs on each node
  nodesReady: string[];
}

export interface CloudInitExtras {
  storage: string;
  snippetsEnabled: boolean;
  /** Automatic on-demand snippet writing is active — nothing to hand-place. */
  onDemand: boolean;
  /** The tenant-offered options (checkboxes), i.e. the catalog filtered to `offered`. */
  features: Array<{ id: string; label: string; hint: string }>;
  /** Always-on base installed on every VM (the catalog filtered to `baseSelected`). */
  base: Array<{ id: string; label: string }>;
  /** The full catalog + the admin's current selections, for the offered/base toggles. */
  catalog: Array<{ id: string; label: string; hint: string }>;
  offered: string[];
  baseSelected: string[];
  recommendedBase: string[];
  bundles: CloudInitBundle[]; // combos of the OFFERED features (searchable picker)
}

/**
 * Admin view of cloud-init snippets. The snippet picker (bundles) is available in
 * BOTH modes — for manual placement in the fallback, and as reference/override in
 * on-demand mode. Performance: bundle *content* is pure/cheap, and node readiness
 * is computed with ONE snippet listing per node (matched in-memory), not a Proxmox
 * call per combo — and only in manual mode.
 */
export async function getCloudInitExtras(): Promise<CloudInitExtras> {
  const onDemandCfg = pve.snippetWriteConfig();
  const onDemand = !!onDemandCfg;
  const offeredIds = await getOfferedFeatureIds();
  const baseIds = await getBaseFeatureIds();
  const catalog = pve.CLOUD_INIT_CATALOG.map((f) => ({ id: f.id, label: f.label, hint: f.hint }));
  const features = catalog.filter((f) => offeredIds.includes(f.id));
  const base = pve.CLOUD_INIT_CATALOG.filter((f) => baseIds.includes(f.id)).map((f) => ({ id: f.id, label: f.label }));

  const client = await pve.getClient();
  const storage = onDemand ? onDemandCfg!.storage : await getSnippetStorage();
  const sres = await client.get<{ data: Array<{ storage: string; content?: string; path?: string }> }>('/storage');
  const s = sres.data.data.find((x) => x.storage === storage);
  const snippetsEnabled = onDemand || (s?.content ?? '').split(',').includes('snippets');
  const dir = `${s?.path ?? '/var/lib/vz'}/snippets`;

  // Node readiness matters only for manual placement — compute it (one listing per
  // node, matched in-memory) only in the fallback; on-demand writes on the fly.
  const placed: Record<string, Set<string>> = {};
  if (!onDemand && snippetsEnabled) {
    const cr = await client.get<{ data: Array<{ type: string; status?: string; node?: string }> }>('/cluster/resources');
    const nodeNames = cr.data.data.filter((i) => i.type === 'node' && i.status === 'online' && i.node).map((i) => i.node!);
    await Promise.all(
      nodeNames.map(async (node) => {
        try {
          const r = await client.get<{ data: Array<{ volid: string }> }>(
            `/nodes/${node}/storage/${storage}/content?content=snippets`,
          );
          placed[node] = new Set(r.data.data.map((x) => x.volid.split('/').pop()!));
        } catch {
          placed[node] = new Set();
        }
      }),
    );
  }

  const featLabel = (id: string) =>
    (pve.CLOUD_INIT_CATALOG.find((f) => f.id === id)?.label ?? id).replace(/^Install /, '');

  const bundles: CloudInitBundle[] = featureCombos(offeredIds).map((combo) => {
    const file = pve.cloudInitSnippetFile(combo);
    const content = pve.cloudInitSnippetContent(combo);
    return {
      features: [...combo].sort(),
      label: [...combo].sort().map(featLabel).join(' + '),
      file,
      volid: `${storage}:snippets/${file}`,
      content,
      command: `mkdir -p ${dir} && cat > ${dir}/${file} <<'EOF'\n${content}EOF`,
      nodesReady: onDemand ? [] : Object.keys(placed).filter((node) => placed[node]!.has(file)),
    };
  });

  return {
    storage,
    snippetsEnabled,
    onDemand,
    features,
    base,
    catalog,
    offered: offeredIds,
    baseSelected: baseIds,
    recommendedBase: pve.RECOMMENDED_BASE_IDS,
    bundles,
  };
}

export interface CloudInitStatus {
  snippetsEnabled: boolean;
  /** Automatic on-demand snippet writing is active — every offered feature is
   *  available on every node (ProxMate writes the combo at deploy), so the wizard
   *  must NOT gate on `nodes`. */
  onDemand: boolean;
  features: Array<{ id: string; label: string; hint: string }>;
  nodes: Record<string, string[]>; // node → present ProxMate snippet filenames (manual mode only)
  /** Always-on base installed on every cloud-init VM (empty unless on-demand writing is configured). */
  base: Array<{ id: string; label: string }>;
}

/** Lightweight (wizard): the features + which ProxMate snippet files are present on each node. */
export async function cloudInitStatus(): Promise<CloudInitStatus> {
  const onDemand = !!pve.snippetWriteConfig();
  const offeredIds = await getOfferedFeatureIds();
  const features = pve.CLOUD_INIT_CATALOG
    .filter((f) => offeredIds.includes(f.id))
    .map((f) => ({ id: f.id, label: f.label, hint: f.hint }));
  // The always-on base only applies when on-demand snippet writing is configured.
  const baseIds = onDemand ? await getBaseFeatureIds() : [];
  const base = pve.CLOUD_INIT_CATALOG.filter((f) => baseIds.includes(f.id)).map((f) => ({ id: f.id, label: f.label }));

  // On-demand: ProxMate writes the exact combo snippet at deploy time, so every
  // offered feature is deployable on every node — there is no per-node readiness to
  // compute (and nothing is pre-placed to list). Short-circuit before any storage/
  // node listing.
  if (onDemand) return { snippetsEnabled: true, onDemand: true, features, nodes: {}, base };

  const client = await pve.getClient();
  const storage = await getSnippetStorage();
  const sres = await client.get<{ data: Array<{ storage: string; content?: string }> }>('/storage');
  const snippetsEnabled = (sres.data.data.find((x) => x.storage === storage)?.content ?? '').split(',').includes('snippets');
  if (!snippetsEnabled) return { snippetsEnabled: false, onDemand: false, features, nodes: {}, base };

  const cr = await client.get<{ data: Array<{ type: string; status?: string; node?: string }> }>('/cluster/resources');
  const nodeNames = cr.data.data.filter((i) => i.type === 'node' && i.status === 'online' && i.node).map((i) => i.node!);
  // Snippet listing is an independent READ per node — fetch them concurrently.
  // The per-node try/catch is kept inside the mapped fn so one node's failure
  // never rejects the batch (it just yields an empty list for that node).
  const nodes: Record<string, string[]> = {};
  await Promise.all(
    nodeNames.map(async (node) => {
      try {
        const r = await client.get<{ data: Array<{ volid: string }> }>(
          `/nodes/${node}/storage/${storage}/content?content=snippets`,
        );
        nodes[node] = r.data.data.map((x) => x.volid.split('/').pop()!).filter((f) => f.startsWith('proxmate-'));
      } catch {
        nodes[node] = [];
      }
    }),
  );
  return { snippetsEnabled, onDemand: false, features, nodes, base };
}

/** Admin: enable the `snippets` content type on the snippet storage (API-doable). */
export async function enableCloudInitSnippets(): Promise<CloudInitExtras> {
  await pve.ensureSnippetsEnabled(await getSnippetStorage(), await pve.getClient());
  return getCloudInitExtras();
}
