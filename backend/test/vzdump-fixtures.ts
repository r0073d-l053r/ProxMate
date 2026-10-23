import { createHash } from 'node:crypto';

/**
 * Minimal vzdump archives for tests: a VMA header carrying config blobs (the
 * layout pve-qemu's vma_spec.txt describes, with a valid md5), and a tar archive
 * with the given entries.
 */
export function buildVma(
  configs: Record<string, string> | Array<[string, string]>,
  opts: { corruptMd5?: boolean; dataPointer?: number } = {},
): Buffer {
  const blobParts: Buffer[] = [Buffer.alloc(1)]; // offset 0 means "none"
  let blobLen = 1;
  const addBlob = (text: string): number => {
    const data = Buffer.from(`${text}\0`, 'utf8');
    const entry = Buffer.alloc(2 + data.length);
    entry.writeUInt16LE(data.length, 0);
    data.copy(entry, 2);
    const at = blobLen;
    blobParts.push(entry);
    blobLen += entry.length;
    return at;
  };
  const names: number[] = [];
  const datas: number[] = [];
  for (const [name, text] of Array.isArray(configs) ? configs : Object.entries(configs)) {
    names.push(addBlob(name));
    datas.push(addBlob(text));
  }
  if (opts.dataPointer !== undefined) datas[0] = opts.dataPointer;
  const blobs = Buffer.concat(blobParts);
  const blobOffset = 12288;
  const headerSize = Math.ceil((blobOffset + blobs.length) / 512) * 512;
  const h = Buffer.alloc(headerSize);
  h.write('VMA\0', 0, 'latin1');
  h.writeUInt32BE(1, 4);
  h.writeUInt32BE(blobOffset, 48);
  h.writeUInt32BE(blobs.length, 52);
  h.writeUInt32BE(headerSize, 56);
  names.forEach((n, i) => h.writeUInt32BE(n, 2044 + i * 4));
  datas.forEach((d, i) => h.writeUInt32BE(d, 3068 + i * 4));
  blobs.copy(h, blobOffset);
  const md5 = createHash('md5').update(h).digest();
  if (opts.corruptMd5) md5[0] = md5[0]! ^ 0xff;
  md5.copy(h, 32);
  // Some extent data after the header, as a real archive has.
  return Buffer.concat([h, Buffer.alloc(4096, 0xab)]);
}

export interface TarEntryOpts {
  /** Type flag (default '0', a regular file). */
  type?: string;
  /** Bytes at 257..264 (default POSIX "ustar\0" + "00"). */
  magic?: string;
  /** Bytes at 345 (a POSIX name prefix, or GNU atime/ctime data). */
  at345?: string;
  badChecksum?: boolean;
}

export function buildTar(entries: Array<[string, string] | [string, string, TarEntryOpts]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text, opts = {}] of entries) {
    const data = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(512);
    head.write(name, 0, 100, 'utf8');
    head.write('0000644\0', 100);
    head.write('0000000\0', 108);
    head.write('0000000\0', 116);
    head.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    head.write('00000000000\0', 136);
    head.write(opts.type ?? '0', 156);
    head.write(opts.magic ?? 'ustar\x0000', 257, 'latin1');
    if (opts.at345) head.write(opts.at345, 345, 'latin1');
    head.fill(' ', 148, 156);
    let sum = 0;
    for (const b of head) sum += b;
    if (opts.badChecksum) sum += 1;
    head.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
