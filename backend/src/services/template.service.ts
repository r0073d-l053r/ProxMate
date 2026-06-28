import type { Template, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
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
export async function discover(): Promise<Array<{ vmid: number; node: string; name: string; diskGb: number }>> {
  const [pveTemplates, registered] = await Promise.all([pve.getTemplates(), prisma.template.findMany()]);
  const known = new Set(registered.map((t) => t.proxmoxVmId));
  return pveTemplates
    .filter((t) => !known.has(t.vmid))
    .map((t) => ({
      vmid: t.vmid,
      node: t.node,
      name: t.name,
      diskGb: t.maxdisk ? Math.round(t.maxdisk / 1024 / 1024 / 1024) : 0,
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
}

/** Register a Proxmox template into the store (or update an existing registration). */
export async function register(input: RegisterTemplateInput): Promise<Template> {
  // Trust the disk size from Proxmox if the caller didn't supply one.
  let diskGb = input.diskGb ?? 0;
  if (!diskGb) {
    const found = (await pve.getTemplates()).find((t) => t.vmid === input.proxmoxVmId);
    if (found?.maxdisk) diskGb = Math.round(found.maxdisk / 1024 / 1024 / 1024);
  }

  // Auto-detect cloud-init capability when the caller didn't assert it, so
  // host-made cloud-init templates published via "Add from cluster" are flagged.
  let cloudInit = input.cloudInit;
  if (cloudInit === undefined) {
    try {
      cloudInit = pve.isCloudInitTemplate(await pve.getVmConfig(input.node, input.proxmoxVmId));
    } catch {
      cloudInit = false;
    }
  }

  return prisma.template.upsert({
    where: { proxmoxVmId: input.proxmoxVmId },
    update: {
      name: input.name,
      description: input.description ?? null,
      os: input.os ?? null,
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
      proxmoxVmId: input.proxmoxVmId,
      proxmoxNode: input.node,
      diskGb,
      cloudInit,
      notes: input.notes ?? null,
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
];

export interface AddCloudImageInput {
  name: string;
  imageUrl: string;
  os?: string;
  description?: string;
  node?: string;
}

/**
 * Build a cloud-init template from a cloud image, entirely via the Proxmox API:
 * download the image → import it as a VM disk + attach a cloud-init drive →
 * convert to a template → register it (flagged `cloudInit`). Long-running (the
 * image download is hundreds of MB). The source image is deleted once imported.
 */
export async function addCloudImage(input: AddCloudImageInput): Promise<Template> {
  const client = await pve.getClient();
  const diskStorage = await getConfig('default_storage');
  const bridge = await getConfig('default_bridge');
  if (!diskStorage || !bridge) {
    throw new Error('Server defaults are not configured — finish setup first');
  }

  // Place on a node that has the disk pool (default = best capacity). Linked
  // clones of the template will stay on this node, like every other template.
  const node = input.node ?? (await pve.pickBestNode({ cpu: 1, ramMb: 1024, storageGb: 4 }, diskStorage, client));

  // Need an import-capable storage on that node to land the downloaded image.
  const importStorages = await pve.getImportStorages(node, client);
  if (importStorages.length === 0) {
    throw new Error(`No storage on "${node}" accepts disk images (enable the "import" content type on a directory storage).`);
  }
  const isoStorage = (await getConfig('iso_storage')) ?? '';
  const importStorage = importStorages.includes(isoStorage) ? isoStorage : importStorages[0]!;

  // Proxmox VM names must be DNS-ish; the store name keeps the admin's label.
  const safeName = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cloud-image';
  const filename = `${safeName}-${Date.now()}.qcow2`; // import needs a disk-image extension
  const importFrom = `${importStorage}:import/${filename}`;
  const vmid = await pve.getNextVmId(client);

  // 1. Download the image (can take minutes for the larger images).
  const dlUpid = await pve.downloadUrlToStorage(node, importStorage, { url: input.imageUrl, filename }, client);
  await pve.waitForTask(node, dlUpid, client, 900_000);

  try {
    // 2. Create the VM importing that disk + a cloud-init drive.
    const createUpid = await pve.createCloudInitVm({ node, vmid, name: safeName, importFrom, diskStorage, bridge }, client);
    await pve.waitForTask(node, createUpid, client, 600_000);

    // 3. Read the imported disk's real size, then convert to a template.
    const diskGb = pve.primaryDiskSizeGb(await pve.getVmConfig(node, vmid, client));
    await pve.convertToTemplate(node, vmid, client);

    // 4. Register in the store as a cloud-init template.
    const tpl = await register({
      proxmoxVmId: vmid,
      node,
      name: input.name,
      description: input.description,
      os: input.os,
      diskGb,
      cloudInit: true,
    });
    await pve.deleteStorageVolume(node, importFrom, client).catch(() => {}); // image no longer needed
    return tpl;
  } catch (err) {
    // Best-effort cleanup of partial artifacts so a failed build leaves nothing.
    await pve.deleteStorageVolume(node, importFrom, client).catch(() => {});
    await pve.deleteVm(node, vmid, client).catch(() => {});
    throw err;
  }
}

// ─── Cloud-init "extras" support (install Docker / Tailscale snippets) ─

/** The storage we use for snippets (the ISO storage is a directory). */
export async function getSnippetStorage(): Promise<string> {
  return (await getConfig('iso_storage')) ?? 'local';
}

/** All non-empty combinations of the available features. */
function featureCombos(): string[][] {
  const ids = pve.CLOUD_INIT_FEATURES.map((f) => f.id);
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
  features: Array<{ id: string; label: string; hint: string }>;
  bundles: CloudInitBundle[];
}

/** Admin view: every snippet bundle to place, with content/commands + readiness. */
export async function getCloudInitExtras(): Promise<CloudInitExtras> {
  const client = await pve.getClient();
  const storage = await getSnippetStorage();
  const sres = await client.get<{ data: Array<{ storage: string; content?: string; path?: string }> }>('/storage');
  const s = sres.data.data.find((x) => x.storage === storage);
  const snippetsEnabled = (s?.content ?? '').split(',').includes('snippets');
  const dir = `${s?.path ?? '/var/lib/vz'}/snippets`;

  const featLabel = (id: string) =>
    (pve.CLOUD_INIT_FEATURES.find((f) => f.id === id)?.label ?? id).replace(/^Install /, '');

  const bundles: CloudInitBundle[] = [];
  for (const combo of featureCombos()) {
    const file = pve.cloudInitSnippetFile(combo);
    const content = pve.cloudInitSnippetContent(combo);
    bundles.push({
      features: [...combo].sort(),
      label: [...combo].sort().map(featLabel).join(' + '),
      file,
      volid: `${storage}:snippets/${file}`,
      content,
      command: `mkdir -p ${dir} && cat > ${dir}/${file} <<'EOF'\n${content}EOF`,
      nodesReady: snippetsEnabled ? await pve.nodesWithSnippet(storage, file, client) : [],
    });
  }

  return {
    storage,
    snippetsEnabled,
    features: pve.CLOUD_INIT_FEATURES.map((f) => ({ id: f.id, label: f.label, hint: f.hint })),
    bundles,
  };
}

export interface CloudInitStatus {
  snippetsEnabled: boolean;
  features: Array<{ id: string; label: string; hint: string }>;
  nodes: Record<string, string[]>; // node → present ProxMate snippet filenames
}

/** Lightweight (wizard): the features + which ProxMate snippet files are present on each node. */
export async function cloudInitStatus(): Promise<CloudInitStatus> {
  const features = pve.CLOUD_INIT_FEATURES.map((f) => ({ id: f.id, label: f.label, hint: f.hint }));
  const client = await pve.getClient();
  const storage = await getSnippetStorage();
  const sres = await client.get<{ data: Array<{ storage: string; content?: string }> }>('/storage');
  const snippetsEnabled = (sres.data.data.find((x) => x.storage === storage)?.content ?? '').split(',').includes('snippets');
  if (!snippetsEnabled) return { snippetsEnabled: false, features, nodes: {} };

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
  return { snippetsEnabled, features, nodes };
}

/** Admin: enable the `snippets` content type on the snippet storage (API-doable). */
export async function enableCloudInitSnippets(): Promise<CloudInitExtras> {
  await pve.ensureSnippetsEnabled(await getSnippetStorage(), await pve.getClient());
  return getCloudInitExtras();
}
