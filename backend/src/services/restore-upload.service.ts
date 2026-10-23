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
  recordOpTask,
  OP_SETTLED,
  type VmOpKind,
  nextVmId,
  reserveVmIds,
  releaseVmId,
} from './vm.service.js';
import { beginInFlight } from '../lib/in-flight.js';
import { parseGuestConfigText, guestConfigSizes } from '../lib/guest-config.js';
import { readArchiveConfig, ArchiveConfigError } from '../lib/vzdump-archive.js';
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
const DISK_KEY = /^(ide|sata|scsi|virtio)\d+$|^efidisk0$|^tpmstate0$|^rootfs$|^mp\d+$|^unused\d+$|^vmstate$/;

/** Config keys a restore may carry, but that are removed from the restored guest. */
export const STRIPPED_AFTER_RESTORE = ['onboot', 'startup', 'protection'];

/** Why one allowed key's value is still refused, or null. */
function valueProblem(key: string, value: string): string | null {
  const v = value.trim();
  if (DISK_KEY.test(key)) {
    // The volume is the property string's `file=`/`volume=` item, or its bare first
    // item (the default key). More than one of those, or none, is refused.
    const parts = v.split(',').map((p) => p.trim());
    const named = parts.filter((p) => /^(file|volume)=/.test(p)).map((p) => p.slice(p.indexOf('=') + 1));
    const bare = parts[0] !== undefined && !/^[a-z_-]+=/.test(parts[0]) ? [parts[0]] : [];
    const volumes = [...bare, ...named];
    const volume = volumes.length === 1 ? volumes[0]! : '';
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

/** Keys only a snapshot section carries (`[name]`), on top of the guest's own. */
const SNAPSHOT_SECTION_KEYS = new Set(['snaptime', 'vmstate', 'runningmachine', 'runningcpu', 'snapstate']);
/** `[PENDING]`, `[special:cloudinit]` or a snapshot name, as Proxmox's config parser accepts them. */
const SECTION_RE = /^\[(PENDING|special:cloudinit|[a-z][a-z0-9_-]*)\]$/;

/** Why one config key is refused for a guest of `kind`, or null. */
function keyProblem(key: string, value: string, kind: pve.GuestKind, extra: ReadonlySet<string> = new Set()): string | null {
  const [keys, patterns] = kind === 'lxc' ? [LXC_KEYS, LXC_KEY_PATTERNS] : [QEMU_KEYS, QEMU_KEY_PATTERNS];
  const allowed = COMMON_KEYS.has(key) || keys.has(key) || extra.has(key) || patterns.some((re) => re.test(key));
  if (!allowed) return `"${key}"`;
  const problem = valueProblem(key, value);
  return problem ? `"${key}" (${problem})` : null;
}

/**
 * Refuse an archive whose config reaches past the guest itself (see the allowlist
 * above). Throws RestoreUploadError naming the first offending key. Every section
 * is checked — the guest's own, `[PENDING]`, `[special:cloudinit]` and each
 * snapshot — and a line ProxMate cannot read refuses the archive, so nothing can
 * sit where this check does not look. This is an early estimate only: Proxmox may
 * apply settings the archive carries elsewhere (a container's rootfs can hold its
 * own `etc/vzdump/pct.conf`), so the restored guest is checked again
 * (assertRestoredGuestConfig).
 */
export function assertRestorableConfig(text: string, kind: pve.GuestKind): void {
  const refuse = (what: string) =>
    new RestoreUploadError(`This backup can't be restored here: its configuration sets ${what}, which an uploaded backup may not carry.`);
  let extra: ReadonlySet<string> = new Set();
  let inMain = true;
  let unprivileged: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const m = SECTION_RE.exec(line);
      if (!m) throw new RestoreUploadError("This backup can't be restored here: its configuration has a section ProxMate can't read.");
      if (m[1] === 'PENDING') {
        throw new RestoreUploadError(
          "This backup can't be restored here: it carries pending changes. Apply or revert them in Proxmox, then back it up again.",
        );
      }
      inMain = false;
      extra = SNAPSHOT_SECTION_KEYS;
      continue;
    }
    const m = /^([a-z][a-z0-9_.-]*):\s*(.*)$/.exec(line);
    if (!m) throw new RestoreUploadError("This backup can't be restored here: its configuration has a line ProxMate can't read.");
    const problem = keyProblem(m[1]!, m[2]!, kind, extra);
    if (problem) throw refuse(problem);
    if (inMain && m[1] === 'unprivileged') unprivileged = m[2]!.trim();
  }
  if (kind === 'lxc' && unprivileged !== '1') {
    throw new RestoreUploadError("This backup can't be restored here: it is a privileged container.");
  }
}

/** Thrown when a restored guest's own config carries something ProxMate does not restore. */
export class RestoredConfigError extends RestoreUploadError {
  constructor(
    public readonly problem: string,
    /** Config keys of the guest itself that are refused. */
    public readonly keys: string[] = [],
    /** Keys with a pending change. */
    public readonly pendingKeys: string[] = [],
  ) {
    super(`The backup contains settings ProxMate won't restore (${problem}).`);
    this.name = 'RestoredConfigError';
  }
}

/**
 * Check a restored guest's config as Proxmox now holds it, before the guest is
 * used. The archive pre-check cannot be authoritative: a container restore applies
 * the `etc/vzdump/pct.conf` found in the extracted rootfs (the last one wins), and
 * Proxmox's own reading of an archive may differ from ours. So the live config and
 * every pending change are checked with the same allowlist as the archive, and the
 * snapshots: refused outright for a fresh restore (vzdump carries none), each one's
 * config checked with `allowSnapshots`. `allowKey` lets a caller accept a line the
 * allowlist refuses (an approved PCI device). Throws RestoredConfigError listing
 * every problem; a read failure throws too (fail closed).
 */
export async function assertRestoredGuestConfig(
  node: string,
  vmid: number,
  kind: pve.GuestKind,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  opts: { allowSnapshots?: boolean; allowKey?: (key: string, value: string) => boolean } = {},
): Promise<void> {
  const base = `/nodes/${node}/${kind}/${vmid}`;
  const [cfgRes, pendingRes, snapRes] = await Promise.all([
    client.get<{ data: Record<string, unknown> }>(`${base}/config`),
    client.get<{ data: Array<{ key: string; value?: unknown; pending?: unknown; delete?: number }> }>(`${base}/pending`),
    client.get<{ data: Array<{ name: string }> }>(`${base}/snapshot`),
  ]);
  const problems: string[] = [];
  const check = (cfg: Record<string, unknown>, extra: ReadonlySet<string>): string[] => {
    const bad: string[] = [];
    for (const [key, value] of Object.entries(cfg)) {
      const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
      if (text !== null && opts.allowKey?.(key, text)) continue;
      // Anything but a plain value (e.g. raw `lxc` entries, returned as a list) is refused.
      const problem = text === null ? `"${key}"` : keyProblem(key, text, kind, extra);
      if (problem) {
        problems.push(problem);
        bad.push(key);
      }
    }
    return bad;
  };
  const cfg = cfgRes.data.data ?? {};
  const keys = check(cfg, new Set());
  if (kind === 'lxc' && String(cfg['unprivileged'] ?? '') !== '1') problems.push('a privileged container');
  const pendingKeys = (pendingRes.data.data ?? []).filter((e) => e.pending !== undefined || e.delete).map((e) => e.key);
  if (pendingKeys.length > 0) problems.push(`pending changes to ${pendingKeys.map((k) => `"${k}"`).join(', ')}`);
  const snapshots = (snapRes.data.data ?? []).filter((x) => x.name !== 'current');
  if (snapshots.length > 0 && !opts.allowSnapshots) problems.push('snapshots');
  if (opts.allowSnapshots) {
    for (const { name } of snapshots) {
      const snap = await client.get<{ data: Record<string, unknown> }>(`${base}/snapshot/${encodeURIComponent(name)}/config`);
      const before = problems.length;
      check(snap.data.data ?? {}, SNAPSHOT_SECTION_KEYS);
      for (let i = before; i < problems.length; i += 1) problems[i] = `${problems[i]} in snapshot "${name}"`;
    }
  }
  if (problems.length > 0) throw new RestoredConfigError(problems.join(', '), keys, pendingKeys);
}

/**
 * Make a restored guest that failed assertRestoredGuestConfig (or could not be
 * checked) harmless. First the keys that would let Proxmox start it on its own or
 * refuse its removal (`protection`, `onboot`, `startup`) go; then, with `destroy`,
 * it is deleted. Only callers that know the guest is the product of their own
 * restore pass `destroy`: a restore without `force` fails on an existing VMID, so
 * a finished task's guest at that VMID can only be the one it created. A guest
 * that is kept (or cannot be deleted) loses every refused key and pending change
 * Proxmox lets the API remove, and every NIC is set to `link_down`. Best effort
 * throughout; returns whether the guest is gone.
 */
export async function neutraliseRestoredGuest(
  node: string,
  vmid: number,
  kind: pve.GuestKind,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  opts: { keys?: string[]; pendingKeys?: string[]; destroy: boolean },
): Promise<boolean> {
  const configUrl = `/nodes/${node}/${kind}/${vmid}/config`;
  const put = (params: Record<string, string>) =>
    client.put(configUrl, new URLSearchParams(params)).then(() => true, () => false);
  for (const key of ['protection', 'onboot', 'startup']) await put({ delete: key });
  if (opts.destroy) {
    try {
      const upid = await pve.deleteVm(node, vmid, client, kind);
      await pve.waitForTask(node, upid, client, 10 * 60 * 1000);
      return true;
    } catch {
      /* still there: take away what it must not have */
    }
  }
  if ((opts.pendingKeys ?? []).length > 0) await put({ revert: opts.pendingKeys!.join(',') });
  // One at a time, so a key the API won't touch doesn't keep the others. Never
  // `unprivileged`: removing it would make the container privileged.
  for (const key of opts.keys ?? []) if (key !== 'unprivileged') await put({ delete: key });
  try {
    const cfg = (await client.get<{ data: Record<string, unknown> }>(configUrl)).data.data ?? {};
    for (const [key, value] of Object.entries(cfg)) {
      if (!/^net\d+$/.test(key) || typeof value !== 'string' || /(^|,)link_down=1(,|$)/.test(value)) continue;
      await put({ [key]: `${value.replace(/(^|,)link_down=[^,]*/g, '')},link_down=1` });
    }
  } catch {
    /* config unreadable: the row is held either way */
  }
  return false;
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
export async function stripRestoreFlags(
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

/**
 * Best-effort removal of an uploaded archive known only by its volid (as a
 * `restore-upload` row records it in `opArchive`), for the restart reconciler.
 */
export async function cleanupUploadedArchive(volid: string, node: string | null, rowId?: string): Promise<void> {
  const storage = volid.split(':')[0] ?? '';
  const filename = path.basename(volid.slice(volid.indexOf(':') + 1));
  if (!storage || !VZDUMP_UPLOAD_RE.test(filename)) return;
  if (rowId && (await archiveClaimedByOther(volid, rowId))) return;
  await cleanupArchive(filename, node, storage, volid);
}

/** Rows whose restore may still need an archive: still creating, or still carrying a task. */
const ARCHIVE_USERS = [{ status: 'creating' }, { opUpid: { not: null } }];

/**
 * Whether a row other than `rowId` still needs this archive (it is creating, or
 * still carries a task, with the same `opArchive`). Such an archive is left alone.
 * A failed lookup counts as claimed.
 */
export async function archiveClaimedByOther(volid: string, rowId: string): Promise<boolean> {
  try {
    return (
      (await prisma.virtualMachine.count({ where: { opArchive: volid, id: { not: rowId }, OR: ARCHIVE_USERS } })) > 0
    );
  } catch {
    return true;
  }
}

/**
 * Marks an archive ProxMate itself wrote to the share (`.proxmate-uploaded.<name>`,
 * a dot-file Proxmox's backup scan ignores). The share is also where real vzdump
 * backups live, under the same naming, so only marked archives are ever swept.
 */
const MARKER_PREFIX = '.proxmate-uploaded.';
export const UPLOAD_MARKER_RE = /^\.proxmate-uploaded\.vzdump-(qemu|lxc)-\d+-[\w.-]+\.(vma|tar)(\.(zst|gz|lzo))?$/;

function markerPath(filename: string): string | null {
  return resolveUnderUploadDir(MARKER_PREFIX + filename, UPLOAD_MARKER_RE);
}

/** Record that `filename` (already validated, in the upload directory) is an upload ProxMate wrote. */
export async function markUploaded(filename: string): Promise<void> {
  const marker = markerPath(filename);
  if (marker) await fsp.writeFile(marker, '');
}

/**
 * Record in the marker the VMID a restore of this upload is creating, so the sweep
 * can tell an archive a restore may still be reading (its machine row is still
 * `creating`) from one left behind. The archive name's own VMID is the tenant's
 * original one outside pool mode, so it cannot serve as that key.
 */
async function noteRestoreTarget(filename: string, vmid: number): Promise<void> {
  const marker = markerPath(filename);
  if (marker) await fsp.writeFile(marker, String(vmid)).catch(() => undefined);
}

/**
 * After a restored guest has passed the check, a later step failed and the row
 * will be held: keep the guest from starting on its own or reaching the network
 * until an admin looks at it (neutraliseRestoredGuest without the delete). An
 * over-quota failure is a quota hold, not a safety one, and is left alone; a
 * failure of the check itself has already been handled. Best effort.
 */
export async function neutraliseAfterFailure(
  node: string,
  vmid: number,
  kind: pve.GuestKind,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  err: unknown,
): Promise<void> {
  if (err instanceof RestoredConfigError || (err as { guestRemoved?: boolean })?.guestRemoved !== undefined) return;
  if ((err as { name?: string })?.name === 'QuotaError') return;
  await neutraliseRestoredGuest(node, vmid, kind, client, { destroy: false }).catch(() => undefined);
}

/**
 * The post-restore check for a guest our own restore task just created at our
 * VMID: on any failure, including one to read the config, the guest is
 * neutralised and removed (see neutraliseRestoredGuest). The error is rethrown
 * with `guestRemoved` set when the guest is gone.
 */
export async function checkRestoredOrRemove(
  node: string,
  vmid: number,
  kind: pve.GuestKind,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  try {
    await assertRestoredGuestConfig(node, vmid, kind, client);
  } catch (err) {
    const bad = err instanceof RestoredConfigError ? err : null;
    const removed = await neutraliseRestoredGuest(node, vmid, kind, client, {
      keys: bad?.keys,
      pendingKeys: bad?.pendingKeys,
      destroy: true,
    });
    if (err && typeof err === 'object') Object.assign(err, { guestRemoved: removed });
    else throw Object.assign(new Error(String(err)), { guestRemoved: removed });
    throw err;
  }
}

/**
 * Move a finished upload from its temp name to its vzdump name (both already
 * resolved under the upload directory) without ever replacing a file: a hard link
 * takes the new name, then the temp name goes. False when the name is taken.
 */
export async function promoteUpload(tempPath: string, finalPath: string): Promise<boolean> {
  try {
    await fsp.link(tempPath, finalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await fsp.unlink(tempPath);
  } catch (err) {
    await fsp.unlink(finalPath).catch(() => undefined);
    throw err;
  }
  return true;
}

/**
 * Give an uploaded archive the VMID it is about to be restored to, in place on the
 * share: `vzdump-qemu-<old>-<rest>` becomes `vzdump-qemu-<vmid>-<rest>`. Proxmox
 * treats a backup as belonging to the VMID in its name, and lets a restore read
 * an archive of the guest being restored, while one named for another VMID needs
 * VM.Backup on that guest — which a pool-scoped token does not have. Both names go
 * through the same validation and containment checks as the upload itself. A hard
 * link takes the new name, so an existing file there is never replaced.
 */
export async function renameArchiveForVmid(filename: string, vmid: number): Promise<string> {
  if (path.basename(filename) !== filename || !VZDUMP_UPLOAD_RE.test(filename)) {
    throw new RestoreUploadError('That file is not a vzdump backup archive.');
  }
  const renamed = filename.replace(/^vzdump-(qemu|lxc)-\d+-/, (_m, kind: string) => `vzdump-${kind}-${vmid}-`);
  const from = resolveUnderUploadDir(filename, VZDUMP_UPLOAD_RE);
  const to = resolveUnderUploadDir(renamed, VZDUMP_UPLOAD_RE);
  if (!from || !to) throw new RestoreUploadError('That file is not a vzdump backup archive.');
  if (from === to) return filename;
  try {
    await fsp.link(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RestoreUploadError(
        'Another uploaded backup for the same machine number is already on the server, so this upload was ' +
          'discarded. Upload it again in a moment.',
      );
    }
    throw err;
  }
  try {
    await fsp.unlink(from);
  } catch (err) {
    // Never leave the archive under both names.
    await fsp.unlink(to).catch(() => undefined);
    throw err;
  }
  const [oldMarker, newMarker] = [markerPath(filename), markerPath(renamed)];
  if (oldMarker && newMarker) await fsp.rename(oldMarker, newMarker).catch(() => undefined);
  return renamed;
}

/** Best-effort removal of the uploaded archive (Proxmox API first, then the mount) and its marker. */
async function cleanupArchive(filename: string, node: string | null, storage: string, volid: string): Promise<void> {
  const marker = markerPath(filename);
  if (marker) await fsp.unlink(marker).catch(() => undefined);
  if (node && volid) {
    try {
      await pve.deleteBackup(node, storage, volid);
      return;
    } catch {
      /* fall through to direct unlink */
    }
  }
  const file = resolveUnderUploadDir(filename, VZDUMP_UPLOAD_RE);
  if (file) await fsp.unlink(file).catch(() => undefined);
}

/**
 * Remove uploads ProxMate wrote and no restore is using: marked archives (and
 * their markers) and unfinished `.proxmate-upload-*.part` files untouched for
 * `olderThanMs`. A marked archive is kept while a machine row still `creating`
 * records it as its archive (`opArchive`) or has the VMID noted in its marker; the
 * restart reconciler removes it when it settles that row. Run at startup; returns
 * how many files were removed.
 */
export async function sweepStaleUploads(olderThanMs = 6 * 60 * 60 * 1000): Promise<number> {
  const dir = uploadDir();
  if (!dir) return 0;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  const old = async (full: string) => (await fsp.stat(full).catch(() => null))?.mtimeMs ?? Infinity;
  const pending = await prisma.virtualMachine.findMany({
    where: { opArchive: { not: null }, OR: ARCHIVE_USERS },
    select: { opArchive: true },
  });
  const inUse = new Set(pending.map((r) => path.basename(String(r.opArchive).slice(String(r.opArchive).indexOf(':') + 1))));
  let removed = 0;
  for (const name of names) {
    if (TEMP_UPLOAD_RE.test(name)) {
      const full = resolveUnderUploadDir(name, TEMP_UPLOAD_RE);
      if (full && (await old(full)) < cutoff && (await fsp.unlink(full).then(() => true, () => false))) removed += 1;
      continue;
    }
    if (!UPLOAD_MARKER_RE.test(name)) continue;
    const marker = resolveUnderUploadDir(name, UPLOAD_MARKER_RE);
    if (!marker || (await old(marker)) >= cutoff) continue;
    const archive = name.slice(MARKER_PREFIX.length);
    if (inUse.has(archive)) continue;
    const noted = (await fsp.readFile(marker, 'utf8').catch(() => '')).trim();
    if (/^\d+$/.test(noted)) {
      const inFlight = await prisma.virtualMachine.count({ where: { proxmoxVmId: Number(noted), OR: ARCHIVE_USERS } });
      if (inFlight > 0) continue;
    }
    const file = resolveUnderUploadDir(archive, VZDUMP_UPLOAD_RE);
    if (file && (await fsp.unlink(file).then(() => true, () => false))) removed += 1;
    await fsp.unlink(marker).catch(() => undefined);
  }
  return removed;
}

/**
 * With a pool-scoped token, what Proxmox would otherwise be asked about the
 * archive before its guest exists: that it is there, which nodes can restore it,
 * and its embedded config. Proxmox checks those reads by the VMID in the name with
 * no guest to compare it to, which would need Datastore.Allocate on the whole
 * backup storage. So the file is checked on the share, the nodes come from where
 * the backup storage is available, and the config is read from the archive itself.
 */
async function inspectArchiveLocally(
  filename: string,
  storage: string,
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<{ nodes: string[]; rawCfg: string }> {
  const file = resolveUnderUploadDir(filename, VZDUMP_UPLOAD_RE);
  const stat = file ? await fsp.stat(file).catch(() => null) : null;
  if (!file || !stat?.isFile()) throw new RestoreUploadError('The uploaded file is no longer on the server.');
  const placement = await pve.storagePlacement(storage, client);
  if (placement.nodes.length === 0) {
    throw new RestoreUploadError(`The "${storage}" backup storage isn't available on any node.`);
  }
  if (!placement.shared && placement.nodes.length > 1) {
    throw new RestoreUploadError(
      `With a Proxmox pool configured, uploaded backups need a shared backup storage: "${storage}" is local to ` +
        'each node, so ProxMate cannot tell which node holds the upload without asking Proxmox to list every backup on it.',
    );
  }
  try {
    return { nodes: placement.nodes, rawCfg: await readArchiveConfig(file) };
  } catch (err) {
    if (err instanceof ArchiveConfigError) throw new RestoreUploadError(err.message);
    throw err;
  }
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
  let filename = path.basename(input.filename);
  if (filename !== input.filename || !VZDUMP_UPLOAD_RE.test(filename)) {
    throw new RestoreUploadError('That file is not a vzdump backup archive.');
  }
  const kind: pve.GuestKind = filename.startsWith('vzdump-lxc-') ? 'lxc' : 'qemu';

  // From here on the archive is removed on any failure, unless a restore task that
  // outlived our wait has taken it over.
  let archiveHandedOff = false;
  let storage = '';
  let volid = '';
  let cleanupNode: string | null = null;
  let ownRowId = '';
  let presetVmid: number | undefined;
  try {
    const client = await pve.getClient();
    const pool = await pve.getGuestPool();
    storage = await getBackupStorage();

    let nodes: string[];
    let rawCfg: string;
    if (pool) {
      // The archive must name the VMID it is restored to (see renameArchiveForVmid),
      // so that VMID is reserved first and held until the restore has finished.
      [presetVmid] = await reserveVmIds(1, client);
      filename = await renameArchiveForVmid(filename, presetVmid!);
      await noteRestoreTarget(filename, presetVmid!);
      volid = `${storage}:backup/${filename}`;
      ({ nodes, rawCfg } = await inspectArchiveLocally(filename, storage, client));
    } else {
      volid = `${storage}:backup/${filename}`;
      // Proxmox must see the uploaded file through the same storage the share is a
      // mount of — if it doesn't, the mount and `backup_storage` point at
      // different places and restoring is impossible.
      nodes = await pve.getBackupNodes(storage, volid, client);
      if (nodes.length === 0) {
        throw new RestoreUploadError(
          `The uploaded file isn't visible on the "${storage}" backup storage. ` +
            'Check that BACKUP_DOWNLOAD_DIR is mounted from that storage\'s directory.',
        );
      }
      cleanupNode = nodes[0]!;
      rawCfg = await pve.extractBackupConfig(nodes[0]!, volid, client);
    }

    // Quota-check from the archive's embedded config BEFORE restoring anything.
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
    const vmid = presetVmid ?? (await nextVmId(client));
    if (presetVmid === undefined) await noteRestoreTarget(filename, vmid);

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
        os: 'Restored backup', // vm.service UPLOAD_RESTORE_OS
        status: 'creating',
        opKind: 'restore-upload' satisfies VmOpKind,
        opStartedAt: new Date(),
        // So an interrupted restore's archive can still be removed after a restart.
        opArchive: volid,
      },
    });
    release(); // usage now includes this row
    ownRowId = vm.id;
    const done = beginInFlight(vm.id);

    let created = false;
    let restoreTask:
      | { node: string; upid: string; verify: () => Promise<void>; beforeTag: () => Promise<void>; afterTask: () => Promise<void> }
      | undefined;
    try {
      // Remap all volumes onto our default pool: cross-cluster archives name
      // storages this cluster may not have. unique=1 → fresh MACs.
      // Volumes already listed for this VMID (left by an earlier guest that had it)
      // must not end up attached to the restored guest; see assertOwnVolumes.
      const leftovers = await pve.listGuestVolumes(node, vmid, client);
      const upid = await pve.restoreNewGuest(
        { node, vmid, volid, storage: defaultStorage, pool },
        client,
        kind,
      );
      await recordOpTask(vm.id, upid);
      restoreTask = {
        node,
        upid,
        // A restore that finishes after we stopped waiting gets the same treatment
        // as one that finished in time before it is ever tied to the row (the row
        // stays held either way).
        // A late guest gets the on-time treatment: no autostart, the check (and
        // removal if it fails), whether or not the row is still there.
        verify: async () => {
          await stripRestoreFlags(node, vmid, client, kind).catch(() => undefined);
          await checkRestoredOrRemove(node, vmid, kind, client);
        },
        beforeTag: async () => {
          try {
            await pve.resetRestoredFirewall(node, vmid, client, kind);
            await pve.setVmName(node, vmid, input.name, client, kind).catch(() => undefined);
            await assertOwnVolumes(vm, client, leftovers, { unusedAreForeign: !!pool });
            await rebuildRestoredGuestConfig(node, vmid, isolate, client, kind);
            if (isolate) await pve.configureVmIsolation(node, vmid, await pve.readIsolationOptions(), client, kind);
            await syncRestoredGuest(vm, { approvedPci: [], client });
          } catch (err) {
            await neutraliseAfterFailure(node, vmid, kind, client, err);
            throw err;
          }
        },
        afterTask: async () => {
          if (!(await archiveClaimedByOther(volid, vm.id))) await cleanupArchive(filename, node, storage, volid);
        },
      };
      await pve.waitForTask(node, upid, client, 30 * 60 * 1000);
      created = true;
      // Nothing may start it on its own, and a protected guest couldn't be removed:
      // the archive's autostart and protection go before anything else.
      await stripRestoreFlags(node, vmid, client, kind).catch(() => undefined);
      // What Proxmox actually restored decides, not the archive pre-check: a guest
      // carrying settings ProxMate won't restore is removed before anything uses it.
      try {
        await checkRestoredOrRemove(node, vmid, kind, client);
      } catch (err) {
        if ((err as { guestRemoved?: boolean }).guestRemoved) {
          created = false;
          restoreTask = undefined; // the task's guest is gone; settle on what is at the VMID (nothing)
        }
        throw err;
      }
      // The archive's own guest firewall (rules, IP sets, aliases) is not kept:
      // isolation below writes ProxMate's.
      await pve.resetRestoredFirewall(node, vmid, client, kind);
      // The archive's config carries the OLD guest's tags; tie the guest to this row.
      await markClonedGuest(vm, client);
      // Every volume the restored config references must be this guest's own.
      await assertOwnVolumes(vm, client, leftovers, { unusedAreForeign: !!pool });

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

      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped', ...OP_SETTLED } });
      const startUpid = await pve.startVm(node, vmid, client, kind);
      await pve.waitForTask(node, startUpid, client);
      const running = await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
      // Another row restoring from the same archive (or following its task) still needs it.
      if (!(await archiveClaimedByOther(volid, vm.id))) await cleanupArchive(filename, node, storage, volid);
      return running;
    } catch (err) {
      // Any failure once the restore has landed leaves the row in `error`, which
      // nothing may start. A restore task still running when the wait gave up keeps
      // reading the archive; its follower removes the archive once it ends (or, if
      // that follower is lost, the restart reconciler does: task-reconcile.service.ts).
      if (created) await neutraliseAfterFailure(node, vmid, kind, client, err);
      const { following } = await settleFailedCreate(vm, err, created, { task: restoreTask });
      if (following) archiveHandedOff = true;
      throw err;
    } finally {
      done();
    }
  } catch (err) {
    // Any pre-restore failure (reservation, rename, quota, placement, reading the
    // archive) drops the archive, so a rejected upload never lingers on the share,
    // unless another row's restore from the same archive still needs it.
    if (!archiveHandedOff && !(volid && (await archiveClaimedByOther(volid, ownRowId)))) {
      await cleanupArchive(filename, cleanupNode, storage, volid);
    }
    throw err;
  } finally {
    if (presetVmid !== undefined) releaseVmId(presetVmid);
  }
}
