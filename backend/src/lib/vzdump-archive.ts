import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import type { Transform } from 'node:stream';

/**
 * Read the guest config embedded in a vzdump archive straight from the file,
 * without asking Proxmox. Proxmox's own reader (`vzdump/extractconfig`) checks
 * access to an archive by the VMID in its name, so for an archive whose guest
 * does not exist yet a pool-scoped token would need Datastore.Allocate on the
 * whole backup storage. Only the start of the archive is decompressed: the VMA
 * header carries the config blobs, and vzdump writes the config as the first
 * entries of a tar archive.
 *
 * Supported: `.vma`, `.tar`, each optionally `.zst` or `.gz`. `.lzo` has no
 * decoder here and is refused.
 */

export class ArchiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveConfigError';
  }
}

/** Never decompress more than this looking for the config (the header or first tar entries). */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

const VMA_MAGIC = Buffer.from('VMA\0', 'latin1');
const VMA_FIXED = 12288; // fixed part of the header, before the blob buffer may start

function decompressor(filename: string): Transform | null {
  if (filename.endsWith('.zst')) {
    if (typeof zlib.createZstdDecompress !== 'function') {
      throw new ArchiveConfigError('This server cannot read zstd archives (it needs Node.js 22.15 or later).');
    }
    return zlib.createZstdDecompress();
  }
  if (filename.endsWith('.gz')) return zlib.createGunzip();
  if (filename.endsWith('.lzo')) {
    throw new ArchiveConfigError('LZO-compressed backups cannot be read here. Upload a .zst or .gz backup instead.');
  }
  return null;
}

/**
 * Decompress the start of `file` until `parse` returns something other than
 * undefined (it is called with everything read so far), the archive ends, or the
 * scan cap is reached.
 */
async function scanPrefix<T>(file: string, parse: (buf: Buffer, ended: boolean) => T | undefined): Promise<T> {
  const raw = createReadStream(file);
  const inflate = decompressor(file);
  const stream = inflate ? raw.pipe(inflate) : raw;
  const chunks: Buffer[] = [];
  let total = 0;
  // Re-parse only each time the data read so far doubles, so the copying stays linear.
  let nextParse = 64 * 1024;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      total += chunk.length;
      if (total < nextParse && total < MAX_SCAN_BYTES) continue;
      nextParse = total * 2;
      const result = parse(Buffer.concat(chunks, total), false);
      if (result !== undefined) return result;
      if (total >= MAX_SCAN_BYTES) {
        throw new ArchiveConfigError('No guest configuration was found in the first 64 MiB of this backup.');
      }
    }
    const result = parse(Buffer.concat(chunks, total), true);
    if (result !== undefined) return result;
    throw new ArchiveConfigError('No guest configuration was found at the start of this backup.');
  } catch (err) {
    if (err instanceof ArchiveConfigError) throw err;
    throw new ArchiveConfigError(`This backup could not be read: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    raw.destroy();
    inflate?.destroy();
  }
}

/**
 * The config blobs of a VMA header. Layout (pve-qemu `vma_spec.txt`): magic
 * `VMA\0`, version (u32 BE, 1), uuid, ctime, md5 of the header with the md5 field
 * zeroed, blob buffer offset/size and header size (u32 BE) at 48/52/56, then
 * `config_names[256]` and `config_data[256]` (u32 BE offsets into the blob
 * buffer) at 2044 and 3068. Each blob is a 2-byte little-endian length then data.
 */
export function parseVmaHeader(buf: Buffer, ended: boolean): Record<string, string> | undefined {
  if (buf.length < 60) {
    if (ended) throw new ArchiveConfigError('This is not a VMA backup (the file is too short).');
    return undefined;
  }
  if (!buf.subarray(0, 4).equals(VMA_MAGIC)) throw new ArchiveConfigError('This is not a VMA backup.');
  if (buf.readUInt32BE(4) !== 1) throw new ArchiveConfigError('This VMA version is not supported.');
  const blobOffset = buf.readUInt32BE(48);
  const blobSize = buf.readUInt32BE(52);
  const headerSize = buf.readUInt32BE(56);
  if (headerSize < VMA_FIXED || headerSize > MAX_SCAN_BYTES || blobOffset < VMA_FIXED || blobOffset + blobSize > headerSize) {
    throw new ArchiveConfigError('This VMA backup has a malformed header.');
  }
  if (buf.length < headerSize) {
    if (ended) throw new ArchiveConfigError('This VMA backup ends inside its header.');
    return undefined;
  }
  const header = Buffer.from(buf.subarray(0, headerSize));
  const md5 = Buffer.from(header.subarray(32, 48));
  header.fill(0, 32, 48);
  if (!createHash('md5').update(header).digest().equals(md5)) {
    throw new ArchiveConfigError('This VMA backup header is damaged (checksum mismatch).');
  }
  const blobs = header.subarray(blobOffset, blobOffset + blobSize);
  const blob = (offset: number): Buffer | null => {
    if (offset === 0 || offset + 2 > blobs.length) return null;
    const len = blobs.readUInt16LE(offset);
    if (offset + 2 + len > blobs.length) throw new ArchiveConfigError('This VMA backup has a malformed config entry.');
    return blobs.subarray(offset + 2, offset + 2 + len);
  };
  const out: Record<string, string> = {};
  for (let i = 0; i < 256; i += 1) {
    const nameAt = header.readUInt32BE(2044 + i * 4);
    const dataAt = header.readUInt32BE(3068 + i * 4);
    const name = blob(nameAt);
    const data = blob(dataAt);
    if (!name || !data) continue;
    out[name.toString('utf8').replace(/\0+$/, '')] = data.toString('utf8').replace(/\0+$/, '');
  }
  return out;
}

/** Trim a NUL-terminated tar header field. */
function tarField(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/**
 * The first tar entry whose name (without a leading `./`) is in `wanted`, or
 * undefined while more of the archive is needed. Plain ustar headers, with GNU
 * long names (`L`) and pax headers (`x`, whose `path` is honoured) skipped over.
 */
export function findTarEntry(buf: Buffer, ended: boolean, wanted: readonly string[]): { name: string; data: string } | undefined {
  let pos = 0;
  let longName: string | null = null;
  while (pos + 512 <= buf.length) {
    const block = buf.subarray(pos, pos + 512);
    if (block.every((b) => b === 0)) throw new ArchiveConfigError('No guest configuration was found in this backup.');
    const sizeField = tarField(block, 124, 12).trim();
    if (!/^[0-7]*$/.test(sizeField)) throw new ArchiveConfigError('This is not a tar backup.');
    const size = parseInt(sizeField || '0', 8);
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = tarField(block, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${tarField(block, 0, 100)}` : tarField(block, 0, 100));
    longName = null;
    const dataStart = pos + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      if (ended) throw new ArchiveConfigError('This tar backup ends inside an entry.');
      return undefined;
    }
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
    } else if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1]!;
    } else {
      name = name.replace(/^\.\//, '');
      if (wanted.includes(name)) return { name, data: data.toString('utf8') };
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  if (ended) throw new ArchiveConfigError('No guest configuration was found in this backup.');
  return undefined;
}

/**
 * The guest config text of the vzdump archive at `file` (an absolute path the
 * caller has already validated): `qemu-server.conf` of a VMA or legacy QEMU tar,
 * `etc/vzdump/pct.conf` of a container tar.
 */
export async function readArchiveConfig(file: string): Promise<string> {
  const base = file.replace(/\.(zst|gz|lzo)$/, '');
  if (base.endsWith('.vma')) {
    const configs = await scanPrefix(file, parseVmaHeader);
    const cfg = configs['qemu-server.conf'];
    if (cfg === undefined) throw new ArchiveConfigError('This VMA backup carries no qemu-server.conf.');
    return cfg;
  }
  if (base.endsWith('.tar')) {
    const wanted = ['etc/vzdump/pct.conf', 'etc/vzdump/qemu-server.conf', 'qemu-server.conf'];
    return (await scanPrefix(file, (buf, ended) => findTarEntry(buf, ended, wanted))).data;
  }
  throw new ArchiveConfigError('This is not a vzdump backup archive.');
}
