import { diskSizeGb } from '../services/disk.service.js';

/**
 * Pure helpers for reading the resources a Proxmox guest config describes — the
 * live config, a snapshot's config, or the one embedded in a vzdump archive.
 * Restores and rollbacks bring back a whole earlier config, so these are what
 * ProxMate re-derives the row's cpu/ram/storage from afterwards.
 */

/**
 * Parse `key: value` config text (as `vzdump/extractconfig` returns it) into a
 * record. Only the live section counts: a `[snapshot]` header ends it.
 */
export function parseGuestConfigText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = line.match(/^([a-z][a-z0-9_.-]*):\s*(.*)$/i);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Memory in MB from a `memory` value: a bare number or a property string (`current=N`). */
export function parseMemoryMb(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /(?:^|,)(?:current=)?(\d+)(?:,|$)/.exec(value.trim());
  return m ? parseInt(m[1]!, 10) : null;
}

export interface GuestConfigSizes {
  /** vCPUs the guest gets; null for a container with no `cores` line (it may use every host core). */
  cpu: number | null;
  ram: number; // MB
  storage: number; // GB, root + data disks, as the row counts them
  /** A disk line with no `size=` — its real size can't be read from the config. */
  unsizedDisk: boolean;
}

const QEMU_DISK = /^(scsi|virtio|sata|ide)\d+$/;
const LXC_DISK = /^(rootfs|mp\d+)$/;

/** The CPU/RAM/disk a guest config describes, in the units a VirtualMachine row uses. */
export function guestConfigSizes(cfg: Record<string, string>, kind: 'qemu' | 'lxc'): GuestConfigSizes {
  const int = (v: string | undefined) => (v === undefined ? NaN : parseInt(v, 10));
  let cpu: number | null;
  if (kind === 'lxc') {
    const cores = int(cfg['cores']);
    cpu = Number.isFinite(cores) && cores > 0 ? cores : null;
  } else {
    // QEMU runs sockets × cores vCPUs, unless `vcpus` caps how many are online.
    const sockets = Math.max(1, int(cfg['sockets']) || 1);
    const cores = Math.max(1, int(cfg['cores']) || 1);
    const vcpus = int(cfg['vcpus']);
    cpu = Number.isFinite(vcpus) && vcpus > 0 ? vcpus : sockets * cores;
  }
  const ram = parseMemoryMb(cfg['memory']) ?? 512;

  let storage = 0;
  let unsizedDisk = false;
  for (const [key, raw] of Object.entries(cfg)) {
    const val = String(raw);
    if (kind === 'lxc' ? !LXC_DISK.test(key) : !QEMU_DISK.test(key)) continue;
    if (val.includes('media=cdrom') || val.includes('cloudinit')) continue;
    if (!/\bsize=/.test(val)) {
      unsizedDisk = true;
      continue;
    }
    storage += diskSizeGb(val);
  }
  return { cpu, ram, storage, unsizedDisk };
}

/** The `hostpciN` lines of a config, as raw values. */
export function pciLines(cfg: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(cfg)
    .filter(([k]) => /^hostpci\d+$/.test(k))
    .map(([key, value]) => ({ key, value: String(value) }));
}
