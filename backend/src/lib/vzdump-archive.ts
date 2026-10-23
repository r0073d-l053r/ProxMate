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
 * Supported: `.vma` (QEMU) and `.tar` (containers), each optionally `.zst` or
 * `.gz`. `.lzo` has no decoder here and is refused, as is anything that does not
 * have exactly the shape Proxmox itself writes. The result is only an early
 * estimate (quota, obvious refusals): Proxmox may apply settings from elsewhere in
 * the archive, so the restored guest is checked again once it exists.
 */

export class ArchiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveConfigError';
  }
}

/** Never decompress more than this looking for the config (the VMA header, or the first tar entry). */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** zstd window cap (2^24 = 16 MiB) so a crafted frame cannot make the decoder allocate more. */
const ZSTD_WINDOW_LOG_MAX = 24;

const VMA_MAGIC = Buffer.from('VMA\0', 'latin1');
/** The only config blobs vzdump writes into a VMA. */
const VMA_CONFIG_NAMES = new Set(['qemu-server.conf', 'qemu-server.fw']);
const VMA_FIXED = 12288; // fixed part of the header, before the blob buffer may start

function decompressor(filename: string): Transform | null {
  if (filename.endsWith('.zst')) {
    if (typeof zlib.createZstdDecompress !== 'function') {
      throw new ArchiveConfigError('This server cannot read zstd archives (it needs Node.js 22.15 or later).');
    }
    return zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX } });
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
  // The decompressor first: it may refuse the format, and no file is opened then.
  const inflate = decompressor(file);
  const raw = createReadStream(file);
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
        throw new ArchiveConfigError('No guest configuration was found at the start of this backup.');
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
    if (offset === 0) return null;
    if (offset + 2 > blobs.length) throw new ArchiveConfigError('This VMA backup has a malformed config entry.');
    const len = blobs.readUInt16LE(offset);
    if (offset + 2 + len > blobs.length) throw new ArchiveConfigError('This VMA backup has a malformed config entry.');
    return blobs.subarray(offset + 2, offset + 2 + len);
  };
  const out: Record<string, string> = {};
  for (let i = 0; i < 256; i += 1) {
    const nameAt = header.readUInt32BE(2044 + i * 4);
    const dataAt = header.readUInt32BE(3068 + i * 4);
    if (nameAt === 0 && dataAt === 0) continue;
    const name = blob(nameAt);
    const data = blob(dataAt);
    if (!name || !data) throw new ArchiveConfigError('This VMA backup has a malformed config entry.');
    // Read a name as C does, up to its first NUL: "qemu-server.conf\0x" is qemu-server.conf.
    const nul = name.indexOf(0);
    const key = name.subarray(0, nul === -1 ? name.length : nul).toString('utf8');
    if (!VMA_CONFIG_NAMES.has(key)) throw new ArchiveConfigError(`This VMA backup carries an unexpected config "${key}".`);
    if (key in out) throw new ArchiveConfigError(`This VMA backup carries "${key}" twice.`);
    out[key] = data.toString('utf8').replace(/\0+$/, '');
  }
  return out;
}

const PCT_CONF = './etc/vzdump/pct.conf';
const USTAR_MAGIC = Buffer.from('ustar\x0000', 'latin1'); // POSIX: magic "ustar\0", version "00"
const GNU_MAGIC = Buffer.from('ustar  \x00', 'latin1'); // GNU tar, as vzdump writes it
const MAX_PCT_CONF = 1024 * 1024;

/**
 * The container config of a vzdump tar, read the way vzdump writes it: the first
 * header, with a valid checksum, for a regular file named exactly
 * `./etc/vzdump/pct.conf`. Anything else — another first entry, a long-name or pax
 * header, a POSIX prefix, an old OpenVZ `vps.conf` — is refused rather than
 * interpreted, so this reader can never be steered to a different entry than the
 * one it names.
 */
export function readTarPctConf(buf: Buffer, ended: boolean): string | undefined {
  if (buf.length < 512) {
    if (ended) throw new ArchiveConfigError('This is not a container backup (the file is too short).');
    return undefined;
  }
  const h = buf.subarray(0, 512);
  const field = (start: number, len: number) => h.subarray(start, start + len);
  const octal = (start: number, len: number): number => {
    const text = field(start, len).toString('latin1').replace(/[\0 ]+$/, '').trim();
    if (!/^[0-7]+$/.test(text)) throw new ArchiveConfigError('This is not a container backup ProxMate can read.');
    return parseInt(text, 8);
  };
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  if (octal(148, 8) !== sum) throw new ArchiveConfigError('This backup is damaged (tar header checksum mismatch).');
  const magic = field(257, 8);
  const gnu = magic.equals(GNU_MAGIC);
  if (!gnu && !magic.equals(USTAR_MAGIC)) throw new ArchiveConfigError('This is not a container backup ProxMate can read.');
  // In a POSIX header 345..500 is a name prefix; in a GNU header it is other data.
  if (!gnu && field(345, 155).some((b) => b !== 0)) {
    throw new ArchiveConfigError('This is not a container backup ProxMate can read.');
  }
  const nameField = field(0, 100);
  const nul = nameField.indexOf(0);
  const name = nameField.subarray(0, nul === -1 ? 100 : nul).toString('utf8');
  const type = h[156]!;
  if (name !== PCT_CONF || (type !== 0x30 && type !== 0)) {
    throw new ArchiveConfigError(
      name.endsWith('vps.conf')
        ? 'OpenVZ backups (vps.conf) cannot be restored here.'
        : 'This is not a container backup ProxMate can read: it does not start with its configuration.',
    );
  }
  const size = octal(124, 12);
  if (size > MAX_PCT_CONF) throw new ArchiveConfigError('This backup carries an oversized configuration.');
  if (buf.length < 512 + size) {
    if (ended) throw new ArchiveConfigError('This backup ends inside its configuration.');
    return undefined;
  }
  return buf.subarray(512, 512 + size).toString('utf8');
}

/**
 * The guest config text of the vzdump archive at `file` (an absolute path the
 * caller has already validated): `qemu-server.conf` of a VMA, or
 * `./etc/vzdump/pct.conf` of a container tar. A QEMU tar (the old format) is refused.
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
    if (!/(^|\/)vzdump-lxc-[^/]*$/.test(base)) {
      throw new ArchiveConfigError('Old-format QEMU tar backups cannot be restored here. Upload a .vma backup instead.');
    }
    return scanPrefix(file, readTarPctConf);
  }
  throw new ArchiveConfigError('This is not a vzdump backup archive.');
}
