import type { SshKey } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * A loose OpenSSH public-key sniff: type token + base64 blob (+ optional comment).
 * Mirrors the frontend wizard's check so a bad paste is rejected before it reaches
 * a VM's cloud-init. Not a cryptographic validation — just shape.
 *
 * Separators are space/tab ONLY (no `\s`, which matches newlines): a multi-line
 * value could otherwise smuggle a second `authorized_keys` entry into cloud-init.
 */
const OPENSSH_KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-[a-z0-9-]+|sk-(ssh-ed25519|ecdsa-sha2-[a-z0-9-]+)@openssh\.com)[ \t]+[A-Za-z0-9+/=]+([ \t]+[^\r\n]*)?$/;

export function isValidPublicKey(key: string): boolean {
  const k = key.trim();
  // Single line only — reject any embedded CR/LF (authorized_keys injection guard).
  if (/[\r\n]/.test(k)) return false;
  return OPENSSH_KEY_RE.test(k);
}

/** A user's saved keys, newest first. */
export async function listSshKeys(userId: string): Promise<SshKey[]> {
  return prisma.sshKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

export class DuplicateKeyError extends Error {
  constructor() {
    super('You already have this key saved.');
    this.name = 'DuplicateKeyError';
  }
}

export class TooManyKeysError extends Error {
  constructor() {
    super(`You can save at most ${MAX_KEYS_PER_USER} SSH keys. Remove one first.`);
    this.name = 'TooManyKeysError';
  }
}

// Cap saved keys per user — they're small but unbounded rows are a cheap DB-bloat
// vector on a multi-tenant box.
export const MAX_KEYS_PER_USER = 25;

/**
 * Save a new key for a user. The key line is normalized (trimmed) and de-duped
 * against the user's existing keys by exact match so the same key isn't stored twice.
 */
export async function addSshKey(userId: string, name: string, publicKey: string): Promise<SshKey> {
  const normalized = publicKey.trim();
  const count = await prisma.sshKey.count({ where: { userId } });
  if (count >= MAX_KEYS_PER_USER) throw new TooManyKeysError();
  const existing = await prisma.sshKey.findFirst({ where: { userId, publicKey: normalized } });
  if (existing) throw new DuplicateKeyError();
  return prisma.sshKey.create({ data: { userId, name: name.trim(), publicKey: normalized } });
}

/** Delete a key, but only if it belongs to the requesting user. Returns false if
 *  it doesn't exist or isn't theirs (so the caller can 404 without leaking). */
export async function deleteSshKey(userId: string, id: string): Promise<boolean> {
  const key = await prisma.sshKey.findUnique({ where: { id } });
  if (!key || key.userId !== userId) return false;
  await prisma.sshKey.delete({ where: { id } });
  return true;
}
