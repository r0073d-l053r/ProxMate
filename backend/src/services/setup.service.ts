import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { isSetupComplete, getConfig, setConfig } from './config.service.js';
import { createSession } from './auth.service.js';
import { getClient, getVersion, getNodes, getStorages, getBridges } from './proxmox.service.js';

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

export async function testProxmoxConnection(): Promise<{
  connected: boolean;
  version: string;
  nodeCount: number;
}> {
  const client = await getClient();
  const [version, nodes] = await Promise.all([getVersion(client), getNodes(client)]);
  return { connected: true, version, nodeCount: nodes.length };
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
}): Promise<void> {
  await setConfig('default_storage', data.storage);
  await setConfig('default_bridge', data.bridge);
  await setConfig('iso_storage', data.isoStorage);
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
