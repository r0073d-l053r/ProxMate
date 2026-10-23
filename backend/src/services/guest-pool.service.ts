import type { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma.js';
import * as pve from './proxmox.service.js';
import { tagsMarkRow, tagsMarkTemplate } from './vm.service.js';

// ─── Pool-scoped token support ────────────────────────────────
//
// With the `proxmox_pool` setting, every guest ProxMate creates joins that pool
// (see pve.getGuestPool), so the token's guest privileges can be granted on
// /pool/<name> instead of on /. This module answers the connection test's pool
// questions and moves guests ProxMate already manages into the pool.

/** A guest carrying a ProxMate ownership marker, as /cluster/resources lists it. */
export interface ManagedGuest {
  vmid: number;
  node: string;
  name: string;
  kind: pve.GuestKind;
  template: boolean;
  /** The pool it is in now, or null for none. */
  pool: string | null;
}

export interface PoolReport {
  name: string;
  /** true: listed; false: the token may see it (Pool.Audit) and it is not there; null: cannot tell. */
  exists: boolean | null;
  /** Guest privileges the token lacks on /pool/<name>. */
  missingOnPool: string[];
  /** Guest privileges the token still holds on / or /vms, i.e. on every guest. */
  guestPrivilegesOnRoot: string[];
  /** Managed guests outside the pool (what "move managed guests into the pool" would touch). */
  outside: ManagedGuest[];
  /** Machines and templates ProxMate knows whose guest the token cannot see at all. */
  notVisible: Array<{ vmid: number; name: string }>;
}

interface VmResource {
  type: string;
  vmid?: number;
  node?: string;
  name?: string;
  tags?: string;
  pool?: string;
  template?: number;
}

/**
 * Guests carrying a ProxMate marker that ties them to a row (a machine's
 * `proxmate-<row id>` or a template's `proxmate-template-<id>`, at that row's VMID),
 * plus the rows whose guest the token cannot see. A guest without such a marker is
 * never returned, whatever its name or VMID.
 */
export async function managedGuests(client: AxiosInstance): Promise<{
  guests: ManagedGuest[];
  notVisible: Array<{ vmid: number; name: string }>;
}> {
  const [rows, templates, res] = await Promise.all([
    prisma.virtualMachine.findMany({ select: { id: true, name: true, proxmoxVmId: true, status: true } }),
    prisma.template.findMany({ select: { id: true, name: true, proxmoxVmId: true } }),
    client.get<{ data: VmResource[] }>('/cluster/resources?type=vm'),
  ]);
  const byVmid = new Map<number, VmResource>();
  for (const r of res.data.data ?? []) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined && r.node) byVmid.set(r.vmid, r);
  }

  const guests: ManagedGuest[] = [];
  const notVisible: Array<{ vmid: number; name: string }> = [];
  const seen = new Set<number>();
  const take = (r: VmResource) => {
    if (seen.has(r.vmid!)) return;
    seen.add(r.vmid!);
    guests.push({
      vmid: r.vmid!,
      node: r.node!,
      name: r.name ?? `vm-${r.vmid}`,
      kind: r.type === 'lxc' ? 'lxc' : 'qemu',
      template: (r.template ?? 0) === 1,
      pool: r.pool || null,
    });
  };
  for (const row of rows) {
    const r = byVmid.get(row.proxmoxVmId);
    if (!r) {
      // A create still in flight has no guest yet; anything else should have one.
      if (row.status !== 'creating') notVisible.push({ vmid: row.proxmoxVmId, name: row.name });
      continue;
    }
    if (tagsMarkRow(r.tags, row.id)) take(r);
  }
  for (const t of templates) {
    const r = byVmid.get(t.proxmoxVmId);
    if (!r) notVisible.push({ vmid: t.proxmoxVmId, name: t.name });
    else if (tagsMarkTemplate(r.tags, t.id)) take(r);
  }
  return { guests, notVisible };
}

/**
 * The privileges among `wanted` held on `path`. /access/permissions already folds
 * in propagation, but lists a path only when an ACL names it (plus a fixed set of
 * top-level paths), so an unlisted path falls back to its parent's answer.
 */
export function heldOn(perms: pve.PvePermissions, path: string, wanted: readonly string[]): string[] {
  let at = path;
  while (perms[at] === undefined && at !== '/') at = at.slice(0, at.lastIndexOf('/')) || '/';
  const on = perms[at] ?? {};
  return wanted.filter((p) => !!on[p]);
}

/** "8.2.4" → [8, 2]; null parts when unparseable. */
function pveRelease(version: string): [number | null, number | null] {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

/**
 * What a pool-scoped token still holds, or lacks, outside the pool: the grants
 * that let it reach past the pool (Sys.Modify on /, Datastore.Allocate on every
 * storage) and the narrow ones the script grants instead (Sys.AccessNetwork for
 * cloud-image downloads, Datastore.Allocate on the storages that need it).
 * Warnings only: each names what is affected.
 */
async function infraWarnings(client: AxiosInstance, perms: pve.PvePermissions, version: string): Promise<string[]> {
  const out: string[] = [];
  const sysModify = heldOn(perms, '/', ['Sys.Modify']).length > 0;
  if (sysModify) {
    out.push(
      'The token holds Sys.Modify on /, so the pool does not fully contain it: Proxmox also lets it manage ' +
        "cluster backup jobs, the cluster firewall's groups, IP sets and options, and other cluster settings. " +
        'ProxMate needs it only to enable the cluster firewall; without it, do that step once by hand as root.',
    );
  } else if (!(await pve.isClusterFirewallEnabled(client).catch(() => false))) {
    // Once the cluster firewall is on, ProxMate has nothing left to do there.
    out.push(
      'Sys.Modify on / is not granted, so ProxMate cannot enable the cluster firewall or write its management ' +
        'rules for tenant isolation. Do it once as root (Datacenter → Firewall: add an accept rule for your ' +
        'management network on ports 8006 and 22, then enable it), or grant it with ' +
        'deploy/proxmox-token.sh --with-cluster-firewall, which widens what the token can reach.',
    );
  }

  const [major, minor] = pveRelease(version);
  const hasAccessNetwork = major !== null && (major > 8 || (major === 8 && (minor ?? 0) >= 2));
  const canDownload =
    (sysModify && heldOn(perms, '/', ['Sys.Audit']).length > 0) ||
    (hasAccessNetwork && heldOn(perms, '/nodes', ['Sys.AccessNetwork']).length > 0);
  if (!canDownload) {
    out.push(
      hasAccessNetwork
        ? 'Sys.AccessNetwork is missing on /nodes — importing cloud images for the Template Store will fail. ' +
            'deploy/proxmox-token.sh --pool grants it.'
        : `Proxmox VE ${version} checks Sys.Audit and Sys.Modify on / for cloud-image downloads, and the token ` +
            'lacks them — importing cloud images for the Template Store will fail.',
    );
  }

  if (heldOn(perms, '/storage', ['Datastore.Allocate']).length > 0) {
    out.push(
      'The token holds Datastore.Allocate on /storage, which lets it delete any volume and change any storage ' +
        'definition, inside the pool or not. Grant it only on the storages that need it ' +
        '(deploy/proxmox-token.sh --pool, with --snippet-storage / --import-storage if wanted).',
    );
  }
  // Datastore.Allocate is only needed on the snippet storage to turn its snippets
  // content type on; once it is on (or root turned it on), nothing is missing.
  const snippetStorage = pve.snippetWriteConfig()?.storage;
  if (snippetStorage && heldOn(perms, `/storage/${snippetStorage}`, ['Datastore.Allocate']).length === 0) {
    const storages = await pve.getStorages(client).catch(() => []);
    const content = storages.find((st) => st.storage === snippetStorage)?.content ?? '';
    if (!content.split(',').includes('snippets')) {
      out.push(
        `The snippet storage "${snippetStorage}" does not have the snippets content type, and the token lacks ` +
          `Datastore.Allocate there to turn it on. Do it once as root (Datacenter → Storage → ${snippetStorage} → ` +
          `Content: Snippets), or grant it there only with deploy/proxmox-token.sh --pool --snippet-storage ${snippetStorage}.`,
      );
    }
  }
  return out;
}

/**
 * The connection test's pool section. `guestPrivileges` is the list the token
 * needs on every guest (it depends on the Proxmox VE release). Blocking problems
 * are returned separately from warnings, in the connection test's own terms.
 */
export async function checkGuestPool(
  client: AxiosInstance,
  perms: pve.PvePermissions,
  pool: string,
  opts: { guestPrivileges: readonly string[]; version: string },
): Promise<{ report: PoolReport; blocking: string[]; warnings: string[] }> {
  const { guestPrivileges } = opts;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const poolPath = `/pool/${pool}`;
  const canAuditPool = heldOn(perms, poolPath, ['Pool.Audit']).length > 0;

  const listed = await pve.listPools(client).then(
    (ids) => ids.includes(pool),
    () => null,
  );
  let exists: boolean | null = listed;
  if (listed === false && !canAuditPool) exists = null;
  if (exists === false) {
    blocking.push(
      `The resource pool "${pool}" does not exist, so Proxmox will refuse every guest ProxMate creates. ` +
        `Create it with \`pveum pool add ${pool}\` (or run deploy/proxmox-token.sh --pool ${pool}), or clear the pool setting.`,
    );
  } else if (exists === null) {
    warnings.push(
      `Could not confirm that the resource pool "${pool}" exists: the token lacks Pool.Audit on ${poolPath}. ` +
        'Creates will fail if it does not exist. deploy/proxmox-token.sh --pool grants it.',
    );
  }

  const held = new Set(heldOn(perms, poolPath, guestPrivileges));
  const missingOnPool = guestPrivileges.filter((p) => !held.has(p));
  const allocateAnywhere = held.has('VM.Allocate') || heldOn(perms, '/vms', ['VM.Allocate']).length > 0;
  if (!allocateAnywhere) {
    blocking.push(
      `VM.Allocate is missing on ${poolPath} (and on /vms), so Proxmox will refuse every guest ProxMate creates ` +
        `in the pool. Grant the guest role there: deploy/proxmox-token.sh --pool ${pool}.`,
    );
  }
  if (missingOnPool.length > 0) {
    warnings.push(
      `The token is missing ${missingOnPool.join(', ')} on ${poolPath}, so those actions will fail on guests in the pool. ` +
        `Grant the guest role there, e.g. \`pveum acl modify ${poolPath} --tokens '<user>@<realm>!<tokenid>' --roles ProxMate-Guest\`.`,
    );
  }

  const onRoot = new Set([
    ...heldOn(perms, '/', guestPrivileges),
    ...heldOn(perms, '/vms', guestPrivileges),
  ]);
  const guestPrivilegesOnRoot = guestPrivileges.filter((p) => onRoot.has(p) && p.startsWith('VM.'));
  if (guestPrivilegesOnRoot.length > 0) {
    warnings.push(
      `The token still holds guest privileges on / (${guestPrivilegesOnRoot.join(', ')}), so Proxmox lets it act on ` +
        `every guest and the pool "${pool}" limits nothing yet. Once ProxMate's guests are in the pool, remove that ` +
        'grant (deploy/proxmox-token.sh --pool <name> --drop-root-grant).',
    );
  }

  let outside: ManagedGuest[] = [];
  let notVisible: Array<{ vmid: number; name: string }> = [];
  try {
    const found = await managedGuests(client);
    outside = found.guests.filter((g) => g.pool !== pool);
    notVisible = found.notVisible;
  } catch (err) {
    warnings.push(`Could not check which guests are in the pool "${pool}": ${pve.pveMessage(err)}`);
  }
  if (outside.length > 0) {
    warnings.push(
      `${outside.length} guest(s) ProxMate manages are not in the pool "${pool}" ` +
        `(${outside.map((g) => `${g.vmid} ${g.name}`).join(', ')}). A token scoped to the pool cannot reach them; ` +
        'use "Move managed guests into the pool" in Admin → Settings.',
    );
  }
  if (notVisible.length > 0) {
    warnings.push(
      `${notVisible.length} machine(s) or template(s) ProxMate knows are not visible to the token ` +
        `(VMIDs ${notVisible.map((g) => g.vmid).join(', ')}): they are outside the pool, or gone. ` +
        `As root on a node: \`pveum pool modify ${pool} --vms ${notVisible.map((g) => g.vmid).join(',')} --allow-move 1\`. ` +
        'For a machine whose guest is gone, its backups are outside the pool too: the token can no longer list ' +
        'or delete them, so restore one as root, or rebuild the machine first.',
    );
  }
  warnings.push(...(await infraWarnings(client, perms, opts.version)));

  return {
    report: { name: pool, exists, missingOnPool, guestPrivilegesOnRoot, outside, notVisible },
    blocking,
    warnings,
  };
}

/**
 * Without a pool setting: a token whose guest privileges exist only on some
 * /pool/<id> can work only on guests in that pool, and ProxMate's new guests
 * would land outside it. Returns the pools that look like the intended scope.
 */
export function poolScopedWithoutSetting(perms: pve.PvePermissions): string[] {
  if (perms['/vms']?.['VM.Allocate'] || perms['/']?.['VM.Allocate']) return [];
  return Object.keys(perms)
    .filter((path) => path.startsWith('/pool/') && !!perms[path]?.['VM.Allocate'])
    .map((path) => path.slice('/pool/'.length));
}

/** One guest the move action handled. */
export interface MoveOutcome {
  vmid: number;
  name: string;
  template: boolean;
  /** The pool it was in before, or null for none. */
  from: string | null;
}

/**
 * Admin action: put every guest carrying a ProxMate marker that is outside the
 * configured pool into it. A guest is moved only when its own config confirms the
 * marker the listing showed, so nothing without a ProxMate marker is ever touched.
 * One request per guest: a guest in another pool also needs Pool.Allocate there,
 * and one refusal must not stop the rest.
 */
export async function moveManagedGuestsIntoPool(client?: AxiosInstance): Promise<{
  pool: string;
  moved: MoveOutcome[];
  failed: Array<MoveOutcome & { error: string }>;
}> {
  const pool = await pve.getGuestPool();
  if (!pool) throw new Error('No Proxmox pool is configured.');
  const c = client ?? (await pve.getClient());

  const [{ guests }, rows, templates] = await Promise.all([
    managedGuests(c),
    prisma.virtualMachine.findMany({ select: { id: true, proxmoxVmId: true } }),
    prisma.template.findMany({ select: { id: true, proxmoxVmId: true } }),
  ]);
  const moved: MoveOutcome[] = [];
  const failed: Array<MoveOutcome & { error: string }> = [];
  for (const g of guests.filter((x) => x.pool !== pool)) {
    const outcome: MoveOutcome = { vmid: g.vmid, name: g.name, template: g.template, from: g.pool };
    try {
      const cfg = await pve.getVmConfig(g.node, g.vmid, c, g.kind);
      const ours =
        rows.some((r) => r.proxmoxVmId === g.vmid && tagsMarkRow(cfg['tags'], r.id)) ||
        templates.some((t) => t.proxmoxVmId === g.vmid && tagsMarkTemplate(cfg['tags'], t.id));
      if (!ours) continue;
      await pve.addGuestsToPool(pool, [g.vmid], c);
      moved.push(outcome);
    } catch (err) {
      failed.push({ ...outcome, error: pve.pveMessage(err) });
    }
  }
  return { pool, moved, failed };
}
