import { describe, it, expect } from 'vitest';
import type { MateState } from '@prisma/client';
import { serializeMateState } from '../src/services/matestate.service.js';

// A backup larger than Int32's max (2_147_483_647 bytes ≈ 2.147 GB). This is the
// exact value that overflowed the old `size Int` column and 500'd the whole
// matestates listing once a real (multi-GB) backup existed.
const THREE_GB = BigInt(3_221_225_472);

const base: MateState = {
  id: 'ms1',
  vmId: 'vm1',
  proxmoxVmId: 100,
  proxmoxNode: 'pve-0',
  storage: 'backups',
  volid: 'local:backup/vzdump-qemu-100-2026_07_03-03_00_00.vma.zst',
  size: BigInt(0),
  status: 'ready',
  kind: 'manual',
  notes: null,
  createdAt: new Date('2026-07-03T00:00:00Z'),
  updatedAt: new Date('2026-07-03T00:00:00Z'),
};

describe('serializeMateState', () => {
  it('converts a multi-GB BigInt size to a JSON-safe Number', () => {
    const out = serializeMateState({ ...base, size: THREE_GB });
    expect(typeof out.size).toBe('number');
    expect(out.size).toBe(3_221_225_472);
  });

  it('produces output that JSON.stringify can serialize (the actual bug)', () => {
    const out = serializeMateState({ ...base, size: THREE_GB });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.parse(JSON.stringify(out)).size).toBe(3_221_225_472);
  });

  it('regression guard: a raw BigInt breaks JSON.stringify', () => {
    expect(() => JSON.stringify({ size: THREE_GB })).toThrow(TypeError);
  });
});
