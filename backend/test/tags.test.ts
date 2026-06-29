import { describe, it, expect, vi } from 'vitest';

// normalizeTags is pure, but vm.service imports prisma/notify/metrics at module load —
// stub the heaviest seam so the import is cheap.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/notify.service.js', () => ({ notify: vi.fn() }));
vi.mock('../src/lib/metrics.js', () => ({ proxmoxApiErrors: { inc: vi.fn() } }));

import { normalizeTags } from '../src/services/vm.service.js';

describe('normalizeTags', () => {
  it('lowercases, trims, and drops blanks', () => {
    expect(normalizeTags([' Prod ', 'WEB', '', '  '])).toBe('prod,web');
  });

  it('dedupes while preserving first-seen order', () => {
    expect(normalizeTags(['a', 'b', 'a', 'B'])).toBe('a,b');
  });

  it('returns an empty string for no tags (clears the field)', () => {
    expect(normalizeTags([])).toBe('');
  });
});
