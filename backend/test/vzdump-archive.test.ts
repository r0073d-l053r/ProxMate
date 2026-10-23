import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readArchiveConfig, ArchiveConfigError } from '../src/lib/vzdump-archive.js';
import { buildVma, buildTar } from './vzdump-fixtures.js';

// The guest config of an uploaded backup is read from the file itself when a
// pool-scoped token could not ask Proxmox for it (see restore-upload).

const QEMU_CFG = 'cores: 4\nmemory: 8192\nscsi0: local-lvm:vm-104-disk-0,size=32G\n';
const PCT_CFG = 'arch: amd64\ncores: 2\nmemory: 1024\nrootfs: local-lvm:subvol-105-disk-0,size=8G\nunprivileged: 1\n';

let dir: string;
const file = async (name: string, data: Buffer) => {
  const full = path.join(dir, name);
  await writeFile(full, data);
  return full;
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pm-vzdump-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readArchiveConfig', () => {
  it.each([
    ['vzdump-qemu-104-x.vma', (b: Buffer) => b],
    ['vzdump-qemu-104-x.vma.zst', (b: Buffer) => zlib.zstdCompressSync(b)],
    ['vzdump-qemu-104-x.vma.gz', (b: Buffer) => zlib.gzipSync(b)],
  ])('reads qemu-server.conf from the VMA header of %s', async (name, pack) => {
    const vma = buildVma({ 'qemu-server.conf': QEMU_CFG, 'qemu-server.fw': '[OPTIONS]\nenable: 1\n' });
    expect(await readArchiveConfig(await file(name, pack(vma)))).toBe(QEMU_CFG);
  });

  it.each([
    ['vzdump-lxc-105-x.tar', (b: Buffer) => b],
    ['vzdump-lxc-105-x.tar.zst', (b: Buffer) => zlib.zstdCompressSync(b)],
    ['vzdump-lxc-105-x.tar.gz', (b: Buffer) => zlib.gzipSync(b)],
  ])('reads etc/vzdump/pct.conf from the container tar %s', async (name, pack) => {
    const tar = buildTar([['./etc/vzdump/pct.conf', PCT_CFG], ['./etc/vzdump/pct.fw', ''], ['./bin/sh', 'x'.repeat(2000)]]);
    expect(await readArchiveConfig(await file(name, pack(tar)))).toBe(PCT_CFG);
  });

  it('refuses a VMA whose header checksum does not match', async () => {
    const vma = buildVma({ 'qemu-server.conf': QEMU_CFG }, { corruptMd5: true });
    await expect(readArchiveConfig(await file('vzdump-qemu-1-bad.vma', vma))).rejects.toThrow(/checksum mismatch/);
  });

  it('refuses a file that is not a VMA', async () => {
    await expect(readArchiveConfig(await file('vzdump-qemu-1-junk.vma', Buffer.alloc(20000, 7)))).rejects.toThrow(
      ArchiveConfigError,
    );
  });

  it('refuses a VMA without a qemu-server.conf', async () => {
    const vma = buildVma({ 'other.conf': 'x' });
    await expect(readArchiveConfig(await file('vzdump-qemu-1-nocfg.vma', vma))).rejects.toThrow(/no qemu-server\.conf/);
  });

  it('refuses a tar without a guest config', async () => {
    const tar = buildTar([['./bin/sh', 'x']]);
    await expect(readArchiveConfig(await file('vzdump-lxc-1-nocfg.tar', tar))).rejects.toThrow(/No guest configuration/);
  });

  it('refuses LZO, which it cannot decode', async () => {
    await expect(readArchiveConfig(await file('vzdump-qemu-1-x.vma.lzo', Buffer.alloc(10)))).rejects.toThrow(/LZO/);
  });

  it('turns a broken compressed stream into a clear error', async () => {
    await expect(readArchiveConfig(await file('vzdump-qemu-1-x.vma.zst', Buffer.from('not zstd at all')))).rejects.toThrow(
      /could not be read/,
    );
  });
});
