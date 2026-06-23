import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../lib/crypto.js';

export async function isSetupComplete(): Promise<boolean> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: 'setup_complete' } });
    return row?.value === 'true';
  } catch {
    return false;
  }
}

export async function getConfig(key: string): Promise<string | null> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  if (!row) return null;
  return row.sensitive ? decrypt(row.value) : row.value;
}

export async function setConfig(key: string, value: string, sensitive = false): Promise<void> {
  const stored = sensitive ? encrypt(value) : value;
  await prisma.systemConfig.upsert({
    where: { key },
    update: { value: stored, sensitive },
    create: { key, value: stored, sensitive },
  });
}
