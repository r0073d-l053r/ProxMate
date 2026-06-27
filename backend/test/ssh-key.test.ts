import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    sshKey: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  isValidPublicKey,
  addSshKey,
  deleteSshKey,
  DuplicateKeyError,
  TooManyKeysError,
  MAX_KEYS_PER_USER,
} from '../src/services/ssh-key.service.js';

const findFirst = vi.mocked(prisma.sshKey.findFirst);
const findUnique = vi.mocked(prisma.sshKey.findUnique);
const count = vi.mocked(prisma.sshKey.count);
const create = vi.mocked(prisma.sshKey.create);
const del = vi.mocked(prisma.sshKey.delete);

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(0 as never);
});

describe('isValidPublicKey', () => {
  it('accepts ed25519, rsa, and ecdsa keys', () => {
    expect(isValidPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 me@host')).toBe(true);
    expect(isValidPublicKey('ssh-rsa AAAAB3NzaC1yc2E')).toBe(true);
    expect(isValidPublicKey('ecdsa-sha2-nistp256 AAAAE2VjZHNh comment')).toBe(true);
  });

  it('rejects junk and private keys', () => {
    expect(isValidPublicKey('not a key')).toBe(false);
    expect(isValidPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(false);
    expect(isValidPublicKey('')).toBe(false);
  });

  it('rejects multi-line input (authorized_keys injection guard)', () => {
    expect(isValidPublicKey('ssh-ed25519 AAAAC3 me\nssh-rsa AAAAB injected')).toBe(false);
    expect(isValidPublicKey('ssh-ed25519 AAAAC3 me\r\ninjected')).toBe(false);
    expect(isValidPublicKey('ssh-ed25519\nAAAAC3')).toBe(false);
  });
});

describe('addSshKey', () => {
  it('trims and stores a new key when not a duplicate', async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'k1' } as never);
    await addSshKey('u1', '  laptop ', '  ssh-ed25519 AAAA me  ');
    expect(create).toHaveBeenCalledWith({
      data: { userId: 'u1', name: 'laptop', publicKey: 'ssh-ed25519 AAAA me' },
    });
  });

  it('throws DuplicateKeyError when the user already has that key', async () => {
    findFirst.mockResolvedValue({ id: 'existing' } as never);
    await expect(addSshKey('u1', 'dup', 'ssh-ed25519 AAAA me')).rejects.toBeInstanceOf(DuplicateKeyError);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws TooManyKeysError at the per-user cap', async () => {
    count.mockResolvedValue(MAX_KEYS_PER_USER as never);
    await expect(addSshKey('u1', 'k', 'ssh-ed25519 AAAA me')).rejects.toBeInstanceOf(TooManyKeysError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('deleteSshKey (ownership)', () => {
  it('deletes a key the user owns', async () => {
    findUnique.mockResolvedValue({ id: 'k1', userId: 'u1' } as never);
    expect(await deleteSshKey('u1', 'k1')).toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: 'k1' } });
  });

  it("refuses to delete another user's key (returns false, no delete)", async () => {
    findUnique.mockResolvedValue({ id: 'k1', userId: 'someone-else' } as never);
    expect(await deleteSshKey('u1', 'k1')).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it('returns false for a missing key', async () => {
    findUnique.mockResolvedValue(null);
    expect(await deleteSshKey('u1', 'missing')).toBe(false);
  });
});
