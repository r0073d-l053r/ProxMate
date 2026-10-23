import { promises as fsp, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import type { User, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { backupDir } from './download.service.js';
import { getBackupStorage } from './matestate.service.js';
import {
  assertWithinQuota,
  acquireQuotaLock,
  markClonedGuest,
  settleFailedCreate,
  syncRestoredGuest,
  assertOwnVolumes,
  nextVmId,
} from './vm.service.js';
import { parseGuestConfigText, guestConfigSizes } from '../lib/guest-config.js';
import * as pve from './proxmox.service.js';

/**
 * Restore-from-upload: a tenant uploads a vzdump archive they previously
 * downloaded (MateState download email) and ProxMate restores it as a brand-new
 * guest — the migration path between clusters / ProxMate instances.
 *
 * The Proxmox API cannot accept backup uploads (`upload` rejects
 * `content=backup`), so this is the write-side twin of the download feature:
 * the file is streamed into the admin-mounted backup share
 * (`BACKUP_DOWNLOAD_DIR`), where Proxmox's storage scan picks it up as a
 * regular backup volume, and the restore runs through the normal API. The
 * feature therefore requires the mount to be WRITABLE (downloads only read).
 */

/** Same strict shape the download side enforces — nothing path-like gets through. */
export const VZDUMP_UPLOAD_RE = /^vzdump-(qemu|lxc)-\d+-[\w.-]+\.(vma|tar)(\.(zst|gz|lzo))?$/;

/** Where uploads land: Proxmox dir storages keep backups in `<dir>/dump`. */
export function uploadDir(): string | null {
  const dir = backupDir();
  if (!dir) return null;
  const dump = path.join(dir, 'dump');
  return existsSync(dump) ? dump : dir;
}

/** Whether restore-from-upload is available (share mounted AND writable). */
export async function restoreUploadsEnabled(): Promise<boolean> {
  const dir = uploadDir();
  if (!dir) return false;
  try {
    await fsp.access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class RestoreUploadError extends Error {}

/** The dot-name multer writes uploads under before they're validated + renamed. */
export const TEMP_UPLOAD_RE = /^\.proxmate-upload-[a-f0-9]{16}\.part$/;

/**
 * Re-derive a TRUSTED absolute path from a possibly tainted one: reduce to a
 * bare basename, require it to match `expect`, resolve it under the upload
 * root, and verify containment (same hardening as the download side's
 * resolveBackupFile). Returns null for anything path-like or foreign — the
 * only way a client-influenced string may reach the filesystem.
 */
export function resolveUnderUploadDir(candidate: string, expect: RegExp): string | null {
  const dir = uploadDir();
  if (!dir) return null;
  const base = path.basename(candidate);
  if (!expect.test(base)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, base);
  if (!full.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel !== base) return null;
  return full;
}

export interface ParsedBackupConfig {
  cores: number;
  memoryMb: number;
  diskGb: number;
  guestName: string | null;
  /** A disk line with no `size=`: the restore would allocate a size this parse can't see. */
  unsizedDisk: boolean;
}

/**
 * Parse the vzdump-embedded guest config (from `vzdump/extractconfig`) into the
 * resource numbers the quota check needs. Pure — unit-tested directly. CPUs are
 * counted as Proxmox runs them (QEMU: sockets x cores, or `vcpus`); memory may be
 * a property string (`current=N`).
 */
export function parseBackupConfig(text: string, kind: pve.GuestKind = 'qemu'): ParsedBackupConfig {
  const cfg = parseGuestConfigText(text);
  const sizes = guestConfigSizes(cfg, kind);
  let diskBytes = 0;
  let unsizedDisk = false;

  const DISK_RE = /^(scsi|sata|virtio|ide|efidisk|tpmstate|rootfs|mp)\d*$/;
  const SIZE_RE = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)/;
  const UNIT: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

  for (const [key, value] of Object.entries(cfg)) {
    if (!DISK_RE.test(key) || value.includes('media=cdrom')) continue;
    const s = value.match(SIZE_RE);
    if (s) diskBytes += parseFloat(s[1]!) * (UNIT[s[2] ?? ''] ?? 1);
    else unsizedDisk = true;
  }

  return {
    // A container with no `cores` line is charged one core; the restore pins it to that.
    cores: sizes.cpu ?? 1,
    memoryMb: Math.max(16, sizes.ram),
    diskGb: Math.ceil(diskBytes / 1024 ** 3),
    guestName: (cfg['name'] ?? cfg['hostname'])?.trim() || null,
    unsizedDisk,
  };
}

// ─── Archive config allowlist ─────────────────────────────────
//
// The archive is built by the tenant, and a restore applies every key in it. So
// only keys that describe the guest itself are accepted; anything else — host
// devices (PCI, USB, serial/parallel ports, container device nodes, virtiofs),
// host paths, raw QEMU arguments, hook scripts, custom cloud-init snippets, NUMA
// host pinning, CPU affinity, RNG sources, raw LXC keys, container features
// beyond nesting, a template flag or a privileged container — refuses the
// archive. Keys a restore must not keep (autostart, start order, protection) are
// accepted but stripped afterwards, and every NIC is rebuilt from scratch.
// `cicustom` is accepted because ProxMate writes it itself (the vendor snippet of
// a cloud-init deploy), but it survives the restore only while every snippet it
// names is one ProxMate produces (see ownCicustom); otherwise it is stripped.

const COMMON_KEYS = new Set([
  'name', 'hostname', 'description', 'tags', 'ostype', 'arch', 'cores', 'memory', 'cpulimit', 'cpuunits',
  'onboot', 'startup', 'protection', 'template', 'digest', 'parent', 'nameserver', 'searchdomain',
]);
const QEMU_KEYS = new Set([
  'agent', 'acpi', 'balloon', 'shares', 'bios', 'boot', 'bootdisk', 'cpu', 'hotplug', 'kvm', 'localtime',
  'machine', 'numa', 'scsihw', 'smbios1', 'sockets', 'vcpus', 'tablet', 'vga', 'vmgenid', 'keyboard', 'meta',
  'citype', 'ciuser', 'cipassword', 'ciupgrade', 'sshkeys', 'cicustom',
]);
const QEMU_KEY_PATTERNS = [/^(ide|sata|scsi|virtio)\d+$/, /^efidisk0$/, /^tpmstate0$/, /^net\d+$/, /^ipconfig\d+$/, /^serial\d+$/, /^unused\d+$/];
const LXC_KEYS = new Set(['swap', 'unprivileged', 'features', 'timezone', 'console', 'tty', 'cmode', 'rootfs']);
const LXC_KEY_PATTERNS = [/^mp\d+$/, /^net\d+$/, /^unused\d+$/];
const DISK_KEY = /^(ide|sata|scsi|virtio)\d+$|^efidisk0$|^tpmstate0$|^rootfs$|^mp\d+$|^unused\d+$/;

/** Config keys a restore may carry, but that are removed from the restored guest. */
export const STRIPPED_AFTER_RESTORE = ['onboot', 'startup', 'protection'];

/** Why one allowed key's value is still refused, or null. */
function valueProblem(key: string, value: string): string | null {
  const v = value.trim();
  if (DISK_KEY.test(key)) {
    const volume = v.split(',')[0] ?? '';
    // A storage volume (`pool:name`), `none`, or a cdrom ISO — never a host path or an import.
    if (volume.startsWith('/') || /(^|,)import-from=/.test(v) || (volume !== 'none' && !volume.includes(':'))) {
      return 'a disk that is not a storage volume';
    }
  }
  if (/^serial\d+$/.test(key) && v !== 'socket') return 'a host serial port';
  if (key === 'numa' && v !== '0' && v !== '1') return 'NUMA host pinning';
  if (key === 'template' && v !== '0') return 'the template flag';
  if (key === 'features' && v.split(',').some((f) => !/^nesting=[01]$/.test(f.trim()))) return 'container features beyond nesting';
  return null;
}

/**
 * Refuse an archive whose config reaches past the guest itself (see the allowlist
 * above). Throws RestoreUploadError naming the first offending key.
 */
export function assertRestorableConfig(text: string, kind: pve.GuestKind): void {
  const cfg = parseGuestConfigText(text);
  const [keys, patterns] = kind === 'lxc' ? [LXC_KEYS, LXC_KEY_PATTERNS] : [QEMU_KEYS, QEMU_KEY_PATTERNS];
  for (const [key, value] of Object.entries(cfg)) {
    const allowed = COMMON_KEYS.has(key) || keys.has(key) || patterns.some((re) => re.test(key));
    const problem = allowed ? valueProblem(key, value) : null;
    if (!allowed || problem) {
      throw new RestoreUploadError(
        `This backup can't be restored here: its configuration sets "${key}"${problem ? ` (${problem})` : ''}, which an uploaded backup may not carry.`,
      );
    }
  }
  if (kind === 'lxc' && cfg['unprivileged']?.trim() !== '1') {
    throw new RestoreUploadError("This backup can't be restored here: it is a privileged container.");
  }
}

/**
 * Whether a `cicustom` value names only snippets ProxMate itself writes: each part
 * is `<SNIPPET_STORAGE>:snippets/proxmate-<features>.yaml` (pve.cloudInitSnippetFile).
 * Their content comes from ProxMate's fixed feature catalog, never from a tenant.
 */
export function ownCicustom(value: string): boolean {
  const storage = pve.snippetWriteConfig()?.storage;
  if (!storage) return false;
  const esc = storage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const part = new RegExp(`^(vendor|user)=${esc}:snippets/proxmate-[a-z0-9-]+\\.yaml$`);
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => part.test(p));
}

/** Remove the keys a restore must not keep (STRIPPED_AFTER_RESTORE) from a restored guest. */
async function stripRestoreFlags(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  kind: pve.GuestKind,
): Promise<void> {
  const cfg = await pve.getVmConfig(node, vmid, client, kind);
  const strip = STRIPPED_AFTER_RESTORE.filter((k) => k in cfg);
  if (strip.length > 0) {
    await client.put(`/nodes/${node}/${kind}/${vmid}/config`, new URLSearchParams({ delete: strip.join(',') }));
  }
}

/** The swap ProxMate gives a container it creates (pve.createLxc's default), in MB. */
const LXC_DEFAULT_SWAP_MB = 512;

const NIC_MODELS = new Set(['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3']);

/**
 * Replace every NIC the archive brought with one built from scratch: the same NIC
 * model (QEMU) or interface name (LXC), a fresh MAC, the admin's default bridge,
 * the isolation VLAN tag when one is configured, and the firewall flag. Nothing
 * else on the archive's NIC line (MAC, trunks, rate, static addresses, …) survives.
 * Also removes the keys a restore must not keep (STRIPPED_AFTER_RESTORE).
 */
async function rebuildRestoredGuestConfig(
  node: string,
  vmid: number,
  isolate: boolean,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  kind: pve.GuestKind,
): Promise<void> {
  const bridge = await getConfig('default_bridge');
  if (!bridge) throw new RestoreUploadError('Server defaults are not configured — finish setup first');
  const vlanTag = isolate ? (await pve.readIsolationOptions()).vlanTag : undefined;
  const tag = vlanTag !== undefined ? `,tag=${vlanTag}` : '';
  const cfg = await pve.getVmConfig(node, vmid, client, kind);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(cfg)) {
    const m = /^net(\d+)$/.exec(key);
    if (!m) continue;
    if (kind === 'lxc') {
      const name = /(?:^|,)name=([a-z0-9]{1,15})(?:,|$)/.exec(value)?.[1] ?? `eth${m[1]}`;
      params.set(key, `name=${name},bridge=${bridge},firewall=1,ip=dhcp${tag}`);
    } else {
      const first = (value.split(',')[0] ?? '').split('=');
      const model = first[0] === 'model' ? first[1] ?? '' : first[0] ?? '';
      params.set(key, `${NIC_MODELS.has(model) ? model : 'virtio'},bridge=${bridge},firewall=1${tag}`);
    }
  }
  // Swap is not quota-counted, so a container keeps no more than ProxMate's own default.
  if (kind === 'lxc' && cfg['swap'] !== undefined && !(Number(cfg['swap']) <= LXC_DEFAULT_SWAP_MB)) {
    params.set('swap', String(LXC_DEFAULT_SWAP_MB));
  }
  const strip = STRIPPED_AFTER_RESTORE.filter((k) => k in cfg);
  if (cfg['cicustom'] !== undefined && !ownCicustom(cfg['cicustom'])) strip.push('cicustom');
  if (strip.length > 0) params.set('delete', strip.join(','));
  if ([...params.keys()].length > 0) await client.put(`/nodes/${node}/${kind}/${vmid}/config`, params);
}

/** Best-effort removal of the uploaded archive (Proxmox API first, then the mount). */
async function cleanupArchive(filename: string, node: string | null, storage: string, volid: string): Promise<void> {
  if (node) {
    try {
      await pve.deleteBackup(node, storage, volid);
      return;
    } catch {
      /* fall through to direct unlink */
    }
  }
  const dir = uploadDir();
  if (dir) await fsp.unlink(path.join(dir, path.basename(filename))).catch(() => undefined);
}

/**
 * Restore an uploaded vzdump archive as a new guest owned by `user`.
 * Assumes the file is already fully written into `uploadDir()` under a
 * validated vzdump filename. Always removes the archive afterwards — it was a
 * transient carrier, and leaving it would clutter every VM's backup listing
 * under the OLD (foreign) VMID.
 */
export async function restoreFromUpload(
  user: User,
  input: { filename: string; name: string },
): Promise<VirtualMachine> {
  // Quota check -> row insert runs under the owner's quota lock (vm.service
  // acquireQuotaLock), released as soon as the row exists.
  const release = await acquireQuotaLock(user.id);
  try {
    return await restoreFromUploadLocked(user, input, release);
  } finally {
    release();
  }
}

async function restoreFromUploadLocked(
  user: User,
  input: { filename: string; name: string },
  release: () => void,
): Promise<VirtualMachine> {
  const filename = path.basename(input.filename);
  if (filename !== input.filename || !VZDUMP_UPLOAD_RE.test(filename)) {
    throw new RestoreUploadError('That file is not a vzdump backup archive.');
  }
  const kind: pve.GuestKind = filename.startsWith('vzdump-lxc-') ? 'lxc' : 'qemu';

  const client = await pve.getClient();
  const storage = await getBackupStorage();
  const volid = `${storage}:backup/${filename}`;

  // Proxmox must see the uploaded file through the same storage the share is a
  // mount of — if it doesn't, the mount and `backup_storage` point at
  // different places and restoring is impossible.
  const nodes = await pve.getBackupNodes(storage, volid, client);
  if (nodes.length === 0) {
    await cleanupArchive(filename, null, storage, volid);
    throw new RestoreUploadError(
      `The uploaded file isn't visible on the "${storage}" backup storage. ` +
        'Check that BACKUP_DOWNLOAD_DIR is mounted from that storage\'s directory.',
    );
  }

  // Set when a restore task outlived our wait and its follower owns the archive.
  let archiveHandedOff = false;
  try {
    // Quota-check from the archive's embedded config BEFORE restoring anything.
    const rawCfg = await pve.extractBackupConfig(nodes[0]!, volid, client);
    assertRestorableConfig(rawCfg, kind);
    const cfg = parseBackupConfig(rawCfg, kind);
    if (cfg.unsizedDisk) {
      throw new RestoreUploadError("This backup can't be restored here: a disk in its configuration has no size.");
    }
    await assertWithinQuota(user, {
      name: input.name,
      cpu: cfg.cores,
      ram: cfg.memoryMb,
      storage: cfg.diskGb,
      os: filename,
    });

    const [defaultStorage, isolationCfg] = await Promise.all([
      getConfig('default_storage'),
      getConfig('isolation_enabled'),
    ]);
    if (!defaultStorage) throw new RestoreUploadError('Server defaults are not configured — finish setup first');
    const isolate = isolationCfg !== 'false';

    const node = await pve.pickBestNode(
      { cpu: cfg.cores, ramMb: cfg.memoryMb, storageGb: cfg.diskGb },
      defaultStorage,
      client,
      nodes,
      // ARM guest builds aren't shipped, so uploaded backups are x86 today.
      'amd64',
    );
    const vmid = await nextVmId(client);

    const vm = await prisma.virtualMachine.create({
      data: {
        userId: user.id,
        proxmoxVmId: vmid,
        proxmoxNode: node,
        name: input.name,
        description: `Restored from uploaded backup${cfg.guestName ? ` of "${cfg.guestName}"` : ''}`,
        type: kind,
        cpu: cfg.cores,
        ram: cfg.memoryMb,
        storage: cfg.diskGb,
        os: 'Restored backup',
        status: 'creating',
      },
    });
    release(); // usage now includes this row

    let created = false;
    let restoreTask:
      | { node: string; upid: string; beforeTag: () => Promise<void>; afterTask: () => Promise<void> }
      | undefined;
    try {
      // Remap all volumes onto our default pool: cross-cluster archives name
      // storages this cluster may not have. unique=1 → fresh MACs.
      // Volumes already listed for this VMID (left by an earlier guest that had it)
      // must not end up attached to the restored guest; see assertOwnVolumes.
      const leftovers = await pve.listGuestVolumes(node, vmid, client);
      const upid = await pve.restoreNewGuest({ node, vmid, volid, storage: defaultStorage }, client, kind);
      restoreTask = {
        node,
        upid,
        // A restore that finishes after we stopped waiting gets the same treatment
        // as one that finished in time before it is ever tied to the row (the row
        // stays held either way).
        beforeTag: async () => {
          await pve.setVmName(node, vmid, input.name, client, kind).catch(() => undefined);
          await stripRestoreFlags(node, vmid, client, kind);
          await assertOwnVolumes(vm, client, leftovers);
          await rebuildRestoredGuestConfig(node, vmid, isolate, client, kind);
          if (isolate) await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client, kind);
          await syncRestoredGuest(vm, { approvedPci: [], client });
        },
        afterTask: () => cleanupArchive(filename, node, storage, volid),
      };
      await pve.waitForTask(node, upid, client, 30 * 60 * 1000);
      created = true;
      // The archive's config carries the OLD guest's tags; tie the guest to this row.
      await markClonedGuest(vm, client);
      // Drop the archive's protection/autostart first: a protected guest couldn't
      // be cleaned up by the volume check below, and nothing may start it on its own.
      await stripRestoreFlags(node, vmid, client, kind);
      // Every volume the restored config references must be this guest's own.
      await assertOwnVolumes(vm, client, leftovers);

      // Before anything else may happen to the guest: its name, network placement
      // and isolation are ours, not the archive's.
      // The restored config carries the OLD guest's name — apply the chosen one.
      await pve.setVmName(node, vmid, input.name, client, kind).catch(() => undefined);

      // ...and the OLD guest's NICs, whose bridge may not exist on this cluster at
      // all. `storage` above remaps the volumes; this is the network half of the same job.
      await rebuildRestoredGuestConfig(node, vmid, isolate, client, kind);

      // Tenant isolation BEFORE first boot, built from the regenerated MACs.
      if (isolate) {
        await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client, kind);
      }

      // Read back what was actually restored: no PCI device is approved for a new
      // guest, and the row's sizes come from the guest itself.
      await syncRestoredGuest(vm, { approvedPci: [], client });

      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
      const startUpid = await pve.startVm(node, vmid, client, kind);
      await pve.waitForTask(node, startUpid, client);
      const done = await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
      await cleanupArchive(filename, node, storage, volid);
      return done;
    } catch (err) {
      // Any failure once the restore has landed leaves the row in `error`, which
      // nothing may start. A restore task still running when the wait gave up keeps
      // reading the archive; its follower removes the archive once it ends.
      const { following } = await settleFailedCreate(vm, err, created, { task: restoreTask });
      if (following) archiveHandedOff = true;
      throw err;
    }
  } catch (err) {
    // Any pre-restore failure (quota, placement, extract) — drop the archive so
    // a rejected upload never lingers on the backup storage.
    if (!archiveHandedOff) await cleanupArchive(filename, nodes[0] ?? null, storage, volid);
    throw err;
  }
}
