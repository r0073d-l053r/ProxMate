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
    const vma = buildVma({ 'qemu-server.fw': 'x' });
    await expect(readArchiveConfig(await file('vzdump-qemu-1-nocfg.vma', vma))).rejects.toThrow(/no qemu-server\.conf/);
  });

  describe('VMA config blobs are read as Proxmox reads them, or refused', () => {
    it('cuts a name at its first NUL, so a second "qemu-server.conf\\0x" is a duplicate', async () => {
      const vma = buildVma([['qemu-server.conf', 'cores: 1\n'], ['qemu-server.conf\0x', 'hostpci0: 01:00.0\n']]);
      await expect(readArchiveConfig(await file('vzdump-qemu-1-dup.vma', vma))).rejects.toThrow(/twice/);
    });

    it('refuses a config blob vzdump never writes', async () => {
      const vma = buildVma({ 'qemu-server.conf': QEMU_CFG, 'other.conf': 'x' });
      await expect(readArchiveConfig(await file('vzdump-qemu-1-other.vma', vma))).rejects.toThrow(/unexpected config "other\.conf"/);
    });

    it('refuses a pointer outside the blob buffer', async () => {
      const vma = buildVma({ 'qemu-server.conf': QEMU_CFG }, { dataPointer: 60000 });
      await expect(readArchiveConfig(await file('vzdump-qemu-1-range.vma', vma))).rejects.toThrow(/malformed config entry/);
    });
  });

  describe('a container tar must start with exactly ./etc/vzdump/pct.conf', () => {
    const evil = 'unprivileged: 1\ndev0: /dev/sda\n';
    const benign = 'unprivileged: 1\nhostname: ok\n';
    it.each([
      ['a GNU header whose atime field looks like a prefix', [['pct.conf', benign, { magic: 'ustar  \0', at345: './etc/vzdump' }], ['./etc/vzdump/pct.conf', evil]]],
      ['the name without ./', [['etc/vzdump/pct.conf', benign], ['./etc/vzdump/pct.conf', evil]]],
      ['a pax header first', [['pax', '30 path=./etc/vzdump/pct.conf\n', { type: 'x' }], ['./etc/vzdump/pct.conf', evil]]],
      ['a GNU long name first', [['././@LongLink', './etc/vzdump/pct.conf', { type: 'L' }], ['x', benign]]],
      ['a directory entry', [['./etc/vzdump/pct.conf', benign, { type: '5' }]]],
      ['a POSIX prefix', [['pct.conf', benign, { at345: './etc/vzdump' }]]],
      ['a bad header checksum', [['./etc/vzdump/pct.conf', benign, { badChecksum: true }]]],
      ['an OpenVZ vps.conf', [['./etc/vzdump/vps.conf', benign]]],
      ['an unknown magic', [['./etc/vzdump/pct.conf', benign, { magic: 'xxxxxxxx' }]]],
    ] as Array<[string, Parameters<typeof buildTar>[0]]>)('refuses %s', async (label, entries) => {
      await expect(readArchiveConfig(await file(`vzdump-lxc-1-${label.replace(/\W+/g, '_')}.tar`, buildTar(entries)))).rejects.toThrow(
        ArchiveConfigError,
      );
    });

    it('accepts the GNU header vzdump writes', async () => {
      const tar = buildTar([['./etc/vzdump/pct.conf', PCT_CFG, { magic: 'ustar  \0', at345: '14507000000\0' }]]);
      expect(await readArchiveConfig(await file('vzdump-lxc-1-gnu.tar', tar))).toBe(PCT_CFG);
    });

    it('refuses an old-format QEMU tar', async () => {
      const tar = buildTar([['qemu-server.conf', QEMU_CFG]]);
      await expect(readArchiveConfig(await file('vzdump-qemu-1-old.tar', tar))).rejects.toThrow(/Old-format QEMU tar/);
    });
  });

  it('refuses LZO, which it cannot decode', async () => {
    await expect(readArchiveConfig(await file('vzdump-qemu-1-x.vma.lzo', Buffer.alloc(10)))).rejects.toThrow(/LZO/);
  });

  it('stops after the first 4 MiB of decompressed data', async () => {
    const huge = Buffer.concat([Buffer.alloc(12288 * 0), Buffer.alloc(5 * 1024 * 1024, 0x41)]);
    huge.write('VMA\0', 0, 'latin1');
    huge.writeUInt32BE(1, 4);
    huge.writeUInt32BE(12288, 48);
    huge.writeUInt32BE(16, 52);
    huge.writeUInt32BE(5 * 1024 * 1024, 56); // a header claiming 5 MiB
    await expect(readArchiveConfig(await file('vzdump-qemu-1-huge.vma.gz', zlib.gzipSync(huge)))).rejects.toThrow(ArchiveConfigError);
  });

  it('turns a broken compressed stream into a clear error', async () => {
    await expect(readArchiveConfig(await file('vzdump-qemu-1-x.vma.zst', Buffer.from('not zstd at all')))).rejects.toThrow(
      /could not be read/,
    );
  });
});
