import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { isSetupComplete, getConfig, setConfig } from './config.service.js';
import { createSession } from './auth.service.js';
import {
  getClient,
  getVersion,
  getNodes,
  getStorages,
  getBridges,
  getEffectivePermissions,
  getClusterVmCount,
  heldPrivileges,
} from './proxmox.service.js';

// Re-export config helpers so existing imports from setup.service keep working.
export { isSetupComplete, getConfig, setConfig };

// ─── Step 1: Create admin account ────────────────────────────

export async function createAdmin(data: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{
  token: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; email: string; role: string; displayName: string };
}> {
  const existing = await prisma.user.findFirst({ where: { role: 'admin' } });
  if (existing) throw new Error('Admin account already exists');

  const passwordHash = await bcrypt.hash(data.password, 12);
  const user = await prisma.user.create({
    data: {
      email: data.email.toLowerCase().trim(),
      passwordHash,
      displayName: data.displayName.trim(),
      role: 'admin',
    },
  });

  // Generate jwt_secret early so admin can log in even before completing setup.
  if (!(await getConfig('jwt_secret'))) {
    await setConfig('jwt_secret', randomBytes(64).toString('hex'), true);
  }

  const { token, csrfToken, expiresAt } = await createSession(user.id);
  return {
    token,
    csrfToken,
    expiresAt,
    user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
  };
}

export async function hasAdmin(): Promise<boolean> {
  const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
  return !!admin;
}

// ─── Step 2: Proxmox connection ───────────────────────────────

export async function saveProxmoxConfig(data: {
  host: string;
  tokenId: string;
  tokenSecret: string;
  verifySsl: boolean;
}): Promise<void> {
  await setConfig('proxmox_host', data.host);
  await setConfig('proxmox_token_id', data.tokenId);
  await setConfig('proxmox_token_secret', data.tokenSecret, true);
  await setConfig('proxmox_verify_ssl', String(data.verifySsl));
}

export interface ProxmoxConnectionResult {
  connected: boolean;
  version: string;
  nodeCount: number;
  vmCount: number;
  storageCount: number;
  /** Non-blocking: things that work now but will bite later, each naming the privilege. */
  warnings: string[];
}

/**
 * Privileges ProxMate needs to do its job, and the concrete thing that breaks without
 * each. Missing ones are reported as warnings rather than failures: a read-only or
 * deliberately narrow token is a legitimate thing to point at ProxMate, and blocking
 * setup over it would be this check making the opposite mistake to the one it exists
 * to catch. The two that ARE blocking are handled separately below.
 */
const OPERATIONAL_PRIVILEGES: ReadonlyArray<readonly [string, string]> = [
  ['VM.Allocate', 'creating and deleting guests'],
  ['VM.Config.Disk', 'attaching and resizing disks'],
  ['VM.Config.Network', 'putting guests on a bridge or VLAN'],
  ['VM.Config.Cloudinit', 'cloud-init deploys'],
  ['VM.PowerMgmt', 'starting, stopping and rebooting guests'],
  ['VM.Console', 'the noVNC and xterm.js consoles'],
  ['VM.Clone', 'deploying from a template'],
  ['VM.Snapshot', 'snapshots'],
  ['Datastore.AllocateSpace', 'creating disks on a storage'],
  ['Sys.Audit', 'node health and capacity readings'],
];

/**
 * Prove the configured token can actually DO something, not merely authenticate.
 *
 * The old version asked for `/version` and `/nodes` and reported success. Both answer
 * happily for a token with zero permissions, which is exactly how both of this
 * project's token failures shipped silently: `pveum user token add` defaults
 * `--privsep` to 1 so a fresh token has no rights at all, and a published
 * least-privilege role once omitted `VM.Audit`. In both cases ProxMate authenticated,
 * reported "connected", and then showed an empty dashboard — sending whoever debugged
 * it at the network layer instead of the ACL.
 *
 * So this asks Proxmox what the token may do (`/access/permissions`, which collapses
 * privsep, the token∩user intersection and pool expansion into one answer) AND checks
 * that the two read privileges everything else depends on return real objects. Every
 * failure names the missing privilege and the command that grants it.
 */
export async function testProxmoxConnection(): Promise<ProxmoxConnectionResult> {
  const client = await getClient();
  // /version first and alone: if the token cannot authenticate at all, that is the
  // finding, and reporting a permission problem on top of it would be noise.
  const version = await getVersion(client);

  const [nodes, perms] = await Promise.all([getNodes(client), getEffectivePermissions(client)]);
  const held = heldPrivileges(perms);

  if (held.size === 0) {
    throw new Error(
      'The token authenticates but holds NO permissions — Proxmox returned an empty ' +
        '/access/permissions. This is almost always privilege separation: `pveum user token add` ' +
        'defaults to --privsep 1, so a new token has no rights until an ACL names it. Note that ' +
        'an ACL granted with --users is a silent no-op for a privsep token, and that even a ' +
        'root@pam-owned token gets no automatic Administrator rights, because "root@pam!proxmate" ' +
        'is not the string "root@pam". Fix: ' +
        "`pveum acl modify / --tokens '<user>@<realm>!<tokenid>' --roles PVEAdmin`, or recreate " +
        'the token with `--privsep 0`.',
    );
  }

  // The two the rest of the product is built on. Checked as privilege AND as result,
  // because a grant scoped to a path holding nothing looks identical to no grant.
  const blocking: string[] = [];
  const warnings: string[] = [];

  const vms = held.has('VM.Audit')
    ? await getClusterVmCount(client).catch(() => null)
    : null;
  if (!held.has('VM.Audit')) {
    blocking.push(
      'VM.Audit is missing — ProxMate cannot see any guest at all, so every VM list, the ' +
        'dashboard and quota accounting come back empty. Note that PVEVMUser includes it but ' +
        'PVEDatastoreUser does not.',
    );
  } else if (vms === null) {
    blocking.push('VM.Audit is granted but /cluster/resources could not be read — check the token scope.');
  } else if (vms === 0) {
    // Not blocking: a brand-new cluster genuinely has no guests. Deliberate deviation
    // from "≥1 VM row" as a hard gate — see the Decisions note.
    warnings.push(
      'VM.Audit is granted but no guests are visible. That is expected on a cluster with none ' +
        'yet; if this cluster does have guests, the grant is scoped to a path that excludes them.',
    );
  }

  const storages = held.has('Datastore.Audit') ? await getStorages(client).catch(() => null) : null;
  if (!held.has('Datastore.Audit')) {
    blocking.push(
      'Datastore.Audit is missing — the disk-pool, ISO and backup pickers will all be empty and ' +
        'no VM can be created. This is the trap in PVEVMUser, which carries no Datastore ' +
        'privilege at all and so produces the same empty-dropdown symptom as privilege separation.',
    );
  } else if (!storages || storages.length === 0) {
    blocking.push(
      'Datastore.Audit is granted but Proxmox returned no storages. Every cluster has at least ' +
        '`local`, so the grant is scoped to a path that contains no storage.',
    );
  }

  if (blocking.length > 0) {
    throw new Error(
      `The token connects to Proxmox VE ${version} but cannot be used:\n` +
        blocking.map((b) => `  • ${b}`).join('\n') +
        '\n\nRun `pveum user token permissions <userid> <tokenid>` to see the token\'s computed ' +
        'effective permissions before changing anything else.',
    );
  }

  for (const [priv, what] of OPERATIONAL_PRIVILEGES) {
    if (!held.has(priv)) warnings.push(`${priv} is missing — ${what} will fail.`);
  }
  if (nodes.length === 0) {
    warnings.push('No nodes are visible. Sys.Audit governs node health and capacity readings.');
  }

  return {
    connected: true,
    version,
    nodeCount: nodes.length,
    vmCount: vms ?? 0,
    storageCount: storages?.length ?? 0,
    warnings,
  };
}

// ─── Step 3: Fetch available Proxmox resources ────────────────

export async function getProxmoxResources(): Promise<{
  storages: Array<{ name: string; type: string }>;
  bridges: Array<{ name: string }>;
  isoStorages: Array<{ name: string; type: string }>;
  backupStorages: Array<{ name: string; type: string }>;
}> {
  const client = await getClient();
  const [storages, bridges] = await Promise.all([
    getStorages(client),
    getBridges(undefined, client),
  ]);

  return {
    // Only storages that can hold VM disk images are valid disk pools.
    storages: storages
      .filter((s) => s.content?.includes('images'))
      .map((s) => ({ name: s.storage, type: s.type })),
    bridges: bridges.map((b) => ({ name: b.iface })),
    isoStorages: storages
      .filter((s) => s.content?.includes('iso'))
      .map((s) => ({ name: s.storage, type: s.type })),
    backupStorages: storages
      .filter((s) => s.content?.includes('backup'))
      .map((s) => ({ name: s.storage, type: s.type })),
  };
}

// ─── Step 3 save: Default VM settings ────────────────────────

export async function saveDefaults(data: {
  storage: string;
  bridge: string;
  isoStorage: string;
  backupStorage?: string;
}): Promise<void> {
  await setConfig('default_storage', data.storage);
  await setConfig('default_bridge', data.bridge);
  await setConfig('iso_storage', data.isoStorage);
  // Optional: which storage MateState backups land on. Empty = let the backend
  // auto-pick the first backup-capable storage (getBackupStorage).
  if (data.backupStorage !== undefined) await setConfig('backup_storage', data.backupStorage);
}

// ─── Step 4: Finalize setup ───────────────────────────────────

export async function completeSetup(): Promise<{
  token: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; email: string; role: string; displayName: string };
}> {
  const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
  if (!admin) throw new Error('Admin account not found — complete step 1 first');

  if (!(await getConfig('jwt_secret'))) {
    await setConfig('jwt_secret', randomBytes(64).toString('hex'), true);
  }
  await setConfig('setup_complete', 'true');

  const { token, csrfToken, expiresAt } = await createSession(admin.id);
  return {
    token,
    csrfToken,
    expiresAt,
    user: { id: admin.id, email: admin.email, role: admin.role, displayName: admin.displayName },
  };
}
